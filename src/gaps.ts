import type { Dimension, Fact, Model, Question, Step } from './domain.ts';

// Gap analysis and next-question selection. Entirely deterministic.
//
// The model is a set of SLOTS (trigger, completion, S2.owner, ...). Each slot has:
//   weight       how much the rest of the analysis depends on it (foundational = high)
//   uncertainty  1 = unknown and never asked, 0.5 = inferred (needs confirming),
//                0 = settled (known / absent) or asked-and-unresolved (not re-asked)
// Score = weight x uncertainty. The next question is the highest-scoring slot, i.e. the
// one that removes the most uncertainty from the model, not the one that yields the most detail.
// A settled slot scores 0, so Ilsa never asks "tell me more" about something already established.

export const WEIGHTS = {
  sequence: 4, trigger: 3, completion: 3, owner: 2, exceptions: 2,
  handoff_in: 1.5, waiting: 1.5, decisions: 1, system: 1,
} as const;
type SlotKind = keyof typeof WEIGHTS;

/** Plain-language reason each dimension matters, shown next to the question. */
export const WHY: Record<Dimension, string> = {
  steps: 'Everything else (owners, handoffs, delays) hangs off the list of steps.',
  trigger: 'Where work enters decides what information you start with.',
  completion: 'Without a clear finish point, finished, abandoned and forgotten work all look the same.',
  ownership: 'Steps without a clear owner are where work stalls without anyone noticing.',
  exceptions: 'Work is usually lost on the path nobody designed: what happens when something goes wrong.',
  handoffs: 'Handoffs are where details and responsibility get dropped.',
  waiting: 'Waiting is where work stalls unless something prompts the next action.',
  decisions: 'Judgment calls made differently by different people make outcomes unpredictable.',
  systems: 'Knowing the tools shows where information is retyped or scattered.',
};
export const WHY_CONFIRM = 'You said this with some uncertainty. Ilsa will not treat it as fact until you confirm it.';

/** Tie-break order when scores are equal: foundational dimensions first, then process order. */
const ORDER: SlotKind[] = ['sequence', 'trigger', 'completion', 'owner', 'exceptions', 'handoff_in', 'waiting', 'decisions', 'system'];

const DIMENSION_OF: Record<SlotKind, Dimension> = {
  sequence: 'steps', trigger: 'trigger', completion: 'completion', owner: 'ownership', exceptions: 'exceptions',
  handoff_in: 'handoffs', waiting: 'waiting', decisions: 'decisions', system: 'systems',
};

/** At most this many "is this list of steps complete?" questions, so discovery always terminates. */
export const MAX_SEQUENCE_CONFIRMS = 2;

export interface Candidate {
  slot: string;
  kind: SlotKind;
  dimension: Dimension;
  intent: Question['intent'];
  step: Step | null;
  weight: number;
  uncertainty: number;
  score: number;
  text: string;
  reason: string;
}

export type FactState = 'established' | 'tentative' | 'unresolved' | 'missing';

export function factState(f: Fact): FactState {
  if (f.status === 'known' || f.status === 'absent') return 'established';
  if (f.status === 'inferred') return 'tentative';
  return f.evidence.length > 0 ? 'unresolved' : 'missing';
}

/** The user explicitly said nobody knows this (in an answer, or by marking it unknown in review). */
export function userSaysUnknown(f: Fact, isDontKnow: (t: string) => boolean): boolean {
  return f.status === 'unknown' && f.evidence.length > 0 && (f.by === 'user' || f.evidence.some((r) => isDontKnow(r.quote)));
}

function uncertaintyOf(f: Fact): number {
  return { established: 0, tentative: 0.5, unresolved: 0, missing: 1 }[factState(f)];
}

const established = (f: Fact) => f.status === 'known' || f.status === 'inferred';

/**
 * Steps where work may change hands. Fix 5 (post-review): a handoff is only ruled out when both
 * owners are established and the same person. Unknown owners no longer hide the handoff.
 */
export function handoffSteps(model: Model): Step[] {
  const steps = model.workflow.steps;
  return steps.filter((s, i) => {
    if (i === 0) return false;
    const a = steps[i - 1].owner;
    const b = s.owner;
    const sameKnownOwner = established(a) && established(b) && a.value!.toLowerCase() === b.value!.toLowerCase();
    return !sameKnownOwner;
  });
}

function quoteOf(f: Fact): string {
  return f.evidence[0]?.quote ?? f.value ?? '';
}

function textFor(kind: SlotKind, intent: Question['intent'], f: Fact, model: Model, step: Step | null): string {
  if (intent === 'confirm' && kind !== 'sequence') {
    return `You said: "${quoteOf(f)}". Is that always how it works, or does it vary? If it varies, what does it depend on?`;
  }
  const steps = model.workflow.steps;
  const prev = step ? steps[steps.indexOf(step) - 1] : undefined;
  switch (kind) {
    case 'sequence':
      return intent === 'discover'
        ? 'Walk me through what happens, step by step, from the moment this starts until it is finished. Who does what, and where?'
        : `Here are the steps I have so far:\n${steps.map((s, i) => `${i + 1}. ${s.summary}`).join('\n')}\nIs anything missing or out of order? If it is right, just say so.`;
    case 'trigger': return 'What starts this process? Where does a new one first show up?';
    case 'completion': return 'How do you know when one of these is finished? Is it marked or recorded anywhere?';
    case 'exceptions': return 'What happens when the normal path breaks down, for example when nobody follows up or the customer does not answer?';
    case 'waiting': return 'Where in this process does someone have to wait on another person, an approval, or the customer?';
    case 'decisions': return 'Where does someone have to make a judgment call in this process, and who makes it?';
    case 'owner': return `Who is responsible for this step: "${step!.summary}"? If it depends, what does it depend on?`;
    case 'system': return `What tool is used for this step: "${step!.summary}"? (email, spreadsheet, CRM, paper, phone...)`;
    case 'handoff_in':
      return `After "${prev?.summary}", how does the work reach the next step, "${step!.summary}"? What tells ${established(step!.owner) ? step!.owner.value : 'whoever does it'} it is their turn?`;
  }
}

function asked(questions: Question[], slot: string, intent: Question['intent']): number {
  return questions.filter((q) => q.slot === slot && q.intent === intent).length;
}

/** Every slot that could be asked about right now, scored. */
export function candidates(model: Model, questions: Question[]): Candidate[] {
  const out: Candidate[] = [];
  const wf = model.workflow;
  const add = (kind: SlotKind, slot: string, f: Fact, step: Step | null) => {
    const state = factState(f);
    if (state !== 'missing' && state !== 'tentative') return;
    const intent: Question['intent'] = state === 'tentative' ? 'confirm' : 'discover';
    if (asked(questions, slot, intent) > 0) return;
    const uncertainty = uncertaintyOf(f);
    const weight = WEIGHTS[kind];
    out.push({
      slot, kind, dimension: DIMENSION_OF[kind], intent, step, weight, uncertainty, score: weight * uncertainty,
      text: textFor(kind, intent, f, model, step),
      reason: `${slot} is ${state === 'missing' ? 'unknown' : 'inferred but unconfirmed'} (weight ${weight} x uncertainty ${uncertainty})`,
    });
  };

  // Sequence: first establish that there are steps at all, then confirm the list.
  if (wf.steps.length < 2) {
    if (asked(questions, 'sequence', 'discover') === 0) {
      out.push({
        slot: 'sequence', kind: 'sequence', dimension: 'steps', intent: 'discover', step: null, weight: WEIGHTS.sequence,
        uncertainty: 1, score: WEIGHTS.sequence, text: textFor('sequence', 'discover', wf.sequence, model, null),
        reason: `fewer than 2 steps known (weight ${WEIGHTS.sequence} x uncertainty 1)`,
      });
    }
  } else if (!sequenceConfirmed(model) && asked(questions, 'sequence', 'confirm') < MAX_SEQUENCE_CONFIRMS) {
    const text = textFor('sequence', 'confirm', wf.sequence, model, null);
    const last = questions.filter((q) => q.slot === 'sequence' && q.intent === 'confirm').at(-1);
    // Re-ask only if the step list has changed since the user last saw it.
    if (!last || last.text !== text) {
      out.push({
        slot: 'sequence', kind: 'sequence', dimension: 'steps', intent: 'confirm', step: null, weight: WEIGHTS.sequence,
        uncertainty: 0.5, score: WEIGHTS.sequence * 0.5, text: textFor('sequence', 'confirm', wf.sequence, model, null),
        reason: `${wf.steps.length} steps found but the list is not confirmed (weight ${WEIGHTS.sequence} x uncertainty 0.5)`,
      });
    }
  }

  add('trigger', 'trigger', wf.trigger, null);
  add('completion', 'completion', wf.completion, null);
  add('exceptions', 'exceptions', wf.exceptions, null);
  add('waiting', 'waiting', wf.waiting, null);
  add('decisions', 'decisions', wf.decisions, null);
  for (const s of wf.steps) {
    add('owner', `${s.id}.owner`, s.owner, s);
    add('system', `${s.id}.system`, s.system, s);
  }
  for (const s of handoffSteps(model)) add('handoff_in', `${s.id}.handoff_in`, s.handoff_in, s);
  return out;
}

/** The confirmed sequence records how many steps were confirmed; adding steps makes it stale. */
export function sequenceConfirmed(model: Model): boolean {
  const f = model.workflow.sequence;
  return f.status === 'known' && f.value === `confirmed: ${model.workflow.steps.length} steps`;
}

export function nextQuestion(model: Model, questions: Question[]): Candidate | null {
  if (questions.some((q) => q.status === 'open')) return null; // one question at a time
  const cs = candidates(model, questions).filter((c) => c.score > 0);
  if (cs.length === 0) return null;
  const stepIndex = (c: Candidate) => (c.step ? model.workflow.steps.indexOf(c.step) : -1);
  cs.sort((a, b) => b.score - a.score || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || stepIndex(a) - stepIndex(b));
  return cs[0];
}

/** Coverage of each discovery dimension, for the UI and the readiness gate. */
export function coverage(model: Model): Record<Dimension, FactState> {
  const wf = model.workflow;
  const worst = (facts: Fact[]): FactState => {
    if (facts.length === 0) return 'missing';
    const states = facts.map(factState);
    for (const s of ['missing', 'unresolved', 'tentative'] as FactState[]) if (states.includes(s)) return s;
    return 'established';
  };
  return {
    trigger: factState(wf.trigger),
    steps: wf.steps.length < 2 ? 'missing' : sequenceConfirmed(model) ? 'established' : 'tentative',
    ownership: worst(wf.steps.map((s) => s.owner)),
    systems: worst(wf.steps.map((s) => s.system)),
    handoffs: wf.steps.length < 2 ? 'missing' : worst(handoffSteps(model).map((s) => s.handoff_in)),
    decisions: factState(wf.decisions),
    waiting: factState(wf.waiting),
    exceptions: factState(wf.exceptions),
    completion: factState(wf.completion),
  };
}

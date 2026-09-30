import type { Dimension, Fact, Model, Question } from './domain.ts';
import { factState, handoffSteps, sequenceConfirmed, userSaysUnknown } from './gaps.ts';
import { isDontKnow } from './language.ts';

// The readiness gate: "understand before recommending", enforced in code.
//
// Having SOME information is not understanding the process. Every slot in the
// foundational dimensions must be one of:
//   established   the user stated it plainly, or stated that it does not exist
//   user-unknown  the user explicitly said they do not know (carried into Unknowns)
// Anything else blocks: inferred-but-unconfirmed, skipped, never asked, or an answer
// that could not be interpreted. Supporting dimensions do not block; their gaps are
// reported as Unknowns.

export const FOUNDATIONAL: Dimension[] = ['steps', 'trigger', 'ownership', 'handoffs', 'exceptions', 'completion'];
export const SUPPORTING: Dimension[] = ['systems', 'decisions', 'waiting'];

export interface Blocker {
  dimension: Dimension;
  slot: string;
  problem: 'not_asked' | 'skipped' | 'needs_confirmation' | 'uninterpreted' | 'too_few_steps' | 'sequence_unconfirmed';
  needed: string;
}

export interface Unknown {
  dimension: Dimension;
  slot: string;
  kind: 'user_does_not_know' | 'unconfirmed' | 'not_covered';
  description: string;
}

export interface Readiness {
  ready: boolean;
  blocking: Blocker[];
  unknowns: Unknown[];
  satisfied: Dimension[];
}

interface SlotRef {
  dimension: Dimension;
  slot: string;
  label: string;
  fact: Fact;
}

function slots(model: Model): SlotRef[] {
  const wf = model.workflow;
  const out: SlotRef[] = [
    { dimension: 'trigger', slot: 'trigger', label: 'what starts the process', fact: wf.trigger },
    { dimension: 'completion', slot: 'completion', label: 'how you know the work is finished', fact: wf.completion },
    { dimension: 'exceptions', slot: 'exceptions', label: 'what happens when the normal path fails', fact: wf.exceptions },
    { dimension: 'decisions', slot: 'decisions', label: 'where judgment calls happen', fact: wf.decisions },
    { dimension: 'waiting', slot: 'waiting', label: 'where the process waits on others', fact: wf.waiting },
  ];
  for (const s of wf.steps) {
    out.push({ dimension: 'ownership', slot: `${s.id}.owner`, label: `who is responsible for ${s.id} ("${s.summary}")`, fact: s.owner });
    out.push({ dimension: 'systems', slot: `${s.id}.system`, label: `which tool is used for ${s.id} ("${s.summary}")`, fact: s.system });
  }
  for (const s of handoffSteps(model)) {
    out.push({ dimension: 'handoffs', slot: `${s.id}.handoff_in`, label: `how work reaches ${s.id} ("${s.summary}")`, fact: s.handoff_in });
  }
  return out;
}

export function readiness(model: Model, questions: Question[]): Readiness {
  const blocking: Blocker[] = [];
  const unknowns: Unknown[] = [];
  const wf = model.workflow;

  if (wf.steps.length < 2) {
    blocking.push({ dimension: 'steps', slot: 'sequence', problem: 'too_few_steps', needed: 'Describe the process step by step (at least two steps).' });
  } else if (!sequenceConfirmed(model)) {
    blocking.push({ dimension: 'steps', slot: 'sequence', problem: 'sequence_unconfirmed', needed: `Confirm the list of ${wf.steps.length} steps is complete and in order.` });
  }

  for (const s of slots(model)) {
    const foundational = FOUNDATIONAL.includes(s.dimension);
    const state = factState(s.fact);
    const skipped = questions.some((q) => q.slot === s.slot && q.status === 'skipped');
    if (state === 'established') continue;

    if (state === 'unresolved' && userSaysUnknown(s.fact, isDontKnow)) {
      unknowns.push({ dimension: s.dimension, slot: s.slot, kind: 'user_does_not_know', description: `Nobody could say ${s.label}.` });
      continue;
    }
    if (!foundational) {
      unknowns.push({
        dimension: s.dimension, slot: s.slot, kind: state === 'tentative' ? 'unconfirmed' : 'not_covered',
        description: state === 'tentative' ? `Unconfirmed: ${s.label} ("${s.fact.value}").` : `Not established: ${s.label}.`,
      });
      continue;
    }
    if (state === 'tentative') {
      blocking.push({ dimension: s.dimension, slot: s.slot, problem: 'needs_confirmation', needed: `Confirm ${s.label}: currently only inferred ("${s.fact.value}").` });
    } else if (state === 'unresolved') {
      blocking.push({ dimension: s.dimension, slot: s.slot, problem: 'uninterpreted', needed: `The answer about ${s.label} could not be interpreted. Restate or correct it.` });
    } else if (skipped) {
      blocking.push({ dimension: s.dimension, slot: s.slot, problem: 'skipped', needed: `Answer ${s.label} (the question was skipped), or say that nobody knows.` });
    } else {
      blocking.push({ dimension: s.dimension, slot: s.slot, problem: 'not_asked', needed: `Establish ${s.label}.` });
    }
  }
  if (wf.steps.length === 0) blocking.push({ dimension: 'ownership', slot: 'steps', problem: 'too_few_steps', needed: 'Ownership cannot be assessed until the steps are known.' });

  const blocked = new Set(blocking.map((b) => b.dimension));
  return {
    ready: blocking.length === 0,
    blocking,
    unknowns,
    satisfied: FOUNDATIONAL.filter((d) => !blocked.has(d)),
  };
}

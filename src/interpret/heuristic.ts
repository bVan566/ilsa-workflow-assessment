import type { EvidenceRef, Fact, WorkflowFactField } from '../domain.ts';
import { getFact } from '../merge.ts';
import { isDontKnow, isHedged, sentences } from '../language.ts';
import { emptyDelta, type Delta, type FactProposal, type InterpretInput, type Interpreter, type StepProposal } from './types.ts';

// The no-key interpreter. Transparent word patterns, not intelligence: it reads plain
// descriptions reasonably and misses anything phrased unusually. Every proposal quotes
// a whole sentence of the user's words, so its evidence always checks out.
// It is general-purpose: nothing here knows about any particular business or scenario.

const STEP_VERB = /\b(copies|copy|copied|enters?|entered|types?|typed|forwards?|forwarded|sends?|sent|calls?|called|emails?|emailed|texts?|texted|assigns?|assigned|decides?|decided|reviews?|reviewed|checks?|checked|follows? up|followed up|schedules?|scheduled|quotes?|quoted|updates?|updated|replies|replied|reply|logs?|logged|creates?|created|passes|passed|hands? (it |them )?(off|over|to)|handed|reads?|looks? at|puts?|adds?|added|writes?|wrote|books?|booked|visits?|estimates?|approves?|approved|reaches out|responds?|responded|picks? (it |them )?up|marks?|marked|files?|filed|receives?|received|gets? back to|contacts?(?! form)|contacted|prints?|printed)\b/i;
const MANUAL = /\b(copies|copy|copied|re-?enters?|re-?types?|types? (it|them|the)|manually|by hand|writes? (it |them )?down|enters? (it|them|the \w+) (into|in)|pastes?|prints?)\b/i;
const DECISION = /\b(decides?|decided|chooses?|chose|approves?|approved|judg(e)?ment call|whether (to|or))\b/i;
const WAIT = /\b(waits?|waiting|until (they|the|we|he|she)|hear back|depends on|pending|approval from)\b/i;
const TRIGGER = /\b(comes? in|came in|arrives?|submits?|fills? out|starts? (when|with)|kicks? off|reaches out to us|calls? us|emails? us|web ?form|contact form|shows? up|lands? in)\b/i;
const COMPLETION = /\b(it'?s (done|finished|complete)|is (done|finished|complete|closed) when|we know (it'?s|we'?re) (done|finished)|considered (done|complete|closed)|marked (as )?(won|lost|done|complete|closed)|close (it|them) out)\b/i;
const COMPLETION_ABSENT = /\b(never (really )?(get |gets )?(closed|marked)|nobody (closes|marks|updates)|no one (closes|marks|updates)|don'?t (really )?(close|mark) (them|it)|no way to (know|tell)|nothing (marks|closes)|never officially clos\w*)\b/i;
const EXCEPTION = /\b(if (nobody|no one|they don'?t|the customer doesn'?t|we don'?t|it'?s not)|falls? through|gets? (lost|forgotten|dropped)|slips? through|nobody follows up|no one follows up)\b/i;
const EXCEPTION_ABSENT = /\b(nothing happens|there'?s no (backup|process|plan)|we don'?t have a (process|plan|backup)|no (backup|fallback) (plan|process))\b/i;
const DECISIONS_ABSENT = /\b(no (real )?decisions?|nothing to decide|no judgment)\b/i;
const WAITING_ABSENT = /\b(no waiting|nothing to wait (for|on)|we never wait|don'?t wait on)\b/i;
const YES = /^\s*(yes|yep|yeah|yup|correct|right|that'?s right|exactly|always|that'?s correct)\b/i;

const AMBIGUOUS_OWNER = /\b(whoever( [a-z]+){0,3}|someone|somebody|anyone|one of us|we all)\b/i;
const ROLE = /\b(the )?(owner|office manager|manager|receptionist|admin(istrator)?|assistant|technicians?|techs?|salesperson|sales ?reps?|sales team|estimators?|dispatcher|bookkeeper|coordinator|project manager|front desk|crew lead|foreman)\b/i;
const NOT_NAMES = new Set(['then', 'after', 'when', 'if', 'the', 'we', 'they', 'it', 'she', 'he', 'our', 'that', 'this', 'so', 'and', 'but',
  'once', 'next', 'first', 'finally', 'usually', 'sometimes', 'someone', 'nobody', 'everyone', 'inquiries', 'leads', 'customers', 'i']);

const SYSTEMS: [RegExp, string][] = [
  [/\b(web ?site|web ?form|contact form|online form)\b/i, 'website form'],
  [/\b(e-?mail|inbox|gmail|outlook)\b/i, 'email'],
  [/\b(spread ?sheet|excel|google sheets?)\b/i, 'spreadsheet'],
  [/\b(crm|hubspot|salesforce|pipedrive|zoho)\b/i, 'CRM'],
  [/\bquickbooks\b/i, 'QuickBooks'],
  [/\b(phone|voicemail)\b/i, 'phone'],
  [/\b(text message|texts?|sms)\b/i, 'text message'],
  [/\b(paper|notepad|notebook|sticky notes?|whiteboard|clipboard)\b/i, 'paper or whiteboard'],
  [/\bcalendar\b/i, 'calendar'],
  [/\b(slack|teams)\b/i, 'chat'],
  [/\b(jobber|servicetitan|housecall pro)\b/i, 'field service software'],
];

function fact(value: string | null, status: Fact['status'], refs: EvidenceRef[]): FactProposal {
  return { value, status, evidence: refs };
}

/** known, or inferred if the sentence hedges. */
function stated(value: string, refs: EvidenceRef[], sentence: string): FactProposal {
  return fact(value, isHedged(sentence) ? 'inferred' : 'known', refs);
}

function clip(s: string, max = 160): string {
  const t = s.replace(/[.!?]+$/, '').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** Leading hedges such as "I think" are about certainty, not about who does the work. */
const LEADING_HEDGE = /^\s*(i think|i believe|i guess|i assume|i suppose|i'?m pretty sure|as far as i know|probably|usually|typically|normally|generally|mostly|sometimes|often|maybe|perhaps)[, ]+(that )?/i;

export function extractOwner(raw: string): string | null {
  let sentence = raw;
  while (LEADING_HEDGE.test(sentence)) sentence = sentence.replace(LEADING_HEDGE, '');
  const verb = STEP_VERB.exec(sentence);
  const before = verb ? sentence.slice(0, verb.index) : sentence;
  const amb = AMBIGUOUS_OWNER.exec(before);
  if (amb) return amb[0].trim();
  if (/^\s*(then |so |and |after that,? )?we\b/i.test(before)) return 'we (no specific person)';
  if (/^\s*(then |so |and |after that,? )?i\b/i.test(before)) return 'you (the person describing the process)';
  const role = ROLE.exec(before);
  if (role) return role[0].replace(/^the /i, '').trim();
  const name = /^\s*(?:then |so |and |after that,? )?([A-Z][a-z]+)\b/.exec(before);
  if (name && !NOT_NAMES.has(name[1].toLowerCase()) && verb) return name[1];
  return null;
}

export function extractSystems(text: string): string | null {
  const found = SYSTEMS.filter(([re]) => re.test(text)).map(([, name]) => name);
  return found.length ? [...new Set(found)].join(', ') : null;
}

export class HeuristicInterpreter implements Interpreter {
  readonly name = 'heuristic';

  async interpret({ evidence, question, model }: InterpretInput): Promise<Delta> {
    const delta = emptyDelta();
    const whole: EvidenceRef[] = [{ evidence_id: evidence.id, quote: evidence.text }];
    const ref = (s: string): EvidenceRef[] => [{ evidence_id: evidence.id, quote: s }];
    const sents = sentences(evidence.text);
    const slot = question?.slot ?? null;

    // Confirmation of the step list: "yes" confirms this many steps; anything else may add steps.
    if (question?.intent === 'confirm' && slot === 'sequence') {
      if (YES.test(evidence.text) && !isHedged(evidence.text)) {
        this.propose(delta, 'sequence', fact(`confirmed: ${model.workflow.steps.length} steps`, 'known', whole));
        return delta;
      }
      return this.interpret({ evidence, question: null, model });
    }

    // Confirmation of an inferred fact.
    if (question?.intent === 'confirm' && slot) {
      const current = getFact(model, slot);
      if (current && YES.test(evidence.text) && current.value) {
        this.propose(delta, slot, fact(current.value, isHedged(evidence.text) ? 'inferred' : 'known', [...current.evidence, ...whole]));
      } else if (!isDontKnow(evidence.text)) {
        // "No, it's Dana" / "it varies: ..." : the user's own words replace the inference.
        const value = this.valueFor(slot, evidence.text) ?? (sents.length ? clip(evidence.text) : null);
        if (value && !/^\s*(no|nope)[.!]?\s*$/i.test(evidence.text)) this.propose(delta, slot, stated(value, whole, evidence.text));
      }
      return delta;
    }

    // Targeted question about one workflow fact or one step fact.
    if (slot && slot !== 'sequence') {
      if (isDontKnow(evidence.text)) {
        this.propose(delta, slot, fact(null, 'unknown', whole));
        return delta;
      }
      const field = slot.includes('.') ? slot.split('.')[1] : slot;
      const absent = { completion: COMPLETION_ABSENT, exceptions: EXCEPTION_ABSENT, decisions: DECISIONS_ABSENT, waiting: WAITING_ABSENT }[field];
      const absentSentence = absent ? sents.find((s) => absent.test(s)) : undefined;
      if (absentSentence) {
        this.propose(delta, slot, fact(null, 'absent', ref(absentSentence)));
        return delta;
      }
      const value = this.valueFor(slot, evidence.text);
      if (value) this.propose(delta, slot, stated(value, whole, evidence.text));
      return delta;
    }

    // Open description (problem statement, or "walk me through it"): extract steps and incidental facts.
    for (const s of sents) {
      const r = ref(s);
      if (model.workflow.trigger.status === 'unknown' && !delta.workflow_facts.some((f) => f.field === 'trigger') && TRIGGER.test(s)) {
        delta.workflow_facts.push({ field: 'trigger', fact: stated(clip(s), r, s) });
      }
      this.incidental(delta, 'completion', s, r, COMPLETION_ABSENT, COMPLETION);
      this.incidental(delta, 'exceptions', s, r, EXCEPTION_ABSENT, EXCEPTION);

      // A sentence describing the process failing is an exception, not a step.
      if (!STEP_VERB.test(s) || EXCEPTION.test(s)) continue;
      const owner = extractOwner(s);
      const system = extractSystems(s);
      const step: StepProposal = {
        summary: clip(s),
        evidence: r,
        manual: MANUAL.test(s) ? true : null,
        decision: DECISION.test(s) ? true : null,
      };
      if (owner) step.owner = stated(owner, r, s);
      if (system) step.system = stated(system, r, s);
      if (WAIT.test(s)) step.waiting_on = stated(clip(s), r, s);
      delta.new_steps.push(step);
      if (step.decision && !delta.workflow_facts.some((f) => f.field === 'decisions')) {
        delta.workflow_facts.push({ field: 'decisions', fact: stated(clip(s), r, s) });
      }
      if (step.waiting_on && !delta.workflow_facts.some((f) => f.field === 'waiting')) {
        delta.workflow_facts.push({ field: 'waiting', fact: stated(clip(s), r, s) });
      }
    }
    return delta;
  }

  /** Workflow-level facts mentioned in passing: an explicit "absent" statement, or an explicit description. */
  private incidental(delta: Delta, field: WorkflowFactField, s: string, r: EvidenceRef[], absent: RegExp, present: RegExp): void {
    if (delta.workflow_facts.some((f) => f.field === field)) return;
    if (absent.test(s)) delta.workflow_facts.push({ field, fact: fact(null, 'absent', r) });
    else if (present.test(s)) delta.workflow_facts.push({ field, fact: stated(clip(s), r, s) });
  }

  /** The value a direct answer gives for a slot, or null if the answer does not establish one. */
  private valueFor(slot: string, answer: string): string | null {
    const field = slot.includes('.') ? slot.split('.')[1] : slot;
    const first = sentences(answer)[0] ?? '';
    const short = answer.trim().split(/\s+/).length <= 6;
    if (field === 'owner') {
      // The question already asked "who", so a name leading the answer is enough.
      let stripped = first;
      while (LEADING_HEDGE.test(stripped)) stripped = stripped.replace(LEADING_HEDGE, '');
      const leadName = /^([A-Z][a-z]+)\b/.exec(stripped);
      return extractOwner(first) ?? (ROLE.exec(answer)?.[0].replace(/^the /i, '') ?? null) ??
        (leadName && !NOT_NAMES.has(leadName[1].toLowerCase()) ? leadName[1] : null) ??
        (short ? clip(answer, 60) : null);
    }
    if (field === 'system') return extractSystems(answer) ?? (short ? clip(answer, 60) : null);
    return first ? clip(first) : null;
  }

  private propose(delta: Delta, slot: string, f: FactProposal): void {
    if (slot.includes('.')) {
      const [step_id, field] = slot.split('.');
      delta.step_updates.push({ step_id, field: field as 'owner', fact: f });
    } else {
      delta.workflow_facts.push({ field: slot as WorkflowFactField, fact: f });
    }
  }
}

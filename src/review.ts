import type { Assessor } from './assess.ts';
import type { Discovery, DiscoveryState } from './discovery.ts';
import {
  emptyFact, evidenceNumber, newStep, STEP_FACTS, WORKFLOW_FACTS,
  type Evidence, type EvidenceKind, type Fact, type Model, type Report, type Step,
} from './domain.ts';
import { diagnose } from './friction.ts';
import { getFact } from './merge.ts';
import { isHedged } from './language.ts';
import type { Readiness } from './readiness.ts';
import { ValidationError } from './validate.ts';
import type { Store } from './store.ts';

// Human review. The user is authoritative over what Ilsa interpreted, but nothing is
// overwritten: every action is recorded as evidence of its own kind and produces a new
// revision attributed to the user. Findings are re-derived and the assessment refreshed
// after every material change.
//
//   correction    the user changes something Ilsa had       (evidence kind "correction")
//   confirmation  the user says something Ilsa had is right (evidence kind "confirmation")
//   dispute       the user says a finding is wrong, and why (evidence kind "dispute")
//   context       the user adds information                (evidence kind "context")

export interface ReviewResult {
  action: 'correction' | 'confirmation' | 'dispute' | 'context';
  revision: number | null;
  log: string[];
  assessment: { regenerated: boolean; report: Report | null; readiness: Readiness };
  state: DiscoveryState;
}

const FACT_SLOTS = new Set<string>([...WORKFLOW_FACTS.filter((f) => f !== 'sequence')]);

export class Review {
  private readonly store: Store;
  private readonly discovery: Discovery;
  private readonly assessor: Assessor;

  constructor(store: Store, discovery: Discovery, assessor: Assessor) {
    this.store = store;
    this.discovery = discovery;
    this.assessor = assessor;
  }

  // ---------------------------------------------------------------- corrections

  /** Correct a step's wording. Ilsa's original wording is kept in `summary_was`. */
  editStep(id: string, stepId: string, summary: string): ReviewResult {
    this.step(id, stepId);
    const text = this.text(summary, 'step text');
    return this.apply(id, 'correction', 'correction', text, stepId, (m, ev) => {
      const s = m.workflow.steps.find((x) => x.id === stepId)!;
      if (s.added_by !== 'user' && s.summary_was == null) s.summary_was = s.summary;
      s.summary = text;
      s.evidence = [...s.evidence, ref(ev)];
      return [`${stepId}: text corrected to "${text}"`];
    }, `correction: ${stepId} text`);
  }

  /**
   * Correct a fact: a step's owner/tool/handoff/waiting ("S2.owner"), or a workflow fact
   * ("completion"). `absent: true` records that it does not exist.
   */
  setFact(id: string, slot: string, input: { value?: string; absent?: boolean }): ReviewResult {
    this.factSlot(id, slot);
    const absent = input.absent === true;
    const text = absent ? this.text(input.value || 'This does not exist.', 'note') : this.text(input.value, 'value');
    return this.apply(id, 'correction', 'correction', text, slot, (m, ev) => {
      const current = getFact(m, slot)!;
      const next: Fact = absent
        ? { value: null, status: 'absent', evidence: [ref(ev)] }
        : { value: text, status: isHedged(text) ? 'inferred' : 'known', evidence: [ref(ev)] };
      setFactIn(m, slot, userSet(current, next, absent ? 'marked_absent' : 'corrected'));
      return [`${slot}: corrected to ${absent ? 'absent' : `"${text}"`}${next.status === 'inferred' ? ' (hedged, so inferred)' : ''}`];
    }, `correction: ${slot}`);
  }

  /** Explicitly record that nobody knows this. Counts as understood-and-unknown for readiness. */
  markUnknown(id: string, slot: string, note = 'Nobody knows this.'): ReviewResult {
    this.factSlot(id, slot);
    const text = this.text(note, 'note');
    return this.apply(id, 'correction', 'correction', text, slot, (m, ev) => {
      setFactIn(m, slot, userSet(getFact(m, slot)!, { value: null, status: 'unknown', evidence: [ref(ev)] }, 'marked_unknown'));
      return [`${slot}: marked unknown by the user`];
    }, `correction: ${slot} marked unknown`);
  }

  /** Move a step. Handoff facts depend on which step comes before, so the affected ones are cleared. */
  moveStep(id: string, stepId: string, toIndex: number): ReviewResult {
    const steps = this.store.get(id).model.workflow.steps;
    const from = steps.findIndex((s) => s.id === stepId);
    if (from < 0) throw new ValidationError([`step ${stepId} does not exist`]);
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= steps.length) throw new ValidationError([`position ${toIndex} is out of range`]);
    if (from === toIndex) throw new ValidationError([`${stepId} is already at position ${toIndex + 1}`]);
    const text = `Move ${stepId} to position ${toIndex + 1}.`;
    return this.apply(id, 'correction', 'correction', text, stepId, (m) => {
      const list = m.workflow.steps;
      const affected = new Set([list[from]?.id, list[from + 1]?.id]);
      const [moved] = list.splice(from, 1);
      list.splice(toIndex, 0, moved);
      affected.add(moved.id);
      affected.add(list[toIndex + 1]?.id);
      return [`${stepId}: moved to position ${toIndex + 1}`, ...clearHandoffs(m, affected)];
    }, `correction: ${stepId} moved`);
  }

  /** Add a step Ilsa missed. Owner and tool may be given; each is recorded as its own correction. */
  addStep(id: string, input: { summary: string; position: number; owner?: string; system?: string }): ReviewResult {
    const steps = this.store.get(id).model.workflow.steps;
    const text = this.text(input.summary, 'step text');
    if (!Number.isInteger(input.position) || input.position < 0 || input.position > steps.length) {
      throw new ValidationError([`position ${input.position} is out of range`]);
    }
    const owner = input.owner?.trim() ? this.text(input.owner, 'owner') : null;
    const system = input.system?.trim() ? this.text(input.system, 'tool') : null;
    const stepId = this.store.nextStepId(id);
    const extra: Evidence[] = [];
    if (owner) extra.push(this.store.addEvidence(id, 'correction', owner, null, `${stepId}.owner`));
    if (system) extra.push(this.store.addEvidence(id, 'correction', system, null, `${stepId}.system`));
    return this.apply(id, 'correction', 'correction', text, stepId, (m, ev) => {
      const s: Step = { ...newStep(stepId, text, [ref(ev)]), added_by: 'user' };
      for (const e of extra) {
        const field = e.about!.split('.')[1] as 'owner' | 'system';
        s[field] = { value: e.text, status: isHedged(e.text) ? 'inferred' : 'known', evidence: [ref(e)], by: 'user', was: null, user_action: 'corrected' };
      }
      m.workflow.steps.splice(input.position, 0, s);
      const after = m.workflow.steps[input.position + 1];
      return [`${stepId}: added at position ${input.position + 1}`, ...clearHandoffs(m, new Set([after?.id]))];
    }, `correction: ${stepId} added`);
  }

  // ---------------------------------------------------------------- confirmations

  /** Confirm something Ilsa had as correct. It becomes known and user-endorsed. */
  confirm(id: string, slot: string, note = 'Confirmed.'): ReviewResult {
    const f = this.factSlot(id, slot);
    if (f.status === 'unknown') throw new ValidationError([`${slot} has nothing to confirm; correct it or mark it unknown instead`]);
    const text = this.text(note, 'note');
    return this.apply(id, 'confirmation', 'confirmation', text, slot, (m, ev) => {
      const cur = getFact(m, slot)!;
      setFactIn(m, slot, { ...cur, status: cur.status === 'inferred' ? 'known' : cur.status, evidence: [...cur.evidence, ref(ev)], by: 'user', was: cur.was ?? null, user_action: 'confirmed' });
      return [`${slot}: confirmed by the user`];
    }, `confirmation: ${slot}`);
  }

  /** Confirm the list of steps is complete and in order. */
  confirmSequence(id: string, note = 'That is the complete list, in order.'): ReviewResult {
    const n = this.store.get(id).model.workflow.steps.length;
    if (n < 2) throw new ValidationError(['there must be at least two steps to confirm']);
    const text = this.text(note, 'note');
    return this.apply(id, 'confirmation', 'confirmation', text, 'sequence', (m, ev) => {
      m.workflow.sequence = { value: `confirmed: ${m.workflow.steps.length} steps`, status: 'known', evidence: [ref(ev)], by: 'user', was: null, user_action: 'confirmed' };
      return [`sequence: ${n} steps confirmed by the user`];
    }, 'confirmation: step list');
  }

  /** Mark a finding accurate. A tentative finding accepted by a human becomes actionable. */
  acceptFinding(id: string, findingId: string, note = 'This is accurate.'): ReviewResult {
    this.liveFinding(id, findingId);
    const text = this.text(note, 'note');
    return this.apply(id, 'confirmation', 'confirmation', text, findingId, (m, ev) => {
      const f = m.findings.find((x) => x.id === findingId)!;
      f.status = 'user_accepted';
      f.review = { action: 'accepted', evidence_id: ev.id, at_evidence: evidenceNumber(ev.id) };
      return [`${findingId}: accepted by the user`];
    }, `confirmation: ${findingId} accepted`, false);
  }

  // ---------------------------------------------------------------- disputes

  /** Mark a finding inaccurate. The reason is required. The dispute is sticky. */
  disputeFinding(id: string, findingId: string, reason: string): ReviewResult {
    this.liveFinding(id, findingId);
    const text = this.text(reason, 'reason for the dispute');
    return this.apply(id, 'dispute', 'dispute', text, findingId, (m, ev) => {
      const f = m.findings.find((x) => x.id === findingId)!;
      f.status = 'user_disputed';
      f.review = { action: 'disputed', evidence_id: ev.id, at_evidence: evidenceNumber(ev.id) };
      return [`${findingId}: disputed by the user ("${text}")`];
    }, `dispute: ${findingId}`, false);
  }

  // ---------------------------------------------------------------- answers after assessment

  /** Answering a discovery question is also a material change once an assessment exists. */
  async answer(id: string, questionId: string, text: string): Promise<ReviewResult> {
    const before = this.store.get(id).revision;
    const { state, interpretation } = await this.discovery.answer(id, questionId, text);
    const changed = this.store.get(id).revision !== before;
    return {
      action: 'context',
      revision: changed ? this.store.get(id).revision : null,
      log: [...interpretation.applied, ...interpretation.dropped.map((d) => `dropped ${d}`)],
      assessment: changed ? this.assessor.refresh(id) : { regenerated: false, report: null, readiness: this.assessor.readiness(id) },
      state: changed ? this.discovery.state(id) : state,
    };
  }

  // ---------------------------------------------------------------- context

  /** Add information. Interpreted like any statement; it cannot override the user's own corrections. */
  async addContext(id: string, text: string, about: string | null = null): Promise<ReviewResult> {
    const clean = this.text(text, 'context');
    const before = this.store.get(id).revision;
    const { state, interpretation } = await this.discovery.addContext(id, clean, about);
    const changed = this.store.get(id).revision !== before;
    return {
      action: 'context',
      revision: changed ? this.store.get(id).revision : null,
      log: [...interpretation.applied, ...interpretation.dropped.map((d) => `dropped ${d}`)],
      assessment: changed ? this.assessor.refresh(id) : { regenerated: false, report: null, readiness: this.assessor.readiness(id) },
      state: changed ? this.discovery.state(id) : state,
    };
  }

  // ---------------------------------------------------------------- shared path

  /**
   * Records the evidence, applies the change to a copy of the model, re-derives findings,
   * saves a new revision, then refreshes open questions and the assessment.
   */
  private apply(
    id: string, action: ReviewResult['action'], kind: EvidenceKind, text: string, about: string,
    mutate: (m: Model, ev: Evidence) => string[], reason: string, rediagnoseFirst = true,
  ): ReviewResult {
    const ev = this.store.addEvidence(id, kind, text, null, about);
    const a = this.store.get(id);
    const model = structuredClone(a.model);
    const log = mutate(model, ev);
    // Findings are re-derived from the changed model. For accept/dispute, the decision is
    // applied to the findings first and then carried through re-derivation unchanged.
    const dx = diagnose(model, a.evidence, rediagnoseFirst ? a.model.findings : model.findings, () => this.store.nextFindingId(id));
    model.findings = dx.findings;
    const changed = JSON.stringify(model) !== JSON.stringify(a.model);
    const revision = changed ? this.store.saveModel(id, model, reason, 'user', [...log, ...dx.log.map((l) => `finding ${l}`)]) : null;
    this.discovery.refreshQuestions(id);
    return {
      action,
      revision,
      log: [...log, ...dx.log],
      assessment: changed ? this.assessor.refresh(id) : { regenerated: false, report: null, readiness: this.assessor.readiness(id) },
      state: this.discovery.state(id),
    };
  }

  private text(v: unknown, what: string): string {
    if (typeof v !== 'string' || !v.trim()) throw new ValidationError([`${what} is required`]);
    return v.trim();
  }

  private step(id: string, stepId: string): Step {
    const s = this.store.get(id).model.workflow.steps.find((x) => x.id === stepId);
    if (!s) throw new ValidationError([`step ${stepId} does not exist`]);
    return s;
  }

  private factSlot(id: string, slot: string): Fact {
    const [a, b] = slot.split('.');
    const ok = b === undefined ? FACT_SLOTS.has(a) : (STEP_FACTS as readonly string[]).includes(b);
    const f = ok ? getFact(this.store.get(id).model, slot) : null;
    if (!f) throw new ValidationError([`"${slot}" is not a field that can be reviewed`]);
    return f;
  }

  private liveFinding(id: string, findingId: string): void {
    const f = this.store.get(id).model.findings.find((x) => x.id === findingId);
    if (!f) throw new ValidationError([`finding ${findingId} does not exist`]);
    if (!['confirmed', 'tentative', 'user_accepted'].includes(f.status)) {
      throw new ValidationError([`finding ${findingId} is ${f.status} and cannot be reviewed`]);
    }
  }
}

function ref(ev: Evidence) {
  return { evidence_id: ev.id, quote: ev.text };
}

/** Marks a fact as set by the user, keeping what Ilsa originally had. */
function userSet(current: Fact, next: Fact, action: Fact['user_action']): Fact {
  const was = current.by === 'user' ? current.was ?? null : { value: current.value, status: current.status };
  return { ...next, by: 'user', was, user_action: action };
}

function setFactIn(m: Model, slot: string, f: Fact): void {
  const [a, b] = slot.split('.');
  if (b === undefined) (m.workflow as unknown as Record<string, Fact>)[a] = f;
  else (m.workflow.steps.find((s) => s.id === a) as unknown as Record<string, Fact>)[b] = f;
}

/** Handoff facts describe how work arrives from the previous step; a new neighbor invalidates them. */
function clearHandoffs(m: Model, ids: Set<string | undefined>): string[] {
  const out: string[] = [];
  for (const s of m.workflow.steps) {
    if (!ids.has(s.id) || s.handoff_in.status === 'unknown' && s.handoff_in.evidence.length === 0) continue;
    s.handoff_in = emptyFact();
    out.push(`${s.id}.handoff_in: cleared because the step before it changed`);
  }
  return out;
}

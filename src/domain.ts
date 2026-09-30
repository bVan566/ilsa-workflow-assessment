// The Ilsa data model. Plain data and closed vocabularies; no AI here.
//
// Core idea: everything Ilsa claims about a business must point back to something
// the user actually said. The user's words are stored as append-only EVIDENCE.
// Workflow facts and friction findings carry EVIDENCE REFERENCES (evidence id +
// an exact quote), which deterministic code checks before anything is accepted.

/** The discovery dimensions: what Ilsa needs to know before it may diagnose or recommend. */
export const DIMENSIONS = [
  'trigger',      // what starts the process
  'steps',        // what actually happens, in order
  'ownership',    // who is responsible at each step
  'systems',      // software, spreadsheets, email, paper
  'handoffs',     // where responsibility moves between people or systems
  'decisions',    // where someone makes a judgment
  'waiting',      // dependencies on people, approvals, external events
  'exceptions',   // what happens when the normal path fails
  'completion',   // how the organization knows the work is finished
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Friction taxonomy. Findings must use one of these; free-form "AI commentary" is not a finding. */
export const FRICTION_CATEGORIES = {
  unclear_ownership: 'No clear owner for a step, or ownership is "whoever gets to it"',
  manual_reentry: 'The same information is typed into another system by hand',
  duplicate_work: 'The same work is done more than once',
  unnecessary_handoff: 'Work changes hands without adding value',
  waiting_dependency: 'Progress stalls waiting on a person, approval or external event',
  missing_terminal_condition: 'No clear point at which the work is recorded as finished',
  manual_status_checking: 'People must ask or look around to learn the status',
  inconsistent_decision: 'The same decision is made differently depending on who makes it',
  information_loss: 'Details are dropped between steps or systems',
  unstructured_intake: 'Work arrives in free-form channels with no standard capture',
  bottleneck: 'One step or person limits the throughput of the whole process',
  single_point_of_failure: 'The process stops if one person or system is unavailable',
  repeated_customer_followup: 'Customers have to chase the business for progress',
  missing_exception_handling: 'No defined path when the normal process fails',
  system_mismatch: 'The tools in use do not fit the work being done',
  tool_switching: 'People move between several tools to complete one step',
} as const;
export type FrictionCategory = keyof typeof FRICTION_CATEGORIES;

// ---------------------------------------------------------------- evidence

export type EvidenceKind = 'problem_statement' | 'answer' | 'correction' | 'context';

/** Something the user said. Append-only: evidence is never edited or deleted. */
export interface Evidence {
  id: string;               // E1, E2, ... assigned by code
  kind: EvidenceKind;
  question_id: string | null;
  text: string;
  created_at: string;
}

/** A pointer into the evidence: which statement, and the exact words relied on. */
export interface EvidenceRef {
  evidence_id: string;
  quote: string;
}

// ---------------------------------------------------------------- workflow model

/**
 * How certain Ilsa is about a single fact. Four states, never collapsed into each other:
 *
 *   known     the user stated it plainly
 *   inferred  the user said it with a hedge ("usually", "I think", "probably"), or it was
 *             read from indirect wording. Held as unconfirmed until the user confirms it.
 *   absent    the user said it does not exist ("nobody closes them out"). That is
 *             knowledge, not a gap, and is often evidence of friction.
 *   unknown   not established. With no evidence: not asked yet. With evidence: asked,
 *             and the answer did not establish it ("I'm not sure"). Never filled by assumption.
 */
export type Certainty = 'known' | 'inferred' | 'absent' | 'unknown';
export const CERTAINTIES: readonly Certainty[] = ['known', 'inferred', 'absent', 'unknown'];

export interface Fact {
  value: string | null;
  status: Certainty;
  evidence: EvidenceRef[];
}

export interface Step {
  id: string;               // S1, S2, ... assigned by code, never reused
  summary: string;
  owner: Fact;              // who is responsible
  system: Fact;             // tool or channel used
  handoff_in: Fact;         // how the work reaches this step from the previous one
  waiting_on: Fact;         // what this step waits for, if anything
  manual: boolean | null;   // done by hand (copying, typing, checking); null = not established
  decision: boolean | null; // involves a judgment call; null = not established
  evidence: EvidenceRef[];  // what the user said that established this step exists
}

export const STEP_FACTS = ['owner', 'system', 'handoff_in', 'waiting_on'] as const;
export type StepFactField = (typeof STEP_FACTS)[number];

export const WORKFLOW_FACTS = ['sequence', 'trigger', 'completion', 'exceptions', 'decisions', 'waiting'] as const;
export type WorkflowFactField = (typeof WORKFLOW_FACTS)[number];

export interface Workflow {
  name: string;
  sequence: Fact;           // whether the user has confirmed the list of steps is complete and in order
  trigger: Fact;
  completion: Fact;
  exceptions: Fact;
  decisions: Fact;          // where judgment calls happen, at the workflow level
  waiting: Fact;            // where the process waits on others, at the workflow level
  steps: Step[];            // in process order
}

// ---------------------------------------------------------------- findings

export type FindingSource = 'rule' | 'model';

/**
 * confirmed      passed validation, supported by facts the user stated plainly
 * tentative      passed validation, but rests on inferred facts or a structural pattern;
 *                shown as "needs confirmation", never as an established problem
 * rejected       failed validation (kept for audit, never shown as a finding)
 * user_accepted  a human reviewer marked it accurate
 * user_disputed  a human reviewer marked it inaccurate (excluded from the assessment)
 */
export type FindingStatus = 'confirmed' | 'tentative' | 'rejected' | 'user_accepted' | 'user_disputed';
export const FINDING_STATUSES: readonly FindingStatus[] = ['confirmed', 'tentative', 'rejected', 'user_accepted', 'user_disputed'];

export interface Finding {
  id: string;               // F1, F2, ...
  signature: string;        // category + where; keeps the id and review status stable across re-detection
  category: FrictionCategory;
  step_ids: string[];
  evidence: EvidenceRef[];
  rationale: string;        // why this creates cost, delay or risk
  support: string;          // which facts in the model support it
  source: FindingSource;
  status: FindingStatus;
  rejection_reason: string | null;
}

// ---------------------------------------------------------------- assessment

export type AssessmentStatus = 'discovery' | 'review' | 'assessed';

export interface Question {
  id: string;               // Q1, Q2, ...
  dimension: Dimension;
  slot: string;             // the exact model field it targets, e.g. "trigger" or "S2.owner"
  intent: 'discover' | 'confirm';
  text: string;
  step_id: string | null;   // when the question is about one step
  status: 'open' | 'answered' | 'skipped';
  answer_evidence_id: string | null;
  created_at: string;
}

/** The versioned part of an assessment: every change produces a new revision. */
export interface Model {
  workflow: Workflow;
  findings: Finding[];
}

export interface Assessment {
  id: string;
  name: string;
  problem_statement: string;
  status: AssessmentStatus;
  revision: number;
  model: Model;
  evidence: Evidence[];
  questions: Question[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- report (the assessment output)

export const INTERVENTIONS = ['process_change', 'existing_tool_change', 'simple_automation', 'ai_assisted'] as const;
export type Intervention = (typeof INTERVENTIONS)[number];

/**
 * act          supported by at least one confirmed (or human-accepted) finding
 * investigate  supported only by tentative findings: "confirm this first", never a fix to go and build
 */
export type RecommendationKind = 'act' | 'investigate';

export interface Recommendation {
  id: string;                 // R1, R2, ...
  finding_ids: string[];      // must be non-empty: no orphan recommendations
  kind: RecommendationKind;
  intervention: Intervention; // for "investigate", the kind of fix it would likely lead to
  title: string;
  detail: string;
  ai_reason: string | null;   // required for ai_assisted: why interpretation, generation or ambiguity needs AI
  why_not_ai: string | null;  // for other types: why ordinary process or software is enough
}

export interface FactView {
  value: string | null;
  certainty: Certainty;
  evidence_ids: string[];
}

export interface CurrentState {
  trigger: FactView;
  steps: {
    id: string; summary: string; owner: FactView; system: FactView; handoff_in: FactView; waiting_on: FactView;
    manual: boolean | null; decision: boolean | null; evidence_ids: string[];
  }[];
  completion: FactView;
  exceptions: FactView;
  decisions: FactView;
  waiting: FactView;
}

export interface ReportFinding {
  id: string;
  category: FrictionCategory;
  step_ids: string[];
  status: FindingStatus;
  rationale: string;
  support: string;
  evidence: EvidenceRef[];
}

/** The assessment. Four separate sections; diagnosis is never mixed with recommendation. */
export interface Report {
  assessment_id: string;
  based_on_revision: number;
  generated_at: string;
  current_state: CurrentState;
  observed_friction: { confirmed: ReportFinding[]; needs_confirmation: ReportFinding[] };
  unknowns: { dimension: Dimension; slot: string; kind: string; description: string }[];
  recommendations: Recommendation[];
}

export function emptyFact(): Fact {
  return { value: null, status: 'unknown', evidence: [] };
}

export function emptyWorkflow(name: string): Workflow {
  return {
    name, sequence: emptyFact(), trigger: emptyFact(), completion: emptyFact(), exceptions: emptyFact(),
    decisions: emptyFact(), waiting: emptyFact(), steps: [],
  };
}

export function newStep(id: string, summary: string, evidence: EvidenceRef[]): Step {
  return {
    id, summary, evidence, manual: null, decision: null,
    owner: emptyFact(), system: emptyFact(), handoff_in: emptyFact(), waiting_on: emptyFact(),
  };
}

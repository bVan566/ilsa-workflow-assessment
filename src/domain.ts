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
 * A single fact about the workflow. `unknown` means "not established yet";
 * `absent` means the user told us it does not exist (e.g. "nobody closes them out"),
 * which is itself useful evidence.
 */
export interface Fact {
  value: string | null;
  status: 'known' | 'unknown' | 'absent';
  evidence: EvidenceRef[];
}

export interface Step {
  id: string;               // S1, S2, ... assigned by code, never reused
  summary: string;
  owner: string | null;     // null = not established
  system: string | null;    // tool or channel used, null = not established
  manual: boolean;          // done by hand (copying, typing, checking)
  decision: boolean;        // involves a judgment call
  waiting_on: string | null;
  evidence: EvidenceRef[];
}

export interface Workflow {
  name: string;
  trigger: Fact;
  completion: Fact;
  exceptions: Fact;
  steps: Step[];            // in process order
}

// ---------------------------------------------------------------- findings

export type FindingSource = 'rule' | 'model';

/**
 * confirmed      passed evidence validation
 * rejected       failed validation (kept for audit, never shown as a finding)
 * user_accepted  a human reviewer marked it accurate
 * user_disputed  a human reviewer marked it inaccurate (excluded from the assessment)
 */
export type FindingStatus = 'confirmed' | 'rejected' | 'user_accepted' | 'user_disputed';

export interface Finding {
  id: string;               // F1, F2, ...
  category: FrictionCategory;
  step_ids: string[];
  evidence: EvidenceRef[];
  rationale: string;        // why this creates cost, delay or risk
  source: FindingSource;
  status: FindingStatus;
  rejection_reason: string | null;
}

// ---------------------------------------------------------------- assessment

export type AssessmentStatus = 'discovery' | 'review' | 'assessed';

export interface Question {
  id: string;               // Q1, Q2, ...
  dimension: Dimension;
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

export function emptyFact(): Fact {
  return { value: null, status: 'unknown', evidence: [] };
}

export function emptyWorkflow(name: string): Workflow {
  return { name, trigger: emptyFact(), completion: emptyFact(), exceptions: emptyFact(), steps: [] };
}

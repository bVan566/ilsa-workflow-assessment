import type {
  Certainty, Evidence, EvidenceRef, Model, Question, StepFactField, WorkflowFactField,
} from '../domain.ts';

// The contract between an interpreter (the part that reads the user's words) and the
// deterministic code that owns the model. An interpreter only PROPOSES changes;
// merge.ts decides what is applied.

export interface FactProposal {
  value: string | null;
  status: Certainty;
  evidence: EvidenceRef[];
}

export interface StepProposal {
  summary: string;
  evidence: EvidenceRef[];
  owner?: FactProposal;
  system?: FactProposal;
  handoff_in?: FactProposal;
  waiting_on?: FactProposal;
  manual?: boolean | null;
  decision?: boolean | null;
}

export interface Delta {
  new_steps: StepProposal[];
  step_updates: { step_id: string; field: StepFactField; fact: FactProposal }[];
  workflow_facts: { field: WorkflowFactField; fact: FactProposal }[];
}

export interface InterpretInput {
  evidence: Evidence;         // the statement being interpreted
  question: Question | null;  // the question it answers, if any
  model: Model;               // current model, for context
}

export interface Interpreter {
  readonly name: string;
  interpret(input: InterpretInput): Promise<Delta>;
}

export function emptyDelta(): Delta {
  return { new_steps: [], step_updates: [], workflow_facts: [] };
}

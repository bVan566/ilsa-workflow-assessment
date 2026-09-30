import {
  CERTAINTIES, FRICTION_CATEGORIES, STEP_FACTS, WORKFLOW_FACTS,
  type Evidence, type EvidenceRef, type Fact, type Model,
} from './domain.ts';
import { isHedged } from './language.ts';

// Deterministic schema and evidence validation. Nothing enters the stored model
// unless it passes these checks, whether a person, a rule or a language model produced it.

/** Minimum quote length, so a fragment like "the" or "yes" cannot be lifted out of a longer statement. */
export const MIN_QUOTE_CHARS = 8;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns null if the reference is valid, otherwise the reason it is not. */
export function checkEvidenceRef(ref: EvidenceRef, evidence: Evidence[]): string | null {
  if (!ref || typeof ref.evidence_id !== 'string' || typeof ref.quote !== 'string') return 'malformed evidence reference';
  const source = evidence.find((e) => e.id === ref.evidence_id);
  if (!source) return `evidence ${ref.evidence_id} does not exist`;
  const quote = normalize(ref.quote);
  const whole = normalize(source.text);
  if (quote.length === 0) return 'quote is empty';
  // A short quote is allowed only when it is the user's entire statement (e.g. "Yes."),
  // so fragments cannot be cherry-picked out of longer answers.
  if (quote.length < MIN_QUOTE_CHARS && quote !== whole) return `quote "${ref.quote}" is too short to count as evidence`;
  if (!whole.includes(quote)) return `quote "${ref.quote}" does not appear in ${ref.evidence_id}`;
  return null;
}

export class ValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`model failed validation: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim().length > 0;

function checkRefs(path: string, refs: unknown, evidence: Evidence[], errors: string[], required: boolean): void {
  if (!Array.isArray(refs)) {
    errors.push(`${path}.evidence must be an array`);
    return;
  }
  if (required && refs.length === 0) errors.push(`${path} has no evidence`);
  refs.forEach((ref, i) => {
    const problem = checkEvidenceRef(ref as EvidenceRef, evidence);
    if (problem) errors.push(`${path}.evidence[${i}]: ${problem}`);
  });
}

export function checkFact(path: string, fact: Fact, evidence: Evidence[], errors: string[]): void {
  if (!fact || !CERTAINTIES.includes(fact.status)) {
    errors.push(`${path}.status must be one of ${CERTAINTIES.join(', ')}`);
    return;
  }
  if ((fact.status === 'known' || fact.status === 'inferred') && !nonEmpty(fact.value)) {
    errors.push(`${path} is ${fact.status} but has no value`);
  }
  if ((fact.status === 'unknown' || fact.status === 'absent') && fact.value !== null) {
    errors.push(`${path} is ${fact.status} but has a value`);
  }
  // known, inferred and absent are all claims about the business, so all need evidence.
  checkRefs(path, fact.evidence, evidence, errors, fact.status !== 'unknown');
  // "Known" means stated plainly. If every quote behind it is hedged, it is only inferred.
  if (fact.status === 'known' && Array.isArray(fact.evidence) && fact.evidence.length > 0 &&
      fact.evidence.every((r) => isHedged(r?.quote ?? ''))) {
    errors.push(`${path} is marked known but all its evidence is hedged; it can only be inferred`);
  }
}

/** Validates the whole versioned model against the assessment's evidence. Returns all errors found. */
export function validateModel(model: Model, evidence: Evidence[]): string[] {
  const errors: string[] = [];
  const wf = model?.workflow;
  if (!wf) return ['model.workflow is missing'];

  if (!nonEmpty(wf.name)) errors.push('workflow.name is required');
  for (const field of WORKFLOW_FACTS) checkFact(`workflow.${field}`, wf[field], evidence, errors);

  const stepIds = new Set<string>();
  if (!Array.isArray(wf.steps)) errors.push('workflow.steps must be an array');
  for (const [i, s] of (wf.steps ?? []).entries()) {
    const p = `steps[${i}]`;
    if (!isStr(s.id) || !/^S\d+$/.test(s.id)) errors.push(`${p}.id must look like S1, S2...`);
    else if (stepIds.has(s.id)) errors.push(`${p}.id ${s.id} is duplicated`);
    else stepIds.add(s.id);
    if (!nonEmpty(s.summary)) errors.push(`${p}.summary is required`);
    for (const field of STEP_FACTS) checkFact(`${p}.${field}`, s[field], evidence, errors);
    if (s.manual !== null && typeof s.manual !== 'boolean') errors.push(`${p}.manual must be true, false or null`);
    if (s.decision !== null && typeof s.decision !== 'boolean') errors.push(`${p}.decision must be true, false or null`);
    checkRefs(p, s.evidence, evidence, errors, true);
  }

  const findingIds = new Set<string>();
  if (!Array.isArray(model.findings)) errors.push('findings must be an array');
  for (const [i, f] of (model.findings ?? []).entries()) {
    const p = `findings[${i}]`;
    if (!isStr(f.id) || !/^F\d+$/.test(f.id)) errors.push(`${p}.id must look like F1, F2...`);
    else if (findingIds.has(f.id)) errors.push(`${p}.id ${f.id} is duplicated`);
    else findingIds.add(f.id);
    if (!(f.category in FRICTION_CATEGORIES)) errors.push(`${p}.category "${f.category}" is not in the friction taxonomy`);
    if (!['rule', 'model'].includes(f.source)) errors.push(`${p}.source must be rule or model`);
    if (!['confirmed', 'rejected', 'user_accepted', 'user_disputed'].includes(f.status)) errors.push(`${p}.status is invalid`);
    if (!Array.isArray(f.step_ids)) errors.push(`${p}.step_ids must be an array`);
    // Rejected findings are kept for audit; the rest must be fully grounded.
    if (f.status === 'rejected') {
      if (!nonEmpty(f.rejection_reason)) errors.push(`${p} is rejected but has no rejection_reason`);
      continue;
    }
    for (const id of f.step_ids ?? []) if (!stepIds.has(id)) errors.push(`${p} refers to unknown step ${id}`);
    if (!nonEmpty(f.rationale)) errors.push(`${p}.rationale is required`);
    checkRefs(p, f.evidence, evidence, errors, true);
  }
  return errors;
}

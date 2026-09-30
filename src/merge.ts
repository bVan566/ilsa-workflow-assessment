import {
  emptyFact, newStep, STEP_FACTS, WORKFLOW_FACTS,
  type Certainty, type Evidence, type EvidenceRef, type Fact, type Model, type Question, type Step,
} from './domain.ts';
import type { Delta, FactProposal } from './interpret/types.ts';
import { isHedged } from './language.ts';
import { checkEvidenceRef } from './validate.ts';

// Applies an interpreter's proposals to the model under fixed, deterministic rules:
//
//  1. A proposal whose evidence does not check out is dropped (and reported).
//  2. "Known" backed only by hedged wording is downgraded to "inferred".
//  3. A proposal never silently weakens an established fact. Only a direct answer to a
//     question about that exact slot may change or downgrade it.
//  4. Nothing is filled without evidence. A targeted question the answer did not resolve
//     is recorded as "asked, unresolved" (unknown + the answer as evidence), never guessed.

export interface MergeResult {
  model: Model;
  applied: string[];
  dropped: string[];
}

/** Strength of a certainty state. "Absent" is as strong as "known": both are statements by the user. */
function rank(f: Fact): number {
  if (f.status === 'known' || f.status === 'absent') return 3;
  if (f.status === 'inferred') return 2;
  return f.evidence.length > 0 ? 1 : 0; // unknown: asked-unresolved outranks never-asked
}

export function getFact(model: Model, slot: string): Fact | null {
  const [a, b] = slot.split('.');
  if (b === undefined) return (WORKFLOW_FACTS as readonly string[]).includes(a) ? model.workflow[a as keyof typeof model.workflow] as Fact : null;
  const step = model.workflow.steps.find((s) => s.id === a);
  return step && (STEP_FACTS as readonly string[]).includes(b) ? step[b as keyof Step] as Fact : null;
}

function setFact(model: Model, slot: string, fact: Fact): void {
  const [a, b] = slot.split('.');
  if (b === undefined) (model.workflow as unknown as Record<string, Fact>)[a] = fact;
  else (model.workflow.steps.find((s) => s.id === a) as unknown as Record<string, Fact>)[b] = fact;
}

/** Checks a proposal's evidence and normalizes it. Returns the fact, or the reason it was rejected. */
function vet(p: FactProposal, evidence: Evidence[]): Fact | string {
  const status: Certainty = p.status;
  if (!['known', 'inferred', 'absent', 'unknown'].includes(status)) return `invalid status "${status}"`;
  const refs: EvidenceRef[] = Array.isArray(p.evidence) ? p.evidence : [];
  for (const r of refs) {
    const problem = checkEvidenceRef(r, evidence);
    if (problem) return problem;
  }
  if (status !== 'unknown' && refs.length === 0) return `a ${status} fact needs evidence`;
  if ((status === 'known' || status === 'inferred') && !(typeof p.value === 'string' && p.value.trim())) return `a ${status} fact needs a value`;
  const hedgedOnly = refs.length > 0 && refs.every((r) => isHedged(r.quote));
  // The opening problem statement is a complaint about symptoms, not a description of the
  // process. Anything read only from it stays unconfirmed until the user confirms it.
  const complaintOnly = refs.length > 0 && refs.every((r) => evidence.find((e) => e.id === r.evidence_id)?.kind === 'problem_statement');
  return {
    value: status === 'known' || status === 'inferred' ? (p.value as string).trim() : null,
    status: status === 'known' && (hedgedOnly || complaintOnly) ? 'inferred' : status,
    evidence: refs,
  };
}

function mergeFact(model: Model, slot: string, p: FactProposal, evidence: Evidence[], targeted: boolean, out: MergeResult): void {
  const current = getFact(model, slot);
  if (!current) {
    out.dropped.push(`${slot}: no such field`);
    return;
  }
  if (current.by === 'user') {
    out.dropped.push(`${slot}: set by the user during review; the interpreter cannot change it`);
    return;
  }
  const next = vet(p, evidence);
  if (typeof next === 'string') {
    out.dropped.push(`${slot}: ${next}`);
    return;
  }
  if (next.status !== p.status) out.applied.push(`${slot}: downgraded known -> inferred (hedged wording or problem statement only)`);
  if (rank(next) < rank(current) && !targeted) {
    out.dropped.push(`${slot}: proposal (${next.status}) would weaken an established ${current.status} fact`);
    return;
  }
  // Same value, stronger or equal certainty: keep the older evidence too (e.g. a confirmation).
  const sameValue = next.value !== null && current.value !== null && next.value.toLowerCase() === current.value.toLowerCase();
  const nothingNew = next.status === current.status && (sameValue || (next.value === null && current.value === null)) &&
    next.evidence.every((r) => current.evidence.some((c) => c.evidence_id === r.evidence_id && c.quote === r.quote));
  if (nothingNew) return;
  const merged: Fact = sameValue ? { ...next, evidence: dedupeRefs([...current.evidence, ...next.evidence]) } : next;
  if (current.status !== 'unknown' && !sameValue && current.value !== next.value) {
    out.applied.push(`${slot}: changed from ${describe(current)} to ${describe(merged)}`);
  } else {
    out.applied.push(`${slot}: ${describe(merged)}`);
  }
  setFact(model, slot, merged);
}

function describe(f: Fact): string {
  return f.value === null ? f.status : `${f.status} "${f.value}"`;
}

function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.evidence_id}|${r.quote.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Applies a delta to a copy of the model. `nextStepId` hands out code-assigned ids.
 * `source` is the statement being interpreted, used to record "asked, unresolved".
 */
export function applyDelta(
  model: Model, delta: Delta, evidence: Evidence[], question: Question | null, source: Evidence, nextStepId: () => string,
): MergeResult {
  const out: MergeResult = { model: structuredClone(model), applied: [], dropped: [] };
  const target = question?.slot ?? null;

  for (const wf of delta.workflow_facts ?? []) {
    mergeFact(out.model, wf.field, wf.fact, evidence, target === wf.field, out);
  }
  for (const up of delta.step_updates ?? []) {
    mergeFact(out.model, `${up.step_id}.${up.field}`, up.fact, evidence, target === `${up.step_id}.${up.field}`, out);
  }

  const existing = new Set(out.model.workflow.steps.map((s) => s.summary.toLowerCase()));
  for (const sp of delta.new_steps ?? []) {
    if (typeof sp.summary !== 'string' || !sp.summary.trim()) {
      out.dropped.push('new step: summary is required');
      continue;
    }
    const problem = (sp.evidence ?? []).map((r) => checkEvidenceRef(r, evidence)).find(Boolean) ??
      ((sp.evidence ?? []).length === 0 ? 'a step needs evidence' : null);
    if (problem) {
      out.dropped.push(`new step "${sp.summary}": ${problem}`);
      continue;
    }
    if (existing.has(sp.summary.trim().toLowerCase())) {
      out.dropped.push(`new step "${sp.summary}": already in the model`);
      continue;
    }
    // Fix 1 (post-review): the opening complaint describes symptoms, not the process.
    // A step supported only by the problem statement is not a step.
    if (sp.evidence.every((r) => evidence.find((e) => e.id === r.evidence_id)?.kind === 'problem_statement')) {
      out.dropped.push(`new step "${sp.summary}": comes only from the problem statement, which describes symptoms, not steps`);
      continue;
    }
    // A restatement of an existing step ("…, like I said") is the same step: its details are
    // proposed as updates to that step instead of creating a duplicate.
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const same = out.model.workflow.steps.find((s) => {
      const a = norm(s.summary);
      const b = norm(sp.summary);
      return a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a));
    });
    if (same) {
      out.applied.push(`"${sp.summary}" restates ${same.id}; treated as the same step`);
      for (const field of STEP_FACTS) {
        const p = sp[field];
        if (p) mergeFact(out.model, `${same.id}.${field}`, p, evidence, false, out);
      }
      continue;
    }
    const step = newStep(nextStepId(), sp.summary.trim(), sp.evidence);
    step.manual = typeof sp.manual === 'boolean' ? sp.manual : null;
    step.decision = typeof sp.decision === 'boolean' ? sp.decision : null;
    out.model.workflow.steps.push(step);
    existing.add(step.summary.toLowerCase());
    out.applied.push(`${step.id}: new step "${step.summary}"`);
    for (const field of STEP_FACTS) {
      const p = sp[field];
      if (p) mergeFact(out.model, `${step.id}.${field}`, p, evidence, false, out);
    }
  }

  // Rule 4: a targeted question whose answer established nothing is "asked, unresolved".
  if (target) {
    const fact = getFact(out.model, target);
    if (fact && fact.status === 'unknown' && fact.evidence.length === 0) {
      setFact(out.model, target, { ...emptyFact(), evidence: [{ evidence_id: source.id, quote: source.text }] });
      out.applied.push(`${target}: asked, unresolved (${source.id})`);
    }
  }
  return out;
}

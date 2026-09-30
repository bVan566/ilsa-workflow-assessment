import {
  INTERVENTIONS,
  type Fact, type FactView, type Finding, type Model, type Report, type ReportFinding,
} from './domain.ts';
import type { Readiness } from './readiness.ts';
import { buildRecommendations } from './recommend.ts';

// Builds the assessment from a model that has passed the readiness gate, and validates
// any report (built here or, later, drafted by a model) against the rules:
//   - four separate sections
//   - confirmed friction contains only confirmed / human-accepted findings;
//     "needs confirmation" contains only tentative ones
//   - every recommendation traces to at least one live, validated finding (no orphans)
//   - a recommendation backed only by tentative findings can only be "investigate"
//   - AI-assisted recommendations must state why AI is needed; others must not claim one

const view = (f: Fact): FactView => ({ value: f.value, certainty: f.status, evidence_ids: [...new Set(f.evidence.map((r) => r.evidence_id))] });

const toReportFinding = (f: Finding): ReportFinding => ({
  id: f.id, category: f.category, step_ids: f.step_ids, status: f.status, rationale: f.rationale, support: f.support, evidence: f.evidence,
});

export function buildReport(assessmentId: string, revision: number, model: Model, gate: Readiness, now: string): Report {
  if (!gate.ready) throw new Error('buildReport called on a model that is not ready');
  const wf = model.workflow;
  const live = model.findings.filter((f) => f.status !== 'rejected' && f.status !== 'user_disputed');
  return {
    assessment_id: assessmentId,
    based_on_revision: revision,
    generated_at: now,
    current_state: {
      trigger: view(wf.trigger),
      steps: wf.steps.map((s) => ({
        id: s.id, summary: s.summary, owner: view(s.owner), system: view(s.system), handoff_in: view(s.handoff_in),
        waiting_on: view(s.waiting_on), manual: s.manual, decision: s.decision, evidence_ids: [...new Set(s.evidence.map((r) => r.evidence_id))],
      })),
      completion: view(wf.completion),
      exceptions: view(wf.exceptions),
      decisions: view(wf.decisions),
      waiting: view(wf.waiting),
    },
    observed_friction: {
      confirmed: live.filter((f) => f.status === 'confirmed' || f.status === 'user_accepted').map(toReportFinding),
      needs_confirmation: live.filter((f) => f.status === 'tentative').map(toReportFinding),
    },
    unknowns: gate.unknowns.map((u) => ({ ...u })),
    recommendations: buildRecommendations(model, live),
  };
}

/** Returns every rule the report breaks. An empty list means the report may be saved. */
export function validateReport(report: Report, model: Model, revision: number): string[] {
  const errors: string[] = [];
  if (!report || typeof report !== 'object') return ['report is missing'];
  for (const section of ['current_state', 'observed_friction', 'unknowns', 'recommendations'] as const) {
    if (!(section in report)) errors.push(`section "${section}" is missing`);
  }
  if (errors.length) return errors;
  if (report.based_on_revision !== revision) errors.push(`report is based on revision ${report.based_on_revision}, model is at ${revision}`);

  const findings = new Map(model.findings.map((f) => [f.id, f]));
  for (const f of report.observed_friction.confirmed) {
    const actual = findings.get(f.id)?.status;
    if (actual !== 'confirmed' && actual !== 'user_accepted') errors.push(`${f.id} is listed as confirmed friction but its status is ${actual ?? 'missing'}`);
  }
  for (const f of report.observed_friction.needs_confirmation) {
    if (findings.get(f.id)?.status !== 'tentative') errors.push(`${f.id} is listed as needing confirmation but is not tentative`);
  }

  const ids = new Set<string>();
  for (const r of report.recommendations) {
    const p = `recommendation ${r.id}`;
    if (ids.has(r.id)) errors.push(`${p} id is duplicated`);
    ids.add(r.id);
    if (!Array.isArray(r.finding_ids) || r.finding_ids.length === 0) {
      errors.push(`${p} does not trace to any finding (orphan)`);
      continue;
    }
    const backing = r.finding_ids.map((id) => findings.get(id));
    const bad = r.finding_ids.filter((id, i) => !backing[i] || ['rejected', 'user_disputed'].includes(backing[i]!.status));
    if (bad.length) errors.push(`${p} cites findings that are missing, rejected or disputed: ${bad.join(', ')}`);
    const strong = backing.some((f) => f && (f.status === 'confirmed' || f.status === 'user_accepted'));
    if (r.kind === 'act' && !strong) errors.push(`${p} recommends action but is backed only by tentative findings; it can only be "investigate"`);
    if (r.kind === 'act' && backing.some((f) => f?.status === 'tentative')) {
      errors.push(`${p} recommends action but also cites tentative findings; tentative findings may only back "investigate"`);
    }
    if (!['act', 'investigate'].includes(r.kind)) errors.push(`${p} kind "${r.kind}" is invalid`);
    if (!INTERVENTIONS.includes(r.intervention)) errors.push(`${p} intervention "${r.intervention}" is invalid`);
    if (r.intervention === 'ai_assisted' && !(typeof r.ai_reason === 'string' && r.ai_reason.trim().length >= 30)) {
      errors.push(`${p} is AI-assisted but does not explain why interpretation, generation or ambiguity requires AI`);
    }
    if (r.intervention !== 'ai_assisted' && r.ai_reason !== null) errors.push(`${p} is not AI-assisted but carries an AI reason`);
    if (!(typeof r.title === 'string' && r.title.trim())) errors.push(`${p} has no title`);
  }
  return errors;
}

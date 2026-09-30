// Evaluation of the no-key interpreter and the deterministic control path.
//   node eval/run.ts        (or: npm run eval)
// Reads eval/cases.json, writes eval/results/run2-post-review.md and .json.
// Run 1 (the original held-out result, before the post-review fixes) is kept in
// eval/results/run1-heldout.md; reproduce it with: git checkout 347540c && npm run eval
// No network. Claude is not evaluated.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Assessor } from '../src/assess.ts';
import { Discovery } from '../src/discovery.ts';
import type { Dimension, Finding, Model, Question } from '../src/domain.ts';
import { vetFinding } from '../src/friction.ts';
import { coverage } from '../src/gaps.ts';
import { FOUNDATIONAL } from '../src/readiness.ts';
import { validateReport } from '../src/report.ts';
import { Review } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { ValidationError } from '../src/validate.ts';

interface Match { match: string; text: string }
interface Case {
  id: string; domain: string; problem: string; walkthrough: string;
  expected_steps: { key: string; owner?: string }[];
  not_steps: string[];
  stated_dimensions: Dimension[];
  answers: Record<string, unknown> & { owners: Match[]; handoffs: Match[]; systems: Match[]; confirm_by_dimension?: Record<string, string>; sequence_confirm?: string };
  expected_findings: { category: string; status: 'confirmed' | 'tentative' }[];
  ai_warranted: boolean;
}

const DIR = import.meta.dirname;
const cases: Case[] = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));
const DEFAULT = "I don't know.";
const lc = (s: string) => s.toLowerCase();
const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${n}/${d} (${((100 * n) / d).toFixed(0)}%)`);

/** The scripted interviewee: answers whatever Ilsa asks, from the case's answers. */
function answerFor(c: Case, q: Question, model: Model, walked: boolean): string {
  const A = c.answers;
  if (q.slot === 'sequence') return q.intent === 'discover' ? (walked ? DEFAULT : c.walkthrough) : (A.sequence_confirm ?? "Yes, that's all of it.");
  if (!q.slot.includes('.')) {
    if (q.intent === 'confirm') return A.confirm_by_dimension?.[q.slot] ?? 'Yes.';
    return typeof A[q.slot] === 'string' ? (A[q.slot] as string) : DEFAULT;
  }
  if (q.intent === 'confirm') return 'Yes.';
  const [sid, field] = q.slot.split('.');
  const summary = lc(model.workflow.steps.find((s) => s.id === sid)?.summary ?? '');
  const list = field === 'owner' ? A.owners : field === 'handoff_in' ? A.handoffs : field === 'system' ? A.systems : [];
  return list.find((e) => summary.includes(lc(e.match)))?.text ?? DEFAULT;
}

// ------------------------------------------------------------------ seeded correction simulation

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIVE = new Set(['confirmed', 'tentative', 'user_accepted']);
/** Categories the no-key rules can nominate. The others (bottleneck, duplicate work, ...) can only come from Claude. */
const RULE_CATEGORIES = new Set(['unclear_ownership', 'manual_reentry', 'tool_switching', 'missing_terminal_condition', 'missing_exception_handling',
  'waiting_dependency', 'information_loss', 'manual_status_checking', 'single_point_of_failure', 'unstructured_intake']);

async function simulateCorrections(store: Store, d: Discovery, x: Assessor, id: string, seed: number, actions: number) {
  const review = new Review(store, d, x);
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const rev1 = JSON.stringify(store.getRevision(id, 1));
  const userSet = new Map<string, string>(); // slot -> value the user set
  let checks = 0;
  const violations: string[] = [];
  const check = (ok: boolean, what: string) => { checks++; if (!ok) violations.push(what); };

  for (let i = 0; i < actions; i++) {
    const before = store.get(id);
    const steps = before.model.workflow.steps;
    const live = before.model.findings.filter((f) => LIVE.has(f.status));
    const kind = pick(['owner', 'unknown', 'dispute', 'accept', 'handoff', 'move', 'context', 'add']);
    let label = kind;
    try {
      if (kind === 'owner' && steps.length) {
        const s = pick(steps); review.setFact(id, `${s.id}.owner`, { value: 'Jordan' }); userSet.set(`${s.id}.owner`, 'Jordan'); label += ` ${s.id}`;
      } else if (kind === 'unknown' && steps.length) {
        const s = pick(steps); review.markUnknown(id, `${s.id}.system`); userSet.delete(`${s.id}.system`); label += ` ${s.id}.system`;
      } else if (kind === 'dispute' && live.length) {
        const f = pick(live); review.disputeFinding(id, f.id, 'Not accurate for us.'); label += ` ${f.id}`;
      } else if (kind === 'accept' && live.some((f) => f.status === 'tentative')) {
        const f = pick(live.filter((x) => x.status === 'tentative')); review.acceptFinding(id, f.id); label += ` ${f.id}`;
      } else if (kind === 'handoff' && steps.length > 1) {
        const s = pick(steps.slice(1)); review.setFact(id, `${s.id}.handoff_in`, { value: 'Assigned in the shared tracker, which notifies them.' });
        userSet.set(`${s.id}.handoff_in`, 'Assigned in the shared tracker, which notifies them.'); label += ` ${s.id}`;
      } else if (kind === 'move' && steps.length > 1) {
        const from = Math.floor(r() * steps.length); let to = Math.floor(r() * steps.length); if (to === from) to = (to + 1) % steps.length;
        review.moveStep(id, steps[from].id, to);
        for (const k of [...userSet.keys()]) if (k.endsWith('.handoff_in')) userSet.delete(k); // reorder may clear handoffs by design
        label += ` ${steps[from].id}->${to + 1}`;
      } else if (kind === 'context') {
        await review.addContext(id, 'Whoever is free usually handles it, and I think we copy it into the spreadsheet again.');
      } else if (kind === 'add') {
        review.addStep(id, { summary: 'The owner reviews open items every Friday', position: Math.floor(r() * (steps.length + 1)), owner: 'the owner' });
      } else continue;
    } catch (err) {
      if (err instanceof ValidationError) continue;
      throw err;
    }

    // Invariants after every review action.
    const after = store.get(id);
    check(after.revision >= before.revision && after.revision <= before.revision + 2, `${label}: revision jumped ${before.revision}->${after.revision}`);
    check(after.evidence.length >= before.evidence.length &&
      JSON.stringify(after.evidence.slice(0, before.evidence.length)) === JSON.stringify(before.evidence), `${label}: earlier evidence changed`);
    check(JSON.stringify(store.getRevision(id, 1)) === rev1, `${label}: revision 1 was modified`);
    for (const [slot, value] of userSet) {
      const [sid, field] = slot.split('.');
      const step = after.model.workflow.steps.find((s) => s.id === sid);
      if (step) check((step as unknown as Record<string, { value: string | null }>)[field].value === value, `${label}: user-set ${slot} was overwritten`);
    }
    const cur = x.current(id);
    if (cur.active) {
      check(cur.active.based_on_revision === after.revision, `${label}: active report is stale`);
      const errs = validateReport(cur.active, after.model, after.revision);
      check(errs.length === 0, `${label}: active report invalid: ${errs.join('; ')}`);
      const disputed = new Set(after.model.findings.filter((f) => f.status === 'user_disputed').map((f) => f.id));
      const inReport = [...cur.active.observed_friction.confirmed, ...cur.active.observed_friction.needs_confirmation].map((f) => f.id);
      check(!inReport.some((f) => disputed.has(f)), `${label}: disputed finding in active report`);
      check(!cur.active.recommendations.some((rec) => rec.finding_ids.some((f) => disputed.has(f))), `${label}: recommendation cites a disputed finding`);
    } else {
      check(cur.previous === null || cur.stale, `${label}: inconsistent active/previous state`);
    }
  }
  return { checks, violations };
}

// ------------------------------------------------------------------ run

interface CaseResult {
  id: string; domain: string; healthy: boolean;
  clarified_first: boolean; invented_steps_from_problem: number;
  premature: { problem: boolean; walkthrough: boolean };
  steps: { expected: number; matched: number; extracted: number; owner_labeled: number; owner_ok: number; missed: string[]; not_steps: string[]; extra: string[]; owner_misses: string[] };
  redundant: Dimension[]; stated: number;
  clarification: { needed: Dimension[]; addressed: Dimension[] };
  questions: number; assessable: boolean; blockers: string[];
  findings: { expected: number; found: number; missed: string[]; unlabeled: string[]; unlabeled_artifact: number; healthy_artifact: number;
    status: { expected: string; got: string; category: string }[]; relinked_ok: number; live: number;
    expected_rule_detectable: number; found_rule_detectable: number };
  recs: { ai: boolean; ai_warranted: boolean; count: number; investigate: number; validator_errors: string[]; act_on_tentative: number } | null;
  corrections: { checks: number; violations: string[] } | null;
}

const results: CaseResult[] = [];
for (const c of cases) {
  const store = new Store();
  const d = new Discovery(store);
  const x = new Assessor(store);

  // Stage A: the problem statement alone.
  const { state: s0 } = await d.start(c.domain, c.problem);
  const id = s0.assessment.id;
  const clarified_first = s0.open_question !== null && s0.open_question.slot === 'sequence';
  const premA = x.generate(id).ok;

  // Stage B: the walk-through.
  const { state: s1 } = await d.answer(id, s0.open_question!.id, c.walkthrough);
  const premB = x.generate(id).ok;
  const wf = s1.assessment.model.workflow;
  const used = new Set<number>();
  let matched = 0, ownerLabeled = 0, ownerOk = 0;
  const missed: string[] = [], ownerMisses: string[] = [];
  for (const e of c.expected_steps) {
    const i = wf.steps.findIndex((s, k) => !used.has(k) && lc(s.summary).includes(lc(e.key)));
    if (i < 0) { missed.push(e.key); continue; }
    used.add(i); matched++;
    if (e.owner) {
      ownerLabeled++;
      const o = wf.steps[i].owner;
      const ok = (o.status === 'known' || o.status === 'inferred') && lc(o.value!).includes(lc(e.owner));
      if (ok) ownerOk++; else ownerMisses.push(`"${e.key}": expected ${e.owner}, got ${o.value ?? o.status}`);
    }
  }
  const notSteps: string[] = [], extra: string[] = [];
  wf.steps.forEach((s, k) => {
    if (used.has(k)) return;
    if (c.not_steps.some((n) => lc(s.summary).includes(lc(n)))) notSteps.push(s.summary); else extra.push(s.summary);
  });
  const cov1 = coverage(s1.assessment.model);
  const redundant = c.stated_dimensions.filter((dim) => cov1[dim] === 'missing');
  const needed = FOUNDATIONAL.filter((dim) => cov1[dim] === 'missing' || cov1[dim] === 'tentative');

  // Stage C: the full scripted interview.
  let state = s1;
  let asked = 1;
  for (let i = 0; i < 60 && state.open_question; i++) {
    const q = state.open_question;
    state = (await d.answer(id, q.id, answerFor(c, q, state.assessment.model, true))).state;
    asked++;
  }
  const finalA = store.get(id);
  const covEnd = coverage(finalA.model);
  const askedDims = new Set(finalA.questions.map((q) => q.dimension));
  const addressed = needed.filter((dim) => askedDims.has(dim) || covEnd[dim] === 'established');

  // Findings vs labels.
  const live = finalA.model.findings.filter((f) => LIVE.has(f.status));
  const usedF = new Set<Finding>();
  const fMissed: string[] = [], statusRows: CaseResult['findings']['status'] = [];
  let found = 0;
  for (const e of c.expected_findings) {
    const f = live.find((l) => l.category === e.category && !usedF.has(l)) ?? live.find((l) => l.category === e.category);
    if (!f) { fMissed.push(`${e.category} (${e.status})`); continue; }
    usedF.add(f); found++;
    statusRows.push({ expected: e.status, got: f.status, category: e.category });
  }
  const labeledCats = new Set(c.expected_findings.map((e) => e.category));
  // Analysis added after the run (does not change any metric): does a finding rest on the scripted
  // interviewee's default "I don't know.", i.e. an answer the case author never scripted?
  const scriptedDefault = (f: Finding) => f.evidence.some((r) => finalA.evidence.find((e) => e.id === r.evidence_id)?.text === DEFAULT);
  const unlabeledF = live.filter((f) => !labeledCats.has(f.category));
  const unlabeled = unlabeledF.map((f) => `${f.category} [${f.status}] ${f.step_ids.join(',') || 'workflow'}: ${f.support}${scriptedDefault(f) ? ` (rests on the scripted "${DEFAULT}")` : ''}`);
  const unlabeledArtifact = unlabeledF.filter(scriptedDefault).length;
  const healthyArtifact = c.expected_findings.length === 0 ? live.filter(scriptedDefault).length : 0;
  const ruleDetectable = c.expected_findings.filter((e) => RULE_CATEGORIES.has(e.category));
  const foundRuleDetectable = ruleDetectable.filter((e) => live.some((l) => l.category === e.category)).length;
  const relinked = live.filter((f) => vetFinding({ category: f.category, step_ids: f.step_ids, evidence: f.evidence, source: f.source }, finalA.model, finalA.evidence).status !== 'rejected').length;

  // Assessment and recommendations.
  const g = x.generate(id);
  let recs: CaseResult['recs'] = null;
  let corrections: CaseResult['corrections'] = null;
  let blockers: string[] = [];
  if (g.ok) {
    const a = store.get(id);
    const tentativeIds = new Set(a.model.findings.filter((f) => f.status === 'tentative').map((f) => f.id));
    recs = {
      ai: g.report.recommendations.some((r) => r.intervention === 'ai_assisted'),
      ai_warranted: c.ai_warranted,
      count: g.report.recommendations.length,
      investigate: g.report.recommendations.filter((r) => r.kind === 'investigate').length,
      validator_errors: validateReport(g.report, a.model, a.revision),
      act_on_tentative: g.report.recommendations.filter((r) => r.kind === 'act' && r.finding_ids.some((f) => tentativeIds.has(f))).length,
    };
    const agg = { checks: 0, violations: [] as string[] };
    for (const seed of [1, 7, 123]) {
      // Each seed runs on a fresh copy of the assessed state, rebuilt from the same inputs.
      const st = new Store(); const dd = new Discovery(st); const xx = new Assessor(st);
      const { state: t0 } = await dd.start(c.domain, c.problem);
      let t = (await dd.answer(t0.assessment.id, t0.open_question!.id, c.walkthrough)).state;
      for (let i = 0; i < 60 && t.open_question; i++) t = (await dd.answer(t0.assessment.id, t.open_question.id, answerFor(c, t.open_question, t.assessment.model, true))).state;
      xx.generate(t0.assessment.id);
      const res = await simulateCorrections(st, dd, xx, t0.assessment.id, seed, 8);
      agg.checks += res.checks;
      agg.violations.push(...res.violations.map((v) => `seed ${seed}: ${v}`));
    }
    corrections = agg;
  } else {
    blockers = g.readiness.blocking.map((b) => `${b.slot}: ${b.problem}`);
  }

  results.push({
    id: c.id, domain: c.domain, healthy: c.expected_findings.length === 0,
    clarified_first, invented_steps_from_problem: s0.assessment.model.workflow.steps.length,
    premature: { problem: premA, walkthrough: premB },
    steps: { expected: c.expected_steps.length, matched, extracted: wf.steps.length, owner_labeled: ownerLabeled, owner_ok: ownerOk, missed, not_steps: notSteps, extra, owner_misses: ownerMisses },
    redundant, stated: c.stated_dimensions.length,
    clarification: { needed, addressed },
    questions: asked, assessable: g.ok, blockers,
    findings: { expected: c.expected_findings.length, found, missed: fMissed, unlabeled, unlabeled_artifact: unlabeledArtifact, healthy_artifact: healthyArtifact,
      status: statusRows, relinked_ok: relinked, live: live.length, expected_rule_detectable: ruleDetectable.length, found_rule_detectable: foundRuleDetectable },
    recs, corrections,
  });
}

// ------------------------------------------------------------------ report

const sum = (f: (r: CaseResult) => number) => results.reduce((n, r) => n + f(r), 0);
const S = {
  steps_expected: sum((r) => r.steps.expected), steps_matched: sum((r) => r.steps.matched), steps_extracted: sum((r) => r.steps.extracted),
  owner_labeled: sum((r) => r.steps.owner_labeled), owner_ok: sum((r) => r.steps.owner_ok), not_steps: sum((r) => r.steps.not_steps.length),
  stated: sum((r) => r.stated), redundant: sum((r) => r.redundant.length),
  needed: sum((r) => r.clarification.needed.length), addressed: sum((r) => r.clarification.addressed.length),
  clarified_first: results.filter((r) => r.clarified_first).length, invented: sum((r) => r.invented_steps_from_problem),
  premature: results.filter((r) => r.premature.problem || r.premature.walkthrough).length,
  assessable: results.filter((r) => r.assessable).length,
  f_expected: sum((r) => r.findings.expected), f_found: sum((r) => r.findings.found), live: sum((r) => r.findings.live),
  unlabeled: sum((r) => r.findings.unlabeled.length), relinked: sum((r) => r.findings.relinked_ok),
  healthy_findings: sum((r) => (r.healthy ? r.findings.live : 0)), healthy_cases: results.filter((r) => r.healthy).length,
  unlabeled_artifact: sum((r) => r.findings.unlabeled_artifact), healthy_artifact: sum((r) => r.findings.healthy_artifact),
  f_expected_rule: sum((r) => r.findings.expected_rule_detectable), f_found_rule: sum((r) => r.findings.found_rule_detectable),
};
const statusRows = results.flatMap((r) => r.findings.status);
const conf = (e: string, g: string) => statusRows.filter((s) => s.expected === e && (g === 'tentative' ? s.got === 'tentative' : s.got !== 'tentative')).length;
const assessed = results.filter((r) => r.recs);
const aiUnwarranted = assessed.filter((r) => r.recs!.ai && !r.recs!.ai_warranted);
const aiMissed = assessed.filter((r) => !r.recs!.ai && r.recs!.ai_warranted);
const aiWarrantedAssessed = assessed.filter((r) => r.recs!.ai_warranted).length;
const corrChecks = sum((r) => r.corrections?.checks ?? 0);
const corrViol = results.flatMap((r) => (r.corrections?.violations ?? []).map((v) => `${r.id} ${v}`));

const L: string[] = [];
L.push('# Evaluation results: Run 2 (post-review, NOT held-out)', '');
L.push('> Same 20 cases as Run 1, after five fixes made in response to Run 1 (see eval/README.md). The cases had already been seen, so this is **not** a held-out result: it shows the effect of the fixes on known cases, and is likely optimistic. The original held-out result is [run1-heldout.md](run1-heldout.md).', '');
L.push(`20 hand-written cases (16 with friction, ${S.healthy_cases} healthy), no-key interpreter and deterministic controls. **Claude is not evaluated.** ↑ higher is better, ↓ lower is better.`, '');
L.push('## Summary', '', '| Area | Metric | Result |', '| --- | --- | --- |');
L.push(`| Step extraction (walk-through only) | Recall ↑ (labeled steps found) | ${pct(S.steps_matched, S.steps_expected)} |`);
L.push(`| | Precision ↑ (extracted steps that are labeled steps) | ${pct(S.steps_matched, S.steps_extracted)} |`);
L.push(`| | Owner accuracy ↑ (where the walk-through names the owner) | ${pct(S.owner_ok, S.owner_labeled)} |`);
L.push(`| | Customer actions wrongly extracted as steps ↓ | ${S.not_steps} |`);
L.push(`| Clarification | First response is a discovery question, not a solution ↑ | ${pct(S.clarified_first, results.length)} (steps invented from the problem statement: ${S.invented}) |`);
L.push(`| | Missing foundational dimensions asked about or established ↑ | ${pct(S.addressed, S.needed)} |`);
L.push(`| | **Redundant questions ↓** (stated in the walk-through, but not extracted, so asked again) | ${pct(S.redundant, S.stated)} |`);
L.push(`| Restraint | **Premature assessments ↓** (generated from the problem statement or walk-through alone) | ${S.premature} of ${results.length * 2} attempts |`);
L.push(`| | Cases assessable after the scripted interview | ${pct(S.assessable, results.length)} |`);
L.push(`| Friction | Recall ↑ (labeled findings detected, by category) | ${pct(S.f_found, S.f_expected)} |`);
L.push(`| | **Unlabeled-finding rate ↓** (live findings in a category the labels do not include) | ${pct(S.unlabeled, S.live)} |`);
L.push(`| | **Findings on healthy workflows ↓** | ${S.healthy_findings} across ${S.healthy_cases} healthy cases |`);
L.push(`| | Findings whose evidence still passes the gate when re-checked ↑ | ${pct(S.relinked, S.live)} |`);
L.push(`| Confirmed vs tentative | Expected confirmed → reported confirmed ↑ | ${pct(conf('confirmed', 'confirmed'), conf('confirmed', 'confirmed') + conf('confirmed', 'tentative'))} |`);
L.push(`| | **Overclaiming ↓** (expected tentative → reported confirmed) | ${conf('tentative', 'confirmed')} of ${conf('tentative', 'confirmed') + conf('tentative', 'tentative')} matched tentative labels |`);
L.push(`| Recommendation restraint | **AI recommended where not warranted ↓** | ${aiUnwarranted.length} of ${assessed.length - aiWarrantedAssessed} assessed cases |`);
L.push(`| | AI not recommended where warranted | ${aiMissed.length} of ${aiWarrantedAssessed} assessed cases |`);
L.push(`| | Recommendations rejected by the report validator ↓ | ${sum((r) => r.recs?.validator_errors.length ?? 0)} |`);
L.push(`| | "Act" recommendations citing a tentative finding ↓ | ${sum((r) => r.recs?.act_on_tentative ?? 0)} |`);
L.push(`| Correction / regeneration | **Invariant violations ↓** (8 seeded review actions × 3 seeds per assessable case) | ${corrViol.length} of ${corrChecks} checks |`);
L.push('');
L.push('### Breakdowns added after the run (analysis only; no metric above was changed)', '',
  `- Friction recall on categories the no-key rules can detect: ${pct(S.f_found_rule, S.f_expected_rule)}. On categories only Claude could propose (bottleneck, duplicate work, inconsistent decisions, customers chasing): ${pct(S.f_found - S.f_found_rule, S.f_expected - S.f_expected_rule)}, as expected with no key.`,
  `- Unlabeled findings that rest on the scripted interviewee's default answer "I don't know." (given to any question the case did not script, typically "who owns this step?" after the interpreter missed an owner the walk-through named): ${S.unlabeled_artifact} of ${S.unlabeled}. Ilsa handled that answer as designed ("the user did not know" supports unclear ownership), but a real user would usually have named the owner. The remaining ${S.unlabeled - S.unlabeled_artifact} are listed per case and include genuine false positives.`,
  `- Findings on healthy workflows that rest on the scripted "I don't know.": ${S.healthy_artifact} of ${S.healthy_findings}.`, '');
L.push('## How to read these numbers', '',
  '- Premature assessments, "act on tentative", validator rejections and invariant violations are **guaranteed by design** (the gate and validator are code). The evaluation confirms the design holds on these inputs; it is not evidence of intelligence.',
  '- Step extraction, redundant questions and friction recall measure the **no-key interpreter**, which is a set of word lists. These are the numbers a better interpreter (for example Claude) would need to beat; that comparison has not been run.',
  '- "Unlabeled findings" are findings in categories the labels did not include. Each one is listed below. Some may be defensible, so this is a candidate false-positive rate, not a verified one.',
  '- Friction recall is measured by category: a finding counts if its category matches, regardless of which steps it cites.', '');

L.push('## Per case', '', '| Case | Steps found | Extra / not-steps | Redundant Qs | Questions | Assessable | Findings found | Unlabeled | AI rec (warranted?) | Correction violations |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of results) {
  L.push(`| ${r.id} ${r.domain} | ${r.steps.matched}/${r.steps.expected} | ${r.steps.extra.length} / ${r.steps.not_steps.length} | ${r.redundant.join(', ') || '—'} | ${r.questions} | ${r.assessable ? 'yes' : '**no**'} | ${r.findings.found}/${r.findings.expected} | ${r.findings.unlabeled.length} | ${r.recs ? `${r.recs.ai ? 'yes' : 'no'} (${r.recs.ai_warranted ? 'yes' : 'no'})` : '—'} | ${r.corrections ? r.corrections.violations.length : '—'} |`);
}
L.push('', '## Misses and weak cases', '');
for (const r of results) {
  const lines: string[] = [];
  if (r.steps.missed.length) lines.push(`missed steps: ${r.steps.missed.map((m) => `"${m}"`).join(', ')}`);
  if (r.steps.not_steps.length) lines.push(`customer action extracted as a step: ${r.steps.not_steps.map((m) => `"${m}"`).join(', ')}`);
  if (r.steps.extra.length) lines.push(`unlabeled extra steps: ${r.steps.extra.map((m) => `"${m}"`).join(', ')}`);
  if (r.steps.owner_misses.length) lines.push(`owner misses: ${r.steps.owner_misses.join('; ')}`);
  if (r.redundant.length) lines.push(`stated but not extracted (asked again): ${r.redundant.join(', ')}`);
  const unaddressed = r.clarification.needed.filter((x) => !r.clarification.addressed.includes(x));
  if (unaddressed.length) lines.push(`missing dimensions never asked: ${unaddressed.join(', ')}`);
  if (!r.assessable) lines.push(`not assessable; blockers: ${r.blockers.join('; ')}`);
  if (r.findings.missed.length) lines.push(`missed findings: ${r.findings.missed.join(', ')}`);
  if (r.findings.unlabeled.length) lines.push(`unlabeled findings: ${r.findings.unlabeled.join(' | ')}`);
  const mism = r.findings.status.filter((s) => (s.expected === 'tentative') !== (s.got === 'tentative'));
  if (mism.length) lines.push(`status mismatches: ${mism.map((s) => `${s.category} expected ${s.expected}, got ${s.got}`).join('; ')}`);
  if (r.recs && r.recs.ai !== r.recs.ai_warranted) lines.push(r.recs.ai ? 'AI recommended but not warranted' : 'AI warranted but not recommended');
  if (r.corrections?.violations.length) lines.push(`correction invariant violations: ${r.corrections.violations.join('; ')}`);
  if (lines.length) L.push(`**${r.id} ${r.domain}**`, ...lines.map((l) => `- ${l}`), '');
}
if (corrViol.length === 0) L.push('No correction/regeneration invariant was violated.', '');

mkdirSync(join(DIR, 'results'), { recursive: true });
writeFileSync(join(DIR, 'results', 'run2-post-review.md'), L.join('\n') + '\n');
writeFileSync(join(DIR, 'results', 'run2-post-review.json'), JSON.stringify({ run: 'run2-post-review', summary: S, results }, null, 2) + '\n');
console.log(L.slice(0, 32).join('\n'));

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Assessor } from '../src/assess.ts';
import { Discovery } from '../src/discovery.ts';
import type { Finding, Model, Recommendation, Report } from '../src/domain.ts';
import { readiness } from '../src/readiness.ts';
import { buildRecommendations } from '../src/recommend.ts';
import { validateReport } from '../src/report.ts';
import { Store } from '../src/store.ts';
import { INQUIRY_ANSWERS, INQUIRY_PROBLEM, interview } from './scenario.ts';

function setup() {
  const store = new Store();
  return { store, d: new Discovery(store), x: new Assessor(store) };
}

async function assessed() {
  const { store, d, x } = setup();
  const { state } = await d.start('New customer inquiry', INQUIRY_PROBLEM);
  const done = await interview(d, state);
  const result = x.generate(done.assessment.id);
  assert.ok(result.ok, 'scenario should reach readiness');
  return { store, d, x, id: done.assessment.id, report: (result as { report: Report }).report };
}

describe('readiness gate: recommendations stay locked until the process is understood', () => {
  it('refuses to assess a bare problem statement, names what is missing, and stores nothing', async () => {
    const { store, d, x } = setup();
    const { state } = await d.start('New customer inquiry', 'Our leads fall through the cracks. Just tell me which CRM to buy.');
    const result = x.generate(state.assessment.id);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /Not ready to assess/);
    assert.deepEqual(new Set(result.readiness.blocking.map((b) => b.dimension)), new Set(['steps', 'trigger', 'completion', 'exceptions', 'ownership']));
    assert.equal(store.reportCount(state.assessment.id), 0);
    assert.equal(store.get(state.assessment.id).status, 'discovery');
  });

  it('does not treat "we have some information" as understanding', async () => {
    const { d, x } = setup();
    const { state } = await d.start('x', INQUIRY_PROBLEM);
    const after = (await d.answer(state.assessment.id, state.open_question!.id, INQUIRY_ANSWERS['sequence:discover'])).state;
    // Four steps, a trigger, owners and a decision are known, and it is still not ready.
    assert.ok(after.assessment.model.workflow.steps.length >= 4);
    const gate = x.readiness(after.assessment.id);
    assert.equal(gate.ready, false);
    const problems = new Map(gate.blocking.map((b) => [b.slot, b.problem]));
    assert.equal(problems.get('sequence'), 'sequence_unconfirmed');
    assert.equal(problems.get('completion'), 'not_asked');
    assert.equal(problems.get('exceptions'), 'needs_confirmation', 'inferred is not enough');
  });

  it('accepts an explicit "nobody knows" as understood-and-unknown, but blocks on uninterpretable or skipped answers', async () => {
    const { d } = setup();
    const { state: s0 } = await d.start('x', INQUIRY_PROBLEM);
    const id = s0.assessment.id;
    let state = (await d.answer(id, s0.open_question!.id, INQUIRY_ANSWERS['sequence:discover'])).state;
    const questions = () => state.assessment.questions;

    // completion: "I don't know" -> not blocking, listed as an unknown
    state = (await d.answer(id, state.open_question!.id, "I don't know how we'd tell.")).state;
    let gate = readiness(state.assessment.model, questions());
    assert.ok(!gate.blocking.some((b) => b.slot === 'completion'));
    assert.ok(gate.unknowns.some((u) => u.slot === 'completion' && u.kind === 'user_does_not_know'));

    // Skip the step-list confirmation -> sequence still blocks
    state = d.skip(id, state.open_question!.id);
    // A foundational question answered with something the interpreter cannot use -> blocks as uninterpreted
    while (state.open_question && !state.open_question.slot.endsWith('.owner')) state = d.skip(id, state.open_question.id);
    const ownerSlot = state.open_question!.slot;
    state = (await d.answer(id, state.open_question!.id, 'Well, it has been different ever since last spring when things changed around here.')).state;
    gate = readiness(state.assessment.model, questions());
    assert.equal(gate.blocking.find((b) => b.slot === ownerSlot)?.problem, 'uninterpreted');
    assert.equal(gate.blocking.find((b) => b.slot === 'sequence')?.problem, 'sequence_unconfirmed');
  });

  it('unlocks once every foundational dimension is established or explicitly unknown', async () => {
    const { report } = await assessed();
    assert.ok(report);
  });
});

describe('assessment: four separate sections, every recommendation traced', () => {
  it('keeps current state, friction, unknowns and recommendations as separate sections', async () => {
    const { report } = await assessed();
    assert.deepEqual(Object.keys(report).filter((k) => ['current_state', 'observed_friction', 'unknowns', 'recommendations'].includes(k)),
      ['current_state', 'observed_friction', 'unknowns', 'recommendations']);
    assert.equal(report.current_state.completion.certainty, 'absent');
    assert.ok(report.observed_friction.confirmed.length > 0);
    assert.ok(report.unknowns.every((u) => u.kind === 'user_does_not_know' || u.kind === 'not_covered' || u.kind === 'unconfirmed'));
  });

  it('traces every recommendation to validated findings, and passes its own validator', async () => {
    const { store, id, report } = await assessed();
    const a = store.get(id);
    const live = new Set(a.model.findings.filter((f) => f.status === 'confirmed' || f.status === 'tentative').map((f) => f.id));
    for (const r of report.recommendations) {
      assert.ok(r.finding_ids.length > 0, `${r.id} is an orphan`);
      for (const f of r.finding_ids) assert.ok(live.has(f), `${r.id} cites ${f}`);
    }
    assert.deepEqual(validateReport(report, a.model, a.revision), []);
  });

  it('does not recommend AI when intake already arrives through a form', async () => {
    const { report } = await assessed();
    assert.ok(report.observed_friction.confirmed.some((f) => f.category === 'unstructured_intake'));
    assert.ok(!report.recommendations.some((r) => r.intervention === 'ai_assisted'));
    const intake = report.recommendations.find((r) => r.title.startsWith('Keep the structure'))!;
    assert.equal(intake.intervention, 'existing_tool_change');
    assert.match(intake.why_not_ai!, /form already captures/);
  });

  it('marks the report stale when the model changes after it was generated', async () => {
    const { store, x, id } = await assessed();
    assert.equal(x.current(id).stale, false);
    const changed = structuredClone(store.get(id).model);
    changed.workflow.steps[1].summary = 'Maria types the details into the spreadsheet';
    store.saveModel(id, changed, 'summary edited', 'user');
    assert.equal(x.current(id).stale, true);
  });
});

describe('recommendation rules', () => {
  const base = (): Model => ({ workflow: {
    name: 'x', sequence: { value: 'confirmed: 1 steps', status: 'known', evidence: [] },
    trigger: { value: 'Customers call us or email us describing the problem', status: 'known', evidence: [] },
    completion: { value: null, status: 'unknown', evidence: [] }, exceptions: { value: null, status: 'unknown', evidence: [] },
    decisions: { value: null, status: 'unknown', evidence: [] }, waiting: { value: null, status: 'unknown', evidence: [] }, steps: [],
  }, findings: [] });
  const finding = (id: string, category: Finding['category'], status: Finding['status']): Finding => ({
    id, signature: `${category}:${id}`, category, step_ids: [], evidence: [{ evidence_id: 'E1', quote: 'quoted text here' }],
    rationale: 'r', support: `support for ${category}`, source: 'rule', status, rejection_reason: null,
  });

  it('lets tentative findings produce only "confirm first" recommendations', () => {
    const recs = buildRecommendations(base(), [finding('F1', 'single_point_of_failure', 'tentative')]);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'investigate');
    assert.match(recs[0].title, /^Confirm first:/);
  });

  it('offers AI only for free-form intake that cannot be structured at the source, alongside the simpler fix, with a reason', () => {
    const recs = buildRecommendations(base(), [finding('F1', 'unstructured_intake', 'confirmed')]);
    const ai = recs.find((r) => r.intervention === 'ai_assisted')!;
    assert.ok(ai.ai_reason && /interpreted/.test(ai.ai_reason));
    assert.ok(recs.some((r) => r.intervention === 'existing_tool_change'), 'the non-AI fix is still offered');
    assert.equal(recs.filter((r) => r.intervention === 'ai_assisted').length, 1);
  });

  it('never recommends AI for categories a rule or a process change can fix', () => {
    const all = (['manual_reentry', 'missing_terminal_condition', 'repeated_customer_followup', 'missing_exception_handling', 'waiting_dependency'] as const)
      .map((c, i) => finding(`F${i + 1}`, c, 'confirmed'));
    const recs = buildRecommendations(base(), all);
    assert.ok(recs.every((r) => r.intervention !== 'ai_assisted' && r.why_not_ai));
  });

  describe('the report validator refuses reports that break the rules', () => {
    const model = (): Model => ({ ...base(), findings: [
      finding('F1', 'manual_reentry', 'confirmed'), finding('F2', 'bottleneck', 'tentative'),
      finding('F3', 'tool_switching', 'user_disputed'), { ...finding('F4', 'duplicate_work', 'rejected'), rejection_reason: 'no' },
    ] });
    const rec = (over: Partial<Recommendation>): Recommendation => ({
      id: 'R1', finding_ids: ['F1'], kind: 'act', intervention: 'existing_tool_change', title: 't', detail: 'd', ai_reason: null, why_not_ai: 'w', ...over,
    });
    const report = (recs: Recommendation[], extra: Partial<Report> = {}): Report => ({
      assessment_id: 'A', based_on_revision: 3, generated_at: 't',
      current_state: {} as Report['current_state'],
      observed_friction: { confirmed: [], needs_confirmation: [] }, unknowns: [], recommendations: recs, ...extra,
    });
    const errs = (r: Report) => validateReport(r, model(), 3).join(' | ');

    it('orphan recommendations', () => assert.match(errs(report([rec({ finding_ids: [] })])), /orphan/));
    it('recommendations citing disputed or rejected findings', () => {
      assert.match(errs(report([rec({ finding_ids: ['F3'] })])), /missing, rejected or disputed: F3/);
      assert.match(errs(report([rec({ finding_ids: ['F4'] })])), /missing, rejected or disputed: F4/);
    });
    it('"act" backed only by tentative findings', () => assert.match(errs(report([rec({ finding_ids: ['F2'] })])), /can only be "investigate"/));
    it('AI-assisted without a reason', () => assert.match(errs(report([rec({ intervention: 'ai_assisted', ai_reason: 'AI is good.' })])), /does not explain why/));
    it('an AI reason on a non-AI recommendation', () => assert.match(errs(report([rec({ ai_reason: 'because language is ambiguous and varies' })])), /carries an AI reason/));
    it('a tentative finding listed as confirmed friction', () => {
      const f2 = { id: 'F2', category: 'bottleneck' as const, step_ids: [], status: 'tentative' as const, rationale: '', support: '', evidence: [] };
      assert.match(errs(report([], { observed_friction: { confirmed: [f2], needs_confirmation: [] } })), /listed as confirmed friction/);
    });
    it('a report built from an older revision', () => assert.match(errs(report([], { based_on_revision: 2 })), /based on revision 2/));
    it('accepts a report that follows the rules', () => {
      assert.equal(errs(report([rec({}), rec({ id: 'R2', finding_ids: ['F2'], kind: 'investigate' })])), '');
    });
  });
});

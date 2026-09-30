import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Discovery } from '../src/discovery.ts';
import { emptyWorkflow, newStep, type Evidence, type Fact, type Finding, type Model } from '../src/domain.ts';
import { diagnose, vetFinding } from '../src/friction.ts';
import { Store } from '../src/store.ts';
import { validateModel } from '../src/validate.ts';

// A small hand-built model, so each rule is tested against exactly the facts it needs.
const E2 = 'The form sends an email to the office inbox. Maria copies the details into our spreadsheet. The owner texts the tech the customer name.';
const E3 = 'Honestly nobody closes them out.';
const E4 = 'I think sometimes nobody follows up.';
const E5 = 'Customers call us back asking what is happening.';
const evidence: Evidence[] = [
  { id: 'E1', kind: 'problem_statement', question_id: null, text: 'We keep losing inquiries.', created_at: 't' },
  { id: 'E2', kind: 'answer', question_id: 'Q1', text: E2, created_at: 't' },
  { id: 'E3', kind: 'answer', question_id: 'Q2', text: E3, created_at: 't' },
  { id: 'E4', kind: 'answer', question_id: 'Q3', text: E4, created_at: 't' },
  { id: 'E5', kind: 'answer', question_id: 'Q4', text: E5, created_at: 't' },
];
const fact = (value: string | null, status: Fact['status'], id: string, quote: string): Fact => ({ value, status, evidence: [{ evidence_id: id, quote }] });

function model(): Model {
  const wf = emptyWorkflow('New inquiry');
  const s1 = newStep('S1', 'The form sends an email to the office inbox', [{ evidence_id: 'E2', quote: 'The form sends an email to the office inbox' }]);
  s1.owner = fact('Nobody, it is automatic', 'known', 'E2', 'The form sends an email to the office inbox');
  s1.system = fact('email', 'known', 'E2', 'The form sends an email to the office inbox');
  const s2 = newStep('S2', 'Maria copies the details into our spreadsheet', [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }]);
  s2.owner = fact('Maria', 'known', 'E2', 'Maria copies the details into our spreadsheet');
  s2.system = fact('spreadsheet', 'known', 'E2', 'Maria copies the details into our spreadsheet');
  s2.manual = true;
  const s3 = newStep('S3', 'Tech calls the customer', [{ evidence_id: 'E2', quote: 'The owner texts the tech the customer name' }]);
  s3.owner = fact('tech', 'known', 'E2', 'The owner texts the tech the customer name');
  s3.handoff_in = fact('The owner texts the tech the customer name', 'known', 'E2', 'The owner texts the tech the customer name');
  wf.steps = [s1, s2, s3];
  wf.completion = fact(null, 'absent', 'E3', E3);
  wf.exceptions = fact('I think sometimes nobody follows up', 'inferred', 'E4', E4);
  return { workflow: wf, findings: [] };
}

let seq = 0;
const nextId = () => `F${++seq}`;
const run = (m: Model, previous: Finding[] = [], extra = []) => diagnose(m, evidence, previous, nextId, extra);
const live = (fs: Finding[]) => fs.filter((f) => f.status !== 'rejected');

describe('friction rules: evidence-backed diagnosis', () => {
  it('finds the problems the model supports, each linked to steps and quotes', () => {
    const { findings } = run(model());
    const got = Object.fromEntries(live(findings).map((f) => [f.category, f]));
    assert.deepEqual(Object.keys(got).sort(), [
      'information_loss', 'manual_reentry', 'missing_exception_handling', 'missing_terminal_condition', 'unstructured_intake',
    ]);
    assert.deepEqual(got.manual_reentry.step_ids, ['S1', 'S2']);
    assert.match(got.manual_reentry.support, /from email \(S1\) into spreadsheet/);
    assert.deepEqual(got.information_loss.step_ids, ['S2', 'S3']);
    assert.equal(got.missing_terminal_condition.evidence[0].quote, E3);
    // Every finding passes the same schema and evidence validation as the rest of the model.
    assert.deepEqual(validateModel({ ...model(), findings }, evidence), []);
  });

  it('marks findings that rest on inferred facts as tentative, not confirmed', () => {
    const f = live(run(model()).findings).find((x) => x.category === 'missing_exception_handling')!;
    assert.equal(f.status, 'tentative');
    assert.equal(live(run(model()).findings).find((x) => x.category === 'missing_terminal_condition')!.status, 'confirmed');
  });

  it('does not call an automated step "unclear ownership"', () => {
    assert.ok(!live(run(model()).findings).some((f) => f.category === 'unclear_ownership'));
  });

  it('flags unclear ownership when the owner is "whoever", or the user says they do not know', () => {
    const m = model();
    m.workflow.steps[1].owner = fact('Whoever', 'known', 'E2', 'Maria copies the details into our spreadsheet');
    assert.ok(live(run(m).findings).some((f) => f.category === 'unclear_ownership' && f.step_ids[0] === 'S2'));
  });

  it('does not treat an answer the interpreter merely failed to parse as evidence of a problem', () => {
    const m = model();
    // Asked-and-unresolved, but the answer was not "I don't know": no unclear-ownership finding.
    m.workflow.steps[1].owner = { value: null, status: 'unknown', evidence: [{ evidence_id: 'E3', quote: E3 }] };
    assert.ok(!live(run(m).findings).some((f) => f.category === 'unclear_ownership'));
  });
});

describe('FAILURE CASE 2: unsupported diagnosis never becomes a finding', () => {
  const vet = (p: object) => vetFinding({ source: 'model', step_ids: [], evidence: [], ...p } as never, model(), evidence);

  it('rejects a quote the user never said', () => {
    const v = vet({ category: 'bottleneck', step_ids: ['S2'], evidence: [{ evidence_id: 'E2', quote: 'Maria is overwhelmed every week' }] });
    assert.equal(v.status, 'rejected');
    assert.match(v.rejection_reason!, /does not appear/);
  });

  it('rejects a real quote that is not linked to the cited step', () => {
    const v = vet({ category: 'repeated_customer_followup', step_ids: ['S2'], evidence: [{ evidence_id: 'E5', quote: E5 }] });
    assert.equal(v.status, 'rejected');
    assert.match(v.rejection_reason!, /not linked/);
  });

  it('rejects a real, linked quote that does not show the claimed problem', () => {
    // "Maria copies the details" is real and belongs to S2, but says nothing about a bottleneck.
    const v = vet({ category: 'bottleneck', step_ids: ['S2'], evidence: [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }] });
    assert.equal(v.status, 'rejected');
    assert.match(v.rejection_reason!, /does not support it/);
  });

  it('rejects categories outside the taxonomy and steps that do not exist', () => {
    assert.match(vet({ category: 'low_morale', evidence: [{ evidence_id: 'E3', quote: E3 }] }).rejection_reason!, /not a friction category/);
    assert.match(vet({ category: 'bottleneck', step_ids: ['S9'], evidence: [{ evidence_id: 'E3', quote: E3 }] }).rejection_reason!, /do not exist/);
  });

  it('keeps rejected model proposals for audit only, and confirms supported ones', () => {
    const m = model();
    m.workflow.completion = fact('Customers call us back asking what is happening', 'known', 'E5', E5);
    const { findings, log } = run(m, [], [
      { category: 'bottleneck', step_ids: ['S2'], evidence: [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }], source: 'model' },
      { category: 'repeated_customer_followup', step_ids: [], evidence: [{ evidence_id: 'E5', quote: E5 }], source: 'model' },
    ] as never);
    const bottleneck = findings.find((f) => f.category === 'bottleneck')!;
    assert.equal(bottleneck.status, 'rejected');
    assert.ok(log.some((l) => /rejected model finding bottleneck/.test(l)));
    const chasing = findings.find((f) => f.category === 'repeated_customer_followup')!;
    assert.equal(chasing.status, 'confirmed');
    assert.equal(chasing.source, 'model');
  });

  it('works end to end through discovery: the unsupported proposal is audited, not shown', async () => {
    const store = new Store();
    const d = new Discovery(store);
    const { state: s0 } = await d.start('x', 'We keep losing new customer inquiries.');
    await d.answer(s0.assessment.id, s0.open_question!.id, 'Maria copies the details into our spreadsheet. The technician calls the customer.');
    const { state } = d.proposeFindings(s0.assessment.id, [
      { category: 'single_point_of_failure', step_ids: ['S1'], evidence: [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }] },
    ], 'claude');
    const f = state.assessment.model.findings.find((x) => x.source === 'model')!;
    assert.equal(f.status, 'rejected');
    assert.equal(store.revisions(s0.assessment.id).at(-1)!.actor, 'claude');
  });
});

describe('findings stay consistent as the model changes', () => {
  it('keeps finding ids stable across re-detection', () => {
    const first = run(model()).findings;
    const again = run(model(), first).findings;
    assert.deepEqual(live(again).map((f) => f.id).sort(), live(first).map((f) => f.id).sort());
  });

  it('keeps a human "disputed" decision and does not raise the finding again as confirmed', () => {
    const first = run(model()).findings;
    const disputed = first.map((f) => (f.category === 'manual_reentry' ? { ...f, status: 'user_disputed' as const } : f));
    const again = run(model(), disputed).findings;
    assert.equal(again.find((f) => f.category === 'manual_reentry')!.status, 'user_disputed');
  });

  it('removes a finding when a change to the model removes its support', () => {
    const first = run(model()).findings;
    const m = model();
    m.workflow.completion = fact('Marked closed in the spreadsheet when the job is booked', 'known', 'E2', 'Maria copies the details into our spreadsheet');
    const { findings, log } = run(m, first);
    assert.ok(!findings.some((f) => f.category === 'missing_terminal_condition'));
    assert.ok(log.some((l) => /missing_terminal_condition no longer supported/.test(l)));
  });

  it('re-checks model-proposed findings against the current model, so a correction can invalidate them', () => {
    const m = model();
    m.workflow.completion = fact('Customers call us back asking what is happening', 'known', 'E5', E5);
    const first = run(m, [], [{ category: 'repeated_customer_followup', step_ids: [], evidence: [{ evidence_id: 'E5', quote: E5 }], source: 'model' }] as never).findings;
    assert.equal(first.find((f) => f.source === 'model')!.status, 'confirmed');
    // The fact that linked the quote is corrected away: the carried-forward finding no longer holds.
    const corrected = model();
    const after = run(corrected, first).findings.find((f) => f.source === 'model')!;
    assert.equal(after.status, 'rejected');
    assert.match(after.rejection_reason!, /not linked/);
  });
});

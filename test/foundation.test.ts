import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { emptyFact, emptyWorkflow, type Fact, type Model, type Step } from '../src/domain.ts';
import { Store, NotFoundError } from '../src/store.ts';
import { ValidationError, checkEvidenceRef, validateModel } from '../src/validate.ts';

const PROBLEM = 'We keep losing new customer inquiries and I do not know why.';
const ANSWER = 'Inquiries come in through the website form and land in the office inbox. Maria copies them into a spreadsheet.';

const known = (value: string, quote: string): Fact => ({ value, status: 'known', evidence: [{ evidence_id: 'E2', quote }] });

function stepFrom(id: string, quote: string, extra: Partial<Step> = {}): Step {
  return { id, summary: 'Copy inquiry into spreadsheet', owner: known('Maria', quote), system: known('spreadsheet', quote),
    handoff_in: emptyFact(), waiting_on: emptyFact(), manual: true, decision: false,
    evidence: [{ evidence_id: 'E2', quote }], ...extra };
}

describe('evidence references', () => {
  const evidence = [
    { id: 'E1', kind: 'problem_statement' as const, question_id: null, text: PROBLEM, created_at: 't' },
    { id: 'E2', kind: 'answer' as const, question_id: 'Q1', text: ANSWER, created_at: 't' },
  ];

  it('accepts an exact quote, ignoring case and whitespace', () => {
    assert.equal(checkEvidenceRef({ evidence_id: 'E2', quote: 'maria  COPIES them into a spreadsheet' }, evidence), null);
  });

  it('rejects a quote the user never said', () => {
    assert.match(checkEvidenceRef({ evidence_id: 'E2', quote: 'leads are ignored for weeks' }, evidence) ?? '', /does not appear/);
  });

  it('rejects evidence that does not exist', () => {
    assert.match(checkEvidenceRef({ evidence_id: 'E9', quote: 'Maria copies them' }, evidence) ?? '', /does not exist/);
  });

  it('rejects quotes too short to support a claim', () => {
    assert.match(checkEvidenceRef({ evidence_id: 'E2', quote: 'Maria' }, evidence) ?? '', /too short/);
  });
});

describe('model validation', () => {
  const evidence = [{ id: 'E2', kind: 'answer' as const, question_id: null, text: ANSWER, created_at: 't' }];
  const base = (): Model => ({
    workflow: { ...emptyWorkflow('New inquiry'), steps: [stepFrom('S1', 'Maria copies them into a spreadsheet')] },
    findings: [],
  });

  it('accepts a grounded model', () => {
    assert.deepEqual(validateModel(base(), evidence), []);
  });

  it('requires every step to carry evidence', () => {
    const m = base();
    m.workflow.steps[0].evidence = [];
    assert.ok(validateModel(m, evidence).some((e) => /has no evidence/.test(e)));
  });

  it('rejects duplicate step ids and malformed ids', () => {
    const m = base();
    m.workflow.steps.push(stepFrom('S1', 'Maria copies them into a spreadsheet'), stepFrom('step-3', 'Maria copies them into a spreadsheet'));
    const errors = validateModel(m, evidence);
    assert.ok(errors.some((e) => /duplicated/.test(e)));
    assert.ok(errors.some((e) => /must look like S1/.test(e)));
  });

  it('treats "known" and "absent" facts as claims that need evidence', () => {
    const m = base();
    m.workflow.completion = { value: null, status: 'absent', evidence: [] };
    assert.ok(validateModel(m, evidence).some((e) => /completion has no evidence/.test(e)));
  });

  it('distinguishes the four certainty states and enforces what each needs', () => {
    const m = base();
    m.workflow.trigger = { value: 'form', status: 'unknown', evidence: [] };
    m.workflow.completion = { value: null, status: 'inferred', evidence: [{ evidence_id: 'E2', quote: 'Maria copies them into a spreadsheet' }] };
    const errors = validateModel(m, evidence);
    assert.ok(errors.some((e) => /trigger is unknown but has a value/.test(e)));
    assert.ok(errors.some((e) => /completion is inferred but has no value/.test(e)));
  });

  it('refuses "known" when every quote behind it is hedged', () => {
    const hedged = [{ id: 'E2', kind: 'answer' as const, question_id: null, text: 'I think Maria usually copies them into a spreadsheet.', created_at: 't' }];
    const m = base();
    const q = 'I think Maria usually copies them';
    m.workflow.steps[0] = stepFrom('S1', q, { owner: { value: 'Maria', status: 'known', evidence: [{ evidence_id: 'E2', quote: q }] }, system: emptyFact() });
    assert.ok(validateModel(m, hedged).some((e) => /all its evidence is hedged/.test(e)));
    m.workflow.steps[0].owner.status = 'inferred';
    assert.deepEqual(validateModel(m, hedged), []);
  });

  it('allows a short quote only when it is the whole statement', () => {
    const ev = [{ id: 'E3', kind: 'answer' as const, question_id: 'Q2', text: 'Yes.', created_at: 't' },
      { id: 'E4', kind: 'answer' as const, question_id: 'Q3', text: 'Yes, but only on weekdays.', created_at: 't' }];
    assert.equal(checkEvidenceRef({ evidence_id: 'E3', quote: 'Yes.' }, ev), null);
    assert.match(checkEvidenceRef({ evidence_id: 'E4', quote: 'Yes' }, ev) ?? '', /too short/);
  });

  it('rejects findings outside the taxonomy, on unknown steps, or without evidence', () => {
    const m = base();
    m.findings = [{ id: 'F1', category: 'bad_vibes' as never, step_ids: ['S7'], evidence: [], rationale: 'r',
      source: 'model', status: 'confirmed', rejection_reason: null }];
    const errors = validateModel(m, evidence);
    assert.ok(errors.some((e) => /not in the friction taxonomy/.test(e)));
    assert.ok(errors.some((e) => /unknown step S7/.test(e)));
    assert.ok(errors.some((e) => /findings\[0\] has no evidence/.test(e)));
  });

  it('keeps rejected findings for audit without requiring evidence, but requires a reason', () => {
    const m = base();
    m.findings = [{ id: 'F1', category: 'bottleneck', step_ids: [], evidence: [], rationale: '', source: 'model',
      status: 'rejected', rejection_reason: null }];
    assert.ok(validateModel(m, evidence).some((e) => /no rejection_reason/.test(e)));
    m.findings[0].rejection_reason = 'quote not found in evidence';
    assert.deepEqual(validateModel(m, evidence), []);
  });
});

describe('store: persistence and revisions', () => {
  it('creates an assessment with the problem statement as evidence E1 and an empty model', () => {
    const store = new Store();
    const a = store.createAssessment('New customer inquiry', PROBLEM);
    assert.equal(a.id, 'ASM-0001');
    assert.equal(a.status, 'discovery');
    assert.deepEqual(a.evidence.map((e) => [e.id, e.kind]), [['E1', 'problem_statement']]);
    assert.equal(a.model.workflow.steps.length, 0);
    assert.equal(a.revision, 1);
  });

  it('records answers as evidence and closes the question atomically', () => {
    const store = new Store();
    const a = store.createAssessment('New customer inquiry', PROBLEM);
    const q = store.addQuestion(a.id, { dimension: 'trigger', slot: 'trigger', intent: 'discover', text: 'What starts the process?' });
    const ev = store.answerQuestion(a.id, q.id, ANSWER);
    const after = store.get(a.id);
    assert.equal(ev.id, 'E2');
    assert.equal(after.questions[0].status, 'answered');
    assert.equal(after.questions[0].answer_evidence_id, 'E2');
    assert.throws(() => store.answerQuestion(a.id, q.id, 'again'), ValidationError);
  });

  it('refuses to save a model that fails validation, and writes nothing', () => {
    const store = new Store();
    const a = store.createAssessment('New customer inquiry', PROBLEM);
    const bad: Model = { workflow: { ...a.model.workflow, steps: [stepFrom('S1', 'a claim nobody made anywhere')] }, findings: [] };
    assert.throws(() => store.saveModel(a.id, bad, 'extraction', 'interpreter'), ValidationError);
    assert.equal(store.get(a.id).revision, 1);
  });

  it('keeps every revision, so corrections are traceable', () => {
    const store = new Store();
    const a = store.createAssessment('New customer inquiry', PROBLEM);
    const q = store.addQuestion(a.id, { dimension: 'steps', slot: 'sequence', intent: 'discover', text: 'What happens next?' });
    store.answerQuestion(a.id, q.id, ANSWER);
    const v1: Model = { workflow: { ...a.model.workflow, steps: [stepFrom('S1', 'Maria copies them into a spreadsheet')] }, findings: [] };
    store.saveModel(a.id, v1, 'extracted from E2', 'interpreter');
    const v2: Model = structuredClone(v1);
    v2.workflow.steps[0].owner = known('Maria copies', 'Maria copies them into a spreadsheet');
    v2.workflow.steps[0].owner.value = 'Dana';
    store.saveModel(a.id, v2, 'user corrected owner of S1', 'user');

    assert.equal(store.get(a.id).model.workflow.steps[0].owner.value, 'Dana');
    assert.equal(store.getRevision(a.id, 2).workflow.steps[0].owner.value, 'Maria');
    assert.deepEqual(store.revisions(a.id).map((r) => [r.revision, r.actor]), [[1, 'system'], [2, 'interpreter'], [3, 'user']]);
  });

  it('never reuses step ids', () => {
    const store = new Store();
    const a = store.createAssessment('x', PROBLEM);
    assert.deepEqual([store.nextStepId(a.id), store.nextStepId(a.id), store.nextFindingId(a.id)], ['S1', 'S2', 'F1']);
  });

  it('survives a restart: data is read back from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ilsa-'));
    try {
      const path = join(dir, 'ilsa.db');
      const first = new Store(path);
      const a = first.createAssessment('New customer inquiry', PROBLEM);
      first.addQuestion(a.id, { dimension: 'trigger', slot: 'trigger', intent: 'discover', text: 'What starts the process?' });
      first.db.close();

      const reopened = new Store(path);
      const b = reopened.get(a.id);
      assert.equal(b.problem_statement, PROBLEM);
      assert.equal(b.questions.length, 1);
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unknown assessments clearly', () => {
    assert.throws(() => new Store().get('ASM-9999'), NotFoundError);
  });
});

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp, makeApp } from '../src/server.ts';
import { Store } from '../src/store.ts';

describe('HTTP API and the no-key sample', () => {
  const server = createApp(makeApp(new Store()));
  let base = '';
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => server.close());

  const post = async (path: string, body: object = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const get = async (path: string) => (await fetch(base + path)).json();

  it('the finished sample runs the whole pipeline without an API key and shows the required friction', async () => {
    const { status, data } = await post('/sample', { mode: 'complete' });
    assert.equal(status, 201);
    const v = data.view;
    assert.equal(v.is_sample, true);
    assert.ok(v.assessment.active, 'a current assessment exists');
    const cats = new Set(v.findings.map((f: { category: string }) => f.category));
    for (const c of ['information_loss', 'manual_reentry', 'unclear_ownership', 'missing_exception_handling', 'missing_terminal_condition']) {
      assert.ok(cats.has(c), `sample should show ${c}`);
    }
    assert.ok(v.findings.some((f: { status: string }) => f.status === 'tentative'), 'at least one tentative finding to confirm or dispute');
  });

  it('the guided sample offers a sample answer for every question, and keeps recommendations locked at first', async () => {
    const { data } = await post('/sample', { mode: 'guided' });
    const v = data.view;
    assert.equal(v.question.slot, 'sequence');
    assert.match(v.question.sample_answer, /contact form/);
    assert.ok(v.question.why.length > 10, 'every question says why it matters');
    assert.equal(v.assessment.active, null);
    assert.equal(v.readiness.ready, false);
    const refused = await post(`/assessments/${v.id}/generate`);
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Not ready to assess/);
  });

  it('the correction loop: a correction removes a finding, updates lineage, and regenerates', async () => {
    const { data } = await post('/sample', { mode: 'complete' });
    const id = data.view.id;
    const before = data.view.assessment.active.recommendations.find((r: { title: string }) => r.title.startsWith('Hand work over'));
    assert.equal(before.finding_ids.length, 2);
    const { status, data: after } = await post(`/assessments/${id}/review/set-fact`, {
      slot: 'S4.handoff_in', value: 'The owner assigns it in the spreadsheet and the technician works from there.',
    });
    assert.equal(status, 200);
    assert.equal(after.change.regenerated, true);
    const rec = after.view.assessment.active.recommendations.find((r: { title: string }) => r.title.startsWith('Hand work over'));
    assert.equal(rec.finding_ids.length, 1);
    const fact = after.view.workflow.steps.find((s: { id: string }) => s.id === 'S4').handoff_in;
    assert.deepEqual([fact.by, fact.user_action, fact.was.value], ['user', 'corrected', 'The owner texts the technician the customer name']);
  });

  it('keeps rejected, audit-only findings out of the normal view', async () => {
    const { data } = await post('/sample', { mode: 'complete' });
    const v = data.view;
    assert.ok(v.findings.every((f: { status: string }) => f.status !== 'rejected'));
    const audit = await get(`/assessments/${v.id}/audit`);
    assert.ok(Array.isArray(audit.rejected));
    assert.ok(audit.revisions.length > 1);
  });

  it('reports bad input clearly', async () => {
    assert.equal((await post('/assessments', { name: '', problem: '' })).status, 400);
    assert.equal((await fetch(`${base}/assessments/ASM-9999`)).status, 404);
    const { data } = await post('/sample', { mode: 'complete' });
    assert.equal((await post(`/assessments/${data.view.id}/review/dispute-finding`, { finding_id: 'F1', reason: '' })).status, 400);
  });
});

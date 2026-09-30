import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Assessor } from '../src/assess.ts';
import { Discovery } from '../src/discovery.ts';
import type { Report } from '../src/domain.ts';
import { Review } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { ValidationError } from '../src/validate.ts';
import { INQUIRY_ANSWERS, INQUIRY_PROBLEM, interview } from './scenario.ts';

async function assessed(answers = INQUIRY_ANSWERS) {
  const store = new Store();
  const d = new Discovery(store);
  const x = new Assessor(store);
  const r = new Review(store, d, x);
  const { state } = await d.start('New customer inquiry', INQUIRY_PROBLEM);
  const done = await interview(d, state, answers);
  const id = done.assessment.id;
  const first = x.generate(id);
  assert.ok(first.ok, 'scenario should be assessable');
  return { store, d, x, r, id };
}

const step = (store: Store, id: string, sid: string) => store.get(id).model.workflow.steps.find((s) => s.id === sid)!;
const finding = (store: Store, id: string, category: string, stepIds?: string) =>
  store.get(id).model.findings.find((f) => f.category === category && (stepIds === undefined || f.step_ids.join(',') === stepIds));
const active = (x: Assessor, id: string): Report => {
  const c = x.current(id);
  assert.ok(c.active, 'expected an active assessment');
  return c.active!;
};

describe('corrections are authoritative, and history is preserved', () => {
  it('creates a new revision, keeps the old one and the evidence, and records what Ilsa had', async () => {
    const { store, r, x, id } = await assessed();
    const before = store.get(id);
    const res = r.setFact(id, 'S3.owner', { value: 'Dana' });
    const after = store.get(id);

    assert.equal(res.action, 'correction');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(store.getRevision(id, before.revision).workflow.steps[2].owner.value, 'owner', 'old revision untouched');
    const owner = step(store, id, 'S3').owner;
    assert.deepEqual([owner.value, owner.by, owner.user_action], ['Dana', 'user', 'corrected']);
    assert.deepEqual(owner.was, { value: 'owner', status: 'known' });
    // Evidence is append-only: everything from before is still there, plus the correction.
    assert.deepEqual(after.evidence.slice(0, before.evidence.length), before.evidence);
    const ev = after.evidence.at(-1)!;
    assert.deepEqual([ev.kind, ev.about, ev.text], ['correction', 'S3.owner', 'Dana']);
    assert.equal(store.revisions(id).at(-1)!.actor, 'user');
    // The assessment was regenerated from the corrected model.
    assert.equal(active(x, id).based_on_revision, after.revision);
  });

  it('does not let later interpretation override a user correction', async () => {
    const { store, r, id } = await assessed();
    r.setFact(id, 'S3.owner', { value: 'Dana' });
    const steps = store.get(id).model.workflow.steps.length;
    const res = await r.addContext(id, 'Then the owner decides who should handle it, like I said.');
    assert.equal(step(store, id, 'S3').owner.value, 'Dana');
    assert.equal(store.get(id).model.workflow.steps.length, steps, 'a restated step is not duplicated');
    assert.ok(res.log.some((l) => /set by the user during review/.test(l)));
  });

  it('keeps Ilsa\'s original wording when a step is corrected', async () => {
    const { store, r, id } = await assessed();
    r.editStep(id, 'S2', 'Maria retypes each inquiry into the Leads spreadsheet');
    const s = step(store, id, 'S2');
    assert.equal(s.summary, 'Maria retypes each inquiry into the Leads spreadsheet');
    assert.equal(s.summary_was, 'Maria copies the details into our spreadsheet');
  });

  it('rejects malformed review actions without recording anything', async () => {
    const { store, r, id } = await assessed();
    const n = store.get(id).evidence.length;
    assert.throws(() => r.setFact(id, 'S9.owner', { value: 'x' }), ValidationError);
    assert.throws(() => r.setFact(id, 'sequence', { value: 'x' }), ValidationError);
    assert.throws(() => r.disputeFinding(id, 'F1', '  '), ValidationError);
    assert.throws(() => r.moveStep(id, 'S1', 99), ValidationError);
    assert.equal(store.get(id).evidence.length, n);
  });
});

describe('FAILURE CASE 3: a correction contradicts what Ilsa extracted', () => {
  it('removes findings that lose support, and recommendations whose lineage depended only on them', async () => {
    const { store, r, x, id } = await assessed();
    const handoffRec = () => active(x, id).recommendations.find((rec) => rec.title.startsWith('Hand work over'));
    const f34 = finding(store, id, 'information_loss', 'S3,S4')!;
    const f23 = finding(store, id, 'information_loss', 'S2,S3')!;
    assert.deepEqual(handoffRec()!.finding_ids.sort(), [f23.id, f34.id].sort());

    // Ilsa had: "The owner texts the technician the customer name". The user corrects it.
    const res = r.setFact(id, 'S4.handoff_in', { value: 'The owner assigns it in the spreadsheet and the technician works from there.' });
    assert.ok(res.log.some((l) => l.startsWith(`${f34.id}: information_loss no longer supported`)));
    assert.ok(res.assessment.regenerated);
    assert.deepEqual(handoffRec()!.finding_ids, [f23.id], 'recommendation keeps its remaining lineage');

    r.setFact(id, 'S3.handoff_in', { value: 'Maria assigns it to the owner in the spreadsheet.' });
    assert.equal(handoffRec(), undefined, 'no lineage left: the recommendation is removed');
    assert.ok(!active(x, id).observed_friction.confirmed.some((f) => f.category === 'information_loss'));
  });

  it('never presents an outdated report as the assessment when a correction breaks readiness', async () => {
    const { store, r, x, id } = await assessed();
    const res = r.moveStep(id, 'S4', 1);
    // Moving S4 changes which step precedes several others, so their handoffs must be re-established.
    assert.ok(res.log.some((l) => /handoff_in: cleared/.test(l)));
    assert.equal(res.assessment.regenerated, false);
    const c = x.current(id);
    assert.equal(c.active, null);
    assert.ok(c.previous, 'the old report is kept, but only as "previous"');
    assert.equal(store.get(id).status, 'review');
    assert.ok(c.readiness.blocking.some((b) => b.dimension === 'handoffs'));
  });
});

describe('confirmation, marking unknown, adding steps', () => {
  it('accepting a tentative finding makes its recommendation actionable', async () => {
    const answers = { ...INQUIRY_ANSWERS, 'S2.handoff_in:discover': "I don't know how she finds out." };
    const { store, r, x, id } = await assessed(answers);
    const f = finding(store, id, 'information_loss', 'S1,S2')!;
    assert.equal(f.status, 'tentative');
    const recFor = () => active(x, id).recommendations.find((rec) => rec.finding_ids.includes(f.id))!;
    // Other confirmed information-loss findings share the recommendation, so check the tentative-only view:
    assert.ok(active(x, id).observed_friction.needs_confirmation.some((n) => n.id === f.id));

    const res = r.acceptFinding(id, f.id);
    assert.equal(res.action, 'confirmation');
    assert.equal(finding(store, id, 'information_loss', 'S1,S2')!.status, 'user_accepted');
    assert.equal(recFor().kind, 'act');
    assert.ok(active(x, id).observed_friction.confirmed.some((n) => n.id === f.id));
  });

  it('confirms an inferred fact, and refuses to "confirm" something unknown', async () => {
    const { store, r, id } = await assessed();
    r.setFact(id, 'S4.system', { value: 'I think they use their phone' });
    assert.equal(step(store, id, 'S4').system.status, 'inferred', 'hedged corrections stay inferred');
    r.confirm(id, 'S4.system');
    assert.deepEqual([step(store, id, 'S4').system.status, step(store, id, 'S4').system.user_action], ['known', 'confirmed']);
    r.markUnknown(id, 'S3.system');
    assert.throws(() => r.confirm(id, 'S3.system'), /nothing to confirm/);
  });

  it('marking a foundational field unknown counts as understood-and-unknown, not a gap', async () => {
    const { store, r, x, id } = await assessed();
    const res = r.markUnknown(id, 'S2.handoff_in', 'Nobody really knows how Maria finds out.');
    assert.ok(res.assessment.regenerated);
    assert.ok(active(x, id).unknowns.some((u) => u.slot === 'S2.handoff_in' && u.kind === 'user_does_not_know'));
    assert.equal(step(store, id, 'S2').handoff_in.user_action, 'marked_unknown');
  });

  it('adding a missing step requires the step list to be re-confirmed before assessing again', async () => {
    const { store, r, x, id } = await assessed();
    const res = r.addStep(id, { summary: 'The owner reviews the spreadsheet every Monday', position: 3, owner: 'the owner', system: 'spreadsheet' });
    const added = store.get(id).model.workflow.steps[3];
    assert.deepEqual([added.added_by, added.owner.by, added.system.value], ['user', 'user', 'spreadsheet']);
    assert.equal(res.assessment.regenerated, false);
    assert.ok(x.current(id).readiness.blocking.some((b) => b.problem === 'sequence_unconfirmed'));

    r.confirmSequence(id);
    // The step after the insertion has a new predecessor, so its handoff was cleared; re-establish it.
    for (const b of x.current(id).readiness.blocking) r.markUnknown(id, b.slot);
    assert.ok(x.current(id).active, 'assessment regenerated once the gate passes again');
  });
});

describe('sticky disputes', () => {
  it('excludes a disputed finding and its recommendation, and keeps the dispute on record', async () => {
    const { store, r, x, id } = await assessed();
    const f = finding(store, id, 'manual_reentry')!;
    const res = r.disputeFinding(id, f.id, 'Maria only copies the rare ones that are missing a phone number.');
    assert.equal(res.action, 'dispute');
    const report = active(x, id);
    assert.ok(!report.observed_friction.confirmed.some((x) => x.id === f.id));
    assert.ok(!report.recommendations.some((rec) => rec.finding_ids.includes(f.id)));
    const stored = finding(store, id, 'manual_reentry')!;
    assert.equal(stored.status, 'user_disputed');
    assert.equal(store.get(id).evidence.find((e) => e.id === stored.review!.evidence_id)!.kind, 'dispute');
  });

  it('does not bring a disputed finding back after unrelated changes', async () => {
    const { store, r, id } = await assessed();
    const f = finding(store, id, 'manual_reentry')!;
    r.disputeFinding(id, f.id, 'Not really a problem for us.');
    r.setFact(id, 'S3.owner', { value: 'Dana' });
    await r.addContext(id, 'We get about ten inquiries a week.');
    const all = store.get(id).model.findings.filter((x) => x.category === 'manual_reentry');
    assert.deepEqual(all.map((x) => x.status), ['user_disputed']);
  });

  it('raises it again, as a new finding, only when materially new evidence supports it', async () => {
    const { store, r, id } = await assessed();
    const f = finding(store, id, 'manual_reentry')!;
    r.disputeFinding(id, f.id, 'Not really a problem for us.');
    // New, directly relevant evidence: the user says Maria retypes into two tools.
    const res = r.setFact(id, 'S2.system', { value: 'spreadsheet, QuickBooks' });
    const all = store.get(id).model.findings.filter((x) => x.category === 'manual_reentry');
    assert.equal(all.length, 2);
    const old = all.find((x) => x.id === f.id)!;
    const fresh = all.find((x) => x.id !== f.id)!;
    assert.equal(old.status, 'user_disputed', 'the dispute stays on record');
    assert.equal(fresh.status, 'confirmed');
    assert.ok(res.log.some((l) => new RegExp(`raised again on new evidence .* \\(${f.id} was disputed earlier\\)`).test(l)));
  });
});

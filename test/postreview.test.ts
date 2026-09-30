import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Discovery } from '../src/discovery.ts';
import { emptyWorkflow, newStep, type Evidence, type Fact, type Model } from '../src/domain.ts';
import { diagnose } from '../src/friction.ts';
import { candidates, handoffSteps } from '../src/gaps.ts';
import { extractSystems } from '../src/interpret/heuristic.ts';
import { emptyDelta, type Interpreter } from '../src/interpret/types.ts';
import { readiness } from '../src/readiness.ts';
import { Store } from '../src/store.ts';

// One test per post-review fix (see eval/README.md, Run 2).

describe('fix 1: the opening complaint cannot create steps', () => {
  it('extracts no steps from a complaint full of action verbs', async () => {
    const d = new Discovery(new Store());
    const { state, interpretation } = await d.start('x', 'Customers keep calling to ask whether their estimate is ready. We send quotes but nobody hears back from us.');
    assert.equal(state.assessment.model.workflow.steps.length, 0);
    assert.ok(interpretation.dropped.some((x) => /only from the problem statement/.test(x)) || interpretation.applied.length === 0);
  });

  it('holds for any interpreter, not just the no-key one', async () => {
    const eager: Interpreter = {
      name: 'eager',
      async interpret({ evidence }) {
        const d = emptyDelta();
        d.new_steps.push({ summary: 'We send quotes', evidence: [{ evidence_id: evidence.id, quote: 'We send quotes' }] });
        return d;
      },
    };
    const d = new Discovery(new Store(), eager);
    const { state, interpretation } = await d.start('x', 'We send quotes but nobody hears back.');
    assert.equal(state.assessment.model.workflow.steps.length, 0);
    assert.ok(interpretation.dropped.some((x) => /only from the problem statement/.test(x)));
  });
});

describe("fix 2: the customer's action is the trigger, not a step", () => {
  it('keeps "Clients call..." out of the steps and uses it as the trigger', async () => {
    const d = new Discovery(new Store());
    const { state: s0 } = await d.start('x', 'Refill requests take days.');
    const { state } = await d.answer(s0.assessment.id, s0.open_question!.id,
      'Clients call and leave a refill request on the voicemail line. The receptionist writes each request in the log. Then the vet approves refills.');
    const wf = state.assessment.model.workflow;
    assert.ok(!wf.steps.some((s) => /Clients call/.test(s.summary)));
    assert.match(wf.trigger.value ?? '', /Clients call/);
    assert.equal(wf.trigger.status, 'known');
    assert.ok(wf.steps.some((s) => /writes each request/.test(s.summary)));
  });
});

describe('fix 3: a wait that is already handled is not friction', () => {
  const ev: Evidence[] = [
    { id: 'E1', kind: 'answer', question_id: null, text: 'We wait for the couple to sign; the CRM sends reminders after three days.', created_at: 't' },
    { id: 'E2', kind: 'answer', question_id: null, text: 'We wait for the customer to call back with a good time.', created_at: 't' },
  ];
  const withWaiting = (id: string): Model => {
    const wf = emptyWorkflow('x');
    wf.waiting = { value: ev.find((e) => e.id === id)!.text, status: 'known', evidence: [{ evidence_id: id, quote: ev.find((e) => e.id === id)!.text }] } as Fact;
    return { workflow: wf, findings: [] };
  };
  let n = 0;
  const next = () => `F${++n}`;

  it('does not flag waiting covered by an automatic reminder', () => {
    assert.ok(!diagnose(withWaiting('E1'), ev, [], next).findings.some((f) => f.category === 'waiting_dependency'));
  });
  it('still flags waiting with nothing to prompt the next action', () => {
    assert.ok(diagnose(withWaiting('E2'), ev, [], next).findings.some((f) => f.category === 'waiting_dependency' && f.status === 'confirmed'));
  });
});

describe('fix 4: compound tool names are one tool', () => {
  it('reads "paper calendar" as one tool, not paper plus calendar', () => {
    assert.equal(extractSystems('The crews check the paper calendar each morning.'), 'paper or whiteboard');
    assert.equal(extractSystems('Email and the paper log.'), 'paper or whiteboard, email');
    assert.equal(extractSystems('It goes on the shared calendar.'), 'calendar');
  });
});

describe('fix 5: unknown owners no longer hide handoffs', () => {
  const ev: Evidence[] = [{ id: 'E1', kind: 'answer', question_id: null, text: 'Maria copies the details. Then the owner decides. Then someone replies.', created_at: 't' }];
  const model = (): Model => {
    const wf = emptyWorkflow('x');
    const q = (t: string) => [{ evidence_id: 'E1', quote: t }];
    const s1 = newStep('S1', 'Maria copies the details', q('Maria copies the details'));
    s1.owner = { value: 'Maria', status: 'known', evidence: q('Maria copies the details') };
    const s2 = newStep('S2', 'Then the owner decides', q('Then the owner decides')); // owner unknown
    const s3 = newStep('S3', 'Then someone replies', q('Then someone replies'));
    s3.owner = { value: 'Maria', status: 'known', evidence: q('Maria copies the details') };
    const s4 = newStep('S4', 'Maria copies the details again', q('Maria copies the details'));
    s4.owner = { value: 'Maria', status: 'known', evidence: q('Maria copies the details') };
    wf.steps = [s1, s2, s3, s4];
    return { workflow: wf, findings: [] };
  };

  it('treats a step next to an unknown owner as a possible handoff, and rules one out only for the same known owner', () => {
    assert.deepEqual(handoffSteps(model()).map((s) => s.id), ['S2', 'S3']);
  });
  it('asks about it and blocks readiness until it is answered or marked unknown', () => {
    assert.ok(candidates(model(), []).some((c) => c.slot === 'S2.handoff_in'));
    assert.ok(readiness(model(), []).blocking.some((b) => b.slot === 'S2.handoff_in'));
    void ev;
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Discovery } from '../src/discovery.ts';
import { coverage, factState, nextQuestion } from '../src/gaps.ts';
import { HeuristicInterpreter } from '../src/interpret/heuristic.ts';
import { emptyDelta, type Interpreter } from '../src/interpret/types.ts';
import { Store } from '../src/store.ts';

const PROBLEM = "We keep losing new customer inquiries and I don't know why.";
const WALKTHROUGH =
  'A customer fills out the contact form on our website. The form sends an email to the office inbox. ' +
  'Maria copies the details into our spreadsheet. Then the owner decides who should handle it. ' +
  'The technician calls the customer to set up a visit. Sometimes nobody follows up.';

const make = (interpreter?: Interpreter) => {
  const store = new Store();
  return { store, d: new Discovery(store, interpreter ?? new HeuristicInterpreter()) };
};

describe('discovery: understand before recommending', () => {
  it('meets a vague problem with a discovery question, not a solution, and invents nothing', async () => {
    const { d } = make();
    const { state } = await d.start('New customer inquiry', 'Our leads fall through the cracks. Just tell me which CRM to buy.');
    assert.equal(state.open_question?.slot, 'sequence');
    assert.match(state.open_question!.text, /Walk me through/);
    // Nothing was assumed: no steps, and no dimension is established from a complaint.
    // "Leads fall through the cracks" is kept only as an inferred, unconfirmed exception.
    const wf = state.assessment.model.workflow;
    assert.equal(wf.steps.length, 0);
    assert.ok(!Object.values(state.coverage).includes('established'));
    assert.equal(wf.exceptions.status, 'inferred');
    assert.equal(wf.exceptions.evidence[0].evidence_id, 'E1');
    // The discovery module has no recommendation output at all.
    assert.equal('recommendations' in state, false);
  });

  it('turns a walk-through into grounded steps, each quoting the user', async () => {
    const { d } = make();
    const { state: s0 } = await d.start('New customer inquiry', PROBLEM);
    const { state } = await d.answer(s0.assessment.id, s0.open_question!.id, WALKTHROUGH);
    const wf = state.assessment.model.workflow;

    assert.equal(wf.trigger.status, 'known');
    assert.match(wf.trigger.value!, /contact form/);
    assert.deepEqual(wf.steps.map((s) => s.id), ['S1', 'S2', 'S3', 'S4']);
    const copy = wf.steps.find((s) => /copies/.test(s.summary))!;
    assert.deepEqual([copy.owner.value, copy.system.value, copy.manual], ['Maria', 'spreadsheet', true]);
    assert.equal(wf.steps.find((s) => /decides/.test(s.summary))!.decision, true);
    // "Sometimes nobody follows up" describes an exception, is hedged, so it is inferred and not a step.
    assert.equal(wf.exceptions.status, 'inferred');
    assert.ok(!wf.steps.some((s) => /nobody follows up/.test(s.summary)));
    // Every step is grounded in the user's own words.
    for (const s of wf.steps) assert.equal(s.evidence[0].evidence_id, 'E2');
  });
});

describe('discovery: unknown vs absent vs inferred', () => {
  async function walked() {
    const { d, store } = make();
    const { state: s0 } = await d.start('New customer inquiry', PROBLEM);
    await d.answer(s0.assessment.id, s0.open_question!.id, WALKTHROUGH);
    return { d, store, id: s0.assessment.id };
  }

  async function answerSlot(d: Discovery, id: string, slot: string, text: string) {
    let state = d.state(id);
    // Skip questions until the one about `slot` comes up (bounded).
    for (let i = 0; i < 20 && state.open_question && state.open_question.slot !== slot; i++) state = d.skip(id, state.open_question.id);
    assert.equal(state.open_question?.slot, slot, `expected a question about ${slot}`);
    return (await d.answer(id, state.open_question!.id, text)).state;
  }

  it('records an explicit "does not exist" as absent, which is knowledge rather than a gap', async () => {
    const { d, id } = await walked();
    const state = await answerSlot(d, id, 'completion', "Honestly nobody closes them out. They just stay in the spreadsheet.");
    assert.equal(state.assessment.model.workflow.completion.status, 'absent');
    assert.equal(state.coverage.completion, 'established');
  });

  it('keeps "I don\'t know" as unknown, records that it was asked, and never asks again', async () => {
    const { d, id } = await walked();
    const state = await answerSlot(d, id, 'completion', "I'm not sure, I've never really thought about it.");
    const f = state.assessment.model.workflow.completion;
    assert.equal(f.status, 'unknown');
    assert.equal(f.value, null, 'no value was assumed');
    assert.equal(factState(f), 'unresolved');
    assert.ok(!state.question_ranking.some((c) => c.slot === 'completion'), 'completion is not asked again');
  });

  it('holds a hedged answer as inferred, asks to confirm it, and promotes it only on confirmation', async () => {
    const { d, id } = await walked();
    const s1 = await answerSlot(d, id, 'S1.owner', 'I think Dana usually handles that part.');
    const owner = s1.assessment.model.workflow.steps.find((s) => s.id === 'S1')!.owner;
    assert.equal(owner.status, 'inferred');

    const s2 = await answerSlot(d, id, 'S1.owner', 'Yes.');
    const confirmQ = s2.assessment.questions.find((q) => q.slot === 'S1.owner' && q.intent === 'confirm')!;
    assert.match(confirmQ.text, /Is that always how it works/);
    const confirmed = s2.assessment.model.workflow.steps.find((s) => s.id === 'S1')!.owner;
    assert.equal(confirmed.status, 'known');
    assert.equal(confirmed.evidence.length, 2, 'keeps both the original statement and the confirmation');
  });
});

describe('discovery: question selection', () => {
  it('asks the question that removes the most uncertainty, and never about settled facts', async () => {
    const { d } = make();
    const { state: s0 } = await d.start('New customer inquiry', PROBLEM);
    const { state } = await d.answer(s0.assessment.id, s0.open_question!.id, WALKTHROUGH);
    // Trigger is already known from the walk-through; completion (weight 3, unknown) outranks
    // per-step detail such as which tool a step uses (weight 1).
    assert.equal(state.open_question!.slot, 'completion');
    const ranked = state.question_ranking;
    assert.ok(!ranked.some((c) => c.slot === 'trigger'), 'a known fact is never asked about');
    const system = ranked.find((c) => c.slot.endsWith('.system'))!;
    assert.ok(system.score < 3);
    for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score);
  });

  it('does not re-ask "is this list complete?" unless the list changed since the user last saw it', async () => {
    const { d } = make();
    const { state: s0 } = await d.start('x', PROBLEM);
    const id = s0.assessment.id;
    let state = (await d.answer(id, s0.open_question!.id, WALKTHROUGH)).state;
    for (let i = 0; i < 20 && state.open_question?.slot !== 'sequence'; i++) state = d.skip(id, state.open_question!.id);
    state = (await d.answer(id, state.open_question!.id, 'Hmm, not quite.')).state; // adds no steps
    assert.ok(!state.question_ranking.some((c) => c.slot === 'sequence'));
    assert.notEqual(state.open_question?.slot, 'sequence');
  });

  it('always terminates: a user who answers "I don\'t know" to everything ends discovery with gaps reported', async () => {
    const { d } = make();
    const { state: s0 } = await d.start('New customer inquiry', PROBLEM);
    let state = (await d.answer(s0.assessment.id, s0.open_question!.id, WALKTHROUGH)).state;
    let asked = 0;
    while (state.open_question && asked < 50) {
      state = (await d.answer(state.assessment.id, state.open_question.id, "I don't know.")).state;
      asked++;
    }
    assert.equal(state.complete, true);
    assert.ok(asked < 50);
    assert.ok(Object.values(coverage(state.assessment.model)).includes('unresolved'));
  });
});

describe('heuristic extraction details', () => {
  it('does not mistake a leading "I think" for the person doing the work', async () => {
    const { extractOwner } = await import('../src/interpret/heuristic.ts');
    assert.equal(extractOwner('I think the owner usually texts the tech.'), 'owner');
    assert.equal(extractOwner('I call them back the same day.'), 'you (the person describing the process)');
    assert.equal(extractOwner('Whoever sees it first replies to the customer.'), 'Whoever sees it first');
  });
});

describe('discovery: deterministic merge rules applied to any interpreter', () => {
  it('drops proposals whose evidence the user never gave', async () => {
    const liar: Interpreter = {
      name: 'fabricating',
      async interpret({ evidence }) {
        const d = emptyDelta();
        d.new_steps.push({ summary: 'Leads are ignored for weeks', evidence: [{ evidence_id: evidence.id, quote: 'leads are ignored for weeks' }] });
        d.workflow_facts.push({ field: 'completion', fact: { value: 'Closed in the CRM', status: 'known', evidence: [{ evidence_id: evidence.id, quote: 'we close them in the CRM' }] } });
        return d;
      },
    };
    const { d } = make(liar);
    const { state, interpretation } = await d.start('x', PROBLEM);
    assert.equal(state.assessment.model.workflow.steps.length, 0);
    assert.equal(state.assessment.model.workflow.completion.status, 'unknown');
    assert.equal(interpretation.dropped.length, 2);
  });

  it('downgrades "known" to "inferred" when the only evidence is hedged, whatever the interpreter claims', async () => {
    const overconfident: Interpreter = {
      name: 'overconfident',
      async interpret({ evidence }) {
        const d = emptyDelta();
        d.workflow_facts.push({ field: 'trigger', fact: { value: 'Website form', status: 'known', evidence: [{ evidence_id: evidence.id, quote: evidence.text }] } });
        return d;
      },
    };
    const { d } = make(overconfident);
    const { state } = await d.start('x', 'I think most inquiries probably come from the website form.');
    assert.equal(state.assessment.model.workflow.trigger.status, 'inferred');
  });

  it('does not let an unprompted, weaker proposal overwrite an established fact', async () => {
    let call = 0;
    const flipFlop: Interpreter = {
      name: 'flip-flop',
      async interpret({ evidence }) {
        const d = emptyDelta();
        call++;
        const quote = evidence.text;
        // Call 1 is the problem statement (nothing); call 2 establishes the trigger; call 3 tries to weaken it.
        if (call === 2) d.workflow_facts.push({ field: 'trigger', fact: { value: 'Website form', status: 'known', evidence: [{ evidence_id: evidence.id, quote }] } });
        if (call === 3) d.workflow_facts.push({ field: 'trigger', fact: { value: 'Phone call', status: 'inferred', evidence: [{ evidence_id: evidence.id, quote }] } });
        return d;
      },
    };
    const { d } = make(flipFlop);
    const { state: s0 } = await d.start('x', PROBLEM);
    const { state: s1 } = await d.answer(s0.assessment.id, s0.open_question!.id, 'Every inquiry comes in through the website form.');
    assert.equal(s1.assessment.model.workflow.trigger.status, 'known');
    assert.notEqual(s1.open_question!.slot, 'trigger');
    const { state, interpretation } = await d.answer(s0.assessment.id, s1.open_question!.id, 'We also talk to people I guess.');
    assert.equal(state.assessment.model.workflow.trigger.value, 'Website form');
    assert.ok(interpretation.dropped.some((x) => /would weaken/.test(x)));
  });

  it('falls back to the no-key interpreter when the primary one fails, and says so', async () => {
    const broken: Interpreter = { name: 'claude', async interpret() { throw new Error('503 overloaded'); } };
    const store = new Store();
    const d = new Discovery(store, broken);
    const { state: s0 } = await d.start('x', PROBLEM);
    const { state, interpretation } = await d.answer(s0.assessment.id, s0.open_question!.id, WALKTHROUGH);
    assert.equal(interpretation.interpreter, 'heuristic');
    assert.match(interpretation.applied[0], /claude failed \(503 overloaded\); used heuristic/);
    assert.ok(state.assessment.model.workflow.steps.length >= 3);
    assert.equal(store.revisions(s0.assessment.id).at(-1)!.actor, 'heuristic');
  });

  it('asks one question at a time', async () => {
    const { d } = make();
    const { state } = await d.start('x', PROBLEM);
    assert.equal(state.assessment.questions.filter((q) => q.status === 'open').length, 1);
    assert.equal(nextQuestion(state.assessment.model, state.assessment.questions), null);
  });
});

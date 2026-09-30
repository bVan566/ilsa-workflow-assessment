import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Discovery } from '../src/discovery.ts';
import { ClaudeFindingProposer, ClaudeInterpreter, type LlmClient, type LlmRequest, type LlmResponse } from '../src/interpret/claude.ts';
import { Store } from '../src/store.ts';

// The Claude client is replaced by fakes: these tests run offline, need no key, and cost
// nothing. They prove how the app treats model output. They do not measure model quality.

const PROBLEM = "We keep losing new customer inquiries and I don't know why.";
const WALK = 'The form sends an email to the office inbox. Maria copies the details into our spreadsheet. I think the owner usually decides who handles it.';

const reply = (json: unknown): LlmResponse => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(json) }] });
const step = (over: Record<string, unknown>) => ({
  summary: 's', quote: '', owner: '', owner_certainty: 'unknown', owner_quote: '', tool: '', tool_certainty: 'unknown', tool_quote: '',
  manual: 'unknown', decision: 'unknown', ...over,
});

/** A fake client that answers interpretation calls with `interp` and finding calls with `findings`. */
function fake(interp: (req: LlmRequest) => LlmResponse, findings?: (req: LlmRequest) => LlmResponse) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async create(req) {
      calls.push(req);
      if (req.system.startsWith('You look for operational friction')) {
        if (!findings) throw new Error('no findings fake');
        return findings(req);
      }
      return interp(req);
    },
  };
  return { client, calls };
}

const walkReply = () => reply({
  new_steps: [
    step({ summary: 'Form emails the office inbox', quote: 'The form sends an email to the office inbox', tool: 'email', tool_certainty: 'known', tool_quote: 'sends an email to the office inbox' }),
    step({ summary: 'Maria copies details into the spreadsheet', quote: 'Maria copies the details into our spreadsheet', owner: 'Maria', owner_certainty: 'known',
      tool: 'spreadsheet', tool_certainty: 'known', manual: 'yes' }),
    // Overclaims: the user hedged ("I think ... usually"), but the model says "known".
    step({ summary: 'Owner decides who handles it', quote: 'I think the owner usually decides who handles it', owner: 'owner', owner_certainty: 'known', decision: 'yes' }),
  ],
  fact_updates: [],
  step_list_confirmed: false,
});

async function started(client: LlmClient, withProposer = false) {
  const store = new Store();
  const d = new Discovery(store, new ClaudeInterpreter(client), undefined, withProposer ? new ClaudeFindingProposer(client) : undefined);
  const { state } = await d.start('New inquiry', PROBLEM);
  return { store, d, state };
}

describe('Claude interpreter: proposals only, governed by the same rules', () => {
  it('sends a structured-output request with the configured model, and asks it not to recommend', async () => {
    const { client, calls } = fake(() => reply({ new_steps: [], fact_updates: [], step_list_confirmed: false }));
    await started(client);
    const req = calls[0];
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.output_config.effort, 'low');
    assert.match(req.model, /^claude-/);
    assert.match(req.system, /Do not diagnose problems and do not recommend anything/);
  });

  it('turns valid output into grounded steps, and still downgrades a hedged "known" to inferred', async () => {
    const { client } = fake(walkReply);
    const { d, state } = await started(client);
    const { state: after, interpretation } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
    assert.equal(interpretation.interpreter, 'claude:claude-opus-5-5');
    const steps = after.assessment.model.workflow.steps;
    assert.deepEqual(steps.map((s) => s.id), ['S1', 'S2', 'S3']);
    assert.deepEqual([steps[1].owner.value, steps[1].manual], ['Maria', true]);
    assert.equal(steps[2].owner.status, 'inferred', 'the model said known; the hedged wording decides');
  });

  it('drops anything the model attributes to the user but the user never said', async () => {
    const { client } = fake(() => reply({
      new_steps: [step({ summary: 'Leads are ignored for weeks', quote: 'leads are ignored for weeks' })],
      fact_updates: [{ target: 'completion', certainty: 'known', value: 'Closed in the CRM', quote: 'we close them in the CRM' }],
      step_list_confirmed: false,
    }));
    const { d, state } = await started(client);
    const { state: after, interpretation } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
    assert.equal(after.assessment.model.workflow.steps.length, 0);
    assert.equal(after.assessment.model.workflow.completion.status, 'unknown');
    assert.equal(interpretation.dropped.length, 2);
  });

  it('cannot overwrite a value the user set during review', async () => {
    // Call 0 reads the problem statement, call 1 the walk-through, call 2 the added context.
    let n = 0;
    const empty = () => reply({ new_steps: [], fact_updates: [], step_list_confirmed: false });
    const { client } = fake(() => [empty, walkReply][n++]?.() ?? reply({
      new_steps: [], step_list_confirmed: false,
      fact_updates: [{ target: 'S2.owner', certainty: 'known', value: 'Dana', quote: 'Dana copies the details now' }],
    }));
    const { store, d, state } = await started(client);
    const id = state.assessment.id;
    await d.answer(id, state.open_question!.id, WALK);
    const m = structuredClone(store.get(id).model);
    const ev = store.addEvidence(id, 'correction', 'Priya', null, 'S2.owner');
    m.workflow.steps[1].owner = { value: 'Priya', status: 'known', evidence: [{ evidence_id: ev.id, quote: 'Priya' }], by: 'user', was: null, user_action: 'corrected' };
    store.saveModel(id, m, 'correction', 'user');
    const { interpretation } = await d.addContext(id, 'Dana copies the details now.');
    assert.equal(store.get(id).model.workflow.steps[1].owner.value, 'Priya');
    assert.ok(interpretation.dropped.some((x) => /set by the user/.test(x)));
  });
});

describe('Claude interpreter: any failure falls back to the no-key interpreter', () => {
  const cases: [string, LlmClient][] = [
    ['API unavailable', { create: async () => { throw new Error('connect ECONNREFUSED'); } }],
    ['refusal', { create: async () => ({ stop_reason: 'refusal', content: [] }) }],
    ['no text', { create: async () => ({ stop_reason: 'max_tokens', content: [] }) }],
    ['malformed JSON', { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"new_steps": [' }] }) }],
    ['off-schema certainty', { create: async () => reply({ new_steps: [step({ summary: 'x', owner_certainty: 'certain' })], fact_updates: [], step_list_confirmed: false }) }],
    ['unknown target', { create: async () => reply({ new_steps: [], fact_updates: [{ target: 'budget', certainty: 'known', value: 'x', quote: 'x' }], step_list_confirmed: false }) }],
  ];
  for (const [name, client] of cases) {
    it(`on ${name}: the answer is still interpreted, and the log says why`, async () => {
      const store = new Store();
      const d = new Discovery(store, new ClaudeInterpreter(client));
      const { state } = await d.start('x', PROBLEM);
      const { state: after, interpretation } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
      assert.equal(interpretation.interpreter, 'heuristic');
      assert.match(interpretation.applied[0], /claude:.* failed .*; used heuristic/);
      assert.ok(after.assessment.model.workflow.steps.length >= 2, 'the no-key interpreter still mapped the answer');
    });
  }
});

describe('Claude finding proposer: suggestions go through the same gate', () => {
  it('confirms a supported finding and keeps an unsupported one only as a rejected, audited proposal', async () => {
    const { client } = fake(walkReply, () => reply({ findings: [
      // Supported: S2 is manual and moves work from email (S1) into a spreadsheet.
      { category: 'manual_reentry', step_ids: ['S1', 'S2'], quotes: [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }], rationale: 'Retyping every inquiry.' },
      // Unsupported: nothing the user said shows a bottleneck.
      { category: 'bottleneck', step_ids: ['S2'], quotes: [{ evidence_id: 'E2', quote: 'Maria copies the details into our spreadsheet' }], rationale: 'Maria is overloaded.' },
    ] }));
    const { d, state } = await started(client, true);
    const { state: after } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
    const findings = after.assessment.model.findings;
    const reentry = findings.filter((f) => f.category === 'manual_reentry');
    assert.equal(reentry.length, 1, 'the rule and the model found the same thing: one finding');
    assert.ok(['confirmed', 'tentative'].includes(reentry[0].status));
    const bottleneck = findings.find((f) => f.category === 'bottleneck')!;
    assert.equal(bottleneck.status, 'rejected');
    assert.match(bottleneck.rejection_reason!, /does not support it/);
  });

  it('a failing proposer never blocks discovery: rule findings are used and the log says so', async () => {
    const { client } = fake(walkReply, () => { throw new Error('529 overloaded'); });
    const { d, state } = await started(client, true);
    const { state: after, interpretation } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
    assert.ok(interpretation.applied.some((x) => /finding proposer failed .*; rule findings only/.test(x)));
    assert.ok(after.assessment.model.findings.some((f) => f.category === 'manual_reentry' && f.source === 'rule'));
  });

  it('is skipped when the interpreter has just failed over', async () => {
    const calls: string[] = [];
    const client: LlmClient = { async create(req) { calls.push(req.system.slice(0, 20)); throw new Error('down'); } };
    const store = new Store();
    const d = new Discovery(store, new ClaudeInterpreter(client), undefined, new ClaudeFindingProposer(client));
    const { state } = await d.start('x', PROBLEM);
    const { interpretation } = await d.answer(state.assessment.id, state.open_question!.id, WALK);
    assert.ok(interpretation.applied.some((x) => /finding proposer skipped/.test(x)));
    assert.ok(calls.every((c) => !c.startsWith('You look for')));
  });
});

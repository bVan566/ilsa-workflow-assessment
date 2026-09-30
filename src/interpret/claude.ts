import {
  FRICTION_CATEGORIES, STEP_FACTS, WORKFLOW_FACTS,
  type Certainty, type Evidence, type EvidenceRef, type Fact, type Model, type StepFactField, type WorkflowFactField,
} from '../domain.ts';
import type { FindingProposal } from '../friction.ts';
import { emptyDelta, type Delta, type FactProposal, type InterpretInput, type Interpreter, type StepProposal } from './types.ts';

// Optional Claude interpreter and finding proposer. Used only when an API key is configured.
//
// What the model does: reads the user's words and proposes structure (steps, owners, tools,
// certainty) and, separately, friction the fixed rules cannot see.
// What it cannot do: everything it returns is a PROPOSAL in a fixed JSON schema. The same
// deterministic code that governs the no-key interpreter then decides: quotes must be real,
// hedges cap certainty, user corrections cannot be overwritten, findings must pass the gate.
// Any failure (API error, refusal, malformed or off-schema output) throws, and discovery
// falls back to the no-key interpreter.

export const ILSA_MODEL = process.env.ILSA_MODEL ?? 'claude-opus-5-5';

export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system: string;
  output_config: { effort: 'low'; format: { type: 'json_schema'; schema: Record<string, unknown> } };
  messages: { role: 'user'; content: string }[];
}
export interface LlmResponse {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
}
/** The only part of the Claude API used. Injectable, so every path is testable offline. */
export interface LlmClient {
  create(request: LlmRequest): Promise<LlmResponse>;
}

export class InterpretError extends Error {
  readonly reason: 'refusal' | 'no_text' | 'malformed_json' | 'invalid_output';
  constructor(reason: InterpretError['reason'], detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'InterpretError';
    this.reason = reason;
  }
}

let sdkClient: LlmClient | undefined;
async function defaultClient(): Promise<LlmClient> {
  if (!sdkClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Short timeout: the user is waiting for the next question, and the fallback is always available.
    const sdk = new Anthropic({ timeout: 30_000, maxRetries: 1 });
    sdkClient = { create: (request) => sdk.messages.create(request) };
  }
  return sdkClient;
}

async function callForJson(client: LlmClient | undefined, system: string, schema: Record<string, unknown>, content: string): Promise<unknown> {
  const response = await (client ?? (await defaultClient())).create({
    model: ILSA_MODEL,
    max_tokens: 4000,
    system,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') throw new InterpretError('refusal', 'the model declined');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (typeof text !== 'string') throw new InterpretError('no_text', `no text in response (stop_reason ${response.stop_reason})`);
  try {
    return JSON.parse(text);
  } catch {
    throw new InterpretError('malformed_json', 'response was not valid JSON');
  }
}

// ---------------------------------------------------------------- shared helpers

const CERTAIN = ['known', 'inferred', 'unknown'] as const;
const CERTAIN_ALL = ['known', 'inferred', 'absent', 'unknown'] as const;
const YNU = ['yes', 'no', 'unknown'] as const;
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

function describeFact(f: Fact): string {
  if (f.status === 'unknown') return f.evidence.length ? 'unknown (user does not know)' : 'not established';
  if (f.status === 'absent') return 'does not exist (per user)';
  return `${f.status}: ${f.value}${f.by === 'user' ? ' [set by the user, do not change]' : ''}`;
}

function modelSummary(model: Model, withEvidence: boolean): string {
  const wf = model.workflow;
  const lines = [`Workflow: ${wf.name}`];
  for (const field of WORKFLOW_FACTS.filter((f) => f !== 'sequence')) lines.push(`${field}: ${describeFact(wf[field])}`);
  for (const s of wf.steps) {
    lines.push(`${s.id}: ${s.summary}`);
    for (const f of STEP_FACTS) lines.push(`  ${s.id}.${f}: ${describeFact(s[f])}`);
    if (withEvidence) {
      const refs = [...s.evidence, ...STEP_FACTS.flatMap((f) => s[f].evidence)];
      for (const r of refs) lines.push(`  evidence ${r.evidence_id}: "${r.quote}"`);
    }
  }
  if (withEvidence) {
    for (const field of WORKFLOW_FACTS) for (const r of wf[field].evidence) lines.push(`${field} evidence ${r.evidence_id}: "${r.quote}"`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- interpreter

const INTERPRET_SCHEMA = obj({
  new_steps: {
    type: 'array',
    items: obj({
      summary: str, quote: str,
      owner: str, owner_certainty: { type: 'string', enum: [...CERTAIN] }, owner_quote: str,
      tool: str, tool_certainty: { type: 'string', enum: [...CERTAIN] }, tool_quote: str,
      manual: { type: 'string', enum: [...YNU] }, decision: { type: 'string', enum: [...YNU] },
    }),
  },
  fact_updates: {
    type: 'array',
    items: obj({ target: str, certainty: { type: 'string', enum: [...CERTAIN_ALL] }, value: str, quote: str }),
  },
  step_list_confirmed: { type: 'boolean' },
});

const INTERPRET_SYSTEM = `You help map how a small business process actually works, from what the owner or operator says.
You receive the current workflow model, the question that was asked (if any), and one new statement from the user.
Return only structure that the statement itself supports. Rules:
- Record only what the user said. If something is not stated, leave it out. Never fill gaps with what is typical.
- For everything you record, "quote" must be the user's exact words copied verbatim from the new statement (several words, not paraphrased).
- Certainty: "known" = stated plainly; "inferred" = stated with a hedge (I think, usually, probably, sometimes, maybe); "absent" = the user says it does not exist; "unknown" = the user says they do not know.
- new_steps: actions people or systems take inside the process, in order. The customer's first action is the trigger, not a step. Do not repeat steps already in the model; to add detail to an existing step use fact_updates with target like "S2.owner", "S2.system", "S2.handoff_in", "S2.waiting_on".
- fact_updates targets for the whole workflow: trigger, completion, exceptions, decisions, waiting.
- Use an empty string for any owner, tool, value or quote you do not have, with certainty "unknown".
- step_list_confirmed: true only if the user confirms the listed steps are complete and in order.
- Never change a value marked [set by the user].
- Do not diagnose problems and do not recommend anything. Only map what was said.`;

const STEP_TARGET = new RegExp(`^S\\d+\\.(${STEP_FACTS.join('|')})$`);

export class ClaudeInterpreter implements Interpreter {
  readonly name: string;
  private readonly client?: LlmClient;

  constructor(client?: LlmClient) {
    this.client = client;
    this.name = `claude:${ILSA_MODEL}`;
  }

  async interpret({ evidence, question, model }: InterpretInput): Promise<Delta> {
    const content = [
      'Current workflow model:', modelSummary(model, false), '',
      question ? `Question asked (${question.intent} ${question.slot}): ${question.text}` : 'No specific question: this is an open description or added context.',
      '', `New statement (${evidence.id}): ${evidence.text}`,
    ].join('\n');
    const raw = await callForJson(this.client, INTERPRET_SYSTEM, INTERPRET_SCHEMA, content);
    return toDelta(raw, evidence, question?.slot === 'sequence' && question.intent === 'confirm', model);
  }
}

/** Converts the model's JSON into a Delta, rejecting anything off-schema. Quotes are checked later by merge. */
export function toDelta(raw: unknown, evidence: Evidence, askedToConfirmSteps: boolean, model: Model): Delta {
  const bad = (d: string) => new InterpretError('invalid_output', d);
  if (!raw || typeof raw !== 'object') throw bad('not an object');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.new_steps) || !Array.isArray(r.fact_updates) || typeof r.step_list_confirmed !== 'boolean') {
    throw bad('missing new_steps, fact_updates or step_list_confirmed');
  }
  const ref = (q: unknown): EvidenceRef[] => (typeof q === 'string' && q.trim() ? [{ evidence_id: evidence.id, quote: q.trim() }] : []);
  const fact = (value: unknown, certainty: unknown, quote: unknown): FactProposal | undefined => {
    if (!CERTAIN_ALL.includes(certainty as Certainty)) throw bad(`invalid certainty "${String(certainty)}"`);
    const status = certainty as Certainty;
    const v = typeof value === 'string' && value.trim() ? value.trim() : null;
    if (status === 'unknown' && ref(quote).length === 0) return undefined;
    return { value: status === 'known' || status === 'inferred' ? v : null, status, evidence: ref(quote) };
  };
  const ynu = (v: unknown): boolean | null => {
    if (!YNU.includes(v as never)) throw bad(`invalid yes/no/unknown "${String(v)}"`);
    return v === 'yes' ? true : v === 'no' ? false : null;
  };

  const delta = emptyDelta();
  for (const s of r.new_steps as Record<string, unknown>[]) {
    if (typeof s?.summary !== 'string' || !s.summary.trim()) throw bad('a new step has no summary');
    const step: StepProposal = { summary: s.summary.trim(), evidence: ref(s.quote), manual: ynu(s.manual), decision: ynu(s.decision) };
    const owner = fact(s.owner, s.owner_certainty, s.owner_quote || s.quote);
    const tool = fact(s.tool, s.tool_certainty, s.tool_quote || s.quote);
    if (owner && owner.value !== null) step.owner = owner;
    if (tool && tool.value !== null) step.system = tool;
    delta.new_steps.push(step);
  }
  for (const u of r.fact_updates as Record<string, unknown>[]) {
    const target = typeof u?.target === 'string' ? u.target.trim() : '';
    const f = fact(u.value, u.certainty, u.quote);
    if (!f) continue;
    if (STEP_TARGET.test(target)) {
      const [step_id, field] = target.split('.');
      delta.step_updates.push({ step_id, field: field as StepFactField, fact: f });
    } else if ((WORKFLOW_FACTS as readonly string[]).includes(target) && target !== 'sequence') {
      delta.workflow_facts.push({ field: target as WorkflowFactField, fact: f });
    } else {
      throw bad(`unknown target "${target}"`);
    }
  }
  if (askedToConfirmSteps && r.step_list_confirmed === true) {
    delta.workflow_facts.push({ field: 'sequence', fact: { value: `confirmed: ${model.workflow.steps.length} steps`, status: 'known', evidence: [{ evidence_id: evidence.id, quote: evidence.text }] } });
  }
  return delta;
}

// ---------------------------------------------------------------- finding proposer

export interface FindingProposer {
  readonly name: string;
  propose(model: Model, evidence: Evidence[]): Promise<Omit<FindingProposal, 'source'>[]>;
}

const CATEGORIES = Object.keys(FRICTION_CATEGORIES);
const FINDINGS_SCHEMA = obj({
  findings: {
    type: 'array',
    items: obj({
      category: { type: 'string', enum: CATEGORIES },
      step_ids: { type: 'array', items: str },
      quotes: { type: 'array', items: obj({ evidence_id: str, quote: str }) },
      rationale: str,
    }),
  },
});

const FINDINGS_SYSTEM = `You look for operational friction in a mapped business process.
Only report friction that the user's own words clearly show. Rules:
- Use only these categories: ${CATEGORIES.map((c) => `${c} (${FRICTION_CATEGORIES[c as keyof typeof FRICTION_CATEGORIES]})`).join('; ')}.
- Cite the step ids the friction is about, and quote the user's exact words using the evidence ids listed under those steps (or under the workflow fact the friction is about). Copy quotes verbatim.
- Prefer fewer, well-supported findings. If the words do not clearly show a problem, report nothing. An empty list is a good answer.
- rationale: one sentence on why it costs time, money or customers.
- Do not recommend solutions.`;

export class ClaudeFindingProposer implements FindingProposer {
  readonly name: string;
  private readonly client?: LlmClient;

  constructor(client?: LlmClient) {
    this.client = client;
    this.name = `claude:${ILSA_MODEL}`;
  }

  async propose(model: Model, evidence: Evidence[]): Promise<Omit<FindingProposal, 'source'>[]> {
    void evidence;
    const raw = await callForJson(this.client, FINDINGS_SYSTEM, FINDINGS_SCHEMA, `Mapped process, with the evidence linked to each part:\n${modelSummary(model, true)}`);
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { findings?: unknown }).findings)) {
      throw new InterpretError('invalid_output', 'missing findings array');
    }
    return ((raw as { findings: Record<string, unknown>[] }).findings).map((f) => ({
      category: String(f.category),
      step_ids: Array.isArray(f.step_ids) ? f.step_ids.map(String) : [],
      evidence: Array.isArray(f.quotes) ? (f.quotes as Record<string, unknown>[]).map((q) => ({ evidence_id: String(q.evidence_id), quote: String(q.quote) })) : [],
      rationale: typeof f.rationale === 'string' ? f.rationale : undefined,
    }));
  }
}

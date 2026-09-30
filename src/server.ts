import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Assessor, ReportInvalidError } from './assess.ts';
import { Discovery } from './discovery.ts';
import { FRICTION_CATEGORIES } from './domain.ts';
import { HeuristicInterpreter } from './interpret/heuristic.ts';
import type { Interpreter } from './interpret/types.ts';
import { Review, type ReviewResult } from './review.ts';
import { isSample, runSample, sampleAnswerFor, SAMPLE_NAME, SAMPLE_PROBLEM } from './sample.ts';
import { NotFoundError, Store } from './store.ts';
import { ValidationError } from './validate.ts';

// A thin HTTP layer. Every route calls the modules above; no business rule lives here.
// Each response carries the full "view" of an assessment so the UI never assembles state.

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.ILSA_DATA_DIR ?? join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 3100);

export interface App {
  store: Store;
  discovery: Discovery;
  assessor: Assessor;
  review: Review;
  interpreterName: string;
}

export function makeApp(store: Store, interpreter: Interpreter = new HeuristicInterpreter()): App {
  const discovery = new Discovery(store, interpreter);
  const assessor = new Assessor(store);
  return { store, discovery, assessor, review: new Review(store, discovery, assessor), interpreterName: interpreter.name };
}

/** Everything the UI shows for one assessment. Rejected audit-only findings are counted, not included. */
export function view(app: App, id: string) {
  const state = app.discovery.state(id);
  const a = state.assessment;
  const current = app.assessor.current(id);
  const open = state.open_question;
  return {
    id: a.id,
    name: a.name,
    problem_statement: a.problem_statement,
    status: a.status,
    revision: a.revision,
    is_sample: isSample(a.name),
    workflow: a.model.workflow,
    findings: a.model.findings.filter((f) => f.status !== 'rejected' && f.status !== 'user_disputed'),
    disputed: a.model.findings.filter((f) => f.status === 'user_disputed'),
    rejected_count: a.model.findings.filter((f) => f.status === 'rejected').length,
    evidence: a.evidence,
    question: open && {
      ...open,
      sample_answer: isSample(a.name) ? sampleAnswerFor(open.slot, open.intent) : null,
    },
    questions_answered: a.questions.filter((q) => q.status === 'answered').length,
    discovery_complete: state.complete,
    coverage: state.coverage,
    readiness: current.readiness,
    assessment: { active: current.active, previous: current.previous, stale: current.stale },
  };
}

function audit(app: App, id: string) {
  const a = app.store.get(id);
  return {
    rejected: a.model.findings.filter((f) => f.status === 'rejected'),
    revisions: app.store.revisions(id),
    evidence: a.evidence,
    questions: a.questions,
  };
}

function withChange(app: App, id: string, r: ReviewResult) {
  return { view: view(app, id), change: { action: r.action, revision: r.revision, log: r.log, regenerated: r.assessment.regenerated } };
}

export function createApp(app: App) {
  return createServer(async (req, res) => {
    try {
      await route(app, req, res);
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: err.errors.join('; '), errors: err.errors });
      if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
      if (err instanceof ReportInvalidError) return send(res, 500, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });
}

async function route(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  if (parts[0] !== 'api') return serveStatic(url.pathname, res);

  const body = method === 'POST' ? await readJson(req) : {};
  const [, resource, id, action, sub] = parts;
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');

  if (method === 'GET' && resource === 'config') {
    return send(res, 200, { interpreter: app.interpreterName, categories: FRICTION_CATEGORIES });
  }
  if (resource === 'assessments' && !id) {
    if (method === 'GET') return send(res, 200, app.store.list());
    if (method === 'POST') {
      const { state } = await app.discovery.start(s('name'), s('problem'));
      return send(res, 201, { view: view(app, state.assessment.id) });
    }
  }
  if (resource === 'sample' && method === 'POST') {
    // Guided: start the sample and answer question by question in the UI.
    // Complete: run the whole sample interview through the same pipeline, then assess.
    if (body.mode === 'complete') {
      const state = await runSample(app.discovery);
      app.assessor.generate(state.assessment.id);
      return send(res, 201, { view: view(app, state.assessment.id) });
    }
    const { state } = await app.discovery.start(SAMPLE_NAME, SAMPLE_PROBLEM);
    return send(res, 201, { view: view(app, state.assessment.id) });
  }
  if (resource !== 'assessments' || !id) return send(res, 404, { error: 'not found' });

  if (method === 'GET' && !action) return send(res, 200, { view: view(app, id) });
  if (method === 'GET' && action === 'audit') return send(res, 200, audit(app, id));
  if (method !== 'POST') return send(res, 404, { error: 'not found' });

  switch (action) {
    case 'answer': return send(res, 200, withChange(app, id, await app.review.answer(id, s('question_id'), s('text'))));
    case 'skip': app.discovery.skip(id, s('question_id')); return send(res, 200, { view: view(app, id) });
    case 'context': return send(res, 200, withChange(app, id, await app.review.addContext(id, s('text'), s('about') || null)));
    case 'generate': {
      const r = app.assessor.generate(id);
      return send(res, r.ok ? 200 : 409, { view: view(app, id), ...(r.ok ? {} : { error: r.message }) });
    }
    case 'review': {
      const rv = app.review;
      switch (sub) {
        case 'edit-step': return send(res, 200, withChange(app, id, rv.editStep(id, s('step_id'), s('summary'))));
        case 'set-fact': return send(res, 200, withChange(app, id, rv.setFact(id, s('slot'), { value: s('value'), absent: body.absent === true })));
        case 'mark-unknown': return send(res, 200, withChange(app, id, rv.markUnknown(id, s('slot'), s('note') || undefined)));
        case 'confirm': return send(res, 200, withChange(app, id, rv.confirm(id, s('slot'), s('note') || undefined)));
        case 'confirm-sequence': return send(res, 200, withChange(app, id, rv.confirmSequence(id)));
        case 'move-step': return send(res, 200, withChange(app, id, rv.moveStep(id, s('step_id'), Number(body.to_index))));
        case 'add-step': return send(res, 200, withChange(app, id, rv.addStep(id, {
          summary: s('summary'), position: Number(body.position), owner: s('owner') || undefined, system: s('system') || undefined,
        })));
        case 'accept-finding': return send(res, 200, withChange(app, id, rv.acceptFinding(id, s('finding_id'), s('note') || undefined)));
        case 'dispute-finding': return send(res, 200, withChange(app, id, rv.disputeFinding(id, s('finding_id'), s('reason'))));
      }
    }
  }
  send(res, 404, { error: 'not found' });
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serveStatic(pathname: string, res: ServerResponse): void {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[\w.-]+$/.test(file) || file.includes('..')) return send(res, 404, { error: 'not found' });
  try {
    const content = readFileSync(join(PUBLIC, file));
    // no-cache: the browser revalidates, so an updated UI is never mixed with a stale script.
    res.writeHead(200, { 'content-type': `${MIME[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
    res.end(content);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 100_000) throw new ValidationError(['request body too large']);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new ValidationError(['body must be JSON']);
  }
}

if (import.meta.main) {
  let store: Store;
  try {
    mkdirSync(DATA, { recursive: true });
    store = new Store(join(DATA, 'ilsa.db'));
  } catch (err) {
    console.error(`Could not open the database in ${DATA}: ${(err as Error).message}`);
    console.error('Set ILSA_DATA_DIR to a writable directory (on Windows, keep the full path under 260 characters).');
    process.exit(1);
  }
  const app = makeApp(store);
  createApp(app).listen(PORT, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Ilsa running at http://localhost:${PORT}  (interpreter: ${app.interpreterName})`);
  });
}

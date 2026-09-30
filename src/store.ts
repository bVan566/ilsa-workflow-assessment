import { DatabaseSync } from 'node:sqlite';
import {
  DIMENSIONS, emptyWorkflow,
  type Assessment, type AssessmentStatus, type Dimension, type Evidence, type EvidenceKind, type Model, type Question,
} from './domain.ts';
import { ValidationError, validateModel } from './validate.ts';

// Persistence (SQLite via node:sqlite). Four tables:
//   assessments  one row per assessment, plus counters for ids assigned by code
//   evidence     append-only record of everything the user said
//   questions    discovery questions and whether they were answered
//   revisions    every version of the workflow model, as validated JSON
// The current model is simply the latest revision, so any correction can be traced.

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export const MAX_TEXT = 5000;

export interface RevisionInfo {
  revision: number;
  reason: string;
  actor: string;
  details: string[];
  created_at: string;
}

interface AssessmentRow {
  id: string; name: string; problem_statement: string; status: AssessmentStatus;
  revision: number; created_at: string; updated_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path = ':memory:', now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assessments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        problem_statement TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL,
        step_seq INTEGER NOT NULL DEFAULT 0,
        finding_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evidence (
        assessment_id TEXT NOT NULL REFERENCES assessments(id),
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        question_id TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (assessment_id, id)
      );
      CREATE TABLE IF NOT EXISTS questions (
        assessment_id TEXT NOT NULL REFERENCES assessments(id),
        id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        slot TEXT NOT NULL,
        intent TEXT NOT NULL,
        text TEXT NOT NULL,
        step_id TEXT,
        status TEXT NOT NULL,
        answer_evidence_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (assessment_id, id)
      );
      CREATE TABLE IF NOT EXISTS revisions (
        assessment_id TEXT NOT NULL REFERENCES assessments(id),
        revision INTEGER NOT NULL,
        model_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (assessment_id, revision)
      );
    `);
  }

  private ts(): string {
    return this.now().toISOString();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- assessments

  createAssessment(name: string, problemStatement: string): Assessment {
    const cleanName = requireText(name, 'name', 200);
    const problem = requireText(problemStatement, 'problem statement', MAX_TEXT);
    const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM assessments').get() as { n: number }).n);
    const id = `ASM-${String(count + 1).padStart(4, '0')}`;
    const ts = this.ts();
    this.tx(() => {
      this.db.prepare(`INSERT INTO assessments (id, name, problem_statement, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'discovery', 1, ?, ?)`).run(id, cleanName, problem, ts, ts);
      this.db.prepare(`INSERT INTO evidence (assessment_id, id, kind, question_id, text, created_at)
        VALUES (?, 'E1', 'problem_statement', NULL, ?, ?)`).run(id, problem, ts);
      const model: Model = { workflow: emptyWorkflow(cleanName), findings: [] };
      this.db.prepare(`INSERT INTO revisions (assessment_id, revision, model_json, reason, actor, created_at)
        VALUES (?, 1, ?, 'assessment created', 'system', ?)`).run(id, JSON.stringify(model), ts);
    });
    return this.get(id);
  }

  get(id: string): Assessment {
    const row = this.db.prepare('SELECT * FROM assessments WHERE id = ?').get(id) as unknown as AssessmentRow | undefined;
    if (!row) throw new NotFoundError(`assessment ${id}`);
    return {
      id: row.id,
      name: row.name,
      problem_statement: row.problem_statement,
      status: row.status,
      revision: row.revision,
      model: this.getRevision(id, row.revision),
      evidence: this.evidence(id),
      questions: this.questions(id),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  list(): { id: string; name: string; status: AssessmentStatus; revision: number; updated_at: string }[] {
    return this.db.prepare('SELECT id, name, status, revision, updated_at FROM assessments ORDER BY created_at DESC, id DESC')
      .all() as unknown as { id: string; name: string; status: AssessmentStatus; revision: number; updated_at: string }[];
  }

  setStatus(id: string, status: AssessmentStatus): void {
    this.get(id);
    this.db.prepare('UPDATE assessments SET status = ?, updated_at = ? WHERE id = ?').run(status, this.ts(), id);
  }

  // ---------------------------------------------------------------- evidence (append-only)

  addEvidence(id: string, kind: EvidenceKind, text: string, questionId: string | null = null): Evidence {
    this.get(id);
    const clean = requireText(text, 'evidence text', MAX_TEXT);
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM evidence WHERE assessment_id = ?').get(id) as { n: number }).n);
    const ev: Evidence = { id: `E${n + 1}`, kind, question_id: questionId, text: clean, created_at: this.ts() };
    this.db.prepare('INSERT INTO evidence (assessment_id, id, kind, question_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ev.id, ev.kind, ev.question_id, ev.text, ev.created_at);
    this.touch(id);
    return ev;
  }

  evidence(id: string): Evidence[] {
    return this.db.prepare(`SELECT id, kind, question_id, text, created_at FROM evidence WHERE assessment_id = ?
      ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).all(id) as unknown as Evidence[];
  }

  // ---------------------------------------------------------------- questions

  addQuestion(id: string, q: { dimension: Dimension; slot: string; intent: Question['intent']; text: string; step_id?: string | null }): Question {
    this.get(id);
    if (!DIMENSIONS.includes(q.dimension)) throw new ValidationError([`unknown dimension "${q.dimension}"`]);
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM questions WHERE assessment_id = ?').get(id) as { n: number }).n);
    const question: Question = {
      id: `Q${n + 1}`, dimension: q.dimension, slot: q.slot, intent: q.intent, text: requireText(q.text, 'question', 1000),
      step_id: q.step_id ?? null, status: 'open', answer_evidence_id: null, created_at: this.ts(),
    };
    this.db.prepare(`INSERT INTO questions (assessment_id, id, dimension, slot, intent, text, step_id, status, answer_evidence_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`)
      .run(id, question.id, question.dimension, question.slot, question.intent, question.text, question.step_id, question.created_at);
    return question;
  }

  questions(id: string): Question[] {
    return this.db.prepare(`SELECT id, dimension, slot, intent, text, step_id, status, answer_evidence_id, created_at FROM questions
      WHERE assessment_id = ? ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).all(id) as unknown as Question[];
  }

  /** Records the answer as evidence and closes the question, atomically. */
  answerQuestion(id: string, questionId: string, text: string): Evidence {
    return this.tx(() => {
      const q = this.questions(id).find((x) => x.id === questionId);
      if (!q) throw new NotFoundError(`question ${questionId}`);
      if (q.status !== 'open') throw new ValidationError([`question ${questionId} is already ${q.status}`]);
      const ev = this.addEvidence(id, 'answer', text, questionId);
      this.db.prepare(`UPDATE questions SET status = 'answered', answer_evidence_id = ? WHERE assessment_id = ? AND id = ?`)
        .run(ev.id, id, questionId);
      return ev;
    });
  }

  skipQuestion(id: string, questionId: string): void {
    const q = this.questions(id).find((x) => x.id === questionId);
    if (!q) throw new NotFoundError(`question ${questionId}`);
    if (q.status !== 'open') throw new ValidationError([`question ${questionId} is already ${q.status}`]);
    this.db.prepare(`UPDATE questions SET status = 'skipped' WHERE assessment_id = ? AND id = ?`).run(id, questionId);
  }

  // ---------------------------------------------------------------- model revisions

  /**
   * Saves a new version of the model. It is validated against this assessment's
   * evidence first; an invalid model is refused and nothing is written.
   */
  saveModel(id: string, model: Model, reason: string, actor: string, details: string[] = []): number {
    const current = this.get(id);
    const errors = validateModel(model, current.evidence);
    if (errors.length > 0) throw new ValidationError(errors);
    const next = current.revision + 1;
    this.tx(() => {
      this.db.prepare(`INSERT INTO revisions (assessment_id, revision, model_json, reason, actor, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, next, JSON.stringify(model), requireText(reason, 'reason', 300), requireText(actor, 'actor', 100), JSON.stringify(details), this.ts());
      this.db.prepare('UPDATE assessments SET revision = ?, updated_at = ? WHERE id = ?').run(next, this.ts(), id);
    });
    return next;
  }

  getRevision(id: string, revision: number): Model {
    const row = this.db.prepare('SELECT model_json FROM revisions WHERE assessment_id = ? AND revision = ?').get(id, revision) as { model_json: string } | undefined;
    if (!row) throw new NotFoundError(`revision ${revision} of ${id}`);
    return JSON.parse(row.model_json) as Model;
  }

  revisions(id: string): RevisionInfo[] {
    const rows = this.db.prepare('SELECT revision, reason, actor, details_json, created_at FROM revisions WHERE assessment_id = ? ORDER BY revision')
      .all(id) as unknown as (Omit<RevisionInfo, 'details'> & { details_json: string })[];
    return rows.map(({ details_json, ...r }) => ({ ...r, details: JSON.parse(details_json) as string[] }));
  }

  // ---------------------------------------------------------------- ids assigned by code

  /** Step ids are never reused, even after a step is deleted, so old references stay unambiguous. */
  nextStepId(id: string): string {
    return `S${this.bump(id, 'step_seq')}`;
  }

  nextFindingId(id: string): string {
    return `F${this.bump(id, 'finding_seq')}`;
  }

  private bump(id: string, column: 'step_seq' | 'finding_seq'): number {
    this.get(id);
    this.db.prepare(`UPDATE assessments SET ${column} = ${column} + 1 WHERE id = ?`).run(id);
    return Number((this.db.prepare(`SELECT ${column} AS n FROM assessments WHERE id = ?`).get(id) as { n: number }).n);
  }

  private touch(id: string): void {
    this.db.prepare('UPDATE assessments SET updated_at = ? WHERE id = ?').run(this.ts(), id);
  }
}

function requireText(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw new ValidationError([`${what} is required`]);
  if (v.length > max) throw new ValidationError([`${what} exceeds ${max} characters`]);
  return v.trim();
}

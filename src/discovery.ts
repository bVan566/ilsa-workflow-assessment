import type { Assessment, Evidence, Question } from './domain.ts';
import { diagnose, type FindingProposal } from './friction.ts';
import { candidates, coverage, factState, nextQuestion, sequenceConfirmed, type Candidate } from './gaps.ts';
import { HeuristicInterpreter } from './interpret/heuristic.ts';
import type { Interpreter } from './interpret/types.ts';
import { applyDelta, getFact } from './merge.ts';
import type { Store } from './store.ts';

// Discovery: the Discover -> Clarify -> Map part of the process.
//
//   user statement -> stored as evidence -> interpreter proposes changes
//     -> merge applies them under fixed rules -> new revision saved -> next question chosen
//
// This module has no way to produce a recommendation. That is deliberate: recommendations
// exist only behind the readiness gate built later, so "understand before recommending"
// cannot be skipped by any path through discovery.

export interface Interpretation {
  interpreter: string;
  applied: string[];
  dropped: string[];
  revision: number | null; // null when the statement changed nothing in the model
}

export interface DiscoveryState {
  assessment: Assessment;
  open_question: Question | null;
  coverage: ReturnType<typeof coverage>;
  /** Why the open question was chosen, and what it was chosen over. */
  question_ranking: { slot: string; intent: string; score: number; reason: string }[];
  complete: boolean;
}

export class Discovery {
  private readonly store: Store;
  private readonly primary: Interpreter;
  private readonly fallback: Interpreter;

  constructor(store: Store, primary: Interpreter = new HeuristicInterpreter(), fallback: Interpreter = new HeuristicInterpreter()) {
    this.store = store;
    this.primary = primary;
    this.fallback = fallback;
  }

  async start(name: string, problemStatement: string): Promise<{ state: DiscoveryState; interpretation: Interpretation }> {
    const a = this.store.createAssessment(name, problemStatement);
    const interpretation = await this.interpretAndSave(a.id, a.evidence[0], null);
    this.askNext(a.id);
    return { state: this.state(a.id), interpretation };
  }

  async answer(id: string, questionId: string, text: string): Promise<{ state: DiscoveryState; interpretation: Interpretation }> {
    const question = this.store.questions(id).find((q) => q.id === questionId) ?? null;
    const evidence = this.store.answerQuestion(id, questionId, text);
    const interpretation = await this.interpretAndSave(id, evidence, question);
    this.askNext(id);
    return { state: this.state(id), interpretation };
  }

  /** Extra information the user volunteers. Interpreted like any statement; cannot override user-set facts. */
  async addContext(id: string, text: string, about: string | null = null): Promise<{ state: DiscoveryState; interpretation: Interpretation }> {
    const evidence = this.store.addEvidence(id, 'context', text, null, about);
    const interpretation = await this.interpretAndSave(id, evidence, null);
    this.refreshQuestions(id);
    return { state: this.state(id), interpretation };
  }

  /** After a review action: close an open question it already settled, then pick the next one. */
  refreshQuestions(id: string): void {
    const a = this.store.get(id);
    const open = a.questions.find((q) => q.status === 'open');
    if (open) {
      let settled: boolean;
      if (open.slot === 'sequence') {
        settled = open.intent === 'discover' ? a.model.workflow.steps.length >= 2 : sequenceConfirmed(a.model);
      } else {
        const f = getFact(a.model, open.slot);
        const s = f ? factState(f) : 'established';
        settled = open.intent === 'discover' ? s !== 'missing' : s !== 'tentative';
      }
      if (settled) this.store.closeQuestion(id, open.id);
    }
    this.askNext(id);
  }

  skip(id: string, questionId: string): DiscoveryState {
    this.store.skipQuestion(id, questionId);
    this.askNext(id);
    return this.state(id);
  }

  state(id: string): DiscoveryState {
    const assessment = this.store.get(id);
    const open = assessment.questions.find((q) => q.status === 'open') ?? null;
    const ranking = candidates(assessment.model, assessment.questions.filter((q) => q.id !== open?.id))
      .sort((a, b) => b.score - a.score)
      .map((c) => ({ slot: c.slot, intent: c.intent, score: c.score, reason: c.reason }));
    return {
      assessment,
      open_question: open,
      coverage: coverage(assessment.model),
      question_ranking: ranking,
      complete: open === null && nextQuestion(assessment.model, assessment.questions) === null,
    };
  }

  private askNext(id: string): Question | null {
    const a = this.store.get(id);
    const c: Candidate | null = nextQuestion(a.model, a.questions);
    if (!c) return null;
    return this.store.addQuestion(id, { dimension: c.dimension, slot: c.slot, intent: c.intent, text: c.text, step_id: c.step?.id ?? null });
  }

  private async interpretAndSave(id: string, evidence: Evidence, question: Question | null): Promise<Interpretation> {
    const a = this.store.get(id);
    let interpreter = this.primary;
    let delta;
    const notes: string[] = [];
    try {
      delta = await interpreter.interpret({ evidence, question, model: a.model });
    } catch (err) {
      notes.push(`${interpreter.name} failed (${err instanceof Error ? err.message : String(err)}); used ${this.fallback.name}`);
      interpreter = this.fallback;
      delta = await interpreter.interpret({ evidence, question, model: a.model });
    }
    const result = applyDelta(a.model, delta, a.evidence, question, evidence, () => this.store.nextStepId(id));
    // Findings are always re-derived from the current model, so they can never describe a stale version of it.
    const dx = diagnose(result.model, a.evidence, a.model.findings, () => this.store.nextFindingId(id));
    result.model.findings = dx.findings;
    const details = [...notes, ...result.applied.map((s) => `applied ${s}`), ...result.dropped.map((s) => `dropped ${s}`),
      ...dx.log.map((s) => `finding ${s}`)];
    const changed = JSON.stringify(result.model) !== JSON.stringify(a.model);
    const revision = changed
      ? this.store.saveModel(id, result.model, `interpreted ${evidence.id}${question ? ` (answer to ${question.id})` : ''}`, interpreter.name, details)
      : null;
    return { interpreter: interpreter.name, applied: [...notes, ...result.applied, ...dx.log], dropped: result.dropped, revision };
  }

  /**
   * Findings proposed by a language model. They go through the same gate as rule findings;
   * anything unsupported is kept only as a rejected, audited proposal.
   */
  proposeFindings(id: string, proposals: Omit<FindingProposal, 'source'>[], actor: string): { state: DiscoveryState; log: string[] } {
    const a = this.store.get(id);
    const dx = diagnose(a.model, a.evidence, a.model.findings, () => this.store.nextFindingId(id),
      proposals.map((p) => ({ ...p, source: 'model' as const })));
    const model = { ...a.model, findings: dx.findings };
    if (JSON.stringify(model) !== JSON.stringify(a.model)) {
      this.store.saveModel(id, model, `${proposals.length} model-proposed finding(s) vetted`, actor, dx.log.map((s) => `finding ${s}`));
    }
    return { state: this.state(id), log: dx.log };
  }
}

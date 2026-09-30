import type { Report } from './domain.ts';
import { readiness, type Readiness } from './readiness.ts';
import { buildReport, validateReport } from './report.ts';
import type { Store } from './store.ts';

// Assess -> Recommend. The only path to a report, and it goes through the readiness gate.
// If the gate is not met, nothing is generated and nothing is stored: the caller gets the
// list of what is missing, never a partial diagnosis presented as an assessment.

export type GenerateResult =
  | { ok: true; report: Report; seq: number }
  | { ok: false; readiness: Readiness; message: string };

export class ReportInvalidError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`generated report broke the assessment rules: ${errors.join('; ')}`);
    this.name = 'ReportInvalidError';
    this.errors = errors;
  }
}

export class Assessor {
  private readonly store: Store;
  private readonly now: () => Date;

  constructor(store: Store, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  readiness(id: string): Readiness {
    const a = this.store.get(id);
    return readiness(a.model, a.questions);
  }

  generate(id: string): GenerateResult {
    const a = this.store.get(id);
    const gate = readiness(a.model, a.questions);
    if (!gate.ready) {
      const dims = [...new Set(gate.blocking.map((b) => b.dimension))];
      return {
        ok: false,
        readiness: gate,
        message: `Not ready to assess: ${gate.blocking.length} item(s) still block readiness (${dims.join(', ')}). No assessment was generated.`,
      };
    }
    const report = buildReport(id, a.revision, a.model, gate, this.now().toISOString());
    const errors = validateReport(report, a.model, a.revision);
    if (errors.length) throw new ReportInvalidError(errors);
    const seq = this.store.saveReport(id, report);
    this.store.setStatus(id, 'assessed');
    return { ok: true, report, seq };
  }

  /**
   * The ACTIVE assessment is the latest report only while it matches the current model.
   * After a correction it is either regenerated (see refresh) or no longer active:
   * an outdated report is returned as "previous", never presented as the assessment.
   */
  current(id: string): { active: Report | null; previous: Report | null; stale: boolean; readiness: Readiness } {
    const a = this.store.get(id);
    const latest = this.store.latestReport(id);
    const stale = latest !== null && latest.report.based_on_revision !== a.revision;
    return {
      active: latest && !stale ? latest.report : null,
      previous: latest && stale ? latest.report : null,
      stale,
      readiness: readiness(a.model, a.questions),
    };
  }

  /**
   * Called after every material change. If an assessment has been generated before, it is
   * regenerated from the changed model when the gate still passes; otherwise the assessment
   * drops back to "review" and the blockers say what is now missing.
   */
  refresh(id: string): { regenerated: boolean; report: Report | null; readiness: Readiness } {
    if (this.store.reportCount(id) === 0) return { regenerated: false, report: null, readiness: this.readiness(id) };
    const result = this.generate(id);
    if (result.ok) return { regenerated: true, report: result.report, readiness: this.readiness(id) };
    this.store.setStatus(id, 'review');
    return { regenerated: false, report: null, readiness: result.readiness };
  }
}

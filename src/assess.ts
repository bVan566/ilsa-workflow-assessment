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

  /** The latest report, and whether the model has changed since it was generated. */
  current(id: string): { report: Report | null; stale: boolean; readiness: Readiness } {
    const a = this.store.get(id);
    const latest = this.store.latestReport(id);
    return {
      report: latest?.report ?? null,
      stale: latest !== null && latest.report.based_on_revision !== a.revision,
      readiness: readiness(a.model, a.questions),
    };
  }
}

import {
  FRICTION_CATEGORIES, evidenceNumber,
  type Evidence, type EvidenceRef, type Fact, type Finding, type FindingSource, type FrictionCategory, type Model, type Step,
  type WorkflowFactField,
} from './domain.ts';
import { factState, userSaysUnknown } from './gaps.ts';
import { isDontKnow, isHedged } from './language.ts';
import { checkEvidenceRef, normalize } from './validate.ts';

// Friction detection: Diagnose, never Recommend.
//
// Every candidate finding, whether nominated by the rules below or proposed by a language
// model, goes through ONE gate, vetFinding(), which checks:
//   1. the category is in the taxonomy
//   2. the cited steps exist
//   3. every quote is something the user actually said
//   4. every quote is LINKED to the cited steps (or the workflow fact the category is about),
//      so a true but unrelated sentence cannot be used as support
//   5. the model actually shows this category of problem (a per-category support check)
// Findings resting on inferred facts, or on a structural pattern, are "tentative".

export interface FindingProposal {
  category: string;
  step_ids: string[];
  evidence: EvidenceRef[];
  rationale?: string;
  source: FindingSource;
}

const RATIONALE: Record<FrictionCategory, string> = {
  unclear_ownership: 'When no one clearly owns a step, it waits until someone happens to notice it, and it is nobody\'s job to notice when it stalls.',
  manual_reentry: 'Retyping the same information into another tool costs time on every item and introduces copy errors and omissions.',
  duplicate_work: 'The same work done twice doubles the cost without adding value, and the two versions can disagree.',
  unnecessary_handoff: 'Each handoff adds a wait and a chance for details to be dropped.',
  waiting_dependency: 'Each wait is a point where work can stall unless something prompts the next action.',
  missing_terminal_condition: 'Without a clear "done" point, finished, abandoned and forgotten items look the same, so open work cannot be counted or chased.',
  manual_status_checking: 'People spend time finding out where things stand, and items nobody checks on fall behind.',
  inconsistent_decision: 'The same situation is handled differently depending on who decides, which makes outcomes unpredictable.',
  information_loss: 'Informal handoffs (texts, verbal, memory) drop details and leave no record of who has the work.',
  unstructured_intake: 'Free-form intake has to be read and interpreted by a person before anything can happen, and details vary from one inquiry to the next.',
  bottleneck: 'Work queues behind one step or person, limiting how much the whole process can handle.',
  single_point_of_failure: 'If this one person is out or overloaded, several steps stop at once.',
  repeated_customer_followup: 'Customers having to chase the business is a direct cost to their experience and a sign the process is not tracking them.',
  missing_exception_handling: 'When the normal path fails there is no defined next step, so the item is silently lost.',
  system_mismatch: 'Tools that do not fit the work force workarounds that are slow and easy to get wrong.',
  tool_switching: 'Moving between several tools for one step costs time and makes it easy to miss an update in one of them.',
};

/** Workflow-level facts a category is allowed to draw evidence from (besides the cited steps). */
const CATEGORY_FACTS: Partial<Record<FrictionCategory, WorkflowFactField[]>> = {
  missing_terminal_condition: ['completion'],
  missing_exception_handling: ['exceptions'],
  waiting_dependency: ['waiting'],
  inconsistent_decision: ['decisions'],
  unstructured_intake: ['trigger'],
  repeated_customer_followup: ['exceptions', 'completion', 'waiting'],
  bottleneck: ['waiting'],
};

const AUTOMATIC = /\b(automatic(ally)?|automated|the system (does|sends)|it'?s automatic|happens by itself)\b/i;
const AMBIGUOUS = /\b(whoever|someone|somebody|anyone|one of us|we all|no specific person|nobody|no one|it depends|depends on who)\b/i;
const FREEFORM = /\b(email|phone|text message|paper|voicemail)\b/i;
const INFORMAL = /\b(texts?|texted|tells?|told|verbal(ly)?|mentions?|remembers?|shouts?|sticky|word of mouth|in person|yells?)\b/i;
const CHECKING = /\b((check|look)(s|ing|ed)? (the|in|at|through|for)|asks? (around|if|whether|who)|see if|keep an eye)\b/i;
const LOSS = /\b(nobody follows? up|no one follows? up|falls? through|gets? (lost|forgotten|dropped)|slips? through|nothing happens|forget|forgotten)\b/i;
const TEXT_SUPPORT: Partial<Record<FrictionCategory, RegExp>> = {
  duplicate_work: /\b(again|twice|both|also (enter|copy|type)|duplicate|double)\b/i,
  system_mismatch: /\b(doesn'?t (fit|work)|work ?arounds?|not (built|made) for|hack|clunky)\b/i,
  bottleneck: /\b(wait(s|ing)? (for|on) (him|her|the owner|them|\w+ to)|backlog|pile(s)? up|only (he|she|one person)|bottleneck)\b/i,
  repeated_customer_followup: /\b(customers? (call|email|text)s? (back|again|us)|chas(e|es|ing) us|follow(s|ing)? up with us|asking (where|when|what'?s happening))\b/i,
  inconsistent_decision: /\b(depends|sometimes|varies|whoever|usually|gut|case by case)\b/i,
  unnecessary_handoff: /\b(pass(es)? it (back|on)|forward(s|ed)? (it|them) (back|again)|hand(s|ed)? (it )?back)\b/i,
};

type Level = 'confirmed' | 'tentative';
type Support = { level: Level; support: string } | { level: 'none'; why: string };

const lvl = (f: Fact): Level => (f.status === 'inferred' ? 'tentative' : 'confirmed');
const weakest = (...ls: Level[]): Level => (ls.includes('tentative') ? 'tentative' : 'confirmed');
const established = (f: Fact) => f.status === 'known' || f.status === 'inferred';
const systemsOf = (f: Fact) => (established(f) ? f.value!.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
const dontKnow = (f: Fact) => factState(f) === 'unresolved' && userSaysUnknown(f, isDontKnow);
/** Steps that receive work from another cited step. A single cited step counts as receiving. */
const receiving = (steps: Step[]) => (steps.length > 1 ? steps.slice(1) : steps);

/** The per-category support check: does the model actually show this problem? */
function supportFor(category: FrictionCategory, steps: Step[], model: Model, quotes: string[]): Support {
  const wf = model.workflow;
  const all = wf.steps;
  const prevOf = (s: Step) => all[all.indexOf(s) - 1];

  switch (category) {
    case 'unclear_ownership': {
      for (const s of steps) {
        if (established(s.owner) && AMBIGUOUS.test(s.owner.value!) && !AUTOMATIC.test(s.owner.value!)) {
          return { level: lvl(s.owner), support: `${s.id} owner is "${s.owner.value}"` };
        }
        if (dontKnow(s.owner)) return { level: 'confirmed', support: `asked who owns ${s.id}; the user did not know` };
      }
      return { level: 'none', why: 'no cited step has an ambiguous or unknown-to-the-user owner' };
    }
    case 'manual_reentry': {
      for (const s of steps) {
        if (s.manual !== true) continue;
        const own = systemsOf(s.system);
        if (own.length >= 2) return { level: lvl(s.system), support: `${s.id} is manual and spans ${own.join(' and ')}` };
        const prev = prevOf(s);
        const before = prev ? systemsOf(prev.system) : [];
        if (own.length === 1 && before.length > 0 && !before.includes(own[0])) {
          return { level: weakest(lvl(s.system), lvl(prev!.system)), support: `${s.id} manually moves work from ${before.join(', ')} (${prev!.id}) into ${own[0]}` };
        }
      }
      return { level: 'none', why: 'no cited step is manual and moves information between two different tools' };
    }
    case 'tool_switching': {
      const s = steps.find((x) => systemsOf(x.system).length >= 2);
      return s ? { level: lvl(s.system), support: `${s.id} uses ${s.system.value}` } : { level: 'none', why: 'no cited step uses two or more tools' };
    }
    case 'missing_terminal_condition': {
      if (wf.completion.status === 'absent') return { level: 'confirmed', support: 'the user said nothing marks the work as finished' };
      if (dontKnow(wf.completion)) return { level: 'tentative', support: 'asked how completion is known; the user did not know' };
      return { level: 'none', why: 'completion is not stated to be absent or unknown to the user' };
    }
    case 'missing_exception_handling': {
      if (wf.exceptions.status === 'absent') return { level: 'confirmed', support: 'the user said there is no path for when things go wrong' };
      if (established(wf.exceptions) && LOSS.test(wf.exceptions.value!)) {
        return { level: lvl(wf.exceptions), support: `when the normal path fails: "${wf.exceptions.value}"` };
      }
      return { level: 'none', why: 'no statement that failures go unhandled' };
    }
    case 'waiting_dependency': {
      const s = steps.find((x) => established(x.waiting_on));
      if (s) return { level: lvl(s.waiting_on), support: `${s.id} waits on: ${s.waiting_on.value}` };
      if (established(wf.waiting)) return { level: lvl(wf.waiting), support: `waiting: ${wf.waiting.value}` };
      return { level: 'none', why: 'no step or workflow fact describes waiting' };
    }
    case 'information_loss': {
      // A handoff belongs to the step receiving the work, i.e. every cited step but the first of a pair.
      for (const s of receiving(steps)) {
        if (established(s.handoff_in) && INFORMAL.test(s.handoff_in.value!)) {
          return { level: lvl(s.handoff_in), support: `work reaches ${s.id} informally: "${s.handoff_in.value}"` };
        }
        if (dontKnow(s.handoff_in)) return { level: 'tentative', support: `asked how work reaches ${s.id}; the user did not know` };
      }
      return { level: 'none', why: 'no cited handoff is informal or unknown to the user' };
    }
    case 'manual_status_checking': {
      const s = receiving(steps).find((x) => established(x.handoff_in) && CHECKING.test(x.handoff_in.value!));
      return s ? { level: lvl(s.handoff_in), support: `${s.id} depends on someone checking: "${s.handoff_in.value}"` }
        : { level: 'none', why: 'no cited step depends on someone checking or asking' };
    }
    case 'single_point_of_failure': {
      const owners = steps.filter((s) => established(s.owner)).map((s) => s.owner.value!.toLowerCase());
      const person = owners[0];
      const count = person ? all.filter((s) => established(s.owner) && s.owner.value!.toLowerCase() === person).length : 0;
      if (person && !AMBIGUOUS.test(person) && !AUTOMATIC.test(person) && count >= 3 && owners.every((o) => o === person)) {
        return { level: 'tentative', support: `${person} owns ${count} steps (a structural pattern; confirm it causes delays)` };
      }
      return { level: 'none', why: 'no single named owner of three or more steps' };
    }
    case 'unstructured_intake': {
      const first = all[0];
      const trigger = established(wf.trigger) && FREEFORM.test(wf.trigger.value!);
      const firstFree = first && steps.includes(first) && systemsOf(first.system).some((x) => FREEFORM.test(x));
      if (!trigger && !firstFree) return { level: 'none', why: 'intake is not through a free-form channel' };
      const rekeyed = all.some((s) => s.manual === true);
      return { level: rekeyed ? 'confirmed' : 'tentative', support: `work arrives by ${firstFree ? first!.system.value : wf.trigger.value}${rekeyed ? ' and is re-keyed by hand later' : ''}` };
    }
    default: {
      // Categories with no structural signal: the cited words themselves must show the problem.
      const re = TEXT_SUPPORT[category];
      const hit = re ? quotes.find((q) => re.test(q)) : undefined;
      if (!hit) return { level: 'none', why: `the cited words do not describe ${category.replace(/_/g, ' ')}` };
      if (category === 'unnecessary_handoff' && new Set(steps.map((s) => s.owner.value)).size < 2) {
        return { level: 'none', why: 'a handoff needs at least two cited steps with different owners' };
      }
      return { level: isHedged(hit) ? 'tentative' : 'confirmed', support: `"${hit}"` };
    }
  }
}

/** Evidence attached to the cited steps, and to the workflow facts this category is about. */
function linkedRefs(category: FrictionCategory, steps: Step[], model: Model): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  for (const s of steps) refs.push(...s.evidence, ...s.owner.evidence, ...s.system.evidence, ...s.handoff_in.evidence, ...s.waiting_on.evidence);
  for (const f of CATEGORY_FACTS[category] ?? []) refs.push(...model.workflow[f].evidence);
  return refs;
}

function isLinked(ref: EvidenceRef, linked: EvidenceRef[]): boolean {
  const q = normalize(ref.quote);
  return linked.some((l) => l.evidence_id === ref.evidence_id && (normalize(l.quote).includes(q) || q.includes(normalize(l.quote))));
}

export function signatureOf(category: string, stepIds: string[]): string {
  return `${category}:${stepIds.length ? [...stepIds].sort().join(',') : 'workflow'}`;
}

/** The single gate. Returns a finding (without id) that is confirmed, tentative or rejected. */
export function vetFinding(p: FindingProposal, model: Model, evidence: Evidence[]): Omit<Finding, 'id'> {
  const stepIds = Array.isArray(p.step_ids) ? p.step_ids : [];
  const refs = Array.isArray(p.evidence) ? p.evidence : [];
  const base = {
    signature: signatureOf(String(p.category), stepIds),
    category: p.category as FrictionCategory,
    step_ids: stepIds,
    evidence: refs,
    rationale: '',
    support: '',
    source: p.source,
  };
  const reject = (reason: string): Omit<Finding, 'id'> => ({ ...base, status: 'rejected', rejection_reason: reason });

  if (!(p.category in FRICTION_CATEGORIES)) return reject(`"${p.category}" is not a friction category`);
  const category = p.category as FrictionCategory;
  const steps = stepIds.map((id) => model.workflow.steps.find((s) => s.id === id));
  const missing = stepIds.filter((_, i) => !steps[i]);
  if (missing.length) return reject(`refers to steps that do not exist: ${missing.join(', ')}`);
  if (refs.length === 0) return reject('no evidence cited');
  for (const r of refs) {
    const problem = checkEvidenceRef(r, evidence);
    if (problem) return reject(problem);
  }
  const linked = linkedRefs(category, steps as Step[], model);
  const unlinked = refs.filter((r) => !isLinked(r, linked));
  if (unlinked.length) return reject(`quote "${unlinked[0].quote}" is real but not linked to the cited steps or facts`);
  const s = supportFor(category, steps as Step[], model, refs.map((r) => r.quote));
  if (s.level === 'none') return reject(`the workflow model does not support it: ${s.why}`);
  return {
    ...base,
    rationale: typeof p.rationale === 'string' && p.rationale.trim() ? p.rationale.trim() : RATIONALE[category],
    support: s.support,
    status: s.level,
    rejection_reason: null,
  };
}

/** Candidate findings nominated by structure. Each still has to pass vetFinding(). */
export function ruleProposals(model: Model): FindingProposal[] {
  const wf = model.workflow;
  const out: FindingProposal[] = [];
  const add = (category: FrictionCategory, steps: Step[], refs: EvidenceRef[]) =>
    out.push({ category, step_ids: steps.map((s) => s.id), evidence: refs, source: 'rule' });

  wf.steps.forEach((s, i) => {
    const prev = wf.steps[i - 1];
    if (s.owner.evidence.length) add('unclear_ownership', [s], s.owner.evidence);
    if (s.manual === true && s.system.evidence.length) {
      add('manual_reentry', prev ? [prev, s] : [s], [...s.evidence, ...s.system.evidence, ...(prev?.system.evidence ?? [])]);
    }
    if (s.system.evidence.length) add('tool_switching', [s], s.system.evidence);
    if (s.waiting_on.evidence.length) add('waiting_dependency', [s], s.waiting_on.evidence);
    if (prev && s.handoff_in.evidence.length) {
      add('information_loss', [prev, s], s.handoff_in.evidence);
      add('manual_status_checking', [prev, s], s.handoff_in.evidence);
    }
  });
  if (wf.completion.evidence.length) add('missing_terminal_condition', [], wf.completion.evidence);
  if (wf.exceptions.evidence.length) add('missing_exception_handling', [], wf.exceptions.evidence);
  if (wf.waiting.evidence.length && !wf.steps.some((s) => s.waiting_on.evidence.length)) add('waiting_dependency', [], wf.waiting.evidence);

  // Structural: one named person owning three or more steps.
  const byOwner = new Map<string, Step[]>();
  for (const s of wf.steps) if (established(s.owner)) byOwner.set(s.owner.value!.toLowerCase(), [...(byOwner.get(s.owner.value!.toLowerCase()) ?? []), s]);
  for (const steps of byOwner.values()) if (steps.length >= 3) add('single_point_of_failure', steps, steps.flatMap((s) => s.owner.evidence));

  const first = wf.steps[0];
  if (first && (first.system.evidence.length || wf.trigger.evidence.length)) {
    add('unstructured_intake', [first], [...wf.trigger.evidence, ...first.system.evidence]);
  }
  return out;
}

const STRENGTH: Record<string, number> = { confirmed: 2, tentative: 1, rejected: 0 };

export interface DiagnoseResult {
  findings: Finding[];
  log: string[];
}

/**
 * Re-derives all findings from the current model. Keeps ids and human review decisions
 * stable across re-detection (matched by signature), and re-vets model-proposed findings
 * against the current model so a correction can invalidate them.
 */
export function diagnose(
  model: Model, evidence: Evidence[], previous: Finding[], nextFindingId: () => string, extra: FindingProposal[] = [],
): DiagnoseResult {
  const log: string[] = [];
  // Model-proposed findings are carried forward and re-checked every time.
  const carried: FindingProposal[] = previous
    .filter((f) => f.source === 'model' && f.status !== 'rejected')
    .map((f) => ({ category: f.category, step_ids: f.step_ids, evidence: f.evidence, rationale: f.rationale, source: 'model' }));

  const best = new Map<string, Omit<Finding, 'id'>>();
  const rejectedModel: Omit<Finding, 'id'>[] = [];
  for (const p of [...ruleProposals(model), ...carried, ...extra]) {
    const v = vetFinding(p, model, evidence);
    if (v.status === 'rejected') {
      if (p.source === 'model') rejectedModel.push(v);
      continue; // a rule nomination that does not hold is simply not a finding
    }
    const current = best.get(v.signature);
    if (!current || STRENGTH[v.status] > STRENGTH[current.status]) best.set(v.signature, v);
  }

  const liveStatuses = new Set(['confirmed', 'tentative', 'user_accepted']);
  const prevLive = new Map(previous.filter((f) => liveStatuses.has(f.status)).map((f) => [f.signature, f]));
  const prevDisputed = new Map(previous.filter((f) => f.status === 'user_disputed').map((f) => [f.signature, f]));
  const findings: Finding[] = [];

  for (const v of best.values()) {
    const live = prevLive.get(v.signature);
    const disputed = prevDisputed.get(v.signature);
    if (!live && disputed) {
      // Sticky dispute: the same finding is not raised again unless it now rests on evidence
      // the user gave AFTER disputing it (the dispute's own words do not count).
      const cutoff = disputed.review?.at_evidence ?? Infinity;
      const fresh = v.evidence.filter((r) => evidenceNumber(r.evidence_id) > cutoff &&
        evidence.find((e) => e.id === r.evidence_id)?.kind !== 'dispute');
      if (fresh.length === 0) {
        continue;
      }
      const id = nextFindingId();
      findings.push({ id, ...v, review: null });
      log.push(`${id}: ${v.status} ${v.category} raised again on new evidence ${fresh.map((r) => r.evidence_id).join(', ')} (${disputed.id} was disputed earlier)`);
      continue;
    }
    const id = live?.id ?? nextFindingId();
    // An accepted finding stays accepted while the model still supports it.
    const accepted = live?.status === 'user_accepted';
    findings.push({ id, ...v, status: accepted ? 'user_accepted' : v.status, review: live?.review ?? null });
    if (!live) log.push(`${id}: ${v.status} ${v.category} (${v.support})`);
  }
  for (const prev of prevLive.values()) {
    if (!best.has(prev.signature)) log.push(`${prev.id}: ${prev.category} no longer supported by the model; removed`);
  }
  // Disputed findings stay on record (excluded from every assessment), whether or not still detected.
  for (const d of prevDisputed.values()) findings.push(d);
  // Keep rejected model proposals for audit (previous ones too), never as findings.
  const audit = [...previous.filter((f) => f.status === 'rejected'), ...rejectedModel.map((r) => ({ id: nextFindingId(), ...r }))];
  for (const r of rejectedModel) log.push(`rejected model finding ${r.category}: ${r.rejection_reason}`);
  const seen = new Set<string>();
  for (const r of audit) {
    const key = `${r.signature}|${r.rejection_reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(r);
  }
  return { findings, log };
}

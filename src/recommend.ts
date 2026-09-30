import type { Finding, FrictionCategory, Intervention, Model, Recommendation } from './domain.ts';

// Recommendation catalog: deterministic, one entry per friction category.
//
// Each entry prefers the smallest intervention that fixes the problem. AI is offered only
// where the input genuinely needs interpretation (free-form language that cannot be
// structured at the source). Every non-AI entry says why AI is not needed, so the
// judgment is visible rather than implied.

interface CatalogEntry {
  intervention: Exclude<Intervention, 'ai_assisted'>;
  title: string;
  detail: string;
  why_not_ai: string;
}

const CATALOG: Record<FrictionCategory, CatalogEntry> = {
  unclear_ownership: {
    intervention: 'process_change',
    title: 'Name one owner (and a backup) for each step',
    detail: 'Write down who is responsible for each step flagged here, and who covers when they are out. "Whoever gets to it" becomes a person.',
    why_not_ai: 'Ownership is a decision for the business to make; no software can decide it.',
  },
  manual_reentry: {
    intervention: 'existing_tool_change',
    title: 'Stop retyping: send the information straight into the tool where it is tracked',
    detail: 'Have the first tool write directly into the second (most form, email and spreadsheet tools can do this natively), or use one tool for both steps. If they cannot connect natively, a simple rule-based integration that copies the same fields every time is enough.',
    why_not_ai: 'The information is already in a fixed shape; moving it needs a connection, not interpretation.',
  },
  duplicate_work: {
    intervention: 'process_change',
    title: 'Pick one place where this work is done',
    detail: 'Decide which of the duplicated steps is the real one and remove the other.',
    why_not_ai: 'Removing duplication is a process decision.',
  },
  unnecessary_handoff: {
    intervention: 'process_change',
    title: 'Let the first person finish the step instead of handing it on',
    detail: 'Where a handoff adds no information or judgment, remove it.',
    why_not_ai: 'Removing a handoff is a process decision.',
  },
  waiting_dependency: {
    intervention: 'simple_automation',
    title: 'Put a due date and an automatic reminder on every wait',
    detail: 'When work starts waiting on someone, record what it waits for and when to chase; send a reminder when that date passes.',
    why_not_ai: 'A date-based reminder is a fixed rule; nothing needs interpreting.',
  },
  missing_terminal_condition: {
    intervention: 'existing_tool_change',
    title: 'Add a status with a small set of end states',
    detail: 'In the list where inquiries are tracked, add a status column with fixed end states (for example: booked, declined, not a fit, no response) and treat any item without one as still open.',
    why_not_ai: 'A status column is a field in a tool you already have.',
  },
  manual_status_checking: {
    intervention: 'existing_tool_change',
    title: 'Make status visible in the shared record instead of asking around',
    detail: 'Keep the current owner and status on the record itself, and use a filtered view (for example "open, older than 2 days") instead of checking in with people.',
    why_not_ai: 'Visibility comes from recording status consistently, not from interpretation.',
  },
  inconsistent_decision: {
    intervention: 'process_change',
    title: 'Write down the decision criteria as a short checklist',
    detail: 'Capture how the decision is actually made (who handles what, and why), so anyone can make it the same way.',
    why_not_ai: 'Consistent decisions come from agreed criteria; automate only after the criteria exist.',
  },
  information_loss: {
    intervention: 'existing_tool_change',
    title: 'Hand work over through the shared record, not by text or word of mouth',
    detail: 'Assign the item to the next person in the list or tool where it is tracked, so the details and the new owner are recorded in one place.',
    why_not_ai: 'The fix is recording the handoff, which existing tools already support.',
  },
  unstructured_intake: {
    intervention: 'existing_tool_change',
    title: 'Keep the structure you already capture at intake',
    detail: 'Where requests come through a form, send the form fields straight to the tracking list instead of into an inbox as a message. Add required fields for what the next step needs.',
    why_not_ai: 'A form already captures structured fields; they only need to go to the right place.',
  },
  bottleneck: {
    intervention: 'process_change',
    title: 'Delegate the step or set a response deadline for it',
    detail: 'Either let more than one person perform it, or agree how quickly it must happen and who steps in when it does not.',
    why_not_ai: 'Throughput limits are fixed by who may do the work, not by software.',
  },
  single_point_of_failure: {
    intervention: 'process_change',
    title: 'Name a backup and write the step down',
    detail: 'Document how the steps are done and train a second person to cover them.',
    why_not_ai: 'Resilience comes from people and documentation.',
  },
  repeated_customer_followup: {
    intervention: 'simple_automation',
    title: 'Send customers automatic updates at fixed points',
    detail: 'Send a fixed acknowledgement when a request arrives and a short update when its status changes, so customers do not have to chase.',
    why_not_ai: 'Fixed message templates triggered by status changes are sufficient; nothing needs to be generated.',
  },
  missing_exception_handling: {
    intervention: 'simple_automation',
    title: 'Add a rule for when the normal path stalls',
    detail: 'Define what "stalled" means (for example: no follow-up within 2 business days) and alert the owner automatically, with a named person to escalate to.',
    why_not_ai: 'Detecting "no update within N days" is a fixed rule.',
  },
  system_mismatch: {
    intervention: 'existing_tool_change',
    title: 'Check whether a tool you already use fits this work before adding a new one',
    detail: 'List what the step actually needs and compare it with the tools already in place.',
    why_not_ai: 'Tool fit is a configuration question.',
  },
  tool_switching: {
    intervention: 'existing_tool_change',
    title: 'Do this step in one tool',
    detail: 'Choose which of the tools used here holds the record, and stop keeping the same information in the others.',
    why_not_ai: 'Consolidating tools is a configuration choice.',
  },
};

/** Free-form channels customers write or speak into, which cannot be structured at the source. */
const FREEFORM_CHANNEL = /\b(e-?mails? (from|us)|phone|calls? (us|in)|voicemail|text(s|ed)? us|walk-?ins?|messages? (us|from))\b/i;

/**
 * AI is offered for unstructured intake only when the intake includes a free-form channel
 * that no form can structure (customers phoning, emailing or texting in their own words).
 * If intake is a form, the structure already exists and AI would add cost without value.
 */
function aiIntakeRecommendation(model: Model, finding: Finding): Omit<Recommendation, 'id'> | null {
  const trigger = model.workflow.trigger.value ?? '';
  if (!FREEFORM_CHANNEL.test(trigger)) return null;
  return {
    finding_ids: [finding.id],
    kind: finding.status === 'tentative' ? 'investigate' : 'act',
    intervention: 'ai_assisted',
    title: 'Use AI to pull key details out of free-form requests, with a person checking each one',
    detail: 'For requests that arrive as free text or voice, have an AI draft the structured record (name, need, urgency, contact details) and a person confirm it before it enters the list.',
    ai_reason: 'Requests arrive in the customer\'s own words over email, phone or text, so the details must be interpreted from language that varies every time; fixed rules handle that poorly.',
    why_not_ai: null,
  };
}

const ACTIONABLE = new Set(['confirmed', 'user_accepted']);

/**
 * Builds recommendations from validated findings only. Findings of the same category share
 * one recommendation. Tentative-only support yields "investigate" recommendations.
 */
export function buildRecommendations(model: Model, findings: Finding[]): Recommendation[] {
  const usable = findings.filter((f) => ACTIONABLE.has(f.status) || f.status === 'tentative');
  const byCategory = new Map<FrictionCategory, Finding[]>();
  for (const f of usable) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);

  const recs: Omit<Recommendation, 'id'>[] = [];
  for (const [category, fs] of byCategory) {
    const entry = CATALOG[category];
    const actionable = fs.some((f) => ACTIONABLE.has(f.status));
    const steps = [...new Set(fs.flatMap((f) => f.step_ids))];
    recs.push(actionable
      ? {
          finding_ids: fs.map((f) => f.id), kind: 'act', intervention: entry.intervention, title: entry.title,
          detail: `${entry.detail}${steps.length ? ` (Applies to ${steps.join(', ')}.)` : ''}`, ai_reason: null, why_not_ai: entry.why_not_ai,
        }
      : {
          finding_ids: fs.map((f) => f.id), kind: 'investigate', intervention: entry.intervention,
          title: `Confirm first: ${fs[0].support}`,
          detail: `This rests on unconfirmed information. Check it with the people involved before changing anything. If it is confirmed, the likely fix is: ${entry.title.toLowerCase()}.`,
          ai_reason: null, why_not_ai: entry.why_not_ai,
        });
    if (category === 'unstructured_intake') {
      const ai = aiIntakeRecommendation(model, fs[0]);
      if (ai) recs.push(ai);
    }
  }
  // Act before investigate; within each, keep a stable order by first finding id.
  const num = (r: Omit<Recommendation, 'id'>) => Number(r.finding_ids[0].slice(1));
  recs.sort((a, b) => (a.kind === b.kind ? num(a) - num(b) : a.kind === 'act' ? -1 : 1));
  return recs.map((r, i) => ({ id: `R${i + 1}`, ...r }));
}

import type { Discovery, DiscoveryState } from './discovery.ts';

// The sanitized demo scenario: a fictional small service business ("Brightline Plumbing & Heating")
// and how it handles a new customer inquiry. It is a demonstration FIXTURE, not product logic:
// these are simply the answers a business owner might give. The assessment is produced by the
// same pipeline as any other, from these answers.
//
// It contains enough friction to show: a handoff problem, manual re-entry, unclear follow-up,
// a missing terminal condition, and a tentative finding that can be confirmed or disputed.

export const SAMPLE_PREFIX = 'Sample: ';
export const SAMPLE_NAME = `${SAMPLE_PREFIX}Brightline Plumbing & Heating, new customer inquiry`;
export const SAMPLE_PROBLEM = "We keep losing new customer inquiries and I don't know why.";

/** Answers keyed by "slot:intent". Anything not listed is answered "I'm not sure." */
export const SAMPLE_ANSWERS: Record<string, string> = {
  'sequence:discover':
    'A customer fills out the contact form on our website. The form sends an email to the office inbox. ' +
    'Maria copies the details into our job spreadsheet. Then the owner decides which technician should handle it. ' +
    'The technician calls the customer to set up a visit. After the visit, someone sends the customer a quote. ' +
    'Sometimes nobody follows up.',
  'sequence:confirm': 'Yes, that is the whole list.',
  'completion:discover': 'Honestly nobody closes them out. They just stay in the spreadsheet.',
  'exceptions:confirm': 'Yes, if the tech is busy it just gets forgotten.',
  'waiting:discover': 'We wait for the customer to call back with a good time.',
  'S1.owner:discover': 'Nobody, it is automatic.',
  'S2.handoff_in:discover': 'Maria checks the inbox when she has time.',
  'S3.handoff_in:discover': 'Maria tells the owner at the end of the day.',
  'S4.handoff_in:discover': 'The owner texts the technician the customer name.',
  'S5.handoff_in:discover': "I don't know how that gets passed along.",
  'S3.system:discover': 'The owner looks at the spreadsheet.',
  'S4.system:discover': 'His phone.',
};

export const FALLBACK_ANSWER = "I'm not sure.";

export function isSample(name: string): boolean {
  return name.startsWith(SAMPLE_PREFIX);
}

export function sampleAnswerFor(slot: string, intent: string): string {
  return SAMPLE_ANSWERS[`${slot}:${intent}`] ?? FALLBACK_ANSWER;
}

/** Runs the whole sample interview through the normal discovery pipeline. */
export async function runSample(d: Discovery, limit = 40): Promise<DiscoveryState> {
  let { state } = await d.start(SAMPLE_NAME, SAMPLE_PROBLEM);
  for (let i = 0; i < limit && state.open_question; i++) {
    const q = state.open_question;
    state = (await d.answer(state.assessment.id, q.id, sampleAnswerFor(q.slot, q.intent))).state;
  }
  return state;
}

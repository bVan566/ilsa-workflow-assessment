import type { Discovery, DiscoveryState } from '../src/discovery.ts';

// A scripted interviewee for the "new customer inquiry" scenario, used by tests.
// It answers whatever question it is asked; the product logic does not know about it.

export const INQUIRY_PROBLEM = "We keep losing new customer inquiries and I don't know why.";

export const INQUIRY_ANSWERS: Record<string, string> = {
  'sequence:discover':
    'A customer fills out the contact form on our website. The form sends an email to the office inbox. ' +
    'Maria copies the details into our spreadsheet. Then the owner decides who should handle it. ' +
    'The technician calls the customer to set up a visit. Sometimes nobody follows up.',
  'sequence:confirm': 'Yes, that is the whole list.',
  'completion:discover': 'Honestly nobody closes them out. They just stay in the spreadsheet.',
  'S1.owner:discover': 'Nobody, it is automatic.',
  'S2.handoff_in:discover': 'Maria checks the inbox when she has time.',
  'S3.handoff_in:discover': 'Maria tells the owner at the end of the day.',
  'S4.handoff_in:discover': 'The owner texts the technician the customer name.',
  'exceptions:confirm': 'Yes, if the tech is busy it just gets forgotten.',
  'waiting:discover': 'We wait for the customer to call back with a good time.',
};

/** Answers every question from `answers`, falling back to "I don't know.". */
export async function interview(d: Discovery, state: DiscoveryState, answers = INQUIRY_ANSWERS, limit = 40): Promise<DiscoveryState> {
  for (let i = 0; i < limit && state.open_question; i++) {
    const q = state.open_question;
    const text = answers[`${q.slot}:${q.intent}`] ?? "I don't know.";
    state = (await d.answer(state.assessment.id, q.id, text)).state;
  }
  return state;
}

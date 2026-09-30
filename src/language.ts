// Small, deterministic language checks shared by the validator and the interpreters.
// These are deliberately simple word lists: transparent and testable, not clever.

/** Wording that signals the speaker is not certain, or that the practice varies. */
export const HEDGE = /\b(i think|i believe|i guess|i assume|i suppose|probably|maybe|perhaps|usually|typically|normally|generally|mostly|most of the time|sometimes|often|supposed to|should be|as far as i know|kind of|sort of|i'?m pretty sure|might|may be)\b/i;

/** Wording that says the speaker does not know. The fact stays unknown. */
export const DONT_KNOW = /\b(i don'?t know|i do not know|not sure|no idea|i'?m not certain|can'?t say|unclear to me|no clue|don'?t really know)\b/i;

export function isHedged(text: string): boolean {
  return HEDGE.test(text);
}

export function isDontKnow(text: string): boolean {
  return DONT_KNOW.test(text);
}

/**
 * Splits text into sentences that are exact substrings of the original,
 * so each one can be quoted as evidence verbatim.
 */
export function sentences(text: string): string[] {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

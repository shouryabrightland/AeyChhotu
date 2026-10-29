/* Wake-word matching for the kitchen's always-listening session.

   A chef's hands are full, so the kitchen mic streams continuously. The model
   is told to answer only when addressed, but that alone is not a control: a
   noisy line can make it act on ambient talk. These helpers are the actual
   gate — the browser only accepts a turn (and only lets a tool run) when the
   transcribed speech contains the wake phrase.

   Matching is deliberately forgiving on paper and strict in spirit: speech
   recognition renders "aey chhotu" as "ay chhotu", "hey chhotu", "ai chhotu"
   or Devanagari, so those variants are aliases of the SAME phrase, not extra
   permissions. Everything else is ignored. */

export interface WakePhrase {
  /** The canonical phrase, e.g. "aey chhotu". */
  phrase: string;
  /** How recognition actually hears it. Treated exactly like the phrase. */
  aliases?: string[];
}

/** The kitchen's phrase. Diner and console sessions never use this. */
export const KITCHEN_WAKE: WakePhrase = {
  phrase: "aey chhotu",
  aliases: [
    // Staff also just call it by name; treated exactly like the full phrase.
    "chhotu",
    "ay chhotu",
    "aye chhotu",
    "hey chhotu",
    "ai chhotu",
    "oye chhotu",
    "ऐ छोटू",
    "ए छोटू",
  ],
};

/** Lowercase, strip punctuation, and drop whitespace so "Aey,  Chhotu!" and
 *  "aeychhotu" compare equal. Unicode letters survive (Devanagari). */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

/** True when the utterance actually addressed the assistant. */
export function containsWakePhrase(text: string, wake: WakePhrase = KITCHEN_WAKE): boolean {
  const haystack = normalizeSpeech(text);
  if (!haystack) return false;

  const needles = [wake.phrase, ...(wake.aliases ?? [])]
    .map((candidate) => normalizeSpeech(candidate))
    .filter((candidate) => candidate.length > 0);

  return needles.some((needle) => haystack.includes(needle));
}

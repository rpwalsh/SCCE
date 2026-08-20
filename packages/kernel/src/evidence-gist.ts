import { splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";

/**
 * Verbatim prose gist of an evidence span, following the episodic-memory
 * consolidation contract: sentences are selected from the real span text,
 * never invented or paraphrased. Table/roster material (runs of capitalized
 * cells with no connective prose) is skipped so downstream claim and
 * obligation machinery works from sentences, not cell soup.
 */
export function proseGistSurface(text: string, maxSentences = 2): string {
  if (!text) return "";
  const selected: string[] = [];
  for (const sentence of splitSurfaceSentences(text)) {
    if (selected.length >= maxSentences) break;
    if (isProseSentence(sentence)) selected.push(sentence.replace(/\s+/gu, " ").trim());
  }
  return selected.join(" ");
}

export function isProseSentence(sentence: string): boolean {
  const words = surfaceWords(sentence);
  if (words.length < 6) return false;
  if (/[|]{1}|\t/u.test(sentence)) return false;
  const lower = words.filter(word => /^\p{Ll}/u.test(word)).length;
  return lower / words.length >= 0.35;
}

/** Long runs of capitalized cells with almost no connective prose — table material, never a claim. */
export function isEntitySaladSurface(text: string): boolean {
  const words = surfaceWords(text);
  if (words.length < 6) return false;
  const lower = words.filter(word => /^\p{Ll}/u.test(word)).length;
  return lower / words.length < 0.35;
}

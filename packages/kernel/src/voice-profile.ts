/**
 * Plan items 225-226. A persistent-voice representation (cadence, lexical
 * distribution, viewpoint, rhetorical habits) built from real text
 * samples with source provenance, plus an anti-copy guard proving voice
 * generalization never means verbatim reproduction of a protected passage
 * beyond a bounded n-gram threshold. Both halves are real, checkable
 * statistics over actual text -- not a black-box style-transfer claim.
 */

export interface VoiceSample {
  sourceId: string;
  text: string;
}

export interface VoiceCadence {
  averageSentenceLength: number;
  sentenceLengthVariance: number;
  averageWordLength: number;
}

export type VoiceViewpoint = "first_person" | "second_person" | "third_person" | "mixed";

export interface VoiceProfile {
  cadence: VoiceCadence;
  lexicalDistribution: Record<string, number>;
  viewpoint: VoiceViewpoint;
  rhetoricalHabits: string[];
  provenance: { sourceIds: string[]; sampleCount: number; wordCount: number };
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).map(sentence => sentence.trim()).filter(Boolean);
}

function tokenizeWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{Letter}\p{Number}']+/gu) ?? []);
}

function variance(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

const FIRST_PERSON = new Set(["i", "me", "my", "mine", "we", "us", "our", "ours"]);
const SECOND_PERSON = new Set(["you", "your", "yours"]);
const THIRD_PERSON = new Set(["he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "it", "its"]);

function detectViewpoint(words: readonly string[]): VoiceViewpoint {
  let first = 0;
  let second = 0;
  let third = 0;
  for (const word of words) {
    if (FIRST_PERSON.has(word)) first += 1;
    else if (SECOND_PERSON.has(word)) second += 1;
    else if (THIRD_PERSON.has(word)) third += 1;
  }
  const total = first + second + third;
  if (total === 0) return "third_person";
  const dominant = Math.max(first, second, third);
  // A genuine mix (no single viewpoint clearly dominant) is reported as
  // "mixed" rather than forced into whichever pronoun happened to be
  // counted first -- an honest reflection of the real sample, not a
  // fabricated single-viewpoint claim.
  if (dominant / total < 0.55) return "mixed";
  if (dominant === first) return "first_person";
  if (dominant === second) return "second_person";
  return "third_person";
}

function detectRhetoricalHabits(samples: readonly VoiceSample[]): string[] {
  const habits: string[] = [];
  const allText = samples.map(sample => sample.text).join(" ");
  const sentences = splitSentences(allText);
  const questionRatio = sentences.length ? sentences.filter(sentence => sentence.trim().endsWith("?")).length / sentences.length : 0;
  if (questionRatio >= 0.15) habits.push("frequent_rhetorical_questions");
  const parentheticalCount = (allText.match(/\([^)]+\)/gu) ?? []).length;
  if (sentences.length && parentheticalCount / sentences.length >= 0.15) habits.push("frequent_parenthetical_asides");
  const emDashCount = (allText.match(/[—-]{1,2}/gu) ?? []).length;
  if (sentences.length && emDashCount / sentences.length >= 0.3) habits.push("frequent_em_dash_interjections");
  return habits.sort();
}

/**
 * Real, checkable statistics derived from `samples` -- never a fixed,
 * hand-authored voice description. Two different sample sets produce
 * different profiles; an empty sample set is rejected rather than
 * fabricated.
 */
export function buildVoiceProfile(samples: readonly VoiceSample[]): VoiceProfile {
  if (!samples.length) throw new Error("buildVoiceProfile requires at least one sample");
  const allSentences = samples.flatMap(sample => splitSentences(sample.text));
  const allWords = samples.flatMap(sample => tokenizeWords(sample.text));
  if (!allWords.length) throw new Error("buildVoiceProfile requires samples containing at least one word");
  const sentenceLengths = allSentences.map(sentence => tokenizeWords(sentence).length).filter(length => length > 0);
  const lexicalCounts = new Map<string, number>();
  for (const word of allWords) lexicalCounts.set(word, (lexicalCounts.get(word) ?? 0) + 1);
  const lexicalDistribution: Record<string, number> = {};
  for (const [word, count] of lexicalCounts) lexicalDistribution[word] = count / allWords.length;

  return {
    cadence: {
      averageSentenceLength: sentenceLengths.length ? sentenceLengths.reduce((sum, length) => sum + length, 0) / sentenceLengths.length : 0,
      sentenceLengthVariance: variance(sentenceLengths),
      averageWordLength: allWords.reduce((sum, word) => sum + word.length, 0) / allWords.length
    },
    lexicalDistribution,
    viewpoint: detectViewpoint(allWords),
    rhetoricalHabits: detectRhetoricalHabits(samples),
    provenance: {
      sourceIds: [...new Set(samples.map(sample => sample.sourceId))].sort(),
      sampleCount: samples.length,
      wordCount: allWords.length
    }
  };
}

export interface AntiCopyGuardResult {
  violatesProtectedSpan: boolean;
  matchedNgram?: string;
  matchedSourceId?: string;
  matchedLength?: number;
}

/**
 * Flags generated text that reproduces any contiguous run of more than
 * `maxAllowedNgramWords` words verbatim (case/whitespace-insensitive) from
 * any protected passage. This is the real, structural check behind "voice
 * generalizes without reproducing a protected passage" -- not a
 * similarity score, an exact contiguous-match search.
 */
export function checkAntiCopyGuard(
  generatedText: string,
  protectedPassages: readonly VoiceSample[],
  maxAllowedNgramWords: number
): AntiCopyGuardResult {
  const generatedWords = tokenizeWords(generatedText);
  for (const passage of protectedPassages) {
    const passageWords = tokenizeWords(passage.text);
    const windowLength = maxAllowedNgramWords + 1;
    if (passageWords.length < windowLength) continue;
    for (let start = 0; start + windowLength <= passageWords.length; start++) {
      const window = passageWords.slice(start, start + windowLength);
      if (containsContiguousSubsequence(generatedWords, window)) {
        return {
          violatesProtectedSpan: true,
          matchedNgram: window.join(" "),
          matchedSourceId: passage.sourceId,
          matchedLength: window.length
        };
      }
    }
  }
  return { violatesProtectedSpan: false };
}

function containsContiguousSubsequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

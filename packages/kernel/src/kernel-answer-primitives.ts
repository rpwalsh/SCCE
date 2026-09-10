// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { hasUncasedNonLatinLetter, hasUppercaseLetter, surfaceWords } from "./surface-linguistics.js";
import type { JsonValue } from "./types.js";




export function namedSubjectAnchors(text: string): string[] {
  return namedPriorSurfaceRuns(text)
    .map(normalizePriorKey)
    .filter(namedSourceAnchorSpecificEnough)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
}



 function namedSourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return units.some(unit => [...unit].length >= 3 && !genericQuestionSignal(unit));
}



/**
 * Source-neutral request units shared by graph retrieval and question-slot
 * selection. Punctuation does not identify a language-independent question
 * operator, so every observed unit remains available to downstream scoring.
 *
 * @internal Exported for focused routing-invariant tests; it is not re-exported
 * from the package entrypoint.
 */
export function requestContentPriorUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text));
}



/** @internal See {@link requestContentPriorUnits}. */
export function requestContentSurface(text: string): string {
  const words = splitPriorSurfaceWords(text);
  return words.join(" ") || text;
}



export function genericQuestionSignal(unit: string): boolean {
  if (!unit) return true;
  if (unit.length <= 2) return true;
  let letters = 0;
  let repeated = 0;
  let previous = "";
  for (const char of unit) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
    if (char === previous) repeated++;
    previous = char;
  }
  return letters <= 1 || repeated / Math.max(1, unit.length - 1) > 0.72;
}



 function namedPriorSurfaceRuns(text: string): string[] {
  // A sentence-initial capital is not a name signal: "What is acupuncture?" named "what" as its subject, which then
  // anchored retrieval, admission and the runtime-motion surface ("what acupuncture") to a question word.
  const cased = uniqueKernelStrings(casedEntityRunsWithConnectors(text))
    .filter(run => !sentenceInitialSingleWordRun(run, text))
    .slice(0, 8);
  if (cased.length) return cased;
  // Case carries no signal in a request that never capitalizes anything -- a real, common way to type
  // ("who is ada lovelace"), not a degenerate one. surfaceEntityRuns's whole extraction is gated on
  // hasPriorAnchorSignal (case or non-Latin script), so an all-lowercase Latin request produced zero
  // anchors regardless of what it actually named: measured live, "who is ada lovelace" retrieved nothing
  // for its real subject and fell back to whatever loosely matched the bare word "lovelace" (unrelated
  // pop-culture mentions), realizing a one-word non-answer despite the corpus holding a full biography.
  // Only fires when casing is entirely absent from the input, so a normally-cased request is completely
  // unaffected -- length is the substitute anchor signal (matching the >=3-character single-word floor
  // namedSourceAnchorSpecificEnough already applies downstream), not a new, weaker acceptance rule.
  // The run that is the request's own opening word leads: a request that opens on its subject ("athens is the
  // capital of which country") is about that word, not about the phrase its question words form.
  const opening = normalizePriorKey(surfaceWords(text).map(stripOuterPriorSeparators).filter(Boolean)[0] ?? "");
  const runs = uniqueKernelStrings(surfaceEntityRunsCaseless(text).map(run => withoutLeadingRequestScaffolding(run, text)))
    .filter(Boolean);
  const openingRun = [...opening].length >= 4 ? runs.find(run => normalizePriorKey(run) === opening) : undefined;
  return (openingRun ? [openingRun, ...runs.filter(run => run !== openingRun)] : runs).slice(0, 8);
}

/** Cased runs that survive one short lowercase connector between cased words: "Alfred the Great", "Joan of Arc",
 *  "Vasco da Gama" are one name, and surfaceEntityRuns broke them at the connector -- "Alfred the Great" became the
 *  anchors "alfred" and "great", which admitted the Alfred Hitchcock article (live 2026-09-10). The request's own
 *  short opening word followed by a connector ("Who is Aphrodite") is scaffolding, and is shed. */
function casedEntityRunsWithConnectors(text: string): string[] {
  const words = surfaceWords(text).map(stripOuterPriorSeparators).filter(Boolean);
  const cased = (word: string) => hasUppercaseLetter(word) || hasUncasedNonLatinLetter(word);
  const out: string[] = [];
  let current: string[] = [];
  let pendingConnector: string | undefined;
  const flush = () => {
    if (current.length) out.push(current.join(" "));
    current = [];
    pendingConnector = undefined;
  };
  // The request's short opening word followed by a lowercase word is the sentence's capital on a question or
  // instruction word ("Who was", "Tell me"); it never starts a name. "Ada Lovelace was" keeps its first word.
  const openingWord = words[0];
  const openingIsScaffolding = openingWord !== undefined && words.length >= 2
    && [...openingWord].length <= 5 && !cased(words[1]!) && words[1] === words[1]!.toLocaleLowerCase();
  for (let index = openingIsScaffolding ? 1 : 0; index < words.length; index++) {
    const word = words[index]!;
    if (cased(word) || (current.length > 0 && /^\p{Number}+$/u.test(word))) {
      if (pendingConnector) current.push(pendingConnector);
      pendingConnector = undefined;
      current.push(word);
      continue;
    }
    // A connector joins a name to one more cased word ("Joan of Arc", "Alfred the Great"); it does not fuse two
    // names into a phrase ("Benjamin Sisko in Star Trek ..."), which names nothing the corpus is titled with.
    const next = words[index + 1];
    const afterNext = words[index + 2];
    if (current.length > 0 && !pendingConnector && [...word].length <= 3 && word === word.toLocaleLowerCase()
      && next !== undefined && cased(next) && (afterNext === undefined || !cased(afterNext))) {
      pendingConnector = word;
      continue;
    }
    flush();
  }
  flush();
  return out.filter(Boolean);
}

/** The text's first word alone, followed by a lowercase word: "Who is", "What did", "Explain the" -- a question or
 *  instruction word wearing the sentence's capital, not a name. A two-word run ("Ada Lovelace was") stays. */
function sentenceInitialSingleWordRun(run: string, text: string): boolean {
  const words = surfaceWords(text).map(stripOuterPriorSeparators).filter(Boolean);
  if (words.length < 2 || normalizePriorKey(words[0]!) !== normalizePriorKey(run)) return false;
  // The same length bound the run builder applies: "Athens is the capital of which country?" opens on its subject,
  // and dropping it left "which country" as the anchor (live 2026-09-10, six declines in the reference comparison).
  if ([...words[0]!].length > 5) return false;
  const next = words[1]!;
  return next[0] !== undefined && next[0] === next[0].toLocaleLowerCase() && next[0] !== next[0].toLocaleUpperCase();
}

/** Without case, length is the only signal: the short words a request opens with ("who", "does", "what") are
 *  scaffolding, so they are shed from the run that starts the text until a longer word begins it. */
function withoutLeadingRequestScaffolding(run: string, text: string): string {
  const words = surfaceWords(text).map(stripOuterPriorSeparators).filter(Boolean);
  const runWords = run.split(/\s+/u).filter(Boolean);
  if (!words.length || !runWords.length || normalizePriorKey(words[0]!) !== normalizePriorKey(runWords[0]!)) return run;
  let start = 0;
  while (start < runWords.length && [...runWords[start]!].length <= 5) start++;
  return runWords.slice(start).join(" ");
}

function surfaceEntityRunsCaseless(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current.join(" "));
    current = [];
  };
  for (const raw of surfaceWords(text)) {
    const word = stripOuterPriorSeparators(raw);
    if (!word) continue;
    if (current.length > 0 && /^\p{Number}+$/u.test(word)) {
      current.push(word);
      continue;
    }
    if (splitPriorUnits(normalizePriorKey(word)).some(unit => unit.length >= 3)) {
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return out;
}



 function splitPriorSurfaceWords(text: string): string[] {
  return surfaceWords(text);
}



/**
 * A word written entirely in capitals is a name, however short.
 *
 * The single-word rule below keeps a run only at four normalized characters or more, which is a proxy for "long
 * enough to be a name rather than a sentence-initial capital". It fails exactly on the names that carry the most
 * information: measured on the live corpus, "What is DNA?" extracted the anchor "what" -- four characters, kept --
 * and dropped "DNA" at three, so retrieval searched for the question word, gathered nothing, and refused a question
 * whose article the corpus holds. Case, not length, is what separates a name from a sentence opening, and it reads
 * the same way in every cased script.
 */
function acronymLikeUnit(value: string): boolean {
  const letters = [...value].filter(character => /\p{Letter}/u.test(character));
  return letters.length >= 2 && letters.every(character => /\p{Uppercase_Letter}/u.test(character));
}

export function surfaceEntityRuns(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (
      current.length >= 2 ||
      current.some(hasUncasedNonLatinLetter) ||
      current.some(acronymLikeUnit) ||
      current.some(unit => hasPriorAnchorSignal(unit) && [...normalizePriorKey(unit)].length >= 4)
    ) out.push(current.join(" "));
    current = [];
  };
  for (const raw of surfaceWords(text)) {
    const word = stripOuterPriorSeparators(raw);
    if (!word) continue;
    // A digit run continues a name it follows: "Apollo 11", "Windows 95", "World War 2".
    //
    // Digits carry no case, so the anchor-signal test below is false for them and the run flushed at "Apollo".
    // The request subject became "apollo", which exact-matches the title of the article about the Greek god,
    // and "When did Apollo 11 land on the Moon?" was answered from it. Only a run already under construction
    // may be extended, so a bare year elsewhere in a sentence still starts nothing.
    if (current.length > 0 && /^\p{Number}+$/u.test(word)) {
      current.push(word);
      continue;
    }
    if (hasPriorAnchorSignal(word) && splitPriorUnits(normalizePriorKey(word)).some(unit => unit.length >= 2)) {
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return uniqueKernelStrings(out).slice(0, 32);
}



export function boundedEditDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  // Banded Levenshtein (Ukkonen). A cell (i, j) with |i - j| > maxDistance
  // can never hold a value <= maxDistance, so only the diagonal band of
  // width 2*maxDistance+1 is computed: O(n * maxDistance) instead of the
  // full O(n * m) row this previously filled. Profiled at 8.7% of a turn's
  // CPU via requestUnitSimilarity, which calls this pairwise in a loop.
  //
  // Values are clamped at maxDistance+1. That preserves exactness for every
  // result <= maxDistance (costs along an optimal DP path are
  // non-decreasing, so a path to a small final value never crosses a
  // clamped cell) and collapses everything larger into the single
  // "too far" answer the callers already treat as a miss.
  const cap = maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => Math.min(index, cap));
  for (let i = 1; i <= left.length; i++) {
    const current: number[] = new Array(right.length + 1).fill(cap);
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(right.length, i + maxDistance);
    if (from === 1) current[0] = Math.min(i, cap);
    // Column 0 is a live cell of the row (deleting all of `left` so far);
    // seeding rowMin from cap alone made a row whose band lies entirely
    // past `right`'s end look exhausted and return early -- caught by the
    // oracle test on ("b", "", 1), where the true distance is 1.
    let rowMin = from === 1 ? (current[0] ?? cap) : cap;
    for (let j = from; j <= to; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? cap) + 1,
        (current[j - 1] ?? cap) + 1,
        (previous[j - 1] ?? cap) + cost,
        cap
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return cap;
    previous = current;
  }
  return Math.min(previous[right.length] ?? cap, cap);
}



export function kernelClamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}



export function hasPriorAnchorSignal(value: string): boolean {
  return hasUppercaseLetter(value) || hasUncasedNonLatinLetter(value);
}



export function stripOuterPriorSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPriorSeparator(value[start] ?? "")) start++;
  while (end > start && isPriorSeparator(value[end - 1] ?? "")) end--;
  return value.slice(start, end).trim();
}



export function isPriorSeparator(char: string): boolean {
  return char === "\\" || char === "\"" || char === "'" || char === ":" || char === "," || char === "." || char === ";" || char === "?" || char === "!" || char === "{" || char === "}" || char === "[" || char === "]" || isPriorWhitespace(char);
}



export function collapsePriorWhitespace(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    out += char;
    pendingSpace = false;
  }
  return out.trim();
}



 function isPriorWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}



export function splitPriorUnits(value: string): string[] {
  const units: string[] = [];
  let current = "";
  for (const char of value) {
    if (isPriorWhitespace(char)) {
      if (current) units.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) units.push(current);
  return units;
}



export function normalizePriorKey(value: string): string {
  return collapsePriorWhitespace(value.toLocaleLowerCase());
}



export function kernelString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}



export function kernelNumber(value: JsonValue | undefined, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}



export function kernelStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}



export function uniqueKernelStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const clean = value.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}



export function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

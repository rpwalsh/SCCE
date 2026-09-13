// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * What a request names, decided by the corpus rather than by orthography.
 *
 * The predecessor read Latin capitalization, shed "short" opening words and bounded names at five characters. It
 * reported the verb as the subject of "What did he discover?" and of "Explain relativity.", and it had nothing to
 * read at all in Korean, Japanese, Chinese, Hebrew, Arabic or Devanagari, where case does not exist.
 *
 * Three signals replace it, each a measured property of the corpus and none a property of English:
 *
 *   scaffolding   a unit the language uses to continue many distinct contexts (Kneser-Ney continuation counts,
 *                 already derived per corpus in any script) frames a request; it never names.
 *   identity      a run some source carries as its whole identity is a thing the corpus has a document ABOUT.
 *                 This is exact, not containment: "explain" sits inside "unexplained wealth of the marcos family".
 *   concentration a run whose units appear together in few sources is a topic the corpus documents without titling
 *                 -- relativity, javascript -- where an identity match cannot exist. Where concentration begins is
 *                 read off the corpus's own spread distribution by Otsu, never declared.
 *
 * Retrieval anchoring wants every content run; discourse binding wants only what the corpus is titled with. Those
 * are different questions and this module answers them separately.
 */

export interface CorpusIdentitySignals {
  /** Units the active language uses as scaffolding, by continuation count. */
  readonly closedClass: ReadonlySet<string>;
  /** Runs some source carries as its whole identity, normalized. */
  readonly identities: ReadonlySet<string>;
  /** Run -> distinct sources carrying every unit of it. Absent means unmeasured, which is not zero. */
  readonly spread: ReadonlyMap<string, number>;
  /** Otsu split of the corpus's own spread distribution; runs at or below it are concentrated. */
  readonly concentration: number;
}

const UNIT_SEPARATOR = /[^\p{L}\p{M}\p{N}'’-]+/u;

let signals: CorpusIdentitySignals | undefined;
let generation = 0;

export function primeCorpusIdentitySignals(next: CorpusIdentitySignals): void {
  signals = next;
  generation += 1;
}

export function corpusIdentitySignals(): CorpusIdentitySignals | undefined {
  return signals;
}

/** Bumped whenever the corpus signal changes, so callers memoizing an answer derived from it can tell it is stale. */
export function corpusIdentityGeneration(): number {
  return generation;
}

/** Test seam: forget what the corpus taught, so a unit test starts from no corpus knowledge. */
export function clearCorpusIdentitySignals(): void {
  signals = undefined;
  generation += 1;
}

export function corpusIdentityUnits(text: string): string[] {
  return text.normalize("NFC").toLocaleLowerCase().split(UNIT_SEPARATOR).filter(Boolean);
}

/**
 * Maximal contiguous runs of units the language does not use as scaffolding, plus each run's individual units.
 *
 * Linear in the request. It enumerated every sub-run of every maximal run instead, which is quadratic: one coding
 * request produced 299 runs and measured all of them against the database in a single turn. Finding an identity
 * buried inside a longer run is no longer this function's job -- the corpus is asked directly which of its titles
 * appear in the request, which costs one query whatever the request's length.
 */
export function contentRuns(text: string, closedClass: ReadonlySet<string>): string[] {
  const units = corpusIdentityUnits(text);
  const maximal: string[][] = [];
  let current: string[] = [];
  for (const unit of units) {
    if (closedClass.has(unit)) {
      if (current.length) maximal.push(current);
      current = [];
      continue;
    }
    current.push(unit);
  }
  if (current.length) maximal.push(current);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const run of maximal) {
    for (const key of [run.join(" "), ...run]) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * What the request names, for retrieval: identity runs when the corpus is titled with any of them, otherwise the
 * concentrated runs, otherwise every content run. Longest first, and a run contained in an accepted longer run is
 * dropped -- "moby dick" answers for "moby" and "dick".
 */
export function corpusNamedRuns(text: string): string[] {
  const state = signals;
  // Nothing learned yet: the request's own content, whole. Weak, but it is what is true before the corpus has
  // spoken, and it is equally weak in every language rather than confidently wrong outside Latin script.
  if (!state) {
    const whole = corpusIdentityUnits(text).join(" ");
    return whole ? [whole] : [];
  }
  const identities = corpusNamedIdentities(text);
  if (identities.length) return identities;
  const runs = contentRuns(text, state.closedClass);
  const concentrated = runs.filter(run => {
    const measured = state.spread.get(run);
    return measured !== undefined && measured > 0 && measured <= state.concentration;
  });
  return withoutContainedRuns(concentrated.length ? concentrated : runs);
}

/**
 * What the request names, for discourse binding: only runs the corpus carries as a whole source identity. A
 * follow-up that names nothing here keeps the conversation's subject, which is the whole point of the question.
 * Deliberately stricter than {@link corpusNamedRuns}: naming the wrong new subject loses the thread, while
 * anchoring on an extra content run only widens retrieval.
 */
export function corpusNamedIdentities(text: string): string[] {
  const state = signals;
  if (!state) return [];
  // The identities are titles the corpus found inside this request, so they need not line up with a content run:
  // "the lord of the rings" is one title and its scaffolding words sit in the middle of it.
  const units = corpusIdentityUnits(text);
  const surface = " " + units.join(" ") + " ";
  const present = [...state.identities].filter(identity => {
    if (!identity) return false;
    // A title the language uses as scaffolding names nothing in a request. The corpus holds a document titled "a",
    // so every request containing that word reported it as its subject.
    if (identity.split(" ").every(unit => state.closedClass.has(unit))) return false;
    if (surface.includes(" " + identity + " ")) return true;
    // Where a language binds its grammar onto the word rather than beside it, the name is inside the unit:
    // Korean spaces between eojeol but agglutinates its particles, so "서울의" carries the name "서울" and a
    // whole-request space test found nothing. Anchored to a unit edge, because that is where a bound morpheme
    // attaches in any writing system; an identity buried inside a unit with material on both sides is a
    // coincidence, which is what keeps "explain" from being named by "unexplained".
    if (identity.includes(" ")) return false;
    return units.some(unit => unit !== identity && unit.length > identity.length
      && (unit.startsWith(identity) || unit.endsWith(identity)));
  });
  return withoutContainedRuns(present);
}

function withoutContainedRuns(runs: readonly string[]): string[] {
  const ordered = [...runs].sort((left, right) => right.split(" ").length - left.split(" ").length || right.length - left.length);
  const out: string[] = [];
  for (const run of ordered) {
    if (out.some(kept => containsRun(kept, run))) continue;
    out.push(run);
  }
  return out;
}

function containsRun(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const outerUnits = outer.split(" ");
  const innerUnits = inner.split(" ");
  if (innerUnits.length > outerUnits.length) return false;
  for (let start = 0; start + innerUnits.length <= outerUnits.length; start += 1) {
    if (innerUnits.every((unit, offset) => outerUnits[start + offset] === unit)) return true;
  }
  return false;
}

/**
 * Otsu's threshold over a corpus's spread distribution: the split maximizing between-class variance, which is where
 * the corpus's own two populations -- units it documents and units it merely uses -- separate. No value is declared;
 * a corpus of Korean legal filings would place it somewhere else and this would still be right.
 */
export function concentrationThreshold(distribution: readonly number[], scanCap: number): number {
  const values = distribution.filter(value => Number.isFinite(value) && value > 0);
  if (values.length < 2) return 0;
  const bins = 256;
  // Looped, not spread: Math.max(...values) overflows the stack once the sample is large, which a source summary's
  // sentence-similarity values reach immediately.
  let ceiling = scanCap;
  for (const value of values) if (value > ceiling) ceiling = value;
  const histogram = new Array<number>(bins).fill(0);
  for (const value of values) {
    const bin = Math.min(bins - 1, Math.floor((value / ceiling) * bins));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
  }
  let weighted = 0;
  for (let bin = 0; bin < bins; bin += 1) weighted += bin * histogram[bin]!;
  let belowWeight = 0;
  let belowWeighted = 0;
  let best = -1;
  let bestBin = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    belowWeight += histogram[bin]!;
    if (!belowWeight) continue;
    const aboveWeight = values.length - belowWeight;
    if (!aboveWeight) break;
    belowWeighted += bin * histogram[bin]!;
    const belowMean = belowWeighted / belowWeight;
    const aboveMean = (weighted - belowWeighted) / aboveWeight;
    const between = belowWeight * aboveWeight * (belowMean - aboveMean) * (belowMean - aboveMean);
    if (between > best) {
      best = between;
      bestBin = bin;
    }
  }
  return Math.round(((bestBin + 1) / bins) * ceiling);
}

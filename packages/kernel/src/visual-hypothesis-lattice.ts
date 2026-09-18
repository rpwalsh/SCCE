// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Reading an inscription is not choosing; it is explaining. Where the marks admit two explanations, saying only
// the winner throws away the fact that there were two, and the fact that there were two is often the most
// useful thing a reader can be told about a damaged or unfamiliar text.
//
// So interpretations are kept as a lattice and pruned only by DOMINATION: one is discarded when another
// explains at least as much evidence at no greater description cost and with no more contradictions. Two that
// each explain something the other does not both survive, and what they disagree about is reported.
//
// Confidence is calibrated against a null. Every claim -- these marks fall into lines, this sequence reads like
// the language, these signs are one unit -- is scored against the same measurement taken after destroying the
// structure being claimed: shuffle the order, permute the identities, jitter the positions. The score is then a
// standard score and an empirical tail, in the same units whatever the claim, so "I see lines strongly" and
// "this decipherment is weak" can be said in one currency and compared.
//
// Measured caution, learned the hard way: pick the null that destroys the structure actually being claimed. A
// standard score on the autocorrelation of a page's ink did not separate writing from noise at all (1.74
// against 1.16), while the same idea applied to the gap at a lattice boundary separated them cleanly.

/** One claim, scored against the same measurement with its structure destroyed. */
export interface EvidenceChannel {
  readonly name: string;
  readonly observed: number;
  readonly nullMean: number;
  readonly nullSpread: number;
  /**
   * Standard score against the null. Where the null has no spread at all the score is not infinite but the
   * largest a sample of this size can justify -- the z whose Gaussian tail is the smallest tail the draws can
   * express. Reporting infinity instead loses the claim entirely to any consumer that must add scores up.
   */
  readonly z: number;
  /** Fraction of null draws at least as extreme, add-one corrected: the empirical tail. */
  readonly tail: number;
  readonly samples: number;
}

/**
 * Score an observation against draws from its null. The tail is the add-one corrected rank, which is the usual
 * unbiased estimate and never claims a probability of zero from a finite number of draws.
 */
export function calibrateEvidence(name: string, observed: number, nullSamples: readonly number[]): EvidenceChannel {
  const samples = nullSamples.length;
  if (!samples) {
    return { name, observed, nullMean: 0, nullSpread: 0, z: 0, tail: 1, samples: 0 };
  }
  const nullMean = nullSamples.reduce((sum, value) => sum + value, 0) / samples;
  let variance = 0;
  for (const value of nullSamples) variance += (value - nullMean) ** 2;
  const nullSpread = Math.sqrt(variance / samples);
  const atLeastAsExtreme = nullSamples.filter(value => value >= observed).length;
  const ceiling = Math.sqrt(2 * Math.log(samples + 1));
  const z = nullSpread > 0
    ? (observed - nullMean) / nullSpread
    : (observed > nullMean ? ceiling : (observed < nullMean ? -ceiling : 0));
  return {
    name,
    observed,
    nullMean,
    nullSpread,
    z,
    tail: (atLeastAsExtreme + 1) / (samples + 1),
    samples
  };
}

/** One way of explaining the marks, with what it costs and what it is supported by. */
export interface Interpretation {
  readonly label: string;
  /** The questions this interpretation answers, and how: orientation, grouping, direction, granularity... */
  readonly choices: Readonly<Record<string, string>>;
  readonly text: string;
  /** Total description length in nats: what the explanation and the page cost together. */
  readonly codeLength: number;
  readonly evidence: readonly EvidenceChannel[];
  /** Observations this interpretation cannot account for. */
  readonly contradictions: number;
}

/**
 * Does `better` dominate `worse`? Only when it costs no more to describe, contradicts no more, and is at least
 * as well supported on every channel -- and beats it somewhere. Anything short of that leaves both standing:
 * two explanations that each account for something the other cannot are not ranked, they are alternatives.
 */
export function dominates(better: Interpretation, worse: Interpretation): boolean {
  if (better.codeLength > worse.codeLength) return false;
  if (better.contradictions > worse.contradictions) return false;

  const worseByName = new Map(worse.evidence.map(channel => [channel.name, channel]));
  let strictlyBetter = better.codeLength < worse.codeLength || better.contradictions < worse.contradictions;
  for (const channel of better.evidence) {
    const against = worseByName.get(channel.name);
    if (!against) continue;
    if (channel.z < against.z) return false;
    if (channel.z > against.z) strictlyBetter = true;
  }
  // A channel the other side measured and this one did not is evidence unaccounted for, so it cannot dominate.
  for (const channel of worse.evidence) {
    if (!better.evidence.some(mine => mine.name === channel.name)) return false;
  }
  return strictlyBetter;
}

export interface HypothesisLattice {
  /** Interpretations no other dominates, cheapest first. */
  readonly readings: readonly Interpretation[];
  readonly dominated: readonly Interpretation[];
  /** The questions the survivors answer differently, and the answers they give. */
  readonly undecided: readonly { readonly question: string; readonly answers: readonly string[] }[];
}

/** Keep every interpretation nothing else dominates. */
export function pruneByDomination(interpretations: readonly Interpretation[]): HypothesisLattice {
  const readings: Interpretation[] = [];
  const dominated: Interpretation[] = [];
  for (const candidate of interpretations) {
    if (interpretations.some(other => other !== candidate && dominates(other, candidate))) dominated.push(candidate);
    else readings.push(candidate);
  }
  readings.sort((a, b) => a.codeLength - b.codeLength);

  const questions = new Set<string>();
  for (const reading of readings) for (const question of Object.keys(reading.choices)) questions.add(question);
  const undecided: { question: string; answers: string[] }[] = [];
  for (const question of [...questions].sort()) {
    const answers = [...new Set(readings.map(reading => reading.choices[question] ?? "-"))];
    if (answers.length > 1) undecided.push({ question, answers: answers.sort() });
  }
  return { readings, dominated, undecided };
}

/** What the surviving readings disagree about, in words, or nothing when they agree. */
export function describeDisagreement(lattice: HypothesisLattice): string | undefined {
  if (lattice.readings.length < 2 || !lattice.undecided.length) return undefined;
  const parts = lattice.undecided.map(item => `${item.question} (${item.answers.join(" or ")})`);
  return `${lattice.readings.length} readings stand; they differ on ${parts.join(", ")}`;
}

/** A deterministic 0..1 stream, so every null is reproducible. */
function stream(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state % 1000003) / 1000003;
  };
}

/** A copy with the order destroyed: the null for any claim about sequence. */
export function shuffledOrder<T>(values: readonly T[], seed: number): T[] {
  const out = [...values];
  const next = stream(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

/** A relabelling of identities that keeps the order: the null for any claim about which sign is which. */
export function permutedIdentities(values: readonly number[], seed: number): number[] {
  const distinct = [...new Set(values)];
  const shuffled = shuffledOrder(distinct, seed);
  const mapping = new Map(distinct.map((identity, index) => [identity, shuffled[index]!]));
  return values.map(value => mapping.get(value)!);
}

/** Positions nudged by up to one unit of their own scale: the null for any claim about placement. */
export function jitteredPositions(values: readonly number[], scale: number, seed: number): number[] {
  const next = stream(seed);
  return values.map(value => value + (next() * 2 - 1) * scale);
}

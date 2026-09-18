// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A script does not have to spend one sign per symbol. A digraph spends two signs on one sound, as English does
// with "th" and Greek with "ou"; a logogram spends one sign on a whole word; and an abbreviation spends one sign
// on several. So a correspondence may be one to one, one to many, many to one, or many to many, and which it is
// cannot be declared in advance.
//
// A one-to-one assignment is still exactly right where the evidence says the mapping is bijective, and
// maximumWeightAssignment is used there. This is the layer above it: candidates of every arity are proposed and
// scored, and a bijective answer is simply what comes out when the page is bijective.
//
// Scoring carries no hand-picked coefficients. Each channel of evidence -- how alike the frequencies are, how
// far the neighbourhoods correspond -- is measured, then scored against the distribution of that same
// measurement over random pairings. A candidate's support is the summed surprisal of its channels under those
// nulls, which is the log likelihood ratio against a Gaussian null:
//
//   support = sum over channels of z^2 / 2,  counting only channels where z > 0
//
// Nothing weights one channel against another; each is expressed in the information it carries, and information
// adds. A channel that carries nothing on a given page contributes nothing rather than a tuned fraction.
//
// The empirical tail cannot serve for this, and that is worth recording. With a finite null a great many
// candidates land on the smallest tail the draws can express and tie there, so ranking by surprisal-from-tail
// is ranking by a saturated quantity: measured, it returned an arbitrary pair. The tail is still reported,
// because it is the honest statement of significance; z carries the ordering.
//
// Evidence gates; description length decides. That division is deliberate and was reached by measurement.
//
// A candidate is admissible only where every channel supports it -- z above its own null -- which keeps the
// page's many spurious composites out of consideration. Which admissible candidates are actually taken is then
// settled by ONE global quantity: the total description length of the page read through the whole set of
// correspondences, scored against the known language, plus what the table of correspondences costs to state.
//
//   L = -sum log P(symbol | previous symbol)  +  unreadable * log V  +  table cost
//
// Correspondences are added one at a time, each time the one that shortens L most, until none shortens it.
//
// Scoring candidates independently does not work, and the ways it fails are worth recording because each looks
// reasonable. Ranking by the channels' support alone leaves a digraph's first sign taking the whole symbol and
// its second unreadable, since frequency alone cannot tell them apart -- measured, with the second sign's
// context score correctly negative and outvoted. Adding a per-occurrence saving for covering more signs makes
// every frequent bigram beat every single sign, because merging always shortens the token stream: measured,
// that mapped the digraph to the wrong symbol entirely and admitted three spurious composites. Only a global
// objective that also pays for the text it produces resists both, because a wrong merge costs more in
// likelihood than it saves in tokens.

import { calibrateEvidence, shuffledOrder, type EvidenceChannel } from "./visual-hypothesis-lattice.js";

/** A unit is a run of one or more symbols, joined: "a", or "a b" for a digraph. */
export type Unit = readonly string[];

const keyOf = (unit: Unit) => unit.join(" ");

export interface ArityCandidate {
  readonly source: Unit;
  readonly target: Unit;
  readonly channels: readonly EvidenceChannel[];
  /** Information the channels carry, less the cost of stating a correspondence of this arity. */
  readonly score: number;
}

export interface VariableArityAlignment {
  /** Accepted correspondences, best supported first, no unit used twice. */
  readonly correspondences: readonly ArityCandidate[];
  /** True when every accepted correspondence turned out to be one to one. */
  readonly bijective: boolean;
  /** Candidates that were scored but lost their units to a better-supported correspondence. */
  readonly rejected: number;
}

interface UnitStatistics {
  readonly counts: Map<string, number>;
  readonly total: number;
  readonly neighbours: Map<string, Map<string, number>>;
}

/** Counts and neighbourhoods of every unit up to `maxArity` symbols long. */
function statisticsOf(sequences: readonly (readonly string[])[], maxArity: number): UnitStatistics {
  const counts = new Map<string, number>();
  const neighbours = new Map<string, Map<string, number>>();
  let total = 0;
  for (const sequence of sequences) {
    for (let arity = 1; arity <= maxArity; arity++) {
      for (let i = 0; i + arity <= sequence.length; i++) {
        const unit = keyOf(sequence.slice(i, i + arity));
        counts.set(unit, (counts.get(unit) ?? 0) + 1);
        if (arity === 1) total += 1;
        let row = neighbours.get(unit);
        if (!row) {
          row = new Map<string, number>();
          neighbours.set(unit, row);
        }
        // Whatever stands immediately either side, at single-symbol granularity.
        for (const side of [sequence[i - 1], sequence[i + arity]]) {
          if (side === undefined) continue;
          row.set(side, (row.get(side) ?? 0) + 1);
        }
      }
    }
  }
  return { counts, total, neighbours };
}

const shareOf = (stats: UnitStatistics, unit: string) => (stats.counts.get(unit) ?? 0) / Math.max(1, stats.total);

/** How alike two units' rates are, on a log scale so a factor of two counts the same at any frequency. */
function frequencyAgreement(source: UnitStatistics, target: UnitStatistics, a: string, b: string): number {
  const rateA = shareOf(source, a);
  const rateB = shareOf(target, b);
  if (rateA <= 0 || rateB <= 0) return -Number.MAX_VALUE / 4;
  return -Math.abs(Math.log(rateA) - Math.log(rateB));
}

/**
 * How far two units keep corresponding company: the mass of their neighbourhoods that a provisional
 * single-symbol correspondence carries from one to the other. This is the structural channel, and it is what
 * tells a digraph apart from either of its halves.
 */
function contextAgreement(
  source: UnitStatistics,
  target: UnitStatistics,
  a: string,
  b: string,
  provisional: ReadonlyMap<string, string>
): number {
  const here = source.neighbours.get(a);
  const there = target.neighbours.get(b);
  if (!here || !there) return 0;
  let carried = 0;
  let offered = 0;
  for (const [neighbour, weight] of here) {
    offered += weight;
    const mapped = provisional.get(neighbour);
    if (mapped === undefined) continue;
    if (there.has(mapped)) carried += weight;
  }
  return offered > 0 ? carried / offered : 0;
}

export interface VariableArityRequest {
  readonly sourceSequences: readonly (readonly string[])[];
  readonly targetSequences: readonly (readonly string[])[];
  /**
   * A correspondence already believed at single-symbol granularity, used to read neighbourhoods across. The
   * one-to-one assignment is the natural source of it, and it need not be complete or correct.
   */
  readonly provisional: ReadonlyMap<string, string>;
  /** Longest unit considered on either side. Two covers digraphs and logograms of two signs. */
  readonly maxArity?: number;
  /** How many null pairings each channel is scored against: a cost budget. */
  readonly nullDraws?: number;
}

interface LanguageModel {
  readonly joint: Map<string, number>;
  readonly history: Map<string, number>;
  readonly unigram: Map<string, number>;
  readonly tokens: number;
  readonly vocabulary: number;
}

function languageModelOf(sequences: readonly (readonly string[])[]): LanguageModel {
  const joint = new Map<string, number>();
  const history = new Map<string, number>();
  const unigram = new Map<string, number>();
  let tokens = 0;
  for (const sequence of sequences) {
    for (let i = 0; i < sequence.length; i++) {
      unigram.set(sequence[i]!, (unigram.get(sequence[i]!) ?? 0) + 1);
      tokens += 1;
      if (i === 0) continue;
      const previous = sequence[i - 1]!;
      joint.set(`${previous}\u0000${sequence[i]!}`, (joint.get(`${previous}\u0000${sequence[i]!}`) ?? 0) + 1);
      history.set(previous, (history.get(previous) ?? 0) + 1);
    }
  }
  return { joint, history, unigram, tokens, vocabulary: Math.max(1, unigram.size) };
}

/** What the page costs in nats, read through a table and scored against the language. */
function pageCost(
  sequences: readonly (readonly string[])[],
  table: ReadonlyMap<string, Unit>,
  longest: number,
  model: LanguageModel,
  symbolCost: number
): number {
  let cost = 0;
  for (const sequence of sequences) {
    const produced: string[] = [];
    let at = 0;
    while (at < sequence.length) {
      let matched = 0;
      for (let span = Math.min(longest, sequence.length - at); span >= 1; span--) {
        const target = table.get(keyOf(sequence.slice(at, at + span)));
        if (!target) continue;
        produced.push(...target);
        matched = span;
        break;
      }
      if (matched === 0) {
        // A sign no correspondence covers has to be stated literally, every time it appears.
        cost += symbolCost;
        at += 1;
      } else {
        at += matched;
      }
    }
    for (let i = 0; i < produced.length; i++) {
      if (i === 0) {
        const count = model.unigram.get(produced[0]!) ?? 0;
        cost += -Math.log((count + 1) / (model.tokens + model.vocabulary));
        continue;
      }
      const previous = produced[i - 1]!;
      const seen = model.joint.get(`${previous}\u0000${produced[i]!}`) ?? 0;
      cost += -Math.log((seen + 1) / ((model.history.get(previous) ?? 0) + model.vocabulary));
    }
  }
  return cost;
}

const tableCost = (table: ReadonlyMap<string, Unit>, symbolCost: number) => {
  let cost = 0;
  for (const [source, target] of table) cost += (source.split(" ").length + target.length) * symbolCost;
  return cost;
};

/**
 * Align two unit sequences without assuming the arity of the correspondence. Candidates of every arity up to
 * `maxArity` are proposed, gated by whether their evidence channels support them at all, and then added one at
 * a time -- each time whichever shortens the total description of the page most -- until none shortens it.
 */
export function alignVariableArity(request: VariableArityRequest): VariableArityAlignment {
  const maxArity = Math.max(1, request.maxArity ?? 2);
  const draws = Math.max(4, request.nullDraws ?? 64);
  const source = statisticsOf(request.sourceSequences, maxArity);
  const target = statisticsOf(request.targetSequences, maxArity);
  const model = languageModelOf(request.targetSequences);

  // Units that occur once carry no structure worth aligning and would swamp the nulls.
  const sourceUnits = [...source.counts.keys()].filter(unit => (source.counts.get(unit) ?? 0) > 1);
  const targetUnits = [...target.counts.keys()].filter(unit => (target.counts.get(unit) ?? 0) > 1);
  if (!sourceUnits.length || !targetUnits.length) {
    return { correspondences: [], bijective: true, rejected: 0 };
  }

  const frequencyNull: number[] = [];
  const contextNull: number[] = [];
  for (let draw = 0; draw < draws; draw++) {
    const shuffledTargets = shuffledOrder(targetUnits, draw * 17 + 3);
    for (let i = 0; i < sourceUnits.length; i++) {
      const a = sourceUnits[i]!;
      const b = shuffledTargets[i % shuffledTargets.length]!;
      frequencyNull.push(frequencyAgreement(source, target, a, b));
      contextNull.push(contextAgreement(source, target, a, b, request.provisional));
    }
  }

  const symbolCost = Math.log(Math.max(2, sourceUnits.length + targetUnits.length));
  const candidates: ArityCandidate[] = [];
  for (const a of sourceUnits) {
    for (const b of targetUnits) {
      const channels = [
        calibrateEvidence("frequency", frequencyAgreement(source, target, a, b), frequencyNull),
        calibrateEvidence("context", contextAgreement(source, target, a, b, request.provisional), contextNull)
      ];
      // Admissible only where every channel supports it: this is what keeps spurious composites out.
      if (channels.some(channel => channel.z <= 0)) continue;
      const support = channels.reduce((total, channel) => total + (channel.z * channel.z) / 2, 0);
      candidates.push({ source: a.split(" "), target: b.split(" "), channels, score: support });
    }
  }

  const table = new Map<string, Unit>();
  // Only targets are claimed exclusively. A SIGN may belong to several units and usually does: Egyptian spells
  // one word with several phonograms and spells other words with those same phonograms, and a syllabary reuses
  // a sign across every syllable it appears in. Requiring a sign to belong to one unit caps the table at
  // however many disjoint groups the signs fall into -- measured, 4 correspondences on a page with 8, every one
  // of the 4 correct and the other 4 unreachable by construction rather than by evidence. What stops a unit
  // being claimed twice is the table itself, keyed by the whole unit, and what stops a spurious unit being
  // claimed at all is the description length of the page read through it.
  const taken = { target: new Set<string>() };
  const accepted: ArityCandidate[] = [];
  let longest = 1;
  let best = pageCost(request.sourceSequences, table, longest, model, symbolCost)
    + tableCost(table, symbolCost);

  for (;;) {
    let chosen: ArityCandidate | undefined;
    let chosenCost = best;
    let chosenLongest = longest;
    for (const candidate of candidates) {
      if (table.has(keyOf(candidate.source))) continue;
      if (candidate.target.some(part => taken.target.has(part))) continue;
      const trial = new Map(table);
      trial.set(keyOf(candidate.source), candidate.target);
      const span = Math.max(longest, candidate.source.length);
      const cost = pageCost(request.sourceSequences, trial, span, model, symbolCost)
        + tableCost(trial, symbolCost);
      // Ties go to the better-supported candidate, which is the only thing support decides here.
      if (cost < chosenCost || (chosen && cost === chosenCost && candidate.score > chosen.score)) {
        chosen = candidate;
        chosenCost = cost;
        chosenLongest = span;
      }
    }
    if (!chosen) break;
    table.set(keyOf(chosen.source), chosen.target);
    for (const part of chosen.target) taken.target.add(part);
    accepted.push(chosen);
    best = chosenCost;
    longest = chosenLongest;
  }

  // Greedy commits its first correspondences while most of the page is still unread, when the likelihood of the
  // text it produces carries almost no signal and covering more signs carries all of it. Measured, that mapped
  // a digraph to a more frequent symbol than its own and pushed the right one onto another sign -- the two came
  // out swapped. Once the whole page is mapped the likelihood is informative, so the set is then refined by
  // local search: any swap of two targets, or any exchange for a target still unused, that shortens the
  // description is taken, until none does. Deterministic, and it terminates because the cost strictly falls.
  const freeTargets = targetUnits.filter(unit => !unit.split(" ").some(part => taken.target.has(part)));

  for (;;) {
    let improved = false;
    for (let i = 0; i < accepted.length && !improved; i++) {
      for (let j = i + 1; j < accepted.length && !improved; j++) {
        const trial = new Map(table);
        trial.set(keyOf(accepted[i]!.source), accepted[j]!.target);
        trial.set(keyOf(accepted[j]!.source), accepted[i]!.target);
        const cost = pageCost(request.sourceSequences, trial, longest, model, symbolCost)
          + tableCost(trial, symbolCost);
        if (cost >= best) continue;
        const heldTarget = accepted[i]!.target;
        accepted[i] = { ...accepted[i]!, target: accepted[j]!.target };
        accepted[j] = { ...accepted[j]!, target: heldTarget };
        table.set(keyOf(accepted[i]!.source), accepted[i]!.target);
        table.set(keyOf(accepted[j]!.source), accepted[j]!.target);
        best = cost;
        improved = true;
      }
    }
    for (let i = 0; i < accepted.length && !improved; i++) {
      for (const candidate of freeTargets) {
        const replacement = candidate.split(" ");
        if (replacement.some(part => taken.target.has(part))) continue;
        const trial = new Map(table);
        trial.set(keyOf(accepted[i]!.source), replacement);
        const cost = pageCost(request.sourceSequences, trial, longest, model, symbolCost)
          + tableCost(trial, symbolCost);
        if (cost >= best) continue;
        for (const part of accepted[i]!.target) taken.target.delete(part);
        for (const part of replacement) taken.target.add(part);
        accepted[i] = { ...accepted[i]!, target: replacement };
        table.set(keyOf(accepted[i]!.source), replacement);
        best = cost;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }

  return {
    correspondences: accepted,
    bijective: accepted.every(c => c.source.length === 1 && c.target.length === 1),
    rejected: candidates.length - accepted.length
  };
}

/** Read a sign sequence out through correspondences of any arity, longest match first. */
export function readThroughCorrespondences(
  sequence: readonly string[],
  correspondences: readonly ArityCandidate[]
): string[] {
  const bySource = new Map<string, Unit>();
  let longest = 1;
  for (const correspondence of correspondences) {
    bySource.set(keyOf(correspondence.source), correspondence.target);
    longest = Math.max(longest, correspondence.source.length);
  }
  const out: string[] = [];
  let at = 0;
  while (at < sequence.length) {
    let matched = false;
    for (let span = Math.min(longest, sequence.length - at); span >= 1; span--) {
      const target = bySource.get(keyOf(sequence.slice(at, at + span)));
      if (!target) continue;
      out.push(...target);
      at += span;
      matched = true;
      break;
    }
    if (!matched) {
      out.push("?");
      at += 1;
    }
  }
  return out;
}

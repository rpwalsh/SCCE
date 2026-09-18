// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What counts as ONE unit of a script is not ours to declare. An alphabet spends one sign per sound, Egyptian
// and Mayan spend one on a morpheme or a whole word, Aztec can spend a single picture on a word's meaning and
// another on its sound, and the same script mixes these on one page. Any rule of the form "this script's signs
// are morphemes" is a rule about one script, and there are hundreds.
//
// So units are discovered, by asking whether treating a recurring group of signs as one unit makes the page
// SHORTER to describe. Description length is counted in two parts, model and data:
//
//   L(H, D) = L(H) + L(D | H)
//
// L(H) is what the inventory costs to write down -- each unit spelled out in base signs -- and L(D | H) is what
// the page costs once you have it, at the entropy of the units it is made of. A composite earns its place only
// when it pays for itself:
//
//   dL(u) = L(D, I) - L(D, I + {u})  >  0
//
// Likelihood alone cannot do this, and this file exists because of how that failed: per-symbol likelihood always
// prefers a coarser reading, since a smaller inventory never risks an improbable continuation. Measured in the
// eye, a two-stroke inventory beat the correct eight-character one and a one-sign inventory beat everything.
// Description length is the correction, because a coarser inventory now has to pay for itself in L(H).
//
// Candidates are whole recurring RUNS, not merges of adjacent units, and that matters. Merging pairs commits
// across boundaries it cannot see: on an agglutinative corpus written solid -- prefix, root, suffix, no spaces,
// as Nahuatl is -- pair merging recovered five of six affixes and not one root, because it had already welded
// "tepetl" into "tepetltin" before "tepetl" could be proposed on its own. Once a wrong unit is in, the right
// one is unreachable. Proposing runs directly makes every morpheme a candidate from the start.
//
// Runs are ranked by the tokens they would save, which is the cheapest useful proxy, and the best few are then
// costed exactly. And because a greedy pass can still admit a unit that a later one makes redundant, admitted
// units are offered for REMOVAL too: whichever single change shortens the description most is taken, added or
// removed, until nothing does.

/** A discovered unit: a run of base signs treated as one. */
export interface InducedUnit {
  /** Base signs in order. Length 1 for a base sign promoted as itself. */
  readonly signs: readonly number[];
  readonly occurrences: number;
  /** Nats saved by admitting this unit, at the moment it was admitted. */
  readonly savedNats: number;
}

export interface UnitInventory {
  readonly units: readonly InducedUnit[];
  /** Description length in nats of the page under this inventory. */
  readonly codeLength: number;
  /** Description length under base signs alone, for comparison. */
  readonly baseCodeLength: number;
}

const key = (signs: readonly number[]) => signs.join(",");

/** Longest run considered as one unit, and how many runs are costed exactly per round. Cost budgets. */
const MAX_UNIT_SIGNS = 12;
const PROPOSALS_PER_ROUND = 40;

function entropyCodeLength(counts: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total <= 0) return 0;
  let length = 0;
  for (const count of counts.values()) length += count * -Math.log(count / total);
  return length;
}

/**
 * What the inventory costs to write down: every unit spelled out in base signs, plus a terminator so the
 * spelling is self-delimiting. A base sign costs nothing to introduce -- the script already has it.
 */
function inventoryCodeLength(units: readonly (readonly number[])[], baseSigns: number): number {
  const alphabet = Math.max(2, baseSigns + 1);
  let length = 0;
  for (const unit of units) {
    if (unit.length < 2) continue;
    length += (unit.length + 1) * Math.log(alphabet);
  }
  return length;
}

/** Segment a run of base signs into the longest units available, cheapest total first (dynamic programming). */
export function segmentByUnits(
  sequence: readonly number[],
  cost: ReadonlyMap<string, number>,
  longest: number
): number[][] {
  const n = sequence.length;
  if (!n) return [];
  const best = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= n; end++) {
    for (let span = 1; span <= Math.min(longest, end); span++) {
      const start = end - span;
      if (!Number.isFinite(best[start]!)) continue;
      const unitCost = cost.get(key(sequence.slice(start, end)));
      if (unitCost === undefined) continue;
      const total = best[start]! + unitCost;
      if (total < best[end]!) {
        best[end] = total;
        from[end] = start;
      }
    }
  }
  if (!Number.isFinite(best[n]!)) return sequence.map(sign => [sign]);

  const pieces: number[][] = [];
  let end = n;
  while (end > 0) {
    const start = from[end]!;
    pieces.push([...sequence.slice(start, end)]);
    end = start;
  }
  return pieces.reverse();
}

interface Tokenization {
  readonly tokens: number[][][];
  readonly counts: Map<string, number>;
}

function tokenize(
  sequences: readonly (readonly number[])[],
  units: ReadonlySet<string>,
  longest: number
): Tokenization {
  // Every unit is equally likely for the purpose of segmenting; the counts that follow set the real costs.
  const flat = new Map<string, number>();
  for (const unit of units) flat.set(unit, 1);
  const tokens: number[][][] = [];
  const counts = new Map<string, number>();
  for (const sequence of sequences) {
    const pieces = segmentByUnits(sequence, flat, longest);
    tokens.push(pieces);
    for (const piece of pieces) counts.set(key(piece), (counts.get(key(piece)) ?? 0) + 1);
  }
  return { tokens, counts };
}

/**
 * Discover the units a sequence of signs is really made of. Every recurring run is a candidate, ranked by the
 * tokens it would save and then costed exactly; whichever single change -- admitting a run or withdrawing one
 * already admitted -- shortens the total description most is taken, until nothing does. Longest-match
 * segmentation is recomputed each round, so units can themselves compose.
 *
 * Returns the inventory that describes the page most briefly: for an alphabet the base signs, for a logographic
 * script its words, and for an agglutinative language written solid its morphemes. Long pieces come back most
 * reliably -- measured on a prefix-root-suffix corpus with no spaces, three of four roots and one of six
 * affixes, at 55 per cent compression. Roots are the pieces a logogram corresponds to, so the bridge holds
 * where it is needed.
 *
 * Short affixes mostly do not come back separately, and the reason is not a defect in the search. A SPLIT move
 * was added to reach boundaries inside already-admitted units -- cutting "tepetltin" into "tepetl" and "tin" --
 * and it changed nothing, because "tepetltzin" is itself a recurring word of the language and paying for it
 * once is cheaper than paying for its parts. The induction is returning recurring units at whatever length
 * pays, which is what it is for. Recovering the affix boundary as well needs a morphology model with a prior
 * over morph length and category, which this deliberately is not, and the move was withdrawn rather than
 * shipped unexercised.
 */
export function induceUnits(sequences: readonly (readonly number[])[]): UnitInventory {
  const baseSigns = new Set<number>();
  for (const sequence of sequences) for (const sign of sequence) baseSigns.add(sign);
  const admitted = new Set<string>([...baseSigns].map(sign => key([sign])));

  const lengthOf = (units: ReadonlySet<string>, span: number) => {
    const { counts } = tokenize(sequences, units, span);
    const spelled = [...units].map(k => k.split(",").map(Number));
    return entropyCodeLength(counts) + inventoryCodeLength(spelled, baseSigns.size);
  };
  const spanOf = (units: ReadonlySet<string>) => {
    let longest = 1;
    for (const unit of units) longest = Math.max(longest, unit.split(",").length);
    return longest;
  };

  const baseCodeLength = lengthOf(admitted, 1);
  let codeLength = baseCodeLength;

  // Every run that recurs, with what it would save in tokens: occurrences times the tokens it absorbs.
  const runs = new Map<string, number>();
  for (const sequence of sequences) {
    for (let span = 2; span <= Math.min(MAX_UNIT_SIGNS, sequence.length); span++) {
      for (let i = 0; i + span <= sequence.length; i++) {
        const run = key(sequence.slice(i, i + span));
        runs.set(run, (runs.get(run) ?? 0) + 1);
      }
    }
  }
  const proposals = [...runs]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([run, occurrences]) => ({ run, saving: occurrences * (run.split(",").length - 1), occurrences }))
    .sort((a, b) => b.saving - a.saving);

  const savedByUnit = new Map<string, number>();
  for (;;) {
    let bestChange: { unit: string; add: boolean; length: number } | undefined;

    // Additions: the most promising runs, costed exactly.
    let considered = 0;
    for (const proposal of proposals) {
      if (admitted.has(proposal.run)) continue;
      if (considered >= PROPOSALS_PER_ROUND) break;
      considered += 1;
      const trial = new Set(admitted);
      trial.add(proposal.run);
      const length = lengthOf(trial, spanOf(trial));
      if (length >= codeLength) continue;
      if (!bestChange || length < bestChange.length) bestChange = { unit: proposal.run, add: true, length };
    }

    // Removals: a unit an earlier round admitted may have been made redundant by a later one.
    for (const unit of admitted) {
      if (unit.split(",").length < 2) continue;
      const trial = new Set(admitted);
      trial.delete(unit);
      const length = lengthOf(trial, spanOf(trial));
      if (length >= codeLength) continue;
      if (!bestChange || length < bestChange.length) bestChange = { unit, add: false, length };
    }

    if (!bestChange) break;
    if (bestChange.add) {
      admitted.add(bestChange.unit);
      savedByUnit.set(bestChange.unit, codeLength - bestChange.length);
    } else {
      admitted.delete(bestChange.unit);
      savedByUnit.delete(bestChange.unit);
    }
    codeLength = bestChange.length;
  }

  const { counts } = tokenize(sequences, admitted, spanOf(admitted));
  const finalUnits: InducedUnit[] = [...admitted].map(k => ({
    signs: k.split(",").map(Number),
    occurrences: counts.get(k) ?? 0,
    savedNats: savedByUnit.get(k) ?? 0
  })).filter(unit => unit.occurrences > 0);

  return { units: finalUnits, codeLength, baseCodeLength };
}

/** Segment the page into the induced units, in reading order. */
export function unitsOf(
  sequences: readonly (readonly number[])[],
  inventory: UnitInventory
): number[][][] {
  const cost = new Map<string, number>();
  let total = 0;
  for (const unit of inventory.units) total += unit.occurrences;
  for (const unit of inventory.units) {
    cost.set(key(unit.signs), -Math.log(Math.max(1, unit.occurrences) / Math.max(1, total)));
  }
  const longest = inventory.units.reduce((most, unit) => Math.max(most, unit.signs.length), 1);
  return sequences.map(sequence => segmentByUnits(sequence, cost, longest));
}

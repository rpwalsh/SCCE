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
// Pointwise mutual information ranks the candidates but never decides: PMI is frequency-sensitive, so a
// threshold on it is a tuned constant by another name. It proposes, dL disposes.

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
 * Discover the units a sequence of signs is really made of. Adjacent pairs are proposed in order of pointwise
 * mutual information and admitted only while they shorten the total description, longest-match segmentation
 * being recomputed each round so composites can themselves compose. Returns the inventory that describes the
 * page most briefly, which for an alphabet is the base signs and for a logographic script is its words.
 */
export function induceUnits(sequences: readonly (readonly number[])[]): UnitInventory {
  const baseSigns = new Set<number>();
  for (const sequence of sequences) for (const sign of sequence) baseSigns.add(sign);
  const admitted = new Set<string>([...baseSigns].map(sign => key([sign])));
  let longest = 1;

  const lengthOf = (units: ReadonlySet<string>, span: number) => {
    const { counts } = tokenize(sequences, units, span);
    const spelled = [...units].map(k => k.split(",").map(Number));
    return entropyCodeLength(counts) + inventoryCodeLength(spelled, baseSigns.size);
  };

  const baseCodeLength = lengthOf(admitted, 1);
  let codeLength = baseCodeLength;
  const units: InducedUnit[] = [];

  for (;;) {
    const { tokens } = tokenize(sequences, admitted, longest);
    // Pointwise mutual information over adjacent token pairs: it ranks the candidates, it never decides.
    const pairCounts = new Map<string, { count: number; left: string; right: string }>();
    const tokenCounts = new Map<string, number>();
    let pairTotal = 0;
    let tokenTotal = 0;
    for (const pieces of tokens) {
      for (const piece of pieces) {
        tokenCounts.set(key(piece), (tokenCounts.get(key(piece)) ?? 0) + 1);
        tokenTotal += 1;
      }
      for (let i = 1; i < pieces.length; i++) {
        const left = key(pieces[i - 1]!);
        const right = key(pieces[i]!);
        const joint = `${left}|${right}`;
        const held = pairCounts.get(joint);
        if (held) held.count += 1;
        else pairCounts.set(joint, { count: 1, left, right });
        pairTotal += 1;
      }
    }
    if (!pairTotal) break;

    const ranked = [...pairCounts.values()]
      .filter(pair => pair.count > 1)
      .map(pair => {
        const pLeft = (tokenCounts.get(pair.left) ?? 0) / tokenTotal;
        const pRight = (tokenCounts.get(pair.right) ?? 0) / tokenTotal;
        const pJoint = pair.count / pairTotal;
        return { pair, score: Math.log(pJoint / Math.max(1e-12, pLeft * pRight)) };
      })
      .sort((a, b) => b.score - a.score);

    let improved = false;
    for (const { pair } of ranked) {
      const signs = [...pair.left.split(",").map(Number), ...pair.right.split(",").map(Number)];
      const candidate = key(signs);
      if (admitted.has(candidate)) continue;
      const span = Math.max(longest, signs.length);
      const trial = new Set(admitted);
      trial.add(candidate);
      const trialLength = lengthOf(trial, span);
      const saved = codeLength - trialLength;
      if (saved <= 0) continue;
      admitted.add(candidate);
      longest = span;
      codeLength = trialLength;
      units.push({ signs, occurrences: pair.count, savedNats: saved });
      improved = true;
      break;
    }
    if (!improved) break;
  }

  const { counts } = tokenize(sequences, admitted, longest);
  const finalUnits: InducedUnit[] = [...admitted].map(k => {
    const signs = k.split(",").map(Number);
    const promoted = units.find(unit => key(unit.signs) === k);
    return {
      signs,
      occurrences: counts.get(k) ?? 0,
      savedNats: promoted?.savedNats ?? 0
    };
  }).filter(unit => unit.occurrences > 0);

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

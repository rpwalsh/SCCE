// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Marks on a page become a sign inventory, the inventory becomes a sequence, and the sequence is read by
// aligning its structure against a language SCCE already knows. Nothing here is told what any sign means.
//
// Built for scripts that break the assumptions Latin print encourages. Sign adjacency comes from the LINE, not
// from word gaps, because Egyptian and many other scripts write no word dividers. Reading direction is measured
// against the known language's own directional statistics rather than assumed. Whether a mark and its mirror
// image are one sign is scored, not assumed: Egyptian flips its glyphs with the reading direction, while
// Canadian syllabics give the reflected form of one shape a different sound.
//
// Granularity is the honest limit: this aligns signs against whatever unit the known language is supplied in. An
// alphabetic script aligns to characters; a logographic or consonantal script (hieroglyphs among them) carries
// morphemes or words per sign, and must be aligned against that granularity to mean anything.

import type { AlignedSymbolPair, CooccurrenceBigram, CrossLingualAlignmentOptions } from "./cross-lingual-alignment.js";
import { induceStructuralSubstitution } from "./cross-lingual-alignment.js";
import { populationVoidCut, type PageLayout } from "./visual-page-analysis.js";
import { glyphProfile, mirrorProfile, profileDistance, windowProfile, type GlyphProfile } from "./visual-shape-signature.js";

export interface SignCluster {
  readonly id: number;
  /** Indices into the reading-order glyph list. */
  readonly members: readonly number[];
  readonly occurrences: number;
  /** Mean density profile of the cluster's members. */
  readonly exemplar: GlyphProfile;
  /** Set when this sign was folded together with its own mirror image. */
  readonly mirrored: boolean;
}

export interface SignInventory {
  readonly clusters: readonly SignCluster[];
  /** Sign id for each glyph, in reading order. */
  readonly signOf: readonly number[];
  /** The merge distance the dendrogram was cut at: the page's measured same-sign scale. */
  readonly cutDistance: number;
  readonly cutGap: number;
  /** False when no void separated the marks, so they are one population and nothing was told apart. */
  readonly distinguishable: boolean;
}

interface Clustering {
  readonly signOf: readonly number[];
  readonly groups: readonly (readonly number[])[];
  readonly cutDistance: number;
  readonly cutGap: number;
}

/**
 * Single-link clustering with the cut chosen by the data: merges are taken in increasing distance (Prim's tree
 * over the complete graph) and the dendrogram is cut at the void that stands wider than the whole spread of
 * merges beneath it. Scale-relative and parameter-free -- one uniform population of marks stays one sign,
 * because no void inside it is wider than the variation it already contains.
 */
export function clusterByDistance(count: number, distance: (a: number, b: number) => number): Clustering {
  if (count <= 0) return { signOf: [], groups: [], cutDistance: 0, cutGap: 0 };
  if (count === 1) return { signOf: [0], groups: [[0]], cutDistance: 0, cutGap: 0 };

  const inTree = new Uint8Array(count);
  const best = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(count).fill(-1);
  const edges: { a: number; b: number; weight: number }[] = [];
  best[0] = 0;
  for (let step = 0; step < count; step++) {
    let pick = -1;
    for (let i = 0; i < count; i++) if (!inTree[i] && (pick < 0 || best[i]! < best[pick]!)) pick = i;
    inTree[pick] = 1;
    if (from[pick]! >= 0) edges.push({ a: pick, b: from[pick]!, weight: best[pick]! });
    for (let i = 0; i < count; i++) {
      if (inTree[i]) continue;
      const d = distance(pick, i);
      if (d < best[i]!) {
        best[i] = d;
        from[i] = pick;
      }
    }
  }
  edges.sort((x, y) => x.weight - y.weight);

  const weights = edges.map(edge => edge.weight);
  const split = populationVoidCut(weights);
  const cutDistance = split.cut;
  const cutGap = split.gap;
  const cutIndex = split.accepted ? weights.filter(weight => weight <= split.cut).length : edges.length;

  const parent = [...Array(count).keys()];
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[a] !== root) {
      const next = parent[a]!;
      parent[a] = root;
      a = next;
    }
    return root;
  };
  for (let i = 0; i < cutIndex; i++) {
    const ra = find(edges[i]!.a);
    const rb = find(edges[i]!.b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  const idOfRoot = new Map<number, number>();
  const groups: number[][] = [];
  const signOf: number[] = [];
  for (let i = 0; i < count; i++) {
    const root = find(i);
    let id = idOfRoot.get(root);
    if (id === undefined) {
      id = groups.length;
      idOfRoot.set(root, id);
      groups.push([]);
    }
    groups[id]!.push(i);
    signOf.push(id);
  }
  return { signOf, groups, cutDistance, cutGap };
}

/**
 * Blank the profile cells that carry the same value in every grapheme on the page. A feature that never varies
 * distinguishes nothing, and worse, it drowns the ones that do: a script like Devanagari hangs every letter from
 * one continuous headline, so each cell inherits a slice of it and the letters read as two dozen signs instead
 * of eight. Which cells those are is measured off the page, so no script's furniture has to be named.
 */
function informativeCellsOnly(profiles: readonly GlyphProfile[]): GlyphProfile[] {
  if (profiles.length < 2) return [...profiles];
  const size = profiles[0]!.density.length;
  const informative = new Array<boolean>(size).fill(false);
  for (let cell = 0; cell < size; cell++) {
    const first = profiles[0]!.density[cell]!;
    for (const profile of profiles) {
      if (profile.density[cell]! !== first) {
        informative[cell] = true;
        break;
      }
    }
  }
  return profiles.map(profile => ({
    cols: profile.cols,
    rows: profile.rows,
    density: profile.density.map((value, cell) => (informative[cell] ? value : 0))
  }));
}

function meanProfile(profiles: readonly GlyphProfile[], members: readonly number[]): GlyphProfile {
  const first = profiles[members[0]!]!;
  const density = new Array<number>(first.density.length).fill(0);
  for (const member of members) {
    const p = profiles[member]!;
    for (let i = 0; i < density.length; i++) density[i]! += p.density[i]!;
  }
  for (let i = 0; i < density.length; i++) density[i]! /= members.length;
  return { cols: first.cols, rows: first.rows, density };
}

export interface PageSigns {
  readonly inventory: SignInventory;
  /** Sign ids per line, in the order the layout laid them out. Structure comes from these. */
  readonly lines: readonly (readonly number[])[];
  /** Sign ids per word where the script separates words at all; empty of meaning where it does not. */
  readonly words: readonly (readonly number[])[];
  readonly profiles: readonly GlyphProfile[];
  /** Ink area of each mark, in pixels, so a code length can be counted in pixels rather than in cells. */
  readonly markAreas: readonly number[];
  /** Cluster pairs whose exemplars match under reflection inside the page's measured same-sign scale. */
  readonly mirrorPairs: readonly (readonly [number, number])[];
}

/**
 * How a mark's identity is framed. "box" fits the grid to the mark's own bounding box, which normalises size
 * away -- right where every mark is the same size, and wrong where size is what distinguishes them. "window"
 * takes a window of the writing's own scale centred on the mark's ink, which keeps size.
 *
 * Neither is correct in general and the difference is measurable: a box snaps exactly to the ink so two prints
 * of one letter match exactly, while a centroid is fractional and at small cells its sub-pixel jitter moves ink
 * across cell boundaries. Pieces cut out of a joined hand vary in width, and framed to their own boxes they
 * collapsed into a single sign. So the framing is not decided here: both are read and costed.
 */
export type IdentityFraming = "box" | "window";

/** Discover the page's sign inventory from its own marks, on the grid the page measured for itself. */
export function readPageSigns(
  layout: PageLayout,
  options: { readonly framing?: IdentityFraming } = {}
): PageSigns {
  const glyphs = layout.lines.flatMap(line => line.words.flatMap(word => word.glyphs));
  // A cell grapheme already carries its whole cell, which is a fixed frame either way. Anything else is framed
  // as asked: to its own box, or to a window of the writing's scale centred on its ink.
  const framing = options.framing ?? "box";
  const profiles = informativeCellsOnly(glyphs.map(g => {
    if (g.cellRaster) return glyphProfile(g.cellRaster, layout.glyphGrid.cols, layout.glyphGrid.rows);
    if (framing === "window") {
      return windowProfile(
        g.raster,
        g.centroidX - g.x0,
        g.centroidY - g.y0,
        layout.glyphWindow.width,
        layout.glyphWindow.height,
        layout.glyphGrid.cols,
        layout.glyphGrid.rows
      );
    }
    return glyphProfile(g.raster, layout.glyphGrid.cols, layout.glyphGrid.rows);
  }));
  const base = clusterByDistance(profiles.length, (a, b) => profileDistance(profiles[a]!, profiles[b]!));
  const exemplars = base.groups.map(members => meanProfile(profiles, members));

  // Which line each glyph fell on, in the same reading order as the profiles.
  const lineOfGlyph: number[] = [];
  layout.lines.forEach((line, index) => {
    for (const word of line.words) for (let k = 0; k < word.glyphs.length; k++) lineOfGlyph.push(index);
  });

  // Whether a script treats a mark and its reflection as one sign is not ours to assume, and it cannot be
  // settled by how well the text reads either: folding shrinks the inventory, and a smaller inventory always
  // scores better per symbol, so likelihood folds whatever it can. Measured that way three pairs of plainly
  // different letters folded together and the reading collapsed.
  //
  // It is a structural claim, and structure can be measured. A script that mirrors its glyphs with the reading
  // direction mirrors a whole LINE of them, so the two forms segregate by line. Two genuinely different letters
  // that merely happen to be reflections -- b and d, or H and E in a symmetric hand -- appear side by side
  // within one line. So a pair may fold only if no line ever carries both forms.
  const mirrorPairs: [number, number][] = [];
  for (let i = 0; i < exemplars.length; i++) {
    for (let j = i + 1; j < exemplars.length; j++) {
      if (profileDistance(exemplars[i]!, mirrorProfile(exemplars[j]!)) > base.cutDistance) continue;
      const linesOf = (cluster: number) =>
        new Set(base.groups[cluster]!.map(glyph => lineOfGlyph[glyph] ?? -1));
      const left = linesOf(i);
      const right = linesOf(j);
      let shared = false;
      for (const line of left) if (right.has(line)) { shared = true; break; }
      if (!shared) mirrorPairs.push([i, j]);
    }
  }

  const inventory: SignInventory = {
    clusters: base.groups.map((members, id) => ({
      id,
      members: [...members].sort((a, b) => a - b),
      occurrences: members.length,
      exemplar: exemplars[id]!,
      mirrored: false
    })),
    signOf: base.signOf,
    cutDistance: base.cutDistance,
    cutGap: base.cutGap,
    distinguishable: base.cutGap > 0
  };

  const lines: number[][] = [];
  const words: number[][] = [];
  let cursor = 0;
  for (const line of layout.lines) {
    const sequence: number[] = [];
    for (const word of line.words) {
      const inWord = word.glyphs.map(() => base.signOf[cursor++]!);
      words.push(inWord);
      sequence.push(...inWord);
    }
    lines.push(sequence);
  }
  return { inventory, lines, words, profiles, markAreas: glyphs.map(g => g.area), mirrorPairs };
}

/** The same page read on the hypothesis that a mark and its reflection are one sign. */
export function foldMirrorSigns(signs: PageSigns): PageSigns {
  if (!signs.mirrorPairs.length) return signs;
  const count = signs.inventory.clusters.length;
  const parent = [...Array(count).keys()];
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[a] !== root) {
      const next = parent[a]!;
      parent[a] = root;
      a = next;
    }
    return root;
  };
  for (const [i, j] of signs.mirrorPairs) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  }

  const idOfRoot = new Map<number, number>();
  const remap = new Map<number, number>();
  const grouped: number[][] = [];
  const folded: boolean[] = [];
  for (let cluster = 0; cluster < count; cluster++) {
    const root = find(cluster);
    let id = idOfRoot.get(root);
    if (id === undefined) {
      id = grouped.length;
      idOfRoot.set(root, id);
      grouped.push([]);
      folded.push(false);
    } else {
      folded[id] = true;
    }
    grouped[id]!.push(...signs.inventory.clusters[cluster]!.members);
    remap.set(cluster, id);
  }

  const inventory: SignInventory = {
    clusters: grouped.map((members, id) => ({
      id,
      members: [...members].sort((a, b) => a - b),
      occurrences: members.length,
      exemplar: meanProfile(signs.profiles, members),
      mirrored: folded[id]!
    })),
    signOf: signs.inventory.signOf.map(id => remap.get(id)!),
    cutDistance: signs.inventory.cutDistance,
    cutGap: signs.inventory.cutGap,
    distinguishable: signs.inventory.distinguishable
  };
  return {
    inventory,
    lines: signs.lines.map(line => line.map(id => remap.get(id)!)),
    words: signs.words.map(word => word.map(id => remap.get(id)!)),
    profiles: signs.profiles,
    markAreas: signs.markAreas,
    mirrorPairs: []
  };
}

export const signSymbol = (id: number): string => `sign:${id}`;

export interface SymbolFrequency {
  readonly symbol: string;
  readonly count: number;
}

/** Within-line adjacency of signs, in the shape the structural aligner consumes. No word dividers required. */
export function signBigrams(sequences: readonly (readonly number[])[]): CooccurrenceBigram[] {
  const counts = new Map<string, number>();
  for (const sequence of sequences) {
    for (let i = 1; i < sequence.length; i++) {
      const key = `${sequence[i - 1]!} ${sequence[i]!}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([key, count]) => {
    const parts = key.split(" ");
    return { previous: signSymbol(Number(parts[0])), next: signSymbol(Number(parts[1])), count };
  });
}

/** Signs by descending frequency. */
export function signFrequencies(sequences: readonly (readonly number[])[]): SymbolFrequency[] {
  const counts = new Map<number, number>();
  for (const sequence of sequences) {
    for (const sign of sequence) counts.set(sign, (counts.get(sign) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id, count]) => ({ symbol: signSymbol(id), count }));
}

/**
 * How many frequency ranks are worth anchoring on: the prefix whose consecutive leads exceed the sampling noise
 * in the counts that produced them. Anchoring a rank pair that is within noise of swapping would hand the
 * alignment a wrong correspondence and defend it, so those ranks are left to be recovered by structure instead.
 */
export function trustedRankDepth(frequencies: readonly SymbolFrequency[]): number {
  const total = frequencies.reduce((sum, f) => sum + f.count, 0);
  if (total <= 0) return 0;
  let depth = 0;
  for (let i = 0; i + 1 < frequencies.length; i++) {
    const p = frequencies[i]!.count / total;
    const q = frequencies[i + 1]!.count / total;
    const noise = Math.sqrt((p * (1 - p)) / total) + Math.sqrt((q * (1 - q)) / total);
    if (p - q <= noise) break;
    depth = i + 1;
  }
  return depth;
}

/**
 * How likely the decoded sequence is under the known language's own bigram model: the mean log conditional
 * probability of each symbol given the one before it, add-one smoothed over the language's vocabulary. This is
 * the criterion that decides reading direction, grouping and orientation, and it doubles as the confidence in a
 * reading.
 *
 * It must be a CONDITIONAL probability. Scoring the raw frequency of the bigrams a reading produces cannot tell
 * a real reading from a wrong one: any decoding that lands mostly on the language's common symbols scores well
 * whatever order it puts them in, and measured that way a transposed page beat the correct reading of itself.
 * Normalising by the history makes an improbable continuation cost something, which is what orders the readings.
 */
export function structuralFit(
  sequences: readonly (readonly number[])[],
  signToSymbol: ReadonlyMap<number, string>,
  languageBigrams: readonly CooccurrenceBigram[]
): number {
  const joint = new Map<string, number>();
  const history = new Map<string, number>();
  const vocabulary = new Set<string>();
  for (const bigram of languageBigrams) {
    joint.set(`${bigram.previous}\u0000${bigram.next}`, bigram.count);
    history.set(bigram.previous, (history.get(bigram.previous) ?? 0) + bigram.count);
    vocabulary.add(bigram.previous);
    vocabulary.add(bigram.next);
  }
  const size = Math.max(1, vocabulary.size);

  let total = 0;
  let pairs = 0;
  for (const sequence of sequences) {
    for (let i = 1; i < sequence.length; i++) {
      const previous = signToSymbol.get(sequence[i - 1]!);
      const next = signToSymbol.get(sequence[i]!);
      pairs += 1;
      if (previous === undefined || next === undefined) {
        // An unassigned sign is as unlikely as the rarest continuation, never free.
        total += Math.log(1 / size);
        continue;
      }
      const seen = joint.get(`${previous}\u0000${next}`) ?? 0;
      total += Math.log((seen + 1) / ((history.get(previous) ?? 0) + size));
    }
  }
  return pairs > 0 ? total / pairs : Number.NEGATIVE_INFINITY;
}

export interface DeciphermentRequest {
  /** Sign sequences per line, as laid out. Reading direction is decided here, not assumed by the caller. */
  readonly lines: readonly (readonly number[])[];
  /** Directed adjacency of the known language, from the corpus, at the granularity the signs carry. */
  readonly languageBigrams: readonly CooccurrenceBigram[];
  readonly languageFrequencies: readonly SymbolFrequency[];
  readonly options?: CrossLingualAlignmentOptions;
}

export interface Decipherment {
  readonly signToSymbol: ReadonlyMap<number, string>;
  readonly pairs: readonly AlignedSymbolPair[];
  /** True when the page reads against the layout order: right-to-left for a left-to-right layout. */
  readonly reversed: boolean;
  /** Sequences in the direction that was read, symbol by symbol. */
  readonly readings: readonly (readonly string[])[];
  readonly text: string;
  /** Fit of the chosen direction, and of the one rejected: the margin is the evidence for the choice. */
  readonly fit: number;
  readonly rejectedFit: number;
  /** Anchors the alignment was allowed, after discarding frequency ranks too close to call. */
  readonly anchorDepth: number;
}

/**
 * Read an unknown script by structure alone. The sign sequence's own adjacency is aligned against the adjacency
 * of a language SCCE has ingested, anchored only by frequency ranks that are statistically distinguishable --
 * which is how a substitution is broken without a key, and how a script is approached without a bilingual.
 *
 * Direction is recovered rather than assumed. The aligner symmetrizes co-occurrence, so a line and its reverse
 * induce the same key; what separates them is the known language's DIRECTED bigrams, the only place that
 * information exists. Both readings are scored against it and the better one is returned with its margin.
 */
export function decipherSigns(request: DeciphermentRequest): Decipherment {
  const signFrequency = signFrequencies(request.lines);
  const languageFrequency = [...request.languageFrequencies].sort((a, b) => b.count - a.count);
  const anchorDepth = Math.min(trustedRankDepth(signFrequency), trustedRankDepth(languageFrequency));

  const asClosedClass = (frequencies: readonly SymbolFrequency[]) => {
    const total = frequencies.reduce((sum, f) => sum + f.count, 0) || 1;
    return frequencies.slice(0, anchorDepth).map(f => ({ word: f.symbol, documentShare: f.count / total }));
  };

  const pairs = induceStructuralSubstitution({
    sourceLanguage: "signs",
    targetLanguage: "language",
    sourceBigrams: signBigrams(request.lines),
    targetBigrams: [...request.languageBigrams],
    sourceClosedClass: asClosedClass(signFrequency),
    targetClosedClass: asClosedClass(languageFrequency),
    options: request.options
  });

  const signToSymbol = new Map<number, string>();
  for (const pair of pairs) {
    const id = Number(pair.sourceSymbol.slice(signSymbol(0).length - 1));
    if (Number.isFinite(id)) signToSymbol.set(id, pair.targetSymbol);
  }

  const reversedLines = request.lines.map(line => [...line].reverse());
  const forwardFit = structuralFit(request.lines, signToSymbol, request.languageBigrams);
  const reverseFit = structuralFit(reversedLines, signToSymbol, request.languageBigrams);
  const reversed = reverseFit > forwardFit;
  const chosen = reversed ? reversedLines : request.lines;

  const readings = chosen.map(line => line.map(sign => signToSymbol.get(sign) ?? "?"));
  return {
    signToSymbol,
    pairs,
    reversed,
    readings,
    text: readings.map(line => line.join("")).join("\n"),
    fit: reversed ? reverseFit : forwardFit,
    rejectedFit: reversed ? forwardFit : reverseFit,
    anchorDepth
  };
}

export interface PageReading extends Decipherment {
  /** True when reading the page as a script that mirrors its glyphs fit the known language better. */
  readonly mirrorFolded: boolean;
  readonly signCount: number;
}

/**
 * Read a page end to end, deciding by measurement every question the script itself answers differently: how
 * many signs there are, whether a mark and its reflection are one sign, and which direction the line runs. Each
 * hypothesis is scored by how much the text it produces behaves like the language SCCE already knows.
 */
export function decipherPage(input: {
  readonly signs: PageSigns;
  readonly languageBigrams: readonly CooccurrenceBigram[];
  readonly languageFrequencies: readonly SymbolFrequency[];
  readonly options?: CrossLingualAlignmentOptions;
}): PageReading {
  const hypotheses: { signs: PageSigns; folded: boolean }[] = [{ signs: input.signs, folded: false }];
  if (input.signs.mirrorPairs.length) hypotheses.push({ signs: foldMirrorSigns(input.signs), folded: true });

  let best: PageReading | undefined;
  for (const hypothesis of hypotheses) {
    const reading = decipherSigns({
      lines: hypothesis.signs.lines,
      languageBigrams: input.languageBigrams,
      languageFrequencies: input.languageFrequencies,
      options: input.options
    });
    const candidate: PageReading = {
      ...reading,
      mirrorFolded: hypothesis.folded,
      signCount: hypothesis.signs.inventory.clusters.length
    };
    if (!best || candidate.fit > best.fit) best = candidate;
  }
  return best!;
}

export interface InventoryCodeLength {
  /** Nats to state the inventory: every sign's exemplar, at the resolution its cells can carry. */
  readonly model: number;
  /** Nats to reproduce the page's ink from that inventory: what each mark costs given its own sign. */
  readonly ink: number;
  readonly total: number;
}

/**
 * What an inventory costs, in the two parts SCCE costs everything in: L(H) to state the signs and L(D|H) to
 * reproduce the marks from them. This is what makes two readings of one page comparable when they disagree
 * about how many marks there even are.
 *
 * Without the ink term a reading is charged only for the tokens it emits, so the coarsest reading always wins:
 * seven word-blobs of a cursive page cost almost nothing to emit and were preferred to the two hundred and
 * sixty-eight letters cut out of them, reading 2.6 per cent of the page. The ink term is what they actually
 * differ on. Every grouping codes the SAME pixels, so weighting each profile cell by the pixels it stands for
 * makes the totals comparable: a blob whose sign is a blurred average of seven unlike blobs pays for every
 * pixel of the difference, and a letter whose sign fits it tightly pays almost nothing.
 *
 * Cell probabilities are Laplace-smoothed off the cluster's own members, so a cell that is always ink in its
 * sign still leaves room for a mark where it is not, and nothing is ever charged infinity.
 */
export function inventoryCodeLength(signs: PageSigns): InventoryCodeLength {
  const { profiles, inventory } = signs;
  if (!profiles.length || !inventory.clusters.length) return { model: 0, ink: 0, total: 0 };

  const cells = Math.max(1, profiles[0]!.density.length);
  // Pixels each profile cell stands for, so the ink term is counted in pixels and not in cells.
  const pixels = profiles.reduce((total, _profile, index) => total + Math.max(1, marksArea(signs, index)), 0);
  const pixelsPerCell = Math.max(1, pixels / (profiles.length * cells));
  // A cell's density can carry as many distinct values as it has pixels, and that is what stating one costs.
  const levels = Math.max(2, Math.round(pixelsPerCell) + 1);

  let model = 0;
  let ink = 0;
  for (const cluster of inventory.clusters) {
    model += cells * Math.log(levels);
    const members = cluster.members;
    if (!members.length) continue;
    for (let cell = 0; cell < cells; cell++) {
      let present = 0;
      for (const member of members) present += profiles[member]!.density[cell]!;
      // Laplace: the sign's own members estimate the cell, and never to certainty.
      const probability = (present + 1) / (members.length + 2);
      for (const member of members) {
        const density = profiles[member]!.density[cell]!;
        const cost = -(density * Math.log(probability) + (1 - density) * Math.log(1 - probability));
        ink += cost * pixelsPerCell;
      }
    }
  }
  return { model, ink, total: model + ink };
}

/** Ink area of the mark a profile came from, in pixels. */
function marksArea(signs: PageSigns, index: number): number {
  const areas = signs.markAreas;
  return areas && index < areas.length ? areas[index]! : 1;
}

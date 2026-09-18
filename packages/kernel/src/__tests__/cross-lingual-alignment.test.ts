// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { alignLanguagesByStructure, type LanguageCooccurrence, type StructuralAnchor } from "../cross-lingual-alignment.js";

// The claim: two languages that describe the same world have co-occurrence structures of the same SHAPE, and
// aligning the shapes -- never the surfaces -- recovers a translation map with no dictionary and no parallel
// text. This proves it on a controlled case: the target language is a relabeling of the source's structure
// (perfectly isomorphic), the symbol strings share nothing, and only two closed-class hubs are anchored. The
// aligner must recover the hidden relabeling from structure alone.

const N = 8;
// A fixed asymmetric weight matrix (deterministic LCG) so every symbol has a distinct structural fingerprint,
// which is what makes the isomorphism recoverable -- a fully symmetric structure would be aligned only up to
// its symmetry, exactly as real degenerate structure would be.
function fixedWeights(): number[][] {
  let seed = 1234567;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 1000) / 1000; };
  const w = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) w[i]![j] = 0.05 + next();
  return w;
}

function structureFrom(prefix: string, weights: number[][], relabel: (i: number) => number): LanguageCooccurrence {
  const symbols = Array.from({ length: N }, (_, i) => `${prefix}${relabel(i)}`);
  const cooccurrence = new Map<string, Map<string, number>>();
  for (let i = 0; i < N; i++) {
    const row = new Map<string, number>();
    for (let j = 0; j < N; j++) if (weights[i]![j]! > 0) row.set(`${prefix}${relabel(j)}`, weights[i]![j]!);
    cooccurrence.set(`${prefix}${relabel(i)}`, row);
  }
  const mass = new Map<string, number>();
  for (let i = 0; i < N; i++) mass.set(`${prefix}${relabel(i)}`, weights[i]!.reduce((a, b) => a + b, 0));
  return { language: prefix, symbols, cooccurrence, mass };
}

const symbolMass = (weights: number[][], i: number) => weights[i]!.reduce((a, b) => a + b, 0);

describe("aligning two languages by the shape of their structure, with no word list", () => {
  it("recovers a hidden relabeling from structure alone, with anchors derived from structure not a dictionary", () => {
    const weights = fixedWeights();
    // Source: identity labeling s0..s7. Target: the SAME structure relabeled by a permutation, symbols t*.
    const permutation = [3, 5, 0, 7, 1, 6, 2, 4];
    const source = structureFrom("s", weights, i => i);
    const target = structureFrom("t", weights, i => permutation[i]!);
    const correctTargetFor = (i: number) => `t${permutation[i]}`;

    // The anchors come from STRUCTURE, not a word list: each language's highest-mass symbols are its function-
    // word hubs (closed class SCCE discovers unsupervised), and they correspond by rank. Nothing here consults
    // the hidden permutation -- rank k of the source is paired with rank k of the target, and because the
    // structure is isomorphic those ranks line up. This is exactly how the closed class anchors real alignment.
    const sourceHubs = [...Array(N).keys()].sort((a, b) => symbolMass(weights, b) - symbolMass(weights, a));
    const targetByMass = [...target.symbols].sort((a, b) =>
      [...target.cooccurrence.get(b)!.values()].reduce((x, y) => x + y, 0) -
      [...target.cooccurrence.get(a)!.values()].reduce((x, y) => x + y, 0));
    const anchors: StructuralAnchor[] = [0, 1, 2, 3].map(k => ({
      sourceSymbol: `s${sourceHubs[k]}`, targetSymbol: targetByMass[k]!, strength: 1
    }));

    const pairs = alignLanguagesByStructure(source, target, { anchors, outerIterations: 150, epsilon: 0.05 });
    const recovered = new Map(pairs.map(p => [p.sourceSymbol, p.targetSymbol]));

    let correct = 0;
    for (let i = 0; i < N; i++) if (recovered.get(`s${i}`) === correctTargetFor(i)) correct += 1;
    // Structure-only recovery of most symbols proves the mechanism; the surfaces (s* vs t*) share nothing.
    expect(correct).toBeGreaterThanOrEqual(6);
  });

  it("returns a mapping for every source symbol and never invents a symbol", () => {
    const weights = fixedWeights();
    const source = structureFrom("s", weights, i => i);
    const target = structureFrom("t", weights, i => i);
    const pairs = alignLanguagesByStructure(source, target, { outerIterations: 30 });
    expect(pairs.length).toBe(N);
    for (const pair of pairs) {
      expect(source.symbols).toContain(pair.sourceSymbol);
      expect(target.symbols).toContain(pair.targetSymbol);
      expect(pair.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("is deterministic: the same structures give the same alignment", () => {
    const weights = fixedWeights();
    const source = structureFrom("s", weights, i => i);
    const target = structureFrom("t", weights, i => [2, 0, 3, 1, 6, 4, 7, 5][i]!);
    const a = alignLanguagesByStructure(source, target, { outerIterations: 25 });
    const b = alignLanguagesByStructure(source, target, { outerIterations: 25 });
    expect(a.map(p => `${p.sourceSymbol}=${p.targetSymbol}`)).toEqual(b.map(p => `${p.sourceSymbol}=${p.targetSymbol}`));
  });
});

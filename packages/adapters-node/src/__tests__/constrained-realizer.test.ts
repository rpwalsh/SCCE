// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { allowedTokenIds, applyLexicalMask, createConstrainedDecodingRealizer, degenerateSurface, type ConstrainedRuntime } from "../constrained-realizer.js";

// Word-level fake tokenizer: id = index in a fixed vocabulary; unknown words map to nothing.
const VOCAB = ["<eos>", "pump", "alpha", "is", "stable", "the", "and", "volcano", "erupted", ".", " "];
const tokenizer = {
  encode: (text: string) => text.split(/\s+/u).map(word => VOCAB.indexOf(word.trim())).filter(id => id >= 0),
  decode: (ids: readonly number[]) => ids.map(id => VOCAB[id]).join(" "),
  eosTokenId: 0,
  vocabSize: VOCAB.length
};
const facts = [{ subject: "pump alpha", predicate: "is", object: "stable", evidenceIds: ["e1"] }];

describe("constrained decoding realizer", () => {
  it("allows only fact tokens, closed-class words, EOS and punctuation", () => {
    const allowed = allowedTokenIds(tokenizer, facts, new Set(["the", "and"]));
    for (const word of ["pump", "alpha", "is", "stable", "the", "and", "."]) expect(allowed.has(VOCAB.indexOf(word))).toBe(true);
    expect(allowed.has(0)).toBe(true);
    expect(allowed.has(VOCAB.indexOf("volcano"))).toBe(false);
    expect(allowed.has(VOCAB.indexOf("erupted"))).toBe(false);
  });

  it("masks every disallowed logit to -Infinity in place", () => {
    const logits = new Float32Array(VOCAB.length).fill(1);
    applyLexicalMask(logits, new Set([1, 4]));
    expect(logits[1]).toBe(1);
    expect(logits[4]).toBe(1);
    expect(logits[7]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("realizes through the mask and never emits an unlicensed content token", async () => {
    const steps: Float32Array[] = [];
    const runtime: ConstrainedRuntime = {
      tokenizer,
      model: {
        async generate(_prompt, options) {
          const out: number[] = [];
          const plan = ["volcano", "pump", "alpha", "is", "stable", "."];
          for (const [step, word] of plan.entries()) {
            const logits = new Float32Array(VOCAB.length).fill(0);
            logits[VOCAB.indexOf(word)] = 5;
            options.mask(logits, step);
            steps.push(logits);
            const best = [...logits].indexOf(Math.max(...logits));
            if (Number.isFinite(logits[VOCAB.indexOf(word)])) out.push(VOCAB.indexOf(word));
            else out.push(best === -1 ? 0 : best);
          }
          return out;
        }
      }
    };
    const realizer = createConstrainedDecodingRealizer({ modelId: "fake", modelDir: "/nowhere", loader: async () => runtime, closedClassWords: () => new Set(["the"]) });
    const surfaces = await realizer.realize({ requestText: "status?", facts, targetLanguage: "en", targetScript: "Latn", maxSentences: 2 });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).not.toContain("volcano");
    expect(surfaces[0]).toContain("stable");
    expect(steps[0]?.[VOCAB.indexOf("volcano")]).toBe(Number.NEGATIVE_INFINITY);
  });

  it("falls back to no surfaces when the runtime is unavailable or output is degenerate", async () => {
    const missing = createConstrainedDecodingRealizer({ modelId: "fake", modelDir: "/nowhere", loader: async () => undefined });
    expect(await missing.realize({ requestText: "q", facts, targetLanguage: "en", targetScript: "Latn", maxSentences: 1 })).toEqual([]);
    const degenerate = createConstrainedDecodingRealizer({ modelId: "fake", modelDir: "/nowhere", loader: async () => ({ tokenizer, model: { generate: async () => [1, 1, 1, 1] } }) });
    expect(await degenerate.realize({ requestText: "q", facts, targetLanguage: "en", targetScript: "Latn", maxSentences: 1 })).toEqual([]);
    expect(degenerateSurface("pump pump pump")).toBe(true);
    expect(degenerateSurface("pump alpha is stable.")).toBe(false);
  });

  it("returns nothing for facts without evidence ids", async () => {
    const realizer = createConstrainedDecodingRealizer({ modelId: "fake", modelDir: "/nowhere", loader: async () => { throw new Error("must not load"); } });
    expect(await realizer.realize({ requestText: "q", facts: [{ subject: "x", predicate: "y", object: "z", evidenceIds: [] }], targetLanguage: "en", targetScript: "Latn", maxSentences: 1 })).toEqual([]);
  });
});

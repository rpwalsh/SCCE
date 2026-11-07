// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, corpusIdentityGeneration, corpusIdentitySignals, corpusNamedIdentities, corpusNamedRuns, primeCorpusIdentitySignals, type CorpusIdentitySignals } from "../corpus-identity.js";
import { namedSubjectAnchors } from "../kernel-answer-primitives.js";
import { withRequestLanguageFormScope } from "../request-language-form-scope.js";

afterEach(clearCorpusIdentitySignals);

function signals(identity: string): CorpusIdentitySignals {
  return { identities: new Set([identity]), closedClass: new Set(["q0"]), spread: new Map([[identity, 1]]), concentration: 1 };
}

describe("corpus identity ownership across cognitive turns", () => {
  it("keeps overlapping source identities and subject caches in their originating turn", async () => {
    const legacy = signals("ambient");
    primeCorpusIdentitySignals(legacy);
    let ready = 0, bothReady!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { bothReady = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const run = (identity: string, foreign: string) => withRequestLanguageFormScope(async () => {
      const initial = corpusIdentitySignals();
      primeCorpusIdentitySignals(signals(identity));
      const generation = corpusIdentityGeneration();
      const initialAnchors = namedSubjectAnchors(`q0 ${identity}`);
      if (++ready === 2) bothReady();
      await resume;
      expect(initial).toBeUndefined();
      expect(corpusIdentityGeneration()).toBe(generation);
      expect(corpusNamedIdentities(`q0 ${identity} ${foreign} ambient`)).toEqual([identity]);
      expect(namedSubjectAnchors(`q0 ${identity}`)).toEqual(initialAnchors);
      expect(namedSubjectAnchors(`q0 ${identity}`)).toEqual([identity]);
      expect(corpusNamedRuns(`q0 ${identity}`)).toEqual([identity]);
      return generation;
    });
    const a = run("港", "נמלית"), b = run("נמלית", "港");
    await started; release();
    const generations = await Promise.all([a, b]);
    expect(generations[0]).not.toBe(generations[1]);
    expect(corpusIdentitySignals()).toBe(legacy);
    await withRequestLanguageFormScope(async () => {
      expect(corpusIdentitySignals()).toBeUndefined();
      expect(corpusNamedIdentities("ambient 港 נמלית")).toEqual([]);
    });
  });

  it("clears only the current scope and restores the parent after a nested failure", async () => {
    primeCorpusIdentitySignals(signals("ambient"));
    await withRequestLanguageFormScope(async () => {
      primeCorpusIdentitySignals(signals("parent"));
      const parentGeneration = corpusIdentityGeneration();
      await expect(withRequestLanguageFormScope(async () => {
        expect(corpusIdentitySignals()).toBeUndefined();
        primeCorpusIdentitySignals(signals("child"));
        expect(corpusNamedIdentities("parent child ambient")).toEqual(["child"]);
        clearCorpusIdentitySignals();
        expect(corpusIdentitySignals()).toBeUndefined();
        throw new Error("nested turn failed");
      })).rejects.toThrow("nested turn failed");
      expect(corpusIdentityGeneration()).toBe(parentGeneration);
      expect(corpusNamedIdentities("parent child ambient")).toEqual(["parent"]);
    });
    expect(corpusNamedIdentities("parent child ambient")).toEqual(["ambient"]);
  });
});

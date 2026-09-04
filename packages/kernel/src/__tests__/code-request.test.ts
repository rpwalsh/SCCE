// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { codeRequestCorroborated, codeRequestRecognized, codeRequestRequirements, codeRequestSignal } from "../code-request.js";

const recognized = (text: string) => codeRequestRecognized(codeRequestSignal(text));

describe("code request structure", () => {
  it("recognizes a named language corroborated by code shape", () => {
    const signal = codeRequestSignal("Write a TypeScript function named longestCommonPrefix that takes an array of strings.");
    expect(codeRequestRecognized(signal)).toBe(true);
    expect(signal.language).toBe("typescript");
  });

  it("recognizes a request that names a code path, and takes the language from the extension", () => {
    const signal = codeRequestSignal("Fix the off-by-one in packages/kernel/src/mouth.ts please");
    expect(codeRequestRecognized(signal)).toBe(true);
    expect(signal.language).toBe("typescript");
    expect(signal.paths).toEqual(["packages/kernel/src/mouth.ts"]);
  });

  it("recognizes a fenced block in a named language", () => {
    expect(recognized("Why does this python fail?\n```\nprint(1)\n```")).toBe(true);
  });

  it("leaves ordinary prose alone even when it contains a short language alias", () => {
    expect(recognized("Where did the crew go after the war with the Klingons?")).toBe(false);
    expect(recognized("Season one, two, and three were released on April 28, September 22, and December 15, respectively.")).toBe(false);
    expect(recognized("Explain what Ada Lovelace did with the Analytical Engine.")).toBe(false);
    expect(recognized("In plain words, what is a Postgres GIN index good for?")).toBe(false);
  });

  it("tilts on a bare language name without corroborating shape, and leaves the projection to decide", () => {
    const bare = codeRequestSignal("Who created Rust?");
    expect(codeRequestRecognized(bare)).toBe(true);
    expect(codeRequestCorroborated(bare)).toBe(false);
    expect(codeRequestRequirements("Who created Rust?", bare)[0]!.value).toBeLessThan(0.6);
    const artifact = codeRequestSignal("Write a TypeScript function named chunk() that splits an array.");
    expect(codeRequestCorroborated(artifact)).toBe(true);
    expect(codeRequestRequirements("x", artifact)[0]!.value).toBeGreaterThan(0.9);
  });

  it("emits explicit executable-artifact requirements only for recognized requests", () => {
    const request = "Write a TypeScript function named chunk() that splits an array.";
    const requirements = codeRequestRequirements(request, codeRequestSignal(request));
    expect(requirements.map(row => row.dimension)).toEqual(["executableArtifactDemand", "formatConstraintStrength", "externalTruthAuthority"]);
    expect(requirements[0]!.value).toBeGreaterThan(0.6);
    expect(requirements.every(row => row.status === "explicit" && row.polarity === "required")).toBe(true);
    expect(codeRequestRequirements("Who created Star Trek?", codeRequestSignal("Who created Star Trek?"))).toEqual([]);
  });
});

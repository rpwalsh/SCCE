// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { isProseSentence, proseGistSurface } from "../evidence-gist.js";

const TABLE_HEAD = "Enterprise Ferenginar Grodénchik Eisenberg Starfleet Ferengi Andrea Cecily Martin Weyoun Adams Brunt";

describe("proseGistSurface", () => {
  it("skips roster runs and returns the first real sentence", () => {
    const span = `${TABLE_HEAD}. In "The Dogs of War", he became one of the few Star Trek actors to play two unrelated roles.`;
    expect(proseGistSurface(span)).toBe('In "The Dogs of War", he became one of the few Star Trek actors to play two unrelated roles.');
  });

  it("returns empty when the span is pure table material", () => {
    expect(proseGistSurface(`${TABLE_HEAD} | Quark | Rom | Nog`)).toBe("");
  });

  it("keeps ordinary prose unchanged", () => {
    const prose = "Ada Lovelace wrote the first published algorithm intended for a machine.";
    expect(proseGistSurface(prose)).toBe(prose);
  });

  it("caps output at the requested sentence count", () => {
    const span = "One sentence about the topic goes here. A second sentence about it follows now. A third sentence should be dropped entirely.";
    expect(proseGistSurface(span, 2)).toBe("One sentence about the topic goes here. A second sentence about it follows now.");
  });
});

describe("isEntitySaladSurface", () => {
  it("flags roster runs", async () => {
    const { isEntitySaladSurface } = await import("../evidence-gist.js");
    expect(isEntitySaladSurface(TABLE_HEAD)).toBe(true);
    expect(isEntitySaladSurface("He became one of the few actors to do this.")).toBe(false);
    expect(isEntitySaladSurface("Armin Shimerman.")).toBe(false);
  });
});

describe("isProseSentence", () => {
  it("rejects capitalized cell runs", () => {
    expect(isProseSentence(TABLE_HEAD)).toBe(false);
  });

  it("rejects pipe-delimited rows", () => {
    expect(isProseSentence("He played the role well | 1999 | DS9 | final season episode")).toBe(false);
  });

  it("accepts sentences with connective lowercase words", () => {
    expect(isProseSentence("He became one of the few actors to do this.")).toBe(true);
  });
});

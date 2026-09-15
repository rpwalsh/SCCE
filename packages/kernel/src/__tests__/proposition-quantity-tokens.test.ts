// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearFreeFormLexicon, createHasher, createSemanticProofSystem, primeFreeFormLexicon, PROOF_CONTRADICTION_THRESHOLD, SEMANTIC_CONSTRAINT, trainKneserNey } from "../index.js";

const proof = createSemanticProofSystem({ hasher: createHasher() });

function quantities(text: string): Array<{ value: number; unit: string | null }> {
  return proof.atomizeClaim(text).flatMap(atom => atom.constraints
    .filter(constraint => constraint.kind === SEMANTIC_CONSTRAINT.QUANTITY)
    .map(constraint => {
      const record = constraint.value as { value: number; unit?: string };
      return { value: record.value, unit: record.unit ?? null };
    }));
}

// A small corpus in which some symbols follow numbers and others follow words, the way a hydrated turn holds one.
function fixtureCorpus(grouping: string, decimal: string): string {
  const units = ["metres", "kilometres", "tonnes", "degrees", "hectares"];
  const nouns = ["survey", "river", "summit", "valley", "mission", "border", "report", "archive"];
  const lines: string[] = [];
  for (let i = 0; i < 40; i++) {
    const unit = units[i % units.length]!;
    const noun = nouns[i % nouns.length]!;
    const other = nouns[(i + 3) % nouns.length]!;
    lines.push(`The ${noun} measured ${(i * 37) % 900 + 12} ${unit} across the ${other} in the north.`);
    lines.push(`A ${other} report in the ${noun} archive was kept in the east.`);
    lines.push(`Records list 1${grouping}${String(100 + i * 7).padStart(3, "0")}${decimal}${i % 9} ${unit} for the ${noun}.`);
  }
  return lines.join(" ");
}

afterEach(() => clearFreeFormLexicon());

describe("the proposition compiler reads numeric runs and units from structure and the corpus", () => {
  it("compiles the same quantity with and without a grouping separator to one equal value", () => {
    primeFreeFormLexicon([trainKneserNey(fixtureCorpus(",", "."), { order: 3 })]);
    const grouped = quantities("Mount Everest is 8,848 metres tall.");
    const plain = quantities("Mount Everest is 8848 metres tall.");
    expect(grouped).toEqual([{ value: 8848, unit: "metres" }]);
    expect(grouped).toEqual(plain);
  });

  it("reads the separator roles the corpus uses rather than one convention", () => {
    primeFreeFormLexicon([trainKneserNey(fixtureCorpus(".", ","), { order: 3 })]);
    expect(quantities("Mount Everest is 8.848 metres tall.")).toEqual([{ value: 8848, unit: "metres" }]);
    expect(quantities("The slope rises 3,5 metres.")).toEqual([{ value: 3.5, unit: "metres" }]);
  });

  it("does not read a content word after a bare number as its unit", () => {
    primeFreeFormLexicon([trainKneserNey(fixtureCorpus(",", "."), { order: 3 })]);
    expect(quantities("The elevation was established by the 1955 survey of India.")).toEqual([{ value: 1955, unit: null }]);
    expect(quantities("The crew of Apollo 11 in the north landed.")).toEqual([{ value: 11, unit: null }]);
  });

  it("keeps a symbol the corpus attaches to numbers as a unit", () => {
    primeFreeFormLexicon([trainKneserNey(fixtureCorpus(",", "."), { order: 3 })]);
    expect(quantities("The summit is 3412 metres above the valley.")).toEqual([{ value: 3412, unit: "metres" }]);
  });

  it("reads a run whose two marks fix their own roles before any corpus is hydrated", () => {
    expect(quantities("The haul weighed 1,234.5 tonnes.")).toEqual([{ value: 1234.5, unit: "tonnes" }]);
    expect(quantities("The haul weighed 1.234,5 tonnes.")).toEqual([{ value: 1234.5, unit: "tonnes" }]);
  });

  it("does not equate two unit surfaces by a trailing letter the corpus never taught", () => {
    const [claim] = proof.atomizeClaim("Xylor-7 decomposes at 417 kelvins.");
    const [rival] = proof.atomizeClaim("Xylor-7 decomposes at 431 kelvin.");
    expect(proof.unify(claim!, rival!).contradiction).toBeLessThan(PROOF_CONTRADICTION_THRESHOLD);
  });
});

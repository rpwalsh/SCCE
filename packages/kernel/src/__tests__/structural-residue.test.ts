// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { isStructuralResidueSurface, structuralResidueMeasurement, structuralResidueScore } from "../structural-residue.js";
import { isUnparsedMarkupText } from "../local-evidence-runtime.js";

// Verbatim from evidence_span.81a0172587064a2bd3a5178681684081249e0c93a79736cc, the ONE promoted span of the
// tungsten article, which answered "What is the boiling point of tungsten?" on the 2026-09-13 baseline.
const TUNGSTEN_CITATION_TABLE =
  "oDresel,_Wilfried2007\\\"] = 1,\\n    [\\\"CITEREFMarquetFrançoisLotfiTurcant1997\\\"] = 1,\\n    "
  + "[\\\"CITEREFMaslanaWenelskaBiegunMijowska2020\\\"] = 1,\\n    [\\\"CITEREFMasten2003\\\"] = 1,\\n    "
  + "[\\\"CITEREFMateusLopesMartinsGonçalves2021\\\"] = 1,\\n    [\\\"CITEREFMcMahonNelmes2006\\\"] = 1,\\n    "
  + "[\\\"CITEREFMcMaster,_J.Enemark,_John_H.1998\\\"] = 1,\\n    [\\\"CITEREFMcQuaid_ALamand_MMason_J1994\\\"] = 1,";

const ENCYCLOPEDIA_SENTENCE =
  "Tungsten is a chemical element with the symbol W and atomic number 74, and it has the highest melting point "
  + "of all the metals, at 3,422 degrees Celsius.";

const NON_LATIN_SENTENCE =
  "베를린은 독일의 수도이자 최대 도시이며, 약 380만 명이 거주하고 있어 유럽 연합에서 인구가 가장 많은 도시이다.";

describe("structural residue", () => {
  it("refuses a serialized citation table that carries no markup literal at all", () => {
    // The regression: isUnparsedMarkupText tests for {{, | and == and this table contains none of them, which is
    // why the table reached the answer. Without the structural measure there is nothing that refuses it.
    expect(isUnparsedMarkupText(TUNGSTEN_CITATION_TABLE)).toBe(false);
    expect(isStructuralResidueSurface(TUNGSTEN_CITATION_TABLE)).toBe(true);
  });

  it("admits ordinary prose in a Latin script and in a non-Latin script", () => {
    expect(isStructuralResidueSurface(ENCYCLOPEDIA_SENTENCE)).toBe(false);
    expect(isStructuralResidueSurface(NON_LATIN_SENTENCE)).toBe(false);
    expect(structuralResidueScore(ENCYCLOPEDIA_SENTENCE)).toBeLessThan(structuralResidueScore(TUNGSTEN_CITATION_TABLE));
    expect(structuralResidueScore(NON_LATIN_SENTENCE)).toBeLessThan(structuralResidueScore(TUNGSTEN_CITATION_TABLE));
  });

  it("scores on repeated punctuation skeleton, not on length or on any word", () => {
    const measured = structuralResidueMeasurement(TUNGSTEN_CITATION_TABLE);
    expect(measured.symbolDensity).toBeGreaterThan(0.5);
    expect(measured.bigramDiversity).toBeLessThan(0.5);
    const prose = structuralResidueMeasurement(ENCYCLOPEDIA_SENTENCE);
    expect(prose.bigramDiversity).toBeGreaterThan(0.9);
    // Renaming every key leaves the skeleton intact, so the verdict must not move.
    const renamed = TUNGSTEN_CITATION_TABLE.replace(/CITEREF[^\\"]*/gu, "AAA");
    expect(isStructuralResidueSurface(renamed)).toBe(true);
  });

  it("says nothing about surfaces too short to have a skeleton", () => {
    expect(structuralResidueScore("W.")).toBe(0);
    expect(isStructuralResidueSurface("")).toBe(false);
  });
});

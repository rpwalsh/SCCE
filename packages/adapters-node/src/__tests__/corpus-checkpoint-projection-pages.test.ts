// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import type { LanguagePatternProjection, LanguagePatternRecord, ScceStorage } from "@scce/kernel";
import { checkpointPatternProjectionsCurrent, type LanguageCorpusTrainingInput, type LanguageCorpusTrainingReport } from "../language-corpus-trainer.js";

function fixture(count: number) {
  const projection: LanguagePatternProjection = {
    profileId: "profile", sourceId: "source" as LanguagePatternProjection["sourceId"], sourceVersionId: "version" as LanguagePatternProjection["sourceVersionId"],
    sourceSystem: "workspace", patternSchema: "scce.lexical_sense.v1", componentRecipe: "fixture.lexical.v1",
    informationLabel: { tenantId: "owner", principals: [], compartments: [], exportClass: "restricted", mergePolicy: "same_owner" },
    patternIds: Array.from({ length: count }, (_, index) => `pattern.${String(index).padStart(6, "0")}`)
  };
  const calls: string[][] = [];
  let active: LanguagePatternProjection | undefined = projection;
  const storage = { languageMemory: {
    getLanguagePatternProjection: async () => active,
    listLanguagePatterns: async (query: { view?: string; patternIds?: readonly string[]; limit?: number }) => {
      expect(query.view).toBe("request_seed");
      expect(query.limit).toBe(query.patternIds?.length);
      expect(query.patternIds!.length).toBeLessThanOrEqual(512);
      calls.push([...query.patternIds!]);
      return query.patternIds!.map(id => ({ id } as LanguagePatternRecord));
    }
  } } as unknown as ScceStorage;
  const input = { storage, sourceSystem: "workspace", text: "source", streamUri: "fixture://source", languageOnly: true,
    sourceOwnedPatternProjections: [{ patternSchema: projection.patternSchema, componentRecipe: projection.componentRecipe, patterns: [] }] } as LanguageCorpusTrainingInput;
  const report = { sourceOwnedPatternProjections: [projection] } as unknown as LanguageCorpusTrainingReport;
  return { storage, input, report, projection, calls, replaceActive: (value: LanguagePatternProjection | undefined) => { active = value; } };
}

it("verifies a WordNet-sized completed projection through bounded exact-ID pages without retaining pattern bodies", async () => {
  const f = fixture(107519);
  expect(await checkpointPatternProjectionsCurrent(f.input, f.report)).toBe(true);
  expect(f.calls).toHaveLength(Math.ceil(107519 / 512));
  expect(f.calls.at(-1)).toHaveLength(511);
  expect(f.calls.flat()).toEqual(f.projection.patternIds);
});

it.each(["missing", "duplicate", "replaced"])("rejects %s durable IDs in a later checkpoint page", async failure => {
  const f = fixture(1025), read = f.storage.languageMemory.listLanguagePatterns;
  f.storage.languageMemory.listLanguagePatterns = async query => {
    const rows = await read(query);
    if (query?.patternIds?.includes("pattern.000512")) {
      if (failure === "missing") rows.pop();
      if (failure === "duplicate") rows[rows.length - 1] = rows[0]!;
      if (failure === "replaced") rows[rows.length - 1] = { id: "foreign-pattern" } as LanguagePatternRecord;
    }
    return rows;
  };
  expect(await checkpointPatternProjectionsCurrent(f.input, f.report)).toBe(false);
  expect(f.calls).toHaveLength(2);
});

it.each(["missing", "replaced"])("rejects a %s active projection before reading any pattern page", async failure => {
  const f = fixture(1025);
  f.replaceActive(failure === "missing" ? undefined : { ...f.projection, patternIds: ["foreign-pattern"] });
  expect(await checkpointPatternProjectionsCurrent(f.input, f.report)).toBe(false);
  expect(f.calls).toHaveLength(0);
});

it("keeps an exact empty active projection without issuing an unscoped pattern read", async () => {
  const f = fixture(0);
  expect(await checkpointPatternProjectionsCurrent(f.input, f.report)).toBe(true);
  expect(f.calls).toHaveLength(0);
});

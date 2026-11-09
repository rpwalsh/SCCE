// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import * as induction from "../language-induction.js";
import { compileSourceInductionWindows, sourceInductionBatches } from "../source-window-induction.js";
import { createHasher } from "../primitives.js";
import type { EvidenceId } from "../types.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("joins only matching evidence windows while retaining their original order and physical multiplicity", () => {
  const hasher = createHasher();
  const base = induction.createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "bootstrap", text: "oma vela. oma neri." }] });
  vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "8192");
  vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "16");
  const documents = Array.from({ length: 128 }, (_, index) => ({ id: `owner.${index}`, text: "\u732b e\u0301 \ud83d\udc69\u200d\ud83d\udd2c. tail.",
    evidenceIds: [`evidence.${index % 64}`, `evidence.${index % 64}`] as EvidenceId[] }));
  const windows = [...sourceInductionBatches(documents, hasher)].flatMap(batch => batch.windows);
  expect(windows.length).toBeGreaterThan(documents.length);
  let evidenceReads = 0;
  const ownership = Array.from({ length: 128 }, (_, index) => [`evidence.${index % 64}`, `evidence.${(index + 5) % 64}`, `evidence.${index % 64}`] as EvidenceId[]);
  ownership.push(["unmatched" as EvidenceId]);
  const constructions = ownership.map((evidenceIds, index): induction.GraphBoundConstruction => ({
    id: `construction.${index}`, frameId: `frame.${index}`, predicate: "opaque", predicateSemanticRole: "predicate", slots: [], support: 1,
    get evidenceIds() { evidenceReads++; return evidenceIds; }
  }));
  vi.spyOn(induction, "createLanguageInductionEngine").mockReturnValue({ induce: () => ({ ...base, graphBoundConstructions: constructions }) });
  const first = compileSourceInductionWindows({ documents, hasher });
  expect(first.models).toHaveLength(1);
  expect(first.models[0]!.graphBoundConstructions.map(construction => construction.sourceWindows)).toEqual(ownership.map(evidenceIds =>
    windows.filter(window => window.evidenceIds.some(id => evidenceIds.includes(id as EvidenceId)))
      .map(({ ownerDocumentId, startUtf16, endUtf16 }) => ({ ownerDocumentId, startUtf16, endUtf16 }))));
  expect(evidenceReads).toBeLessThanOrEqual(constructions.length * 3);
  expect(first.models[0]!.graphBoundConstructions.at(-1)!.sourceWindows).toEqual([]);
  const firstRanges = first.models[0]!.graphBoundConstructions[0]!.sourceWindows!;
  expect(firstRanges.some(window => window.ownerDocumentId === "owner.64")).toBe(true);
  expect(() => { firstRanges[0]!.startUtf16++; }).toThrow();
  const changed = compileSourceInductionWindows({ documents: documents.map(document => ({ ...document, evidenceIds: ["other" as EvidenceId] })), hasher });
  expect(changed.models[0]!.graphBoundConstructions.every(construction => construction.sourceWindows?.length === 0)).toBe(true);
  expect(first.models[0]!.graphBoundConstructions[0]!.sourceWindows).toEqual(firstRanges);
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createGraphSurfaceTraceSummaryAccumulator, induceSourceBoundConstructionTrainingSets,
  type GraphSurfaceTransportTrace, type GraphSurfaceTransportCell } from "../graph-surface-alignment.js";
import { createHasher, createClock, canonicalStringify } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

const objective: GraphSurfaceTransportTrace["objective"] = { solver: "sparse_anchor_transport_v1", featureWeight: 0.42,
  structuralWeight: 0.22, anchorWeight: 0.24, massWeight: 0.08, priorWeight: 0.04 };
const cell = (cost: number, posterior: number, selected: boolean): GraphSurfaceTransportCell => ({ surfaceUnitId: "unit", roleId: "role",
  slotIndex: 0, occurrenceIndex: 0, surface: "\u6e2f\ud83e\udded", normalized: "\u6e2f\ud83e\udded", cost, posterior, selected,
  featureCost: 0, structuralCost: 0, anchorBonus: 0, massPenalty: 0, priorPenalty: 0 });
const trace = (cells: GraphSurfaceTransportCell[]): GraphSurfaceTransportTrace => ({ traceId: "trace", latticeId: "lattice", constructionId: "construction",
  predicate: "\u22b9", evidenceIds: ["source"], surfaceStartCodePoint: 0, surfaceEndCodePoint: 1, objective: { ...objective }, cells });

it("consumes each trace immediately without retaining candidate cells or mutable first-objective records", () => {
  const accumulator = createGraphSurfaceTraceSummaryAccumulator();
  const traces = [trace([cell(1e16, 1e16, true), cell(1, 1, true), cell(999, 999, false)]),
    trace([cell(-1e16, -1e16, true), cell(3, 0.125, true)]), trace([cell(0.5, 0.25, true)])];
  const selected = traces.flatMap(row => row.cells.filter(cell => cell.selected));
  const expectedPosterior = selected.reduce((sum, cell) => sum + cell.posterior, 0) / selected.length;
  const expectedCost = selected.reduce((sum, cell) => sum + cell.cost, 0) / selected.length;
  function* ephemeral() {
    for (const row of traces) {
      yield row;
      row.cells.length = 0; row.objective.featureWeight = 999;
      Object.defineProperty(row, "cells", { get: () => { throw Error("expired trace cells were retained"); } });
    }
  }
  for (const row of ephemeral()) accumulator.observe(row);
  accumulator.observeNullRoleAudit([{ slotIndex: 1, occurrenceIndex: 0, reason: "bound", candidateFactCount: 1, omittedPortCount: 1 },
    { slotIndex: 2, occurrenceIndex: 0, reason: "ambiguous_facts", candidateFactCount: 2, omittedPortCount: 1 }]);
  accumulator.observeNullRoleAudit([{ slotIndex: 1, occurrenceIndex: 0, reason: "bound", candidateFactCount: 1, omittedPortCount: 1 }]);
  expect(accumulator.summary({ bindingId: "binding", lattices: [] })).toEqual({ schema: "scce.graph_surface_alignment.summary.v1", bindingId: "binding",
    latticeCount: 0, traceCount: 3, selectedCellCount: 5, meanSelectedPosterior: expectedPosterior, meanSelectedCost: expectedCost,
    nullRoleBindingAudit: { evaluated: 3, bound: 2, reasons: [{ reason: "ambiguous_facts", count: 1 }, { reason: "bound", count: 2 }] }, lattices: [], objective });
});

it("preserves empty and nonfinite summary normalization without reordering the original additions", () => {
  const accumulator = createGraphSurfaceTraceSummaryAccumulator();
  expect(accumulator.summary({ bindingId: "empty", lattices: [] })).toMatchObject({ traceCount: 0, selectedCellCount: 0,
    meanSelectedPosterior: 0, meanSelectedCost: 0, objective });
  accumulator.observe(trace([cell(Infinity, NaN, true)]));
  expect(accumulator.summary({ bindingId: "nonfinite", lattices: [] })).toMatchObject({ meanSelectedPosterior: null, meanSelectedCost: null });
});

it("preserves complete source-bound observations and alignment summary artifacts on sixteen unchanged human records", () => {
  const text = (JSON.parse(readFileSync(new URL("./fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text, hasher = createHasher();
  expect(Buffer.byteLength(text)).toBe(17248);
  expect(hasher.digestHex(text)).toBe("307c6758d4173c6dd87d0b77460c74fafe62c3e58d934eabbf5e05268de3dadc");
  const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true, namespace: "summary-retention" });
  const sourceVersionId = ids.sourceVersionId("dolly.human.16"), contentHash = ids.contentHash(text), byteLength = Buffer.byteLength(text);
  const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: byteLength, spanHash: contentHash }),
    sourceId: ids.sourceId("fixture", "fixture://dolly.human.16"), sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: byteLength, chunkHash: contentHash }), contentHash,
    mediaType: "text/plain", byteStart: 0, byteEnd: byteLength, charStart: 0, charEnd: [...text].length, text, textPreview: text,
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1 };
  const sets = induceSourceBoundConstructionTrainingSets({ evidence: [evidence], profileId: "profile.human.16", hasher });
  expect(sets.length).toBeGreaterThan(0);
  const digest = hasher.digestHex(canonicalStringify(sets));
  expect(digest).toBe("9f8d4a5f54927021e9f7b1310f4f2a78ca8d4a78529de12ff843c300b6bf0812");
});

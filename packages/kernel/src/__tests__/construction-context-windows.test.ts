// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as induction from "../language-induction.js";
import { compileLanguageTrainingBatch, prepareLanguageTrainingInduction } from "../language-training-batch.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { compileUniversalCreativeEventConstructionPattern } from "../language-construction-memory.js";
import { preparedLanguageInductionProducts, sourceLanguageInductionDocuments } from "../graph-surface-alignment.js";
import { sourceInductionBatches } from "../source-window-induction.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("source-owned construction context windows", () => {
  const hasher = createHasher();
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true });
  function evidence(text: string, family: string): EvidenceSpan {
    const sourceId = ids.sourceId("workspace", `fixture://${family}`);
    const sourceVersionId = ids.sourceVersionId(`${sourceId}:${hasher.digestHex(text)}`);
    const contentHash = ids.contentHash(text);
    return { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), spanHash: contentHash }),
      sourceId, sourceVersionId, contentHash, chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Buffer.byteLength(text), chunkHash: contentHash }),
      text, textPreview: text, byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
      mediaType: "text/plain", status: "promoted", alpha: 1, observedAt: 1, features: [], languageHints: {}, scriptHints: {}, trustVector: {},
      provenance: { sourceFamilyId: family } };
  }

  it("composes nested unspaced, astral and combining ranges into their original evidence owner", () => {
    vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "128"); vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "32");
    const body = "previous. ".repeat(20) + "東京👩🏽‍🔬e\u0301東京👩🏽‍🔬e\u0301東京👩🏽‍🔬e\u0301。";
    const parent = evidence(body, "prior");
    const start = body.indexOf("東京");
    const document = { id: "context.exact", text: body.slice(start), sourceVersionId: parent.sourceVersionId, evidenceIds: [parent.id],
      sourceFamilyId: "prior", sourceWindow: { ownerDocumentId: String(parent.id), startUtf16: start, endUtf16: body.length } };
    const batches = [...sourceInductionBatches([document], hasher)];
    expect(batches.flatMap(batch => batch.documents).map(document => document.text).join("")).toBe(document.text);
    const windows = batches.flatMap(batch => batch.windows);
    expect(windows.every(window => window.ownerDocumentId === String(parent.id))).toBe(true);
    expect(windows[0]!.startUtf16).toBe(start);
    expect(windows.at(-1)!.endUtf16).toBe(body.length);
    const current = evidence("ada visited london. zoe visited paris.", "current");
    const input = { evidence: [current], constructionEvidence: [current, parent], constructionContextDocuments: [document], hasher };
    expect(prepareLanguageTrainingInduction(input).prepared).toBeDefined();
    expect(() => prepareLanguageTrainingInduction({ ...input, constructionContextDocuments: [{ ...document, sourceWindow: { ...document.sourceWindow, startUtf16: start + 1 } }] })).toThrow("not source-owned");
    expect(() => prepareLanguageTrainingInduction({ ...input, constructionContextDocuments: [{ ...document, sourceFamilyId: "foreign" }] })).toThrow("not source-owned");
    expect(() => [...sourceInductionBatches([{ ...document, sourceWindow: { ...document.sourceWindow, endUtf16: body.length + 1 } }], hasher)]).toThrow("inconsistent owner ranges");
    const split = start + "東京".length + 1;
    expect(() => prepareLanguageTrainingInduction({ ...input, constructionContextDocuments: [{ ...document, text: body.slice(split),
      sourceWindow: { ...document.sourceWindow, startUtf16: split } }] })).toThrow("splits an owned grapheme");
  });

  it("shares current acquisition with a disjoint qualification view without inducing heldout input", () => {
    const spans = ["first", "second", "third"].map(family => evidence("ada visited london. zoe visited paris. ada visited paris. zoe visited london.", family));
    const current = spans[0]!;
    const context = spans.slice(1).map(span => ({ ...sourceLanguageInductionDocuments([span])[0]!,
      sourceFamilyId: String((span.provenance as { sourceFamilyId: string }).sourceFamilyId) }));
    const engine = vi.spyOn(induction, "createLanguageInductionEngine");
    const prepared = prepareLanguageTrainingInduction({ evidence: [current], constructionEvidence: spans, constructionContextDocuments: context, hasher });
    const calls = engine.mock.calls.length;
    const currentProducts = preparedLanguageInductionProducts({ documents: sourceLanguageInductionDocuments([current]), hasher, prepared: prepared.prepared });
    const fitProducts = preparedLanguageInductionProducts({ documents: prepared.qualificationDocuments.train, hasher, prepared: prepared.prepared });
    const heldOwners = new Set(prepared.qualificationDocuments.heldOut.flatMap(document => document.evidenceIds ?? []).map(String));
    expect(heldOwners.size).toBeGreaterThan(0);
    expect(fitProducts.coverage.windows.every(window => !heldOwners.has(window.ownerDocumentId))).toBe(true);
    expect(currentProducts.coverage.windows.every(window => window.ownerDocumentId === String(current.id))).toBe(true);
    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId: current.sourceVersionId, text: current.text, createdAt: 1 });
    const compiled = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ idFactory: ids, hasher }), hasher, batch: {
      streamId: "fixture://current", sourceSystem: "gutenberg", profile, sourceVersionId: current.sourceVersionId, text: current.text,
      evidence: [current], constructionEvidence: spans, constructionContextDocuments: context, createdAt: 1, preparedInduction: prepared.prepared } });
    expect(compiled.preparedInduction).toBe(prepared.prepared);
    compileUniversalCreativeEventConstructionPattern({ profileId: profile.id, evidence: [current], hasher, updatedAt: 1, preparedInduction: compiled.preparedInduction });
    expect(engine).toHaveBeenCalledTimes(calls);
    expect(compiled.constructionPatterns.length).toBeGreaterThan(0);
    expect(compiled.constructionPatterns.every(pattern => pattern.evidenceIds.every(id => id === current.id))).toBe(true);
    expect(() => preparedLanguageInductionProducts({ documents: [{ ...context[0]!, text: "forged" }], hasher, prepared: prepared.prepared })).toThrow("inputs changed");
  });
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileSourceInductionWindows } from "../source-window-induction.js";
import { createHasher } from "../primitives.js";
import type { EvidenceId, SourceVersionId } from "../types.js";

afterEach(() => vi.unstubAllEnvs());

describe("source-window construction ownership", () => {
  it("retains every actual predicate window without treating a shared evidence ID as occurrence support", () => {
    vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "512");
    vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "128");
    const texts = ["😀 alpha beta. ", "gamma delta. ", "alpha delta. ", "alpha. "];
    const sourceVersionId = "source.version.ownership" as SourceVersionId;
    const evidenceId = "evidence.shared" as EvidenceId;
    let offset = 37;
    const documents = texts.map((text, index) => {
      const startUtf16 = offset;
      offset += text.length;
      return { id: `window.${index}`, text, sourceVersionId, evidenceIds: [evidenceId],
        sourceWindow: { ownerDocumentId: "original.evidence", startUtf16, endUtf16: offset } };
    });
    const products = compileSourceInductionWindows({ documents, hasher: createHasher() });
    expect(products.models).toHaveLength(1);
    expect(products.coverage.complete).toBe(true);
    expect(products.coverage.inputUtf16Length).toBe(texts.join("").length);
    expect(products.coverage.coveredUtf16Length).toBe(texts.join("").length);
    expect(products.coverage.windows.map(({ ownerDocumentId, startUtf16, endUtf16 }) => ({ ownerDocumentId, startUtf16, endUtf16 })))
      .toEqual(documents.map(document => document.sourceWindow));
    const constructions = products.models[0]!.graphBoundConstructions;
    const windows = (predicate: string) => {
      const construction = constructions.find(item => item.predicate === predicate);
      expect(construction, predicate).toBeDefined();
      return construction!.sourceWindows;
    };
    expect(windows("alpha")).toEqual([documents[0]!.sourceWindow, documents[2]!.sourceWindow]);
    expect(windows("beta")).toEqual([documents[0]!.sourceWindow]);
    expect(windows("gamma")).toEqual([documents[1]!.sourceWindow]);
    expect(windows("delta")).toEqual([documents[1]!.sourceWindow, documents[2]!.sourceWindow]);
  });

  it("retains genuine support beyond the frame example limit", () => {
    vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "2048");
    vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "128");
    let offset = 91;
    const documents = Array.from({ length: 20 }, (_, index) => {
      const text = `alpha item${index}. `;
      const startUtf16 = offset;
      offset += text.length;
      return { id: `window.${index}`, text, evidenceIds: ["evidence.shared" as EvidenceId],
        sourceWindow: { ownerDocumentId: "original.evidence", startUtf16, endUtf16: offset } };
    });
    const products = compileSourceInductionWindows({ documents, hasher: createHasher() });
    expect(products.models).toHaveLength(1);
    const model = products.models[0]!;
    const frame = model.semanticFrames.find(item => item.predicate === "alpha")!;
    expect(frame.examples.length).toBeLessThan(documents.length);
    expect(model.graphBoundConstructions.find(item => item.predicate === "alpha")!.sourceWindows)
      .toEqual(documents.map(document => document.sourceWindow));
    expect(products.coverage.coveredUtf16Length).toBe(documents.reduce((total, document) => total + document.text.length, 0));
  });
});

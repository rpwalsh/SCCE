// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher } from "../primitives.js";
import { compileSourceInductionWindows } from "../source-window-induction.js";
import { joinProgramMixtureStorageForm } from "../join-program-storage.js";
import type { EvidenceId } from "../types.js";

describe("real source join-storage equivalence", () => {
  it("preserves the complete pinned human Dolly window and reuses its frozen packed join program", () => {
    const source = JSON.parse(readFileSync(new URL("./fixtures/dolly-human-window-160-193.json", import.meta.url), "utf8")) as { text: string };
    const hasher = createHasher();
    expect(Buffer.byteLength(source.text)).toBe(9_224);
    const products = compileSourceInductionWindows({ documents: [{ id: "real-dolly-owned-window.160-193", text: source.text,
      evidenceIds: ["evidence.real-dolly.160-193" as EvidenceId] }], hasher });
    expect(products.coverage).toMatchObject({ complete: true, inputUtf16Length: 9_214, coveredUtf16Length: 9_214 });
    expect(hasher.digestHex(canonicalStringify(products))).toBe("36211d551553f88c37ffec213d7a1680822122df8c815fdcba3f8af81cc4f832");
    let retainedSourceUtf16 = 0;
    for (const model of products.models) {
      const packed = joinProgramMixtureStorageForm(model.joinProgram);
      expect(packed).toBe(model.joinProgram);
      for (const { program } of packed.mixture.components) {
        if (program.header.trainingDocumentIds.length) expect(program.header.observations).toBeGreaterThan(0);
        expect(program.header.localFactors).toBeDefined();
        for (const document of program.header.localFactors!.documents) {
          retainedSourceUtf16 += document.text.length;
          expect(Object.keys(document.graph).sort()).toEqual(["arcs", "nodeCount", "schema"]);
          expect(document.contexts.every(context => context.length === 1)).toBe(true);
        }
        expect(program.indexes.exactIndex).toEqual([]);
        expect(program.indexes.classIndex).toEqual([]);
        for (const [, refs] of program.indexes.localShapeIndex) {
          expect(refs.every(ref => program.choiceDictionary[ref]![4].length === 0)).toBe(true);
        }
        expect(program.choiceDictionary.every(([, count, probability]) => count > 0 || probability > 0)).toBe(true);
      }
    }
    expect(retainedSourceUtf16).toBe(source.text.length);
  });
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { inlineIngestStream } from "../inline-ingest-source.js";
import { createHasher } from "../primitives.js";
import type { IngestInput } from "../types.js";

function inputWith(content: Uint8Array, text: string, bytes = Buffer.from(text, "utf8")): IngestInput {
  return {
    uri: "https://source.invalid/material.bin",
    namespace: "fixture",
    mediaType: "application/octet-stream",
    content,
    evidenceDerivative: {
      bytes,
      text,
      kind: "extracted-text",
      transformId: "fixture.bounded-extractor.v1",
      originalCoordinateSpace: "extracted-text-utf8",
      redactionMap: []
    },
    sourceAdmission: {
      sourceClass: "runtime_web",
      intendedUse: "direct_evidence",
      promotionAuthority: "review"
    },
    sourceTrust: {
      identity: 0.5,
      integrity: 1,
      parserReliability: 0.8,
      directness: 0.7,
      authority: 0.5,
      freshness: 0.8,
      independenceGroup: "fixture.source",
      accessScope: "public",
      licenseStatus: "unknown"
    }
  };
}

describe("inline canonical ingest derivatives", () => {
  it("preserves original bytes while admitting the extractor's UTF-8 evidence projection", async () => {
    const original = Uint8Array.from([0, 255, 80, 68, 70, 13, 10]);
    const rows = [];
    for await (const row of inlineIngestStream(inputWith(original, "κ maps source material"), 42, createHasher())) rows.push(row);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.file.bytes).toEqual(original);
    expect(row.file.text).toBe("κ maps source material");
    expect(row.file.evidenceDerivative).toMatchObject({
      text: "κ maps source material",
      transformId: "fixture.bounded-extractor.v1",
      originalCoordinateSpace: "extracted-text-utf8"
    });
    expect(Buffer.from(row.file.evidenceDerivative!.bytes).toString("utf8")).toBe(row.file.evidenceDerivative!.text);
  });

  it("rejects an extractor projection whose bytes do not encode its declared text", async () => {
    const consume = async () => {
      for await (const _row of inlineIngestStream(
        inputWith(Uint8Array.from([1, 2, 3]), "declared", Buffer.from("different", "utf8")),
        42,
        createHasher()
      )) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow(/derivative bytes do not encode derivative text/u);
  });

  it("fails closed when a second redaction would mix derivative coordinate spaces", async () => {
    const source = inputWith(Uint8Array.from([1, 2, 3]), "password=first secret");
    source.evidenceDerivative!.redactionMap = [{
      originalCharStart: 0,
      originalCharEnd: 4,
      originalByteStart: 0,
      originalByteEnd: 4,
      derivativeCharStart: 0,
      derivativeCharEnd: 4,
      derivativeByteStart: 0,
      derivativeByteEnd: 4,
      replacement: "[REDACTED]"
    }];
    const consume = async () => {
      for await (const _row of inlineIngestStream(source, 42, createHasher())) { /* consume */ }
    };
    await expect(consume()).rejects.toThrow(/cannot compose evidence derivative redaction maps/u);
  });
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import type { QuarantineSource, ScceKernelDeps } from "../storage.js";
import type {
  ContentHash,
  EvidenceSpan,
  ScceEvent,
  SourceVersion,
  IngestInput
} from "../types.js";

describe("ingestion source derivative identity", () => {
  it("persists original and redacted versions while binding every evidence span to derivative bytes", async () => {
    const clock = createClock({ fixedTime: 1_000 });
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
    const sourceVersions: SourceVersion[] = [];
    const evidence: EvidenceSpan[] = [];
    const quarantined: QuarantineSource[] = [];
    const blobs = new Map<string, Uint8Array>();
    const ranges = new Map<string, { parentHash: ContentHash; byteStart: number; byteEnd: number }>();
    const events: ScceEvent[] = [];
    let transactions = 0;
    const informationLabel = {
      tenantId: "fixture.tenant",
      principals: ["fixture.owner"],
      compartments: ["fixture.ingestion"],
      exportClass: "restricted" as const,
      mergePolicy: "isolated" as const
    };
    const deps = {
      maxChunkBytes: 24,
      informationAccess: {
        tenantId: "fixture.tenant",
        principalId: "fixture.owner",
        compartments: ["fixture.ingestion"],
        maximumExportClass: "restricted"
      },
      sourceInformationLabel: informationLabel,
      storage: {
        transaction: async <T>(operation: () => Promise<T>) => {
          transactions++;
          return operation();
        },
        blobs: {
          put: async (content: Uint8Array) => {
            const hash = idFactory.contentHash(content);
            blobs.set(String(hash), new Uint8Array(content));
            return hash;
          },
          putRanges: async (items: readonly { contentHash: ContentHash; parentHash: ContentHash; byteStart: number; byteEnd: number }[], parent: { contentHash: ContentHash; bytes: Uint8Array }) => {
            expect(idFactory.contentHash(parent.bytes)).toBe(parent.contentHash);
            expect(Buffer.from(blobs.get(String(parent.contentHash)) ?? [])).toEqual(Buffer.from(parent.bytes));
            for (const item of items) {
              expect(item.parentHash).toBe(parent.contentHash);
              expect(idFactory.contentHash(parent.bytes.subarray(item.byteStart, item.byteEnd))).toBe(item.contentHash);
              if (item.contentHash !== parent.contentHash) ranges.set(String(item.contentHash), { parentHash: item.parentHash, byteStart: item.byteStart, byteEnd: item.byteEnd });
            }
          }
        },
        evidence: {
          putSourceVersion: async (source: SourceVersion) => {
            sourceVersions.push(source);
          },
          putEvidenceSpans: async (spans: EvidenceSpan[]) => {
            evidence.push(...spans);
          }
        },
        quarantine: {
          put: async (source: QuarantineSource) => {
            quarantined.push(source);
          }
        },
        ingestion: {
          put: async () => undefined
        }
      }
    } as unknown as ScceKernelDeps;
    const runtime = createIngestionRuntime({
      deps,
      clock,
      hasher,
      idFactory,
      eventFactory: createEventFactory({ idFactory, clock, hasher }),
      language: createLanguageAcquisitionEngine({ idFactory }),
      languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory, hasher }),
      append: async event => {
        events.push(event);
        return event;
      },
      onKernelStateMutation: () => undefined
    });
    const secret = "password = correct-horse-battery-staple";

    const input: IngestInput = {
      uri: "inline://redaction-fixture",
      namespace: "fixture",
      mediaType: "text/plain",
      content: `Header\n${secret}\nTail marker`,
      sourceAdmission: {
        sourceClass: "owner_local",
        intendedUse: "quarantine_only",
        promotionAuthority: "owner"
      },
      sourceTrust: {
        identity: 1,
        integrity: 1,
        parserReliability: 1,
        directness: 1,
        authority: 1,
        freshness: 1,
        independenceGroup: "fixture:source-derivative",
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      },
      // Ingest metadata may describe the source, but may not self-promote it.
      metadata: { epistemicState: "promoted", ownerLabel: "fixture" }
    };
    const result = await runtime.ingest(input);

    expect(sourceVersions).toHaveLength(2);
    expect(result.promotedEvidenceIds).toEqual([]);
    const original = sourceVersions.find(source => source.role === "original");
    const derivative = sourceVersions.find(source => source.role === "evidence-derivative");
    expect(original).toBeDefined();
    expect(derivative).toBeDefined();
    expect(derivative?.sourceVersionId).not.toBe(original?.sourceVersionId);
    expect(derivative?.derivation).toMatchObject({
      kind: "redacted-text",
      derivedFromSourceVersionId: original?.sourceVersionId,
      originalCoordinateSpace: "source-bytes"
    });
    const originalBytes = bytesFor(blobs, original?.contentHash);
    const derivativeBytes = bytesFor(blobs, derivative?.contentHash);
    expect(Buffer.from(originalBytes).toString("utf8")).toContain(secret);
    expect(Buffer.from(derivativeBytes).toString("utf8")).not.toContain("correct-horse-battery-staple");
    expect(evidence.length).toBeGreaterThan(0);
    expect(blobs.size).toBe(2);
    expect(ranges.size).toBeGreaterThan(0);
    expect((original?.metadata as Record<string, unknown>).epistemicState).toBe("asserted");
    expect((original?.metadata as Record<string, unknown>).ownerLabel).toBe("fixture");
    for (const span of evidence) {
      expect(span.informationLabel).toEqual(informationLabel);
      expect(span.sourceVersionId).toBe(derivative?.sourceVersionId);
      expect((span.provenance as Record<string, unknown>).sourceVersionDerivation).toMatchObject({
        kind: "redacted-text",
        derivedFromSourceVersionId: original?.sourceVersionId
      });
      expect(Buffer.from(derivativeBytes)
        .subarray(span.byteStart, span.byteEnd)
        .toString("utf8")).toBe(span.text);
      const range = ranges.get(String(span.contentHash));
      if (span.contentHash !== derivative?.contentHash) {
        expect(range).toEqual({ parentHash: derivative?.contentHash, byteStart: span.byteStart, byteEnd: span.byteEnd });
        expect(Buffer.from(bytesFor(blobs, range?.parentHash)).subarray(range?.byteStart, range?.byteEnd).toString("utf8")).toBe(span.text);
      }
      expect(((span.provenance as Record<string, unknown>).metadata as Record<string, unknown>).epistemicState).toBe("asserted");
    }
    expect(quarantined.map(source => source.sourceVersionId)).toEqual([derivative?.sourceVersionId]);
    expect(events.filter(event => event.typeId === "SourceVersionObserved")).toHaveLength(2);
    expect(transactions).toBe(1);

    const htmlStart = sourceVersions.length;
    await runtime.ingest({
      uri: "inline://html-redaction-fixture",
      namespace: "fixture",
      mediaType: "text/html",
      content: `<article>Header\n${secret}\nTail marker</article><script>do_not_learn()</script>`,
      sourceAdmission: {
        sourceClass: "owner_local",
        intendedUse: "quarantine_only",
        promotionAuthority: "owner"
      },
      sourceTrust: {
        identity: 1,
        integrity: 1,
        parserReliability: 1,
        directness: 1,
        authority: 1,
        freshness: 1,
        independenceGroup: "fixture:html-source-derivative",
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      }
    });
    const htmlDerivative = sourceVersions.slice(htmlStart).find(source => source.role === "evidence-derivative");
    expect(htmlDerivative?.derivation?.transformId).toBe("scce.source-text-derivative.v1+scce.secret-redaction.v1+scce.html-text-surface.v1");
    const htmlBlob = bytesFor(blobs, htmlDerivative?.contentHash);
    expect(Buffer.from(htmlBlob).toString("utf8")).not.toContain("do_not_learn");
    expect(Buffer.from(htmlBlob).toString("utf8")).not.toContain("correct-horse-battery-staple");
    expect(htmlDerivative?.derivation?.redactionMap).toEqual([]);

    const otherOwnerStart = sourceVersions.length;
    await runtime.ingest({ ...input, uri: "inline://other-owner", namespace: "other-owner" });
    const otherOwner = sourceVersions.slice(otherOwnerStart);
    expect(otherOwner.find(source => source.role === "original")?.contentHash).toBe(original?.contentHash);
    expect(otherOwner.find(source => source.role === "original")?.sourceVersionId).not.toBe(original?.sourceVersionId);
    expect(otherOwner.find(source => source.role === "evidence-derivative")?.contentHash).toBe(derivative?.contentHash);
    expect(otherOwner.find(source => source.role === "evidence-derivative")?.sourceVersionId).not.toBe(derivative?.sourceVersionId);

    const changedRawStart = sourceVersions.length;
    await runtime.ingest({ ...input, content: `Header\npassword = another-private-secret-value\nTail marker` });
    const changedRaw = sourceVersions.slice(changedRawStart);
    const changedOriginal = changedRaw.find(source => source.role === "original")!;
    const changedDerivative = changedRaw.find(source => source.role === "evidence-derivative")!;
    expect(changedOriginal.sourceId).toBe(original?.sourceId);
    expect(changedOriginal.sourceVersionId).not.toBe(original?.sourceVersionId);
    expect(changedDerivative.contentHash).toBe(derivative?.contentHash);
    expect(changedDerivative.sourceVersionId).not.toBe(derivative?.sourceVersionId);
    expect(changedDerivative.derivation?.derivedFromSourceVersionId).toBe(changedOriginal.sourceVersionId);

    const extractedText = "Visible source-owned text.";
    const transformations: SourceVersion[] = [];
    for (const transformId of ["source.extract.alpha", "source.extract.beta"]) {
      const start = sourceVersions.length;
      await runtime.ingest({ ...input, evidenceDerivative: { text: extractedText, bytes: Buffer.from(extractedText), kind: "extracted-text", transformId,
        originalCoordinateSpace: "source-bytes", redactionMap: [] } });
      transformations.push(sourceVersions.slice(start).find(source => source.role === "evidence-derivative")!);
    }
    expect(transformations[0]!.sourceId).toBe(transformations[1]!.sourceId);
    expect(transformations[0]!.contentHash).toBe(transformations[1]!.contentHash);
    expect(transformations[0]!.derivation?.derivedFromSourceVersionId).toBe(transformations[1]!.derivation?.derivedFromSourceVersionId);
    expect(transformations[0]!.sourceVersionId).not.toBe(transformations[1]!.sourceVersionId);
    const beforeRejectedSourceCount = sourceVersions.length;
    await expect(runtime.ingest({ ...input, evidenceDerivative: { text: extractedText, bytes: Buffer.from("mismatched bytes"), kind: "extracted-text", transformId: "source.extract.invalid",
      originalCoordinateSpace: "source-bytes", redactionMap: [] } })).rejects.toThrow("evidence derivative bytes do not encode derivative text");
    expect(sourceVersions).toHaveLength(beforeRejectedSourceCount);
    for (const span of evidence) {
      const owned = sourceVersions.find(source => source.sourceVersionId === span.sourceVersionId)!;
      expect(owned.sourceId).toBe(span.sourceId);
      expect(Buffer.from(bytesFor(blobs, owned.contentHash)).subarray(span.byteStart, span.byteEnd).toString("utf8")).toBe(span.text);
    }
  });
});

function bytesFor(blobs: ReadonlyMap<string, Uint8Array>, hash: ContentHash | undefined): Uint8Array {
  const bytes = hash ? blobs.get(String(hash)) : undefined;
  if (!bytes) throw new Error(`fixture blob missing: ${String(hash)}`);
  return bytes;
}

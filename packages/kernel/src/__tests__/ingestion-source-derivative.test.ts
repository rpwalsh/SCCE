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
  SourceVersion
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
      maxChunkBytes: 4096,
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

    await runtime.ingest({
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
      }
    });

    expect(sourceVersions).toHaveLength(2);
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
    for (const span of evidence) {
      expect(span.informationLabel).toEqual(informationLabel);
      expect(span.sourceVersionId).toBe(derivative?.sourceVersionId);
      expect(Buffer.from(derivativeBytes)
        .subarray(span.byteStart, span.byteEnd)
        .toString("utf8")).toBe(span.text);
    }
    expect(quarantined.map(source => source.sourceVersionId)).toEqual([derivative?.sourceVersionId]);
    expect(events.filter(event => event.typeId === "SourceVersionObserved")).toHaveLength(2);
    expect(transactions).toBe(1);
  });
});

function bytesFor(blobs: ReadonlyMap<string, Uint8Array>, hash: ContentHash | undefined): Uint8Array {
  const bytes = hash ? blobs.get(String(hash)) : undefined;
  if (!bytes) throw new Error(`fixture blob missing: ${String(hash)}`);
  return bytes;
}

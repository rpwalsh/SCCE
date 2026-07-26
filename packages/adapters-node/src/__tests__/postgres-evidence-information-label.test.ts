import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceId, SourceVersion, SourceVersionId } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres evidence informationLabel round-trip (plan item 16)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "returns informationLabel from getEvidence, getEvidenceBatch, searchEvidence, and sourceVersionsForEvidence",
    async () => {
      const informationAccess = {
        tenantId: "scce.local",
        principalId: "scce.local.owner",
        compartments: ["scce.cognitive"],
        maximumExportClass: "restricted" as const
      };
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema, informationAccess });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const sourceVersionId = `source-version:info-label:${suffix}` as SourceVersionId;
      const sourceId = `source:info-label:${suffix}` as SourceId;
      const bytes = Buffer.from(`evidence information label fixture ${suffix}`, "utf8");
      const contentHash = await adapter.blobs.put(bytes, "text/plain");
      const informationLabel = {
        tenantId: "scce.local",
        principals: ["scce.local.owner"],
        compartments: ["scce.cognitive"],
        exportClass: "restricted" as const,
        mergePolicy: "isolated" as const
      };
      const source: SourceVersion = {
        sourceId,
        sourceVersionId,
        namespace: "fixture",
        canonicalUri: `fixture://info-label/${suffix}`,
        contentHash,
        mediaType: "text/plain",
        observedAt: Date.now(),
        byteLength: bytes.byteLength,
        sourceTrust: { identity: 0.9, integrity: 0.9, parserReliability: 0.9, directness: 0.9, authority: 0.9, freshness: 0.9, independenceGroup: "fixture", accessScope: "public", licenseStatus: "unknown" },
        metadata: {},
        informationLabel
      };
      const span: EvidenceSpan = {
        id: `evidence:info-label:${suffix}` as EvidenceId,
        sourceId,
        sourceVersionId,
        chunkId: `chunk:info-label:${suffix}` as EvidenceSpan["chunkId"],
        contentHash,
        mediaType: "text/plain",
        byteStart: 0,
        byteEnd: bytes.byteLength,
        charStart: 0,
        charEnd: bytes.byteLength,
        text: bytes.toString("utf8"),
        textPreview: bytes.toString("utf8"),
        languageHints: {},
        scriptHints: {},
        trustVector: { trust: 0.9 } as unknown as EvidenceSpan["trustVector"],
        provenance: {},
        features: [`sym:info-label-${suffix}`],
        status: "promoted",
        alpha: 0.9,
        observedAt: Date.now(),
        informationLabel
      };

      try {
        await adapter.evidence.putSourceVersion(source);
        await adapter.evidence.putEvidenceSpan(span);

        const single = await adapter.evidence.getEvidence(span.id);
        const batch = await adapter.evidence.getEvidenceBatch([span.id]);
        // The three searchEvidence SQL branches (anchor-posting, GIN
        // feature-hit, feature/source bounded) all map their rows through
        // the same rowToEvidence function this test's other two calls
        // exercise directly; querying by sourceVersionId here reliably
        // hits the feature/source bounded branch without needing to
        // contrive anchor-index-specific feature shapes for the others.
        const searched = await adapter.evidence.searchEvidence({ sourceVersionId, status: "any" });
        const versions = await adapter.evidence.sourceVersionsForEvidence([span.id]);

        expect(single?.informationLabel).toEqual(informationLabel);
        expect(batch[0]?.informationLabel).toEqual(informationLabel);
        expect(searched.find(row => String(row.span.id) === String(span.id))?.span.informationLabel).toEqual(informationLabel);
        expect(versions.find(v => String(v.sourceVersionId) === String(sourceVersionId))?.informationLabel).toEqual(informationLabel);
      } finally {
        await adapter.transaction(async () => {
          await adapter.query(`DELETE FROM ${adapter.table("evidence_spans")} WHERE id=$1`, [span.id]);
          await adapter.query(`DELETE FROM ${adapter.table("source_versions")} WHERE id=$1`, [source.sourceVersionId]);
          await adapter.query(
            `DELETE FROM ${adapter.table("sources")} WHERE id=$1 AND NOT EXISTS (
               SELECT 1 FROM ${adapter.table("source_versions")} WHERE source_id=$1
             )`,
            [source.sourceId]
          );
          await adapter.query(
            `DELETE FROM ${adapter.table("blobs")} WHERE content_hash=$1
             AND NOT EXISTS (SELECT 1 FROM ${adapter.table("source_versions")} WHERE content_hash=$1)
             AND NOT EXISTS (SELECT 1 FROM ${adapter.table("evidence_spans")} WHERE content_hash=$1)`,
            [contentHash]
          );
        });
      }
    }
  );
});

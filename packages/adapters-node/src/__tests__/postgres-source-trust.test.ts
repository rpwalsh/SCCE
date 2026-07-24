import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceId, SourceTrust, SourceVersion, SourceVersionId } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres source trust vectors", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "writes and reloads every trust dimension on the hydrated PostgreSQL store",
    async () => {
      const adapter = createPostgresStorageAdapter({
        url: liveDatabaseUrl!,
        schema: liveSchema,
        informationAccess: {
          tenantId: "scce.local",
          principalId: "scce.local.owner",
          compartments: ["scce.cognitive"],
          maximumExportClass: "restricted"
        }
      });
      adapters.push(adapter);
      const suffix = randomUUID();
      const bytes = Buffer.from(`source trust live fixture ${suffix}`, "utf8");
      const contentHash = await adapter.blobs.put(bytes, "text/plain");
      const sourceTrust = fixtureTrust();
      const source = fixtureSource(sourceTrust, contentHash, suffix, bytes.byteLength);

      try {
        await adapter.evidence.putSourceVersion(source);
        const rows = await adapter.query<{ trust_vector: SourceTrust }>(
          `SELECT trust_vector FROM ${adapter.table("source_versions")} WHERE id=$1`,
          [source.sourceVersionId]
        );
        const columns = await adapter.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema=$1 AND table_name='source_versions'
              AND column_name IN ('trust','trust_vector')
            ORDER BY column_name`,
          [liveSchema]
        );

        expect(rows[0]?.trust_vector).toEqual(sourceTrust);
        expect(columns.map(row => row.column_name)).toEqual(["trust_vector"]);
      } finally {
        await adapter.transaction(async () => {
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

function fixtureTrust(): SourceTrust {
  return {
    identity: 0.91,
    integrity: 0.99,
    parserReliability: 0.87,
    directness: 0.78,
    authority: 0.66,
    freshness: 0.73,
    independenceGroup: "fixture:independent-source",
    accessScope: "owner_private",
    licenseStatus: "owner_authorized"
  };
}

function fixtureSource(
  sourceTrust: SourceTrust,
  contentHash: SourceVersion["contentHash"],
  suffix: string,
  byteLength: number
): SourceVersion {
  return {
    sourceId: `source.live.${suffix}` as SourceId,
    sourceVersionId: `source-version.live.${suffix}` as SourceVersionId,
    namespace: "live-source-trust-test",
    canonicalUri: `fixture://source/${suffix}`,
    contentHash,
    mediaType: "text/plain",
    observedAt: Date.now(),
    byteLength,
    sourceTrust,
    metadata: { fixture: true },
    informationLabel: {
      tenantId: "scce.local",
      principals: ["scce.local.owner"],
      compartments: ["scce.cognitive"],
      exportClass: "internal",
      mergePolicy: "same_owner"
    }
  };
}

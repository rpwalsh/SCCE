// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  EvidenceSpan,
  GraphNode,
  InformationAccessContext,
  InformationLabel,
  SourceVersion
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();

describe("live PostgreSQL graph evidence associations", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "migrates legacy arrays, rejects stale markers, cold-restores pages, and propagates dependency labels",
    async () => {
      const schema = disposableSchema();
      const access = informationAccess(["sealed"], "confidential");
      const publicLabel = informationLabel([], "public");
      const sealedLabel = informationLabel(["sealed"], "confidential");
      let writer: PostgresStorageAdapter | undefined = createPostgresStorageAdapter({
        url: liveDatabaseUrl!,
        schema,
        informationAccess: access
      });
      let reader: PostgresStorageAdapter | undefined;
      let publicReader: PostgresStorageAdapter | undefined;

      try {
        await writer.migrate();
        const freshMarker = await graphEvidenceGenerationMarker(writer);
        expect(freshMarker).toBe("scce.graph_evidence_association_generation.v2");

        const legacyFixture = await putEvidenceFixture(writer, {
          key: "legacy",
          sourceFamily: "family.graph-evidence-live.legacy",
          label: publicLabel
        });
        await writer.evidence.putEvidenceSpan({ ...legacyFixture.first, informationLabel: sealedLabel });
        const legacyNode = graphNode("legacy", [legacyFixture.first.id], publicLabel);
        await insertLegacyNode(writer, legacyNode);

        await writer.query(
          `DELETE FROM ${writer.table("storage_meta")} WHERE key='graph_evidence_association_generation'`
        );
        const missingMarker = await writer.verify();
        expect(missingMarker.ok).toBe(false);
        expect(missingMarker.errors).toContain("missing graph evidence association label migration");

        await writer.query(
          `INSERT INTO ${writer.table("storage_meta")}(key,value_json,updated_at)
           VALUES('graph_evidence_association_generation',$1::jsonb,NOW())
           ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=NOW()`,
          [JSON.stringify({ schema: "scce.graph_evidence_association_generation.v1" })]
        );
        const oldMarker = await writer.verify();
        expect(oldMarker.ok).toBe(false);
        expect(oldMarker.errors).toContain("missing graph evidence association label migration");

        await writer.migrate();
        expect(await writer.verify()).toMatchObject({ ok: true, errors: [] });
        expect(await graphEvidenceGenerationMarker(writer)).toBe("scce.graph_evidence_association_generation.v2");
        const legacyRows = await writer.query<{
          evidence_ids: string[];
          information_label: InformationLabel;
          association_count: string;
        }>(
          `SELECT node.evidence_ids,node.information_label,
                  COUNT(association.evidence_id)::text AS association_count
           FROM ${writer.table("graph_nodes")} node
           LEFT JOIN ${writer.table("graph_evidence_associations")} association
             ON association.entity_kind='node' AND association.entity_id=node.id
           WHERE node.id=$1
           GROUP BY node.id`,
          [legacyNode.id]
        );
        expect(legacyRows).toEqual([{
          evidence_ids: [legacyFixture.first.id],
          information_label: sealedLabel,
          association_count: "1"
        }]);
        const legacySlice = await writer.graph.getSlice({
          seedNodeIds: [legacyNode.id],
          limitNodes: 4,
          limitEdges: 4
        });
        expect(legacySlice.nodes[0]).toMatchObject({
          id: legacyNode.id,
          evidenceIds: [legacyFixture.first.id],
          informationLabel: sealedLabel
        });

        const fixture = await putEvidenceFixture(writer, {
          key: "paging",
          sourceFamily: "family.graph-evidence-live.paging",
          label: publicLabel
        });
        const node = graphNode("paging", [fixture.second.id, fixture.first.id], publicLabel);
        await writer.graph.upsertNode(node);
        const sourceFixture = await putEvidenceFixture(writer, {
          key: "source-tightening",
          sourceFamily: "family.graph-evidence-live.source-tightening",
          label: publicLabel
        });
        const sourceNode = graphNode("source-tightening", [sourceFixture.first.id], publicLabel);
        await writer.graph.upsertNode(sourceNode);

        const storedParents = await writer.query<{ evidence_ids: string[]; information_label: InformationLabel }>(
          `SELECT evidence_ids,information_label FROM ${writer.table("graph_nodes")} WHERE id=$1`,
          [node.id]
        );
        expect(storedParents).toEqual([{ evidence_ids: [], information_label: publicLabel }]);
        const storedAssociations = await writer.query<{ association_order: string; evidence_id: string }>(
          `SELECT association_order::text AS association_order,evidence_id
           FROM ${writer.table("graph_evidence_associations")}
           WHERE entity_kind='node' AND entity_id=$1
           ORDER BY association_order`,
          [node.id]
        );
        expect(storedAssociations.map(row => row.evidence_id)).toEqual([
          fixture.second.id,
          fixture.first.id
        ]);
        expect(new Set(storedAssociations.map(row => row.association_order)).size).toBe(2);
        await expectAssociationReads(writer, node, fixture, storedAssociations[0]!.association_order);

        await writer.close();
        writer = undefined;
        reader = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema, informationAccess: access });
        await reader.init();
        await expectAssociationReads(reader, node, fixture, storedAssociations[0]!.association_order);

        await reader.evidence.putEvidenceSpan({
          ...fixture.second,
          informationLabel: sealedLabel
        });
        await reader.evidence.putSourceVersion({
          ...sourceFixture.source,
          informationLabel: sealedLabel
        });
        const tightenedParents = await reader.query<{ id: string; information_label: InformationLabel }>(
          `SELECT id,information_label FROM ${reader.table("graph_nodes")} WHERE id=ANY($1::text[]) ORDER BY id`,
          [[node.id, sourceNode.id]]
        );
        expect(tightenedParents).toEqual([
          { id: node.id, information_label: sealedLabel },
          { id: sourceNode.id, information_label: sealedLabel }
        ].sort((left, right) => left.id.localeCompare(right.id)));

        await reader.close();
        reader = undefined;
        publicReader = createPostgresStorageAdapter({
          url: liveDatabaseUrl!,
          schema,
          informationAccess: informationAccess([], "public")
        });
        await publicReader.init();
        const hiddenPage = await publicReader.graph.listEvidenceForOwner!({
          ownerKind: "node",
          ownerId: node.id,
          limit: 8,
          maxDecodedBytes: 4096
        });
        expect(hiddenPage.associations).toEqual([]);
        expect(hiddenPage.coverage).toMatchObject({ completeness: "complete", returnedCount: 0 });
        await expect(publicReader.graph.getEvidenceAssociationMembership!({
          ownerKind: "node",
          ownerId: node.id,
          evidenceId: fixture.second.id
        })).resolves.toMatchObject({ present: false, coverage: { completeness: "complete", returnedCount: 0 } });
        await expect(publicReader.graph.getSlice({
          seedNodeIds: [node.id, sourceNode.id],
          limitNodes: 4,
          limitEdges: 4
        })).resolves.toMatchObject({ nodes: [] });
      } finally {
        await publicReader?.close().catch(() => undefined);
        await reader?.close().catch(() => undefined);
        await writer?.close().catch(() => undefined);
        const cleanup = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema, informationAccess: access });
        try {
          await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await cleanup.close().catch(() => undefined);
        }
      }
    }
  );
});

async function expectAssociationReads(
  adapter: PostgresStorageAdapter,
  node: GraphNode,
  fixture: EvidenceFixture,
  firstAssociationOrder: string
): Promise<void> {
  const firstPage = await adapter.graph.listEvidenceForOwner!({
    ownerKind: "node",
    ownerId: node.id,
    limit: 1,
    maxDecodedBytes: 4096
  });
  expect(firstPage.associations).toHaveLength(1);
  expect(firstPage.associations[0]).toMatchObject({
    associationOrder: firstAssociationOrder,
    ownerKind: "node",
    ownerId: node.id,
    evidenceId: fixture.second.id,
    sourceVersionId: fixture.source.sourceVersionId,
    sourceFamily: fixture.sourceFamily
  });
  expect(firstPage.coverage).toMatchObject({
    completeness: "partial",
    returnedCount: 1,
    continuation: firstAssociationOrder
  });
  expect(firstPage.decodedBytes).toBeLessThanOrEqual(4096);

  const secondPage = await adapter.graph.listEvidenceForOwner!({
    ownerKind: "node",
    ownerId: node.id,
    afterAssociationOrder: firstPage.coverage.continuation,
    limit: 1,
    maxDecodedBytes: 4096
  });
  expect(secondPage.associations.map(association => association.evidenceId)).toEqual([fixture.first.id]);
  expect(secondPage.coverage).toMatchObject({ completeness: "complete", returnedCount: 1 });

  const reverse = await adapter.graph.listOwnersForEvidence!({
    ownerKind: "node",
    evidenceId: fixture.first.id,
    limit: 8,
    maxDecodedBytes: 4096
  });
  expect(reverse.associations).toHaveLength(1);
  expect(reverse.associations[0]).toMatchObject({ ownerKind: "node", ownerId: node.id });
  expect(reverse.coverage).toMatchObject({ completeness: "complete", returnedCount: 1 });

  await expect(adapter.graph.getEvidenceAssociationMembership!({
    ownerKind: "node",
    ownerId: node.id,
    evidenceId: fixture.first.id
  })).resolves.toMatchObject({
    present: true,
    coverage: { completeness: "complete", returnedCount: 1 }
  });

  const byOwner = await adapter.graph.getSlice({
    seedNodeIds: [node.id],
    limitNodes: 4,
    limitEdges: 4
  });
  expect(byOwner.nodes).toHaveLength(1);
  expect(byOwner.nodes[0]!.evidenceIds).toEqual([fixture.second.id, fixture.first.id]);
  const byEvidence = await adapter.graph.getSlice({
    evidenceIds: [fixture.first.id],
    evidenceBoundOnly: true,
    limitNodes: 4,
    limitEdges: 4
  });
  expect(byEvidence.nodes.map(candidate => candidate.id)).toEqual([node.id]);
}

interface EvidenceFixture {
  key: string;
  sourceFamily: string;
  source: SourceVersion;
  first: EvidenceSpan;
  second: EvidenceSpan;
}

async function putEvidenceFixture(
  storage: PostgresStorageAdapter,
  input: { key: string; sourceFamily: string; label: InformationLabel }
): Promise<EvidenceFixture> {
  const sourceText = "Alpha beta.";
  const sourceBytes = Buffer.from(sourceText, "utf8");
  const sourceContentHash = await storage.blobs.put(sourceBytes, "text/plain");
  const source: SourceVersion = {
    sourceId: `source:graph-evidence-live:${input.key}` as SourceVersion["sourceId"],
    sourceVersionId: `source-version:graph-evidence-live:${input.key}` as SourceVersion["sourceVersionId"],
    namespace: "fixture",
    canonicalUri: `fixture://graph-evidence-live/${input.key}`,
    contentHash: sourceContentHash,
    mediaType: "text/plain",
    observedAt: 1_700_000_000_000,
    byteLength: sourceBytes.byteLength,
    sourceTrust: {
      identity: 1,
      integrity: 1,
      parserReliability: 1,
      directness: 1,
      authority: 1,
      freshness: 1,
      independenceGroup: input.sourceFamily,
      accessScope: "owner_private",
      licenseStatus: "owner_authorized"
    },
    metadata: {},
    informationLabel: input.label
  };
  await storage.evidence.putSourceVersion(source);

  const first = await evidenceSpan(storage, source, input.key, "first", "Alpha", 0, 5, input.label);
  const second = await evidenceSpan(storage, source, input.key, "second", "beta", 6, 10, input.label);
  await storage.evidence.putEvidenceSpans!([first, second]);
  return { key: input.key, sourceFamily: input.sourceFamily, source, first, second };
}

async function evidenceSpan(
  storage: PostgresStorageAdapter,
  source: SourceVersion,
  fixtureKey: string,
  suffix: string,
  text: string,
  byteStart: number,
  byteEnd: number,
  label: InformationLabel
): Promise<EvidenceSpan> {
  const contentHash = await storage.blobs.put(Buffer.from(text, "utf8"), "text/plain");
  return {
    id: `evidence:graph-evidence-live:${fixtureKey}:${suffix}` as EvidenceSpan["id"],
    sourceId: source.sourceId,
    sourceVersionId: source.sourceVersionId,
    chunkId: `chunk:graph-evidence-live:${fixtureKey}:${suffix}` as EvidenceSpan["chunkId"],
    contentHash,
    mediaType: "text/plain",
    byteStart,
    byteEnd,
    charStart: byteStart,
    charEnd: byteEnd,
    text,
    textPreview: text,
    languageHints: { language: "en" },
    scriptHints: { script: "Latn" },
    trustVector: { trust: 1 },
    provenance: { fixture: `graph-evidence-live:${fixtureKey}` },
    features: [`sym:${text.toLocaleLowerCase("en-US")}`],
    status: "promoted",
    alpha: 1,
    observedAt: 1_700_000_000_000,
    informationLabel: label
  };
}

function graphNode(
  key: string,
  evidenceIds: GraphNode["evidenceIds"],
  label: InformationLabel
): GraphNode {
  return {
    id: `node:graph-evidence-live:${key}` as GraphNode["id"],
    typeId: "dimension:graph-evidence-live" as GraphNode["typeId"],
    representation: { value: key },
    alpha: 1,
    evidenceIds,
    features: [`sym:graph-evidence-live:${key}`],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    metadata: {},
    informationLabel: label
  };
}

async function insertLegacyNode(storage: PostgresStorageAdapter, node: GraphNode): Promise<void> {
  await storage.query(
    `INSERT INTO ${storage.table("graph_nodes")}(
       id,type_id,representation_json,alpha,evidence_ids,features,
       created_at,updated_at,metadata_json,information_label
     ) VALUES(
       $1,$2,$3::jsonb,$4,$5::text[],$6::text[],
       TO_TIMESTAMP($7/1000.0),TO_TIMESTAMP($8/1000.0),$9::jsonb,$10::jsonb
     )`,
    [
      node.id,
      node.typeId,
      JSON.stringify(node.representation),
      node.alpha,
      node.evidenceIds,
      node.features,
      node.createdAt,
      node.updatedAt,
      JSON.stringify(node.metadata),
      JSON.stringify(node.informationLabel)
    ]
  );
}

async function graphEvidenceGenerationMarker(storage: PostgresStorageAdapter): Promise<string | undefined> {
  const rows = await storage.query<{ schema: string | null }>(
    `SELECT value_json->>'schema' AS schema
     FROM ${storage.table("storage_meta")}
     WHERE key='graph_evidence_association_generation'`
  );
  return rows[0]?.schema ?? undefined;
}

function informationAccess(
  compartments: string[],
  maximumExportClass: InformationAccessContext["maximumExportClass"]
): InformationAccessContext {
  return {
    tenantId: "fixture.graph-evidence-live",
    principalId: "fixture-owner",
    compartments,
    maximumExportClass
  };
}

function informationLabel(
  compartments: string[],
  exportClass: InformationLabel["exportClass"]
): InformationLabel {
  return {
    tenantId: "fixture.graph-evidence-live",
    principals: ["fixture-owner"],
    compartments,
    exportClass,
    mergePolicy: "same_owner"
  };
}

function disposableSchema(): string {
  const schema = `scce_graph_evidence_live_${randomUUID().replaceAll("-", "")}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new Error("invalid disposable PostgreSQL schema");
  return schema;
}

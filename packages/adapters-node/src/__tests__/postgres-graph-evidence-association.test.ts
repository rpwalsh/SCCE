// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceId, GraphEdge, GraphNode, Hyperedge, InformationAccessContext, SourceVersionId } from "@scce/kernel";
import { canonicalStringify, POSTGRES_REQUIRED_TABLES, POSTGRES_SCHEMA_VERSION } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { requiredHydrationColumns, schemaStatements } from "../postgres-schema.js";

const adapters: PostgresStorageAdapter[] = [];
const label = {
  tenantId: "fixture-tenant",
  principals: ["fixture-principal"],
  compartments: [],
  exportClass: "public" as const,
  mergePolicy: "same_owner" as const
};

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres graph evidence associations", () => {
  it("publishes schema 37 with one reverse membership key and ordered owner index", () => {
    expect(POSTGRES_SCHEMA_VERSION).toBe(37);
    expect(POSTGRES_REQUIRED_TABLES).toContain("graph_evidence_associations");
    expect(requiredHydrationColumns().graph_evidence_associations).toEqual([
      "association_order", "entity_kind", "entity_id", "evidence_id"
    ]);
    const statements = schemaStatements("fixture");
    const table = statements.find(sql => sql.includes(".graph_evidence_associations (") && sql.startsWith("CREATE TABLE"));
    const membershipMigration = statements.find(sql => sql.startsWith("DO $scce_graph_evidence_membership_index$"));
    const ownerOrder = statements.find(sql => sql.includes("graph_evidence_owner_order"));
    expect(table).toContain("association_order BIGINT GENERATED ALWAYS AS IDENTITY");
    expect(table).toContain("PRIMARY KEY(evidence_id,entity_kind,entity_id)");
    expect(membershipMigration).toContain("Referenced graph evidence membership primary key; refusing index migration");
    expect(ownerOrder).toContain("(entity_kind,entity_id,association_order,evidence_id)");
    expect(statements.some(sql => sql.startsWith("DO $scce_graph_evidence_associations$"))).toBe(false);
  });

  it("writes parent and first-seen associations atomically without growing-array unions", async () => {
    const { adapter, calls, depths } = fixture();
    await adapter.graph.upsertNode(node(["evidence:two", "evidence:one", "evidence:two"]));

    const parent = calls.find(call => call.sql.includes("INSERT INTO") && call.sql.includes("graph_nodes"));
    const associations = calls.find(call => call.sql.includes("INSERT INTO") && call.sql.includes("graph_evidence_associations"));
    expect(parent?.sql).toContain("ARRAY[]::text[]");
    expect(parent?.sql).not.toContain("n.evidence_ids || EXCLUDED.evidence_ids");
    expect(parent?.sql).not.toContain("EXCLUDED.evidence_ids <@ n.evidence_ids");
    expect(associations?.sql).toContain("WITH ORDINALITY");
    expect(associations?.sql).toContain("FROM ROWS FROM (");
    expect(associations?.sql).toContain("ORDER BY payload_ordinality,evidence_ordinality");
    expect(associations?.sql).toContain("ON CONFLICT(entity_kind,entity_id,evidence_id) DO NOTHING");
    expect(associations?.sql).toContain("UPDATE \"fixture\".\"graph_nodes\" parent");
    expect(depths.every(depth => depth === 1)).toBe(true);
  });

  it("joins existing evidence and source-version labels into every graph parent before publication", async () => {
    const { adapter, calls } = fixture({
      maximumExportClass: "confidential",
      compartments: ["sealed"]
    });
    const sourceVersionLabel = {
      ...label,
      compartments: ["sealed"],
      exportClass: "confidential" as const
    };
    const baseQuery = adapter.query.bind(adapter);
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM "fixture"."evidence_spans"') && sql.includes("FOR SHARE")) {
        await baseQuery(sql, params);
        return [{
          id: "evidence:one",
          information_label: label,
          source_information_label: sourceVersionLabel
        }] as T[];
      }
      return baseQuery<T>(sql, params);
    };

    await adapter.graph.upsertNode(node(["evidence:one"]));
    await adapter.graph.upsertEdge(graphEdge(["evidence:one"]));
    await adapter.graph.upsertHyperedge(hyperedge(["evidence:one"]));

    const parentCalls = calls.filter(call => call.sql.startsWith("INSERT INTO")
      && ["graph_nodes", "graph_edges", "graph_hyperedges"].some(table => call.sql.includes(table)));
    expect(parentCalls).toHaveLength(3);
    for (const call of parentCalls) {
      const payload = JSON.parse(String(call.params[0])) as Array<{ information_label: unknown }>;
      expect(payload[0]?.information_label).toEqual(sourceVersionLabel);
    }
    const labelReads = calls.filter(call => call.sql.includes('FROM "fixture"."evidence_spans"') && call.sql.includes("FOR SHARE"));
    expect(labelReads).toHaveLength(3);
    expect(labelReads.every(call => call.sql.includes("ORDER BY evidence.id"))).toBe(true);
  });

  it("rejects a disallowed evidence-label merge before parent or association publication", async () => {
    const { adapter, calls } = fixture();
    const baseQuery = adapter.query.bind(adapter);
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM "fixture"."evidence_spans"') && sql.includes("FOR SHARE")) {
        await baseQuery(sql, params);
        return [{
          id: "evidence:one",
          information_label: { ...label, tenantId: "foreign-tenant" },
          source_information_label: label
        }] as T[];
      }
      return baseQuery<T>(sql, params);
    };

    await expect(adapter.graph.upsertNode(node(["evidence:one"]))).rejects.toThrow("cross-tenant information merge denied");
    expect(calls.some(call => call.sql.startsWith('INSERT INTO "fixture"."graph_nodes"'))).toBe(false);
    expect(calls.some(call => call.sql.includes("INSERT INTO") && call.sql.includes("graph_evidence_associations"))).toBe(false);
  });

  it("rejects missing evidence before publishing a dangling association", async () => {
    const { adapter, calls } = fixture();
    const baseQuery = adapter.query.bind(adapter);
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes('FROM "fixture"."evidence_spans"') && sql.includes("FOR SHARE")) {
        await baseQuery(sql, params);
        return [];
      }
      return baseQuery<T>(sql, params);
    };

    await expect(adapter.graph.upsertNode(node(["evidence:missing"])))
      .rejects.toThrow("graph evidence association requires every evidence record to exist");
    expect(calls.some(call => call.sql.startsWith('INSERT INTO "fixture"."graph_nodes"'))).toBe(false);
  });

  it("keeps racing duplicates idempotent and increasing-contributor SQL delta-sized", async () => {
    const { adapter, calls } = fixture();
    await Promise.all([
      adapter.graph.upsertNode(node(["evidence:shared", "evidence:left"])),
      adapter.graph.upsertNode(node(["evidence:shared", "evidence:right"]))
    ]);
    for (let contributor = 0; contributor < 16; contributor += 1) {
      await adapter.graph.upsertNode(node([`evidence:contributor:${contributor}`]));
    }

    const associationCalls = calls.filter(call => call.sql.includes("INSERT INTO") && call.sql.includes("graph_evidence_associations"));
    const parentCalls = calls.filter(call => call.sql.startsWith('INSERT INTO "fixture"."graph_nodes" AS n'));
    expect(associationCalls).toHaveLength(18);
    expect(parentCalls).toHaveLength(18);
    expect(new Set(associationCalls.map(call => call.sql)).size).toBe(1);
    expect(new Set(parentCalls.map(call => call.sql)).size).toBe(1);
    expect(associationCalls.every(call => call.sql.includes("ON CONFLICT(entity_kind,entity_id,evidence_id) DO NOTHING"))).toBe(true);
    expect(schemaStatements("fixture").find(sql => sql.includes(".graph_evidence_associations (") && sql.startsWith("CREATE TABLE")))
      .toContain("PRIMARY KEY(evidence_id,entity_kind,entity_id)");
    const contributorPayloads = parentCalls.slice(2).map(call => JSON.parse(String(call.params[0])) as Array<{ evidence_ids_json: string[] }>);
    expect(contributorPayloads.every(payload => payload.length === 1 && payload[0]!.evidence_ids_json.length === 1)).toBe(true);
    expect(parentCalls.every(call => !call.sql.includes("evidence_ids ||"))).toBe(true);
  });

  it("fails the enclosing transaction when association publication fails", async () => {
    const { adapter, calls } = fixture();
    let rolledBack = false;
    let associationAttempted = false;
    adapter.transaction = async operation => {
      try {
        return await operation();
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    };
    const baseQuery = adapter.query.bind(adapter);
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes("INSERT INTO") && sql.includes("graph_evidence_associations")) {
        associationAttempted = true;
        throw new Error("injected association failure");
      }
      return baseQuery<T>(sql, params);
    };

    await expect(adapter.graph.upsertNode(node(["evidence:one"]))).rejects.toThrow("injected association failure");
    expect(calls.some(call => call.sql.includes("INSERT INTO") && call.sql.includes("graph_nodes"))).toBe(true);
    expect(associationAttempted).toBe(true);
    expect(rolledBack).toBe(true);
  });

  it("returns an access-scoped bounded owner page with explicit partial coverage", async () => {
    const { adapter, calls } = fixture();
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (!sql.includes("graph_evidence_associations")) return [];
      return [1, 2, 3].map(index => ({
        association_order: String(index),
        entity_kind: "node",
        entity_id: "node:one",
        evidence_id: `evidence:${index}`,
        source_version_id: `source-version:${index}`,
        source_family: `family:${index}`
      })) as T[];
    };

    const page = await adapter.graph.listEvidenceForOwner!({
      ownerKind: "node",
      ownerId: "node:one",
      limit: 2,
      maxDecodedBytes: 4096
    });

    expect(page.associations.map(item => item.evidenceId)).toEqual(["evidence:1", "evidence:2"]);
    expect(page.coverage).toEqual({
      schema: "scce.graph_evidence_association_coverage.v1",
      scope: "authorized_owner",
      completeness: "partial",
      returnedCount: 2,
      continuation: "2"
    });
    expect(page.decodedBytes).toBeLessThanOrEqual(4096);
    expect(page.decodedBytes).toBe(Buffer.byteLength(canonicalStringify(page), "utf8"));
    expect(calls[0]?.sql).toContain("owner_record.information_label");
    expect(calls[0]?.sql).toContain("evidence.information_label");
    expect(calls[0]?.sql).toContain("version.information_label");
    expect(calls[0]?.sql).toContain("ORDER BY association.association_order");
  });

  it("serves reverse membership from the evidence-first index and migrates evidence-bound selection", async () => {
    const { adapter, calls } = fixture();
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes("SELECT EXISTS(") && sql.includes("graph_evidence_associations")) {
        return [{ present: true }] as T[];
      }
      return [];
    };

    await expect(adapter.graph.getEvidenceAssociationMembership!({
      ownerKind: "node",
      ownerId: "node:one",
      evidenceId: "evidence:one" as EvidenceId
    })).resolves.toEqual({
      schema: "scce.graph_evidence_association_membership.v1",
      ownerKind: "node",
      ownerId: "node:one",
      evidenceId: "evidence:one",
      present: true,
      coverage: {
        schema: "scce.graph_evidence_association_coverage.v1",
        scope: "authorized_membership",
        completeness: "complete",
        returnedCount: 1
      }
    });
    await adapter.graph.getSlice({
      evidenceIds: ["evidence:one" as EvidenceId],
      evidenceBoundOnly: true,
      limitNodes: 8,
      limitEdges: 8
    });

    const membership = calls.find(call => call.sql.includes("SELECT EXISTS("));
    const nodeSelector = calls.find(call => call.sql.includes("evidence_candidates"));
    const edgeSelector = calls.find(call => call.sql.includes("graph_edges") && call.sql.includes("association.evidence_id=ANY"));
    expect(membership?.sql).toContain("association.evidence_id=$3");
    expect(membership?.sql).toContain("version.information_label");
    expect(nodeSelector?.sql).toContain("association.evidence_id=ANY($1::text[])");
    expect(nodeSelector?.sql).not.toContain("node.evidence_ids &&");
    expect(edgeSelector?.sql).toContain("association.entity_kind='edge'");
  });

  it("reconstructs public evidence order as legacy ordinality followed by first-seen associations", async () => {
    const { adapter, calls } = fixture();
    await adapter.graph.getSlice({ seedNodeIds: ["node:one" as never], limitNodes: 1, limitEdges: 1 });
    const query = calls.find(call => call.sql.includes("graph_nodes") && call.sql.includes("legacy.ordinality"));
    expect(query?.sql).toContain("0 AS lane,legacy.ordinality::bigint AS first_seen");
    expect(query?.sql).toContain("1 AS lane,association.association_order AS first_seen");
    expect(query?.sql).toContain("NOT association.evidence_id=ANY(node.evidence_ids)");
    expect(query?.sql).toContain("ORDER BY ordered.lane,ordered.first_seen");
  });
});

function node(evidenceIds: string[]): GraphNode {
  return {
    id: "node:one" as never,
    typeId: "concept" as never,
    representation: { value: "one" },
    alpha: 0.8,
    evidenceIds: evidenceIds as EvidenceId[],
    features: ["sym:one"],
    createdAt: 1,
    updatedAt: 2,
    metadata: {},
    informationLabel: label
  };
}

function graphEdge(evidenceIds: string[]): GraphEdge {
  return {
    id: "edge:one" as never,
    source: "node:one" as never,
    target: "node:two" as never,
    relationId: "relation:one" as never,
    alpha: 0.8,
    weight: 0.7,
    temporalScope: { status: "atemporal" },
    evidenceIds: evidenceIds as EvidenceId[],
    createdAt: 1,
    updatedAt: 2,
    metadata: {},
    informationLabel: label
  };
}

function hyperedge(evidenceIds: string[]): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge:one" as never,
    relationId: "relation:one" as never,
    participantPorts: [{
      portId: "subject",
      roleId: "role:subject",
      nodeId: "node:one" as never,
      valueKind: "entity",
      realization: "observed",
      evidenceIds: evidenceIds as EvidenceId[]
    }],
    memberNodeIds: ["node:one" as never],
    qualifiers: {},
    modality: {},
    evidenceIds: evidenceIds as EvidenceId[],
    weightVector: {},
    temporalScope: { validFrom: 1 },
    provenanceRefs: [],
    createdAt: 1,
    updatedAt: 2,
    informationLabel: label
  };
}

function fixture(accessOverrides: Partial<InformationAccessContext> = {}): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
  depths: number[];
} {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: {
      tenantId: "fixture-tenant",
      principalId: "fixture-principal",
      compartments: [],
      maximumExportClass: "public",
      ...accessOverrides
    }
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const depths: number[] = [];
  let depth = 0;
  adapter.transaction = async operation => {
    depth += 1;
    try {
      return await operation();
    } finally {
      depth -= 1;
    }
  };
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    depths.push(depth);
    if (sql.includes('FROM "fixture"."evidence_spans"') && sql.includes("FOR SHARE")) {
      return ((params[0] as string[] | undefined) ?? []).map(id => ({
        id,
        information_label: label,
        source_information_label: label
      })) as T[];
    }
    return [];
  };
  return { adapter, calls, depths };
}

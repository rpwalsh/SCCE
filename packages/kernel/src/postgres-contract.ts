import type { JsonValue } from "./types.js";
import { POSTGRES_REQUIRED_TABLES } from "./storage.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";

export type PostgresScalar =
  | "TEXT"
  | "BIGINT"
  | "INTEGER"
  | "DOUBLE PRECISION"
  | "BOOLEAN"
  | "BYTEA"
  | "TEXT[]"
  | "JSONB"
  | "TIMESTAMPTZ"
  | "VECTOR";

export interface PostgresColumnContract {
  name: string;
  scalar: PostgresScalar;
  nullable: boolean;
  primary?: boolean;
  unique?: boolean;
  references?: { table: string; column: string; onDelete: "CASCADE" | "RESTRICT" | "SET NULL" };
  dimensions?: number;
  encrypted?: boolean;
  description: string;
}

export interface PostgresIndexContract {
  name: string;
  table: string;
  columns: string[];
  method: "btree" | "gin" | "hnsw" | "ivfflat";
  where?: string;
  include?: string[];
  reason: string;
}

export interface PostgresTableContract {
  name: string;
  purpose: string;
  columns: PostgresColumnContract[];
  indexes: PostgresIndexContract[];
  partition?: { by: "RANGE" | "HASH"; column: string; cadence?: "monthly" | "yearly"; shards?: number };
  retention?: { archiveAfterDays?: number; deleteAfterDays?: number };
  expectedScale: { rows: number; bytesPerRow: number; hotReadRatio: number };
}

export interface PostgresTransactionContract {
  name: string;
  isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  reads: string[];
  writes: string[];
  maxRowsPerStatement: number;
  advisoryLock?: string;
  retry: { attempts: number; backoffMs: number; retrySqlStates: string[] };
}

export interface CorpusCapacityEstimate {
  corpusBytes: number;
  averageChunkBytes: number;
  chunkRows: number;
  evidenceRows: number;
  graphNodeRows: number;
  graphEdgeRows: number;
  eventRows: number;
  artifactRows: number;
  estimatedTableBytes: Record<string, number>;
  residentMemoryCeilingBytes: number;
  batchCount: number;
  notes: string[];
}

export interface PostgresContract {
  id: string;
  schema: string;
  extensions: string[];
  tables: PostgresTableContract[];
  indexes: PostgresIndexContract[];
  transactions: PostgresTransactionContract[];
  capacity: CorpusCapacityEstimate;
  invariants: string[];
  audit: JsonValue;
}

export function createPostgresContract(input: {
  schema?: string;
  corpusBytes?: number;
  averageChunkBytes?: number;
  vectorDimensions?: number;
  hotReadRatio?: number;
} = {}): PostgresContract {
  const schema = sanitizeIdentifier(input.schema ?? "scce");
  const vectorDimensions = Math.max(8, Math.min(4096, Math.floor(input.vectorDimensions ?? 64)));
  const corpusBytes = Math.max(0, input.corpusBytes ?? 100 * 1024 * 1024 * 1024);
  const averageChunkBytes = Math.max(512, input.averageChunkBytes ?? 48 * 1024);
  const hotReadRatio = clamp01(input.hotReadRatio ?? 0.08);
  const capacity = estimateCorpusCapacity({ corpusBytes, averageChunkBytes, hotReadRatio });
  const tables = tableContracts(vectorDimensions, capacity);
  const indexes = tables.flatMap(table => table.indexes);
  const transactions = transactionContracts();
  const invariants = [
    "scce.postgres.inv.001",
    "scce.postgres.inv.002",
    "scce.postgres.inv.003",
    "scce.postgres.inv.004",
    "scce.postgres.inv.005",
    "scce.postgres.inv.006",
    "scce.postgres.inv.007"
  ];
  const id = `postgres_contract_${createHasher().digestHex(JSON.stringify({ schema, vectorDimensions, corpusBytes, averageChunkBytes, tables: tables.map(t => t.name) })).slice(0, 32)}`;
  return {
    id,
    schema,
    extensions: ["vector"],
    tables,
    indexes,
    transactions,
    capacity,
    invariants,
    audit: toJsonValue({
      schema,
      vectorDimensions,
      corpusBytes,
      averageChunkBytes,
      hotReadRatio,
      tableCount: tables.length,
      indexCount: indexes.length,
      transactionCount: transactions.length,
      capacity
    })
  };
}

export function estimateCorpusCapacity(input: { corpusBytes: number; averageChunkBytes: number; hotReadRatio: number }): CorpusCapacityEstimate {
  const chunkRows = Math.max(1, Math.ceil(input.corpusBytes / input.averageChunkBytes));
  const evidenceRows = chunkRows;
  const graphNodeRows = Math.ceil(chunkRows * 1.8);
  const graphEdgeRows = Math.ceil(graphNodeRows * 5.5);
  const eventRows = Math.ceil(chunkRows * 0.35 + graphEdgeRows * 0.04);
  const artifactRows = Math.ceil(chunkRows * 0.03);
  const estimatedTableBytes = {
    source_versions: Math.ceil(input.corpusBytes * 0.02 + chunkRows * 512),
    evidence_spans: Math.ceil(input.corpusBytes * 1.18 + evidenceRows * 420),
    graph_nodes: Math.ceil(graphNodeRows * 1400),
    graph_edges: Math.ceil(graphEdgeRows * 620),
    events: Math.ceil(eventRows * 900),
    blobs: Math.ceil(artifactRows * input.averageChunkBytes * 0.5),
    semantic_proofs: Math.ceil(eventRows * 220),
    model_state: Math.ceil(Math.max(64 * 1024 * 1024, input.corpusBytes * 0.015))
  };
  const residentMemoryCeilingBytes = Math.ceil(Math.max(input.averageChunkBytes * 8, 64 * 1024 * 1024));
  const batchCount = Math.ceil(chunkRows / 2000);
  const notes = [
    `chunkRows=${chunkRows}`,
    `batchCount=${batchCount}`,
    `residentMemoryCeilingBytes=${residentMemoryCeilingBytes}`,
    `hotReadRatio=${input.hotReadRatio}`
  ];
  return { corpusBytes: input.corpusBytes, averageChunkBytes: input.averageChunkBytes, chunkRows, evidenceRows, graphNodeRows, graphEdgeRows, eventRows, artifactRows, estimatedTableBytes, residentMemoryCeilingBytes, batchCount, notes };
}

export function createBulkIngestBatches(input: {
  sourceVersionId: string;
  totalBytes: number;
  chunkBytes: number;
  maxRowsPerBatch?: number;
}): Array<{ batchId: string; byteStart: number; byteEnd: number; rowStart: number; rowEnd: number; rows: number }> {
  const chunkBytes = Math.max(512, input.chunkBytes);
  const totalRows = Math.max(1, Math.ceil(input.totalBytes / chunkBytes));
  const maxRows = Math.max(1, input.maxRowsPerBatch ?? 2000);
  const batches: Array<{ batchId: string; byteStart: number; byteEnd: number; rowStart: number; rowEnd: number; rows: number }> = [];
  const hasher = createHasher();
  for (let rowStart = 0; rowStart < totalRows; rowStart += maxRows) {
    const rowEnd = Math.min(totalRows, rowStart + maxRows);
    const byteStart = rowStart * chunkBytes;
    const byteEnd = Math.min(input.totalBytes, rowEnd * chunkBytes);
    batches.push({
      batchId: `bulk_${hasher.digestHex(`${input.sourceVersionId}:${rowStart}:${rowEnd}:${byteStart}:${byteEnd}`).slice(0, 24)}`,
      byteStart,
      byteEnd,
      rowStart,
      rowEnd,
      rows: rowEnd - rowStart
    });
  }
  return batches;
}

export function renderPostgresContractSql(contract: PostgresContract): string[] {
  const statements: string[] = [];
  statements.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(contract.schema)};`);
  for (const extension of contract.extensions) statements.push(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)};`);
  for (const table of contract.tables) {
    const columns = table.columns.map(column => `  ${quoteIdent(column.name)} ${columnSql(column)}${column.nullable ? "" : " NOT NULL"}${column.primary ? " PRIMARY KEY" : ""}${column.unique ? " UNIQUE" : ""}${column.references ? ` REFERENCES ${quoteIdent(contract.schema)}.${quoteIdent(column.references.table)}(${quoteIdent(column.references.column)}) ON DELETE ${column.references.onDelete}` : ""}`);
    statements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdent(contract.schema)}.${quoteIdent(table.name)} (\n${columns.join(",\n")}\n);`);
    if (table.partition) {
      statements.push(`COMMENT ON TABLE ${quoteIdent(contract.schema)}.${quoteIdent(table.name)} IS ${sqlString(`${table.purpose}; partition=${table.partition.by}:${table.partition.column}`)};`);
    }
  }
  for (const index of contract.indexes) {
    const method = index.method === "btree" ? "" : ` USING ${index.method}`;
    const include = index.include?.length ? ` INCLUDE (${index.include.map(quoteIdent).join(", ")})` : "";
    const where = index.where ? ` WHERE ${index.where}` : "";
    statements.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(index.name)} ON ${quoteIdent(contract.schema)}.${quoteIdent(index.table)}${method} (${index.columns.map(indexColumnSql).join(", ")})${include}${where};`);
  }
  return statements;
}

export function verifyPostgresContract(contract: PostgresContract): Array<{ id: string; passed: boolean; message: string }> {
  const tableNames = new Set(contract.tables.map(table => table.name));
  const results: Array<{ id: string; passed: boolean; message: string }> = [];
  const missingRequired = POSTGRES_REQUIRED_TABLES.filter(table => !tableNames.has(table));
  results.push({ id: "required-table-set", passed: missingRequired.length === 0, message: missingRequired.length ? `missing required tables: ${missingRequired.join(", ")}` : "all required PostgreSQL tables are in the contract" });
  for (const table of contract.tables) {
    const primary = table.columns.filter(column => column.primary);
    results.push({ id: `primary:${table.name}`, passed: primary.length === 1, message: `${table.name} has one primary key` });
    for (const column of table.columns) {
      if (column.references) results.push({ id: `reference:${table.name}.${column.name}`, passed: tableNames.has(column.references.table), message: `${table.name}.${column.name} references existing table ${column.references.table}` });
      if (column.scalar === "VECTOR") results.push({ id: `vector:${table.name}.${column.name}`, passed: Boolean(column.dimensions && column.dimensions > 0), message: `${table.name}.${column.name} declares vector dimensions` });
    }
  }
  for (const index of contract.indexes) {
    results.push({ id: `index-table:${index.name}`, passed: tableNames.has(index.table), message: `${index.name} indexes existing table ${index.table}` });
  }
  results.push({ id: "durability-engine", passed: contract.extensions.includes("vector"), message: "required PostgreSQL extension pgvector/vector is declared" });
  results.push({ id: "capacity-residency", passed: contract.capacity.residentMemoryCeilingBytes < contract.capacity.corpusBytes || contract.capacity.corpusBytes < 1024 * 1024, message: "capacity plan keeps resident memory bounded below corpus size" });
  return results;
}

function tableContracts(vectorDimensions: number, capacity: CorpusCapacityEstimate): PostgresTableContract[] {
  const table = (name: string, purpose: string, columns: PostgresColumnContract[], indexes: PostgresIndexContract[], rows: number, bytesPerRow: number, hotReadRatio = 0.1, partition?: PostgresTableContract["partition"]): PostgresTableContract => ({
    name,
    purpose,
    columns,
    indexes,
    partition,
    expectedScale: { rows, bytesPerRow, hotReadRatio }
  });
  const col = (name: string, scalar: PostgresScalar, nullable: boolean, description: string, extra: Partial<PostgresColumnContract> = {}): PostgresColumnContract => ({ name, scalar, nullable, description, ...extra });
  const idx = (name: string, tableName: string, columns: string[], method: PostgresIndexContract["method"], reason: string, extra: Partial<PostgresIndexContract> = {}): PostgresIndexContract => ({ name, table: tableName, columns, method, reason, ...extra });
  const core = [
    table("events", "append-only episode ledger", [
      col("id", "TEXT", false, "event id", { primary: true }),
      col("episode_id", "TEXT", false, "episode id"),
      col("type_id", "TEXT", false, "event type"),
      col("t", "BIGINT", false, "millisecond timestamp"),
      col("payload_json", "JSONB", false, "canonical event payload"),
      col("parents", "TEXT[]", false, "parent event ids"),
      col("hash", "TEXT", false, "event hash", { unique: true }),
      col("ledger_hash", "TEXT", false, "hash-chain ledger head"),
      col("created_at", "TIMESTAMPTZ", false, "created timestamp")
    ], [
      idx("events_episode_t_idx", "events", ["episode_id", "t"], "btree", "episode replay"),
      idx("events_type_t_idx", "events", ["type_id", "t"], "btree", "event inspection")
    ], capacity.eventRows, 900, 0.2, { by: "RANGE", column: "t", cadence: "monthly" }),
    table("source_versions", "versioned durable source identity", [
      col("source_version_id", "TEXT", false, "source version id", { primary: true }),
      col("source_id", "TEXT", false, "source id"),
      col("namespace", "TEXT", false, "source namespace"),
      col("canonical_uri", "TEXT", false, "canonical uri"),
      col("content_hash", "TEXT", false, "content hash"),
      col("media_type", "TEXT", false, "media type"),
      col("observed_at", "BIGINT", false, "observed timestamp"),
      col("byte_length", "BIGINT", false, "byte length"),
      col("trust", "DOUBLE PRECISION", false, "source trust"),
      col("metadata", "JSONB", false, "metadata")
    ], [
      idx("source_versions_source_idx", "source_versions", ["source_id", "observed_at"], "btree", "source history"),
      idx("source_versions_hash_idx", "source_versions", ["content_hash"], "btree", "dedupe")
    ], Math.ceil(capacity.chunkRows / 128), 1200, 0.12),
    table("evidence_spans", "bounded evidence spans and previews", [
      col("id", "TEXT", false, "evidence id", { primary: true }),
      col("source_id", "TEXT", false, "source id"),
      col("source_version_id", "TEXT", false, "source version id", { references: { table: "source_versions", column: "source_version_id", onDelete: "CASCADE" } }),
      col("chunk_id", "TEXT", false, "chunk id"),
      col("content_hash", "TEXT", false, "span content hash"),
      col("media_type", "TEXT", false, "span media type"),
      col("byte_start", "BIGINT", false, "byte start"),
      col("byte_end", "BIGINT", false, "byte end"),
      col("char_start", "BIGINT", false, "char start"),
      col("char_end", "BIGINT", false, "char end"),
      col("text", "TEXT", false, "bounded extracted text", { encrypted: true }),
      col("text_preview", "TEXT", false, "safe preview"),
      col("features", "JSONB", false, "feature list"),
      col("status", "TEXT", false, "quarantine or promoted"),
      col("alpha", "DOUBLE PRECISION", false, "initial alpha mass"),
      col("observed_at", "BIGINT", false, "observed timestamp")
    ], [
      idx("evidence_source_span_idx", "evidence_spans", ["source_version_id", "byte_start"], "btree", "source ordered extraction"),
      idx("evidence_features_idx", "evidence_spans", ["features"], "gin", "feature retrieval"),
      idx("evidence_status_alpha_idx", "evidence_spans", ["status", "alpha"], "btree", "promotion and alpha scans")
    ], capacity.evidenceRows, Math.ceil((capacity.estimatedTableBytes.evidence_spans ?? capacity.evidenceRows * 1800) / Math.max(1, capacity.evidenceRows)), 0.12, { by: "HASH", column: "source_version_id", shards: 32 }),
    table("graph_nodes", "semantic graph nodes", [
      col("id", "TEXT", false, "node id", { primary: true }),
      col("type_id", "TEXT", false, "dimension id"),
      col("representation_json", "JSONB", false, "node representation"),
      col("alpha", "DOUBLE PRECISION", false, "alpha value"),
      col("evidence_ids", "TEXT[]", false, "evidence references"),
      col("features", "TEXT[]", false, "features"),
      col("created_at", "TIMESTAMPTZ", false, "created timestamp"),
      col("updated_at", "TIMESTAMPTZ", false, "updated timestamp"),
      col("metadata_json", "JSONB", false, "metadata")
    ], [
      idx("graph_nodes_type_alpha_idx", "graph_nodes", ["type_id", "alpha"], "btree", "typed alpha scan"),
      idx("graph_nodes_features_idx", "graph_nodes", ["features"], "gin", "feature match")
    ], capacity.graphNodeRows, 1400, 0.18),
    table("graph_edges", "semantic graph edges", [
      col("id", "TEXT", false, "edge id", { primary: true }),
      col("source", "TEXT", false, "source node"),
      col("target", "TEXT", false, "target node"),
      col("relation_id", "TEXT", false, "relation"),
      col("alpha", "DOUBLE PRECISION", false, "alpha mass"),
      col("weight", "DOUBLE PRECISION", false, "edge weight"),
      col("valid_from", "BIGINT", false, "valid from"),
      col("valid_to", "BIGINT", true, "valid to"),
      col("evidence_ids", "JSONB", false, "evidence ids"),
      col("metadata", "JSONB", false, "metadata")
    ], [
      idx("graph_edges_source_idx", "graph_edges", ["source", "relation_id"], "btree", "outgoing traversal"),
      idx("graph_edges_target_idx", "graph_edges", ["target", "relation_id"], "btree", "incoming traversal"),
      idx("graph_edges_alpha_idx", "graph_edges", ["alpha"], "btree", "alpha threshold scan")
    ], capacity.graphEdgeRows, 620, 0.16, { by: "HASH", column: "source", shards: 64 }),
    table("semantic_proofs", "proof graph and entailment results", [
      col("id", "TEXT", false, "proof id", { primary: true }),
      col("claim_id", "TEXT", false, "claim id"),
      col("verdict", "TEXT", false, "verdict"),
      col("confidence", "JSONB", false, "confidence vector"),
      col("proof_graph", "JSONB", false, "proof graph"),
      col("evidence_ids", "JSONB", false, "evidence ids"),
      col("validator_version", "TEXT", false, "validator version"),
      col("created_at", "BIGINT", false, "created timestamp")
    ], [
      idx("semantic_proofs_claim_idx", "semantic_proofs", ["claim_id", "created_at"], "btree", "claim history"),
      idx("semantic_proofs_verdict_idx", "semantic_proofs", ["verdict", "created_at"], "btree", "proof inspection")
    ], capacity.eventRows, 2400, 0.08),
    table("construct_graphs", "construct graph payloads", [
      col("id", "TEXT", false, "construct id", { primary: true }),
      col("episode_id", "TEXT", false, "episode id"),
      col("force_vector", "JSONB", false, "force vector"),
      col("nodes", "JSONB", false, "construct nodes"),
      col("edges", "JSONB", false, "construct edges"),
      col("program", "JSONB", true, "program graph"),
      col("artifacts", "JSONB", false, "artifact refs")
    ], [
      idx("construct_graphs_episode_idx", "construct_graphs", ["episode_id"], "btree", "episode construct lookup")
    ], capacity.eventRows, 3600, 0.06),
    table("model_state", "compact model checkpoints and language state", [
      col("id", "TEXT", false, "model state id", { primary: true }),
      col("kind", "TEXT", false, "model kind"),
      col("payload", "JSONB", false, "model payload"),
      col("created_at", "BIGINT", false, "created timestamp"),
      col("active", "BOOLEAN", false, "active marker")
    ], [
      idx("model_state_kind_active_idx", "model_state", ["kind", "active", "created_at"], "btree", "active model lookup")
    ], 100000, 8192, 0.2)
  ];
  return completeRequiredTableContracts(core, { table, col, idx, capacity, vectorDimensions });
}

function completeRequiredTableContracts(
  core: PostgresTableContract[],
  helpers: {
    table: (name: string, purpose: string, columns: PostgresColumnContract[], indexes: PostgresIndexContract[], rows: number, bytesPerRow: number, hotReadRatio?: number, partition?: PostgresTableContract["partition"]) => PostgresTableContract;
    col: (name: string, scalar: PostgresScalar, nullable: boolean, description: string, extra?: Partial<PostgresColumnContract>) => PostgresColumnContract;
    idx: (name: string, tableName: string, columns: string[], method: PostgresIndexContract["method"], reason: string, extra?: Partial<PostgresIndexContract>) => PostgresIndexContract;
    capacity: CorpusCapacityEstimate;
    vectorDimensions: number;
  }
): PostgresTableContract[] {
  const byName = new Map(core.map(table => [table.name, table]));
  for (const required of POSTGRES_REQUIRED_TABLES) {
    const existing = byName.get(required);
    if (existing) continue;
    byName.set(required, auxiliaryTableContract(required, helpers));
  }
  return POSTGRES_REQUIRED_TABLES.map(name => byName.get(name)!).filter(Boolean);
}

function auxiliaryTableContract(
  name: string,
  helpers: {
    table: (name: string, purpose: string, columns: PostgresColumnContract[], indexes: PostgresIndexContract[], rows: number, bytesPerRow: number, hotReadRatio?: number, partition?: PostgresTableContract["partition"]) => PostgresTableContract;
    col: (name: string, scalar: PostgresScalar, nullable: boolean, description: string, extra?: Partial<PostgresColumnContract>) => PostgresColumnContract;
    idx: (name: string, tableName: string, columns: string[], method: PostgresIndexContract["method"], reason: string, extra?: Partial<PostgresIndexContract>) => PostgresIndexContract;
    capacity: CorpusCapacityEstimate;
    vectorDimensions: number;
  }
): PostgresTableContract {
  const { table, col, idx, capacity } = helpers;
  const jsonPayload = (purpose: string, rows = capacity.eventRows, bytes = 1600) => table(name, purpose, [
    col("id", "TEXT", false, "record id", { primary: true }),
    col("episode_id", "TEXT", true, "episode id"),
    col("payload", "JSONB", false, "canonical payload"),
    col("created_at", "BIGINT", false, "created timestamp"),
    col("updated_at", "BIGINT", true, "updated timestamp")
  ], [
    idx(`${name}_episode_idx`, name, ["episode_id", "created_at"], "btree", "episode inspection")
  ], rows, bytes, 0.06);
  switch (name) {
    case "storage_meta":
      return table(name, "schema version and storage metadata", [
        col("key", "TEXT", false, "metadata key", { primary: true }),
        col("value_json", "JSONB", false, "metadata value"),
        col("updated_at", "TIMESTAMPTZ", false, "updated timestamp")
      ], [], 128, 512, 0.8);
    case "sources":
      return table(name, "canonical source identities", [
        col("id", "TEXT", false, "source id", { primary: true }),
        col("namespace", "TEXT", false, "source namespace"),
        col("canonical_uri", "TEXT", false, "canonical uri"),
        col("first_seen_at", "TIMESTAMPTZ", false, "first seen timestamp"),
        col("last_seen_at", "TIMESTAMPTZ", false, "last seen timestamp")
      ], [
        idx("sources_uri_idx", name, ["namespace", "canonical_uri"], "btree", "source lookup")
      ], Math.ceil(capacity.chunkRows / 128), 800, 0.12);
    case "blobs":
      return table(name, "content-addressed source and artifact bytes", [
        col("content_hash", "TEXT", false, "content hash", { primary: true }),
        col("media_type", "TEXT", false, "media type"),
        col("byte_length", "BIGINT", false, "byte length"),
        col("content", "BYTEA", false, "encrypted or raw bytes", { encrypted: true }),
        col("created_at", "TIMESTAMPTZ", false, "created timestamp")
      ], [], capacity.chunkRows, capacity.averageChunkBytes, 0.04);
    case "ingestion_checkpoints":
      return jsonPayload("streaming ingestion checkpoints", capacity.chunkRows, 700);
    case "graph_hyperedges":
      return table(name, "higher arity graph relations", [
        col("id", "TEXT", false, "hyperedge id", { primary: true }),
        col("relation_id", "TEXT", false, "relation"),
        col("member_node_ids", "JSONB", false, "member nodes"),
        col("weight_vector", "JSONB", false, "alpha weights"),
        col("temporal_scope", "JSONB", false, "temporal scope"),
        col("provenance_refs", "JSONB", false, "source refs"),
        col("created_at", "BIGINT", false, "created timestamp"),
        col("updated_at", "BIGINT", false, "updated timestamp")
      ], [
        idx("graph_hyperedges_relation_idx", name, ["relation_id"], "btree", "relation lookup")
      ], Math.ceil(capacity.graphEdgeRows / 12), 900, 0.08);
    case "quarantine_sources":
      return table(name, "acquired source quarantine records", [
        col("id", "TEXT", false, "quarantine id", { primary: true }),
        col("source_id", "TEXT", false, "source id"),
        col("source_version_id", "TEXT", false, "source version id"),
        col("uri", "TEXT", false, "source uri"),
        col("content_hash", "TEXT", false, "content hash"),
        col("media_type", "TEXT", false, "media type"),
        col("fetched_at", "TIMESTAMPTZ", false, "fetched timestamp"),
        col("trust_vector", "JSONB", false, "trust vector"),
        col("permission_vector", "JSONB", false, "permission vector"),
        col("decision", "TEXT", false, "pending promoted rejected"),
        col("decision_json", "JSONB", true, "decision payload")
      ], [
        idx("quarantine_sources_decision_idx", name, ["decision", "fetched_at"], "btree", "promotion review")
      ], capacity.chunkRows, 1500, 0.08);
    case "validation_graphs":
    case "emission_graphs":
      return jsonPayload(`${name} payloads`, capacity.eventRows, 2200);
    case "program_builds":
      return jsonPayload("build and test execution records", capacity.eventRows, 2600);
    case "capability_calls":
      return table(name, "planned and executed capability calls", [
        col("id", "TEXT", false, "capability call id", { primary: true }),
        col("episode_id", "TEXT", false, "episode id"),
        col("capability_id", "TEXT", false, "capability id"),
        col("phase", "TEXT", false, "read prepare commit"),
        col("status", "TEXT", false, "planned invoked succeeded failed"),
        col("input_json", "JSONB", false, "input payload", { encrypted: true }),
        col("result_json", "JSONB", true, "result payload"),
        col("risk_vector", "JSONB", false, "risk vector"),
        col("permission_json", "JSONB", false, "permission vector"),
        col("created_at", "TIMESTAMPTZ", false, "created timestamp"),
        col("completed_at", "TIMESTAMPTZ", true, "completed timestamp")
      ], [
        idx("capability_calls_episode_idx", name, ["episode_id", "created_at"], "btree", "episode replay"),
        idx("capability_calls_status_idx", name, ["status", "phase"], "btree", "pending lookup")
      ], capacity.eventRows, 1800, 0.1);
    case "forecast_states":
    case "forecast_envelopes":
      return jsonPayload(`${name} temporal prediction records`, capacity.eventRows, 1800);
    case "learning_needs":
      return table(name, "field gaps, learning needs, and source plans", [
        col("id", "TEXT", false, "learning need id", { primary: true }),
        col("episode_id", "TEXT", true, "episode id"),
        col("goal", "TEXT", false, "learning goal"),
        col("gap_json", "JSONB", false, "field gap payload"),
        col("source_plan_json", "JSONB", false, "source plans"),
        col("status", "TEXT", false, "pending approved promoted rejected"),
        col("priority", "DOUBLE PRECISION", false, "priority"),
        col("created_at", "TIMESTAMPTZ", false, "created timestamp"),
        col("updated_at", "TIMESTAMPTZ", false, "updated timestamp")
      ], [
        idx("learning_needs_status_idx", name, ["status", "priority"], "btree", "learning plan review")
      ], capacity.eventRows, 2200, 0.12);
    case "ngram_observations":
    case "ngram_models":
    case "language_units":
    case "language_patterns":
    case "language_profiles":
    case "semantic_frames":
    case "translation_alignments":
      return jsonPayload(`${name} language memory records`, capacity.evidenceRows, 1600);
    case "ppf_cache":
    case "alpha_traces":
      return jsonPayload(`${name} inspectable flow cache`, capacity.eventRows, 1500);
    case "self_rewrite_episodes":
    case "self_rewrite_patches":
      return jsonPayload(`${name} self rewrite audit records`, capacity.eventRows, 2200);
    case "benchmark_runs":
    case "benchmark_cases":
      return jsonPayload(`${name} benchmark records`, capacity.eventRows, 1500);
    default:
      return jsonPayload(`${name} required storage table`, capacity.eventRows, 1600);
  }
}

function transactionContracts(): PostgresTransactionContract[] {
  return [
    tx("ingest_source_version", "READ COMMITTED", ["source_versions"], ["source_versions", "evidence_spans", "events"], 2000, "source_version_id", ["40001", "40P01"]),
    tx("build_graph_slice", "REPEATABLE READ", ["evidence_spans", "graph_nodes", "graph_edges"], ["graph_nodes", "graph_edges", "events"], 5000, "episode_id", ["40001", "40P01"]),
    tx("turn_episode", "REPEATABLE READ", ["graph_nodes", "graph_edges", "evidence_spans", "model_state"], ["semantic_proofs", "construct_graphs", "capability_calls", "learning_needs", "events"], 1000, "episode_id", ["40001", "40P01"]),
    tx("approve_capability", "SERIALIZABLE", ["capability_calls"], ["capability_calls", "events"], 100, "capability_call_id", ["40001", "40P01", "23505"]),
    tx("promote_language_model", "REPEATABLE READ", ["evidence_spans", "model_state"], ["model_state", "events"], 500, "model_kind", ["40001", "40P01"])
  ];
}

function tx(name: string, isolation: PostgresTransactionContract["isolation"], reads: string[], writes: string[], maxRowsPerStatement: number, advisoryLock: string, retrySqlStates: string[]): PostgresTransactionContract {
  return { name, isolation, reads, writes, maxRowsPerStatement, advisoryLock, retry: { attempts: 3, backoffMs: 50, retrySqlStates } };
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
  return cleaned || "scce";
}

function quoteIdent(value: string): string {
  return `"${sanitizeIdentifier(value).replace(/"/g, "\"\"")}"`;
}

function indexColumnSql(value: string): string {
  if (value.includes(" ")) return value;
  return quoteIdent(value);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function columnSql(column: PostgresColumnContract): string {
  if (column.scalar === "VECTOR") return `VECTOR(${column.dimensions ?? 64})`;
  return column.scalar;
}

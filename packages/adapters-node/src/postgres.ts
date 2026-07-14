import { Pool, type PoolClient } from "pg";
import {
  POSTGRES_REQUIRED_TABLES,
  POSTGRES_SCHEMA_VERSION,
  createAlphaLayer,
  featureSet,
  type AlphaTraceRecord,
  type AlphaTrace,
  type BenchmarkStore,
  type BrainImportLedgerRecord,
  type BrainImportStore,
  type BrainImportSummary,
  assertGenericBrainLifecycleTransition,
  type BrainLifecycleRecord,
  type BrainLifecycleState,
  type BlobStore,
  type CalibrationObservationRecord,
  type CapabilityAuditStore,
  type CapabilityPlan,
  type ConversationStore,
  type ConversationTurnRecord,
  type ConstructGraph,
  type ConstructStore,
  type ContentHash,
  type CorrectionMemoryStore,
  type CorrectionRuleRecord,
  type DialogueMemoryStore,
  type DialoguePolicyDecisionRecord,
  type EpisodeId,
  type EventLedger,
  type EventRangeQuery,
  type EvidenceId,
  type EvidenceQuery,
  type EvidenceSpan,
  type EvidenceStore,
  type ForecastState,
  type ForecastStore,
  type FlowCacheStore,
  type GraphEdge,
  type GraphNode,
  type GraphSliceQuery,
  type GraphStore,
  type Hyperedge,
  type IngestionCheckpoint,
  type IngestionCheckpointStore,
  type InteractionStateRecord,
  type JsonValue,
  type LanguageMemoryStore,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageUnitRecord,
  type LocaleBundleRecord,
  type LocalizationStore,
  type ModelState,
  type ModelStore,
  type NgramModelRecord,
  type NgramObservation,
  type PpfCacheRecord,
  type ProofId,
  type ProofStore,
  type QuarantineSource,
  type QuarantineStore,
  type ScceEvent,
  type ScceStorage,
  type SemanticProof,
  type SemanticFrameRecord,
  type SelfRewriteEpisodeRecord,
  type SelfRewritePatchRecord,
  type SelfRewriteStore,
  type StylePreferenceSnapshot,
  type ConversationOutcomeRecord,
  type WorkspaceIngestionStatus,
  type WorkspaceRecord,
  type WorkspaceReportRecord,
  type WorkspaceSourceFileRecord,
  type WorkspaceStore,
  type ResponseCandidateRecord,
  type SourceId,
  type SourceVersion,
  type SourceVersionId,
  type TargetProfilePatternRecord,
  type TemporalGraph,
  type TemporalGraphQuery,
  type TranslationAlignmentRecord,
  type UserCorrectionRecord
} from "@scce/kernel";
import { createHash } from "node:crypto";

export interface PostgresStorageOptions {
  url: string;
  schema: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export class PostgresStorageAdapter implements ScceStorage {
  readonly pool: Pool;
  readonly schema: string;
  readonly q: string;
  readonly url: string;
  readonly events: EventLedger;
  readonly conversation: ConversationStore;
  readonly ingestion: IngestionCheckpointStore;
  readonly graph: GraphStore;
  readonly evidence: EvidenceStore;
  readonly blobs: BlobStore;
  readonly quarantine: QuarantineStore;
  readonly proofs: ProofStore;
  readonly constructs: ConstructStore;
  readonly capabilities: CapabilityAuditStore;
  readonly forecasts: ForecastStore;
  readonly benchmarks: BenchmarkStore;
  readonly model: ModelStore;
  readonly languageMemory: LanguageMemoryStore;
  readonly brainImports: BrainImportStore;
  readonly corrections: CorrectionMemoryStore;
  readonly localization: LocalizationStore;
  readonly flowCache: FlowCacheStore;
  readonly selfRewrite: SelfRewriteStore;
  readonly workspace: WorkspaceStore;
  readonly dialogueMemory: DialogueMemoryStore;

  constructor(options: PostgresStorageOptions) {
    if (!/^postgres(?:ql)?:\/\//i.test(options.url)) throw new Error("SCCE v3 requires PostgreSQL; storage adapter received a non-Postgres URL.");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.schema)) throw new Error(`unsafe postgres schema: ${options.schema}`);
    this.schema = options.schema;
    this.q = `"${options.schema}"`;
    this.url = options.url;
    this.pool = new Pool({ connectionString: options.url, ssl: options.ssl });
    this.events = createEventLedger(this);
    this.conversation = createConversationStore(this);
    this.ingestion = createIngestionCheckpointStore(this);
    this.blobs = createBlobStore(this);
    this.evidence = createEvidenceStore(this);
    this.graph = createGraphStore(this);
    this.quarantine = createQuarantineStore(this);
    this.proofs = createProofStore(this);
    this.constructs = createConstructStore(this);
    this.capabilities = createCapabilityStore(this);
    this.forecasts = createForecastStore(this);
    this.benchmarks = createBenchmarkStore(this);
    this.model = createModelStore(this);
    this.languageMemory = createLanguageMemoryStore(this);
    this.brainImports = createBrainImportStore(this);
    this.corrections = createCorrectionMemoryStore(this);
    this.localization = createLocalizationStore(this);
    this.flowCache = createFlowCacheStore(this);
    this.selfRewrite = createSelfRewriteStore(this);
    this.workspace = createWorkspaceStore(this);
    this.dialogueMemory = createDialogueMemoryStore(this);
  }

  table(name: string): string {
    if (!POSTGRES_REQUIRED_TABLES.includes(name as never)) throw new Error(`unknown SCCE table: ${name}`);
    return `${this.q}."${name}"`;
  }

  async init(): Promise<void> {
    await this.migrate();
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of schemaStatements(this.q)) await client.query(statement);
      const schemaErrors = await requiredSchemaErrors(client, this.schema);
      if (schemaErrors.length) throw new Error(`schema migration incomplete: ${schemaErrors.slice(0, 12).join("; ")}`);
      await client.query(
        `INSERT INTO ${this.table("storage_meta")}(key, value_json, updated_at)
         VALUES('schema_version', $1::jsonb, NOW())
         ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=NOW()`,
        [JSON.stringify({ version: POSTGRES_SCHEMA_VERSION, requiredTables: POSTGRES_REQUIRED_TABLES })]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async verify(): Promise<{ ok: boolean; tables: string[]; errors: string[] }> {
    const rows = await this.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
      [this.schema]
    );
    const vector = await this.query<{ installed: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed`);
    const tables = rows.map(row => row.table_name);
    const missing = POSTGRES_REQUIRED_TABLES.filter(table => !tables.includes(table));
    const errors = missing.map(table => `missing table: ${table}`);
    const columns = await this.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1`,
      [this.schema]
    );
    const columnMap = new Map<string, Set<string>>();
    for (const row of columns) {
      let set = columnMap.get(row.table_name);
      if (!set) {
        set = new Set();
        columnMap.set(row.table_name, set);
      }
      set.add(row.column_name);
    }
    for (const [table, requiredColumns] of Object.entries(requiredHydrationColumns())) {
      const existing = columnMap.get(table) ?? new Set<string>();
      for (const column of requiredColumns) if (!existing.has(column)) errors.push(`missing column: ${table}.${column}`);
    }
    if (tables.includes("storage_meta")) {
      const version = await storedSchemaVersion(this).catch(() => undefined);
      if (version === undefined) errors.push("missing schema version");
      else if (version !== POSTGRES_SCHEMA_VERSION) errors.push(`schema version mismatch: expected ${POSTGRES_SCHEMA_VERSION}, found ${version}`);
    }
    if (!vector[0]?.installed) errors.push("missing extension: vector");
    return { ok: errors.length === 0, tables, errors };
  }

  async status(): Promise<JsonValue> {
    try {
      const verify = await this.verify();
      const meta = await this.query<{ value_json: JsonValue; updated_at: Date }>(
        `SELECT value_json, updated_at FROM ${this.table("storage_meta")} WHERE key='schema_version'`
      ).catch(() => []);
      const active = await this.brainImports.active().catch(() => ({ activeImportRunIds: [] }));
      const counts: Record<string, number> = {};
      for (const table of POSTGRES_REQUIRED_TABLES) {
        if (!verify.tables.includes(table)) continue;
        const rows = await this.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${this.table(table)}`).catch(() => []);
        counts[table] = Number(rows[0]?.count ?? 0);
      }
      const schemaVersion = meta[0]?.value_json && typeof meta[0].value_json === "object" && !Array.isArray(meta[0].value_json)
        ? (meta[0].value_json as Record<string, JsonValue>).version
        : undefined;
      return {
        ok: verify.ok,
        connected: true,
        database: { schema: this.schema, urlConfigured: true },
        schemaVersion: schemaVersion ?? null,
        expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
        tableCount: verify.tables.length,
        requiredTableCount: POSTGRES_REQUIRED_TABLES.length,
        tableCounts: counts,
        health: verify.ok ? "ready" : "needs_migration",
        activeBrain: active,
        errors: verify.errors
      };
    } catch (error) {
      return {
        ok: false,
        connected: false,
        database: { schema: this.schema, urlConfigured: true },
        schemaVersion: null,
        expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
        tableCounts: {},
        health: "unreachable",
        activeBrain: { activeImportRunIds: [] },
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  async stats(): Promise<JsonValue> {
    const rows = await this.query<{ relname: string; n_live_tup: string }>(
      `SELECT relname, n_live_tup::text FROM pg_stat_user_tables WHERE schemaname=$1 ORDER BY relname`,
      [this.schema]
    );
    return { tables: rows.map(row => ({ table: row.relname, rows: Number(row.n_live_tup) })) };
  }

  async resetLocalDevOnly(input: { confirmLocalDevOnly: boolean }): Promise<JsonValue> {
    if (!input.confirmLocalDevOnly) throw new Error("reset requires --confirm-local-dev-only");
    if (!isLocalDatabaseUrl(this.url)) throw new Error("reset refused: database host is not local");
    if (this.schema === "public") throw new Error("reset refused: schema public is not allowed");
    await this.query(`DROP SCHEMA IF EXISTS ${this.q} CASCADE`);
    await this.migrate();
    return { ok: true, reset: true, schema: this.schema, migrated: true };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresStorageAdapter(options: PostgresStorageOptions): PostgresStorageAdapter {
  return new PostgresStorageAdapter(options);
}

function schemaStatements(q: string): string[] {
  return [
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE SCHEMA IF NOT EXISTS ${q}`,
    `CREATE TABLE IF NOT EXISTS ${q}.storage_meta (key TEXT PRIMARY KEY, value_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.events (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, type_id TEXT NOT NULL, t BIGINT NOT NULL, payload_json JSONB NOT NULL, parents TEXT[] NOT NULL, hash TEXT NOT NULL UNIQUE, ledger_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.conversation_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, turn_index BIGINT NOT NULL, role_id TEXT NOT NULL, text TEXT NOT NULL, evidence_ids TEXT[] NOT NULL, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ingestion_checkpoints (id TEXT PRIMARY KEY, root_uri TEXT NOT NULL, item_uri TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, offset_bytes BIGINT NOT NULL, content_hash TEXT, byte_length BIGINT, reason TEXT, metadata_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.blobs (content_hash TEXT PRIMARY KEY, media_type TEXT NOT NULL, byte_length BIGINT NOT NULL, content BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.sources (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, canonical_uri TEXT NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.source_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ${q}.sources(id), content_hash TEXT NOT NULL REFERENCES ${q}.blobs(content_hash), media_type TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, byte_length BIGINT NOT NULL, trust DOUBLE PRECISION NOT NULL, metadata_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.evidence_spans (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ${q}.sources(id), source_version_id TEXT NOT NULL REFERENCES ${q}.source_versions(id), chunk_id TEXT NOT NULL, content_hash TEXT NOT NULL REFERENCES ${q}.blobs(content_hash), media_type TEXT NOT NULL, byte_start BIGINT NOT NULL, byte_end BIGINT NOT NULL, char_start BIGINT NOT NULL, char_end BIGINT NOT NULL, text_preview TEXT NOT NULL, text_content TEXT NOT NULL, language_hints JSONB NOT NULL, script_hints JSONB NOT NULL, trust_vector JSONB NOT NULL, provenance_json JSONB NOT NULL, features TEXT[] NOT NULL, status TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, observed_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_nodes (id TEXT PRIMARY KEY, type_id TEXT NOT NULL, representation_json JSONB NOT NULL, alpha DOUBLE PRECISION NOT NULL, evidence_ids TEXT[] NOT NULL, features TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_edges (id TEXT PRIMARY KEY, source_node_id TEXT NOT NULL, target_node_id TEXT NOT NULL, relation_id TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, weight DOUBLE PRECISION NOT NULL, temporal_scope JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.graph_hyperedges (id TEXT PRIMARY KEY, relation_id TEXT NOT NULL, member_node_ids TEXT[] NOT NULL, weight_vector JSONB NOT NULL, temporal_scope JSONB NOT NULL, provenance_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.quarantine_sources (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_version_id TEXT NOT NULL, uri TEXT NOT NULL, content_hash TEXT NOT NULL, media_type TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL, trust_vector JSONB NOT NULL, permission_vector JSONB NOT NULL, license_hint TEXT, decision TEXT NOT NULL, decision_json JSONB)`,
    `CREATE TABLE IF NOT EXISTS ${q}.semantic_proofs (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, verdict TEXT NOT NULL, confidence_json JSONB NOT NULL, proof_graph_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, transform_ids TEXT[] NOT NULL, scores_json JSONB NOT NULL, validator_version TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.construct_graphs (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, force_vector JSONB NOT NULL, graph_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.validation_graphs (id TEXT PRIMARY KEY, construct_id TEXT NOT NULL, graph_json JSONB NOT NULL, passed BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.emission_graphs (id TEXT PRIMARY KEY, construct_id TEXT NOT NULL, graph_json JSONB NOT NULL, output_refs JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.program_builds (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, construct_id TEXT NOT NULL, result_json JSONB NOT NULL, passed BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.capability_calls (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, capability_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, input_json JSONB NOT NULL, result_json JSONB, risk_vector JSONB NOT NULL, permission_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ)`,
    `CREATE TABLE IF NOT EXISTS ${q}.forecast_states (id TEXT PRIMARY KEY, episode_id TEXT, t BIGINT NOT NULL, state_vector DOUBLE PRECISION[] NOT NULL, alpha_surface_json JSONB NOT NULL, spectrum_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.forecast_envelopes (id TEXT PRIMARY KEY, source_state_id TEXT NOT NULL, horizon INT NOT NULL, mean_vector DOUBLE PRECISION[] NOT NULL, covariance_json JSONB NOT NULL, interval_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.learning_needs (id TEXT PRIMARY KEY, episode_id TEXT, goal TEXT NOT NULL, gap_json JSONB NOT NULL, source_plan_json JSONB NOT NULL, status TEXT NOT NULL, priority DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_profiles (id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL, profile_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ngram_observations (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, language_hint TEXT NOT NULL, order_n INT NOT NULL, history TEXT[] NOT NULL, symbol TEXT NOT NULL, count BIGINT NOT NULL, field_weight DOUBLE PRECISION NOT NULL, source_version_id TEXT, evidence_id TEXT, observed_at TIMESTAMPTZ NOT NULL, metadata_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ngram_models (id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, language_hint TEXT NOT NULL, max_order INT NOT NULL, discount DOUBLE PRECISION NOT NULL, model_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_units (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, source_version_id TEXT NOT NULL, script TEXT NOT NULL, unit_kind TEXT NOT NULL, unit_text TEXT NOT NULL, features TEXT[] NOT NULL, competence_vector DOUBLE PRECISION[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, evidence_ids TEXT[] NOT NULL, metadata_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.language_patterns (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, pattern_kind TEXT NOT NULL, support DOUBLE PRECISION NOT NULL, entropy DOUBLE PRECISION NOT NULL, pattern_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.semantic_frames (id TEXT PRIMARY KEY, frame_json JSONB NOT NULL, embedding VECTOR(64) NOT NULL, evidence_ids TEXT[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.translation_alignments (id TEXT PRIMARY KEY, source_frame_id TEXT NOT NULL, target_frame_id TEXT NOT NULL, source_language TEXT NOT NULL, target_language TEXT NOT NULL, force TEXT NOT NULL, loss_vector JSONB NOT NULL, alignment_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.scce2_import_ledger (id TEXT PRIMARY KEY, import_run_id TEXT NOT NULL, brain_version TEXT NOT NULL, root_path TEXT NOT NULL, section_id TEXT NOT NULL, section_kind TEXT NOT NULL, force_class TEXT NOT NULL, source_path TEXT, file_hash TEXT, shard_hash TEXT, source_version_id TEXT, evidence_ids TEXT[] NOT NULL, node_ids TEXT[] NOT NULL, row_counts_json JSONB NOT NULL, warnings TEXT[] NOT NULL, metadata_json JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL, UNIQUE(import_run_id, section_id))`,
    `CREATE TABLE IF NOT EXISTS ${q}.brain_import_lifecycle (import_run_id TEXT PRIMARY KEY, brain_version TEXT NOT NULL, root_path TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('CREATED','IMPORTING','VALIDATING','READY','ACTIVE','STOPPED','FAILED','QUARANTINED','INCOMPATIBLE')), manifest_json JSONB NOT NULL, validation_json JSONB, reason TEXT, revision BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `WITH legacy_runs AS (
       SELECT import_run_id,
              brain_version,
              root_path,
              MIN(imported_at) AS created_at,
              MAX(imported_at) AS updated_at,
              MAX(shard_hash) FILTER (WHERE shard_hash ~ '^[a-fA-F0-9]{64}$') AS manifest_hash,
              COUNT(DISTINCT section_id)::INT AS prior_section_count,
              SUM(COALESCE((row_counts_json->>'graph_nodes')::BIGINT,0)) AS graph_node_count,
              SUM(COALESCE((row_counts_json->>'language_units')::BIGINT,0) + COALESCE((row_counts_json->>'language_patterns')::BIGINT,0)) AS language_row_count,
              SUM(COALESCE((row_counts_json->>'ngram_models')::BIGINT,0)) AS ngram_state_count,
              BOOL_OR(force_class='direct_evidence') AS has_direct_evidence,
              BOOL_OR(force_class='learned_concept_prior') AS has_graph_priors,
              BOOL_OR(force_class='learned_language_prior') AS has_language_priors
       FROM ${q}.scce2_import_ledger
       GROUP BY import_run_id,brain_version,root_path
     ), selected AS (
       SELECT *
       FROM legacy_runs
       WHERE manifest_hash IS NOT NULL AND has_direct_evidence AND has_graph_priors AND has_language_priors
       ORDER BY updated_at DESC,import_run_id
       LIMIT 1
     )
     INSERT INTO ${q}.brain_import_lifecycle(import_run_id,brain_version,root_path,state,manifest_json,validation_json,reason,revision,created_at,updated_at)
     SELECT import_run_id,
            brain_version,
            root_path,
            'ACTIVE',
            jsonb_build_object(
              'schema','scce.brainManifestContract.v1',
              'importRunId',import_run_id,
              'brainVersion',brain_version,
              'rootPath',root_path,
              'manifestHash',manifest_hash,
              'sourceSchema','scce.legacyImportLedger.v1',
              'runtimeContractVersion',1,
              'content',jsonb_build_object(
                'graphShardCount',CASE WHEN graph_node_count>0 THEN 1 ELSE 0 END,
                'languageShardCount',CASE WHEN language_row_count>0 OR ngram_state_count>0 THEN 1 ELSE 0 END,
                'ngramStateCount',ngram_state_count,
                'priorSectionCount',prior_section_count
              ),
              'metadata',jsonb_build_object('migration','postgres.v12.legacy_lifecycle_backfill','sourceTable','scce2_import_ledger'),
              'createdAt',FLOOR(EXTRACT(EPOCH FROM created_at)*1000)
            ),
            jsonb_build_object(
              'schema','scce.brainValidationReport.v1',
              'importRunId',import_run_id,
              'brainVersion',brain_version,
              'manifestHash',manifest_hash,
              'validatorVersion','postgres.v12.legacy_lifecycle_backfill',
              'disposition','PASSED',
              'checks',jsonb_build_array(
                jsonb_build_object('id','legacy_ledger.manifest_hash','passed',true,'severity','error','message','legacy ledger retained a SHA-256 manifest identity'),
                jsonb_build_object('id','legacy_ledger.force_classes','passed',true,'severity','error','message','legacy ledger contains direct evidence, graph priors, and language priors')
              ),
              'validatedAt',FLOOR(EXTRACT(EPOCH FROM updated_at)*1000)
            ),
            'migration activated newest complete legacy ledger run',
            1,
            created_at,
            updated_at
     FROM selected
     WHERE NOT EXISTS (SELECT 1 FROM ${q}.brain_import_lifecycle)
     ON CONFLICT(import_run_id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS ${q}.correction_rules (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, rule_kind TEXT NOT NULL, scope TEXT NOT NULL, pattern TEXT NOT NULL, replacement TEXT, weight DOUBLE PRECISION NOT NULL, context_json JSONB NOT NULL, provenance_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.locale_bundles (id TEXT PRIMARY KEY, source_locale TEXT NOT NULL, target_language_id TEXT NOT NULL, target_script_id TEXT, status TEXT NOT NULL, force TEXT NOT NULL, messages_json JSONB NOT NULL, missing_terms_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, translation_alignment_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.ppf_cache (id TEXT PRIMARY KEY, graph_hash TEXT NOT NULL, beta DOUBLE PRECISION NOT NULL, personalization_json JSONB NOT NULL, mass_json JSONB NOT NULL, diagnostics_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.alpha_traces (id TEXT PRIMARY KEY, graph_hash TEXT NOT NULL, alpha DOUBLE PRECISION NOT NULL, trace_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.self_rewrite_episodes (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, target TEXT NOT NULL, program_graph_json JSONB NOT NULL, improvement_json JSONB NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.self_rewrite_patches (id TEXT PRIMARY KEY, rewrite_episode_id TEXT NOT NULL REFERENCES ${q}.self_rewrite_episodes(id), file_path TEXT NOT NULL, before_hash TEXT, after_hash TEXT NOT NULL, patch_json JSONB NOT NULL, score_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspaces (id TEXT PRIMARY KEY, root_path TEXT NOT NULL, root_uri TEXT NOT NULL, corpus_id TEXT NOT NULL, status TEXT NOT NULL, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspace_source_files (workspace_id TEXT NOT NULL REFERENCES ${q}.workspaces(id), corpus_id TEXT NOT NULL, path TEXT NOT NULL, absolute_path TEXT NOT NULL, media_type TEXT NOT NULL, content_hash TEXT, modified_time TIMESTAMPTZ NOT NULL, byte_length BIGINT NOT NULL, ingestion_status TEXT NOT NULL, import_batch_id TEXT, source_version_id TEXT, evidence_ids TEXT[] NOT NULL, symbol_ids TEXT[] NOT NULL, concept_ids TEXT[] NOT NULL, warnings TEXT[] NOT NULL, errors TEXT[] NOT NULL, metadata_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(workspace_id,path))`,
    `CREATE TABLE IF NOT EXISTS ${q}.workspace_reports (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES ${q}.workspaces(id), corpus_id TEXT NOT NULL, report_kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, data_json JSONB NOT NULL, source_refs_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.interaction_state_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, state_json JSONB NOT NULL, feature_refs TEXT[] NOT NULL, signal_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.dialogue_policy_decision_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, decision_json JSONB NOT NULL, selected_action_ids TEXT[] NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.conversation_outcome_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, answer_graph_hash TEXT, response_hash TEXT NOT NULL, accepted BOOLEAN, rejected BOOLEAN, corrected BOOLEAN, correction_text TEXT, requested_constraint_refs TEXT[] NOT NULL, satisfied_constraint_refs TEXT[] NOT NULL, failed_constraint_refs TEXT[] NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.user_correction_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, response_hash TEXT NOT NULL, correction_text TEXT NOT NULL, rejected_surface_hash TEXT, accepted_surface_hash TEXT, preference_delta_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.style_preference_snapshots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, profile_hash TEXT NOT NULL, profile_json JSONB NOT NULL, source_outcome_ids TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.response_candidate_records (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, candidate_id TEXT NOT NULL, policy_decision_id TEXT NOT NULL, answer_graph_hash TEXT, response_hash TEXT NOT NULL, response_text TEXT NOT NULL, critic_score DOUBLE PRECISION NOT NULL, score_trace_refs TEXT[] NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.target_profile_patterns (id TEXT PRIMARY KEY, target_profile_id TEXT NOT NULL, pattern_family_id TEXT NOT NULL, pattern_json JSONB NOT NULL, evidence_ids TEXT[] NOT NULL, alpha DOUBLE PRECISION NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.calibration_observations (id TEXT PRIMARY KEY, calibration_id TEXT NOT NULL, subsystem_id TEXT NOT NULL, task_class TEXT NOT NULL, raw_score DOUBLE PRECISION NOT NULL, outcome BOOLEAN NOT NULL, selected_output_hash TEXT, accepted BOOLEAN, rejected BOOLEAN, corrected BOOLEAN, unsupported_fact_hit BOOLEAN, citation_failure BOOLEAN, user_correction_distance DOUBLE PRECISION, final_outcome TEXT NOT NULL, source_trace_id TEXT, source_record_id TEXT, metadata_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.model_state (id TEXT PRIMARY KEY, model_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.benchmark_runs (id TEXT PRIMARY KEY, config_json JSONB NOT NULL, started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, summary_json JSONB)`,
    `CREATE TABLE IF NOT EXISTS ${q}.benchmark_cases (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, case_json JSONB NOT NULL, result_json JSONB NOT NULL, score_json JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_events_episode_t ON ${q}.events(episode_id,t)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_session_turn ON ${q}.conversation_turns(session_id, turn_index DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ingestion_root_status ON ${q}.ingestion_checkpoints(root_uri,status,updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_features ON ${q}.evidence_spans USING GIN(features)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source ON ${q}.evidence_spans(source_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_source_version ON ${q}.evidence_spans(source_version_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_status ON ${q}.evidence_spans(status)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_evidence_status_rank ON ${q}.evidence_spans(status, alpha DESC, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_features ON ${q}.graph_nodes USING GIN(features)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_evidence ON ${q}.graph_nodes USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_nodes_updated ON ${q}.graph_nodes(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_source ON ${q}.graph_edges(source_node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_target ON ${q}.graph_edges(target_node_id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_relation ON ${q}.graph_edges(relation_id)`,
    // Version 12 repairs pre-index duplicate ACTIVE rows deterministically. A
    // valid marker is selected; otherwise the most recently updated run is selected. The
    // partial unique index then makes the single-ACTIVE invariant durable.
    `WITH ranked_active AS (
       SELECT import_run_id,
              ROW_NUMBER() OVER (
                ORDER BY
                  CASE WHEN import_run_id=(
                    SELECT model_json->'activeImportRunIds'->>0
                    FROM ${q}.model_state
                    WHERE id='scce2.active_brain'
                  ) THEN 0 ELSE 1 END,
                  updated_at DESC,
                  import_run_id
              ) AS active_rank
       FROM ${q}.brain_import_lifecycle
       WHERE state='ACTIVE'
     )
     UPDATE ${q}.brain_import_lifecycle AS lifecycle
     SET state='READY', reason='migration repaired duplicate ACTIVE lifecycle row', revision=revision+1, updated_at=NOW()
     FROM ranked_active
     WHERE lifecycle.import_run_id=ranked_active.import_run_id AND ranked_active.active_rank>1`,
    `DELETE FROM ${q}.model_state
     WHERE id='scce2.active_brain'
       AND NOT EXISTS (SELECT 1 FROM ${q}.brain_import_lifecycle WHERE state='ACTIVE')`,
    `INSERT INTO ${q}.model_state(id,model_json,updated_at)
     SELECT 'scce2.active_brain',
            jsonb_build_object(
              'activeBrainVersion', brain_version,
              'activeImportRunIds', jsonb_build_array(import_run_id),
              'updatedAt', FLOOR(EXTRACT(EPOCH FROM updated_at)*1000)
            ),
            updated_at
     FROM ${q}.brain_import_lifecycle
     WHERE state='ACTIVE'
     ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_${clean(q)}_brain_lifecycle_single_active ON ${q}.brain_import_lifecycle(state) WHERE state='ACTIVE'`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_brain_lifecycle_state_updated ON ${q}.brain_import_lifecycle(state,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_source_rank ON ${q}.graph_edges(source_node_id, alpha DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_target_rank ON ${q}.graph_edges(target_node_id, alpha DESC, updated_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_edges_evidence ON ${q}.graph_edges USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_hyperedges_members ON ${q}.graph_hyperedges USING GIN(member_node_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_hyperedges_provenance ON ${q}.graph_hyperedges USING GIN(provenance_refs)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_proofs_evidence ON ${q}.semantic_proofs USING GIN(evidence_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_quarantine_decision ON ${q}.quarantine_sources(decision,fetched_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_learning_needs_status ON ${q}.learning_needs(status,priority DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_stream_order ON ${q}.ngram_observations(stream_id,language_hint,order_n,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_source_version_rank ON ${q}.ngram_observations(source_version_id,count DESC,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_profile_rank ON ${q}.ngram_observations((metadata_json->>'profileId'),count DESC,observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_source_system_rank ON ${q}.ngram_observations((metadata_json->>'sourceSystem'), count DESC, observed_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_version_updated ON ${q}.ngram_models((model_json->>'sourceVersionId'),updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_profile_updated ON ${q}.ngram_models((model_json->>'profileId'),updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ngram_model_source_system_updated ON ${q}.ngram_models((model_json->>'sourceSystem'), updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_profiles_created ON ${q}.language_profiles(created_at DESC,id ASC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_units_profile ON ${q}.language_units(profile_id,alpha DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_units_source_system_rank ON ${q}.language_units((metadata_json->>'sourceSystem'), alpha DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_patterns_source_system_rank ON ${q}.language_patterns((pattern_json->>'sourceSystem'), support DESC, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_language_patterns_profile_rank ON ${q}.language_patterns(profile_id,support DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_source_system_rank ON ${q}.semantic_frames((frame_json->>'sourceSystem'), alpha DESC, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_profile_rank ON ${q}.semantic_frames((frame_json->>'profileId'),alpha DESC,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_source_version_rank ON ${q}.semantic_frames((frame_json->>'sourceVersionId'),alpha DESC,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_semantic_frames_embedding ON ${q}.semantic_frames USING ivfflat (embedding vector_cosine_ops) WITH (lists = 64)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_translation_pair ON ${q}.translation_alignments(source_language,target_language,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_run ON ${q}.scce2_import_ledger(import_run_id,imported_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_force ON ${q}.scce2_import_ledger(force_class,imported_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_scce2_import_hash ON ${q}.scce2_import_ledger(section_kind,file_hash,shard_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_correction_scope_kind ON ${q}.correction_rules(scope,rule_kind,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_correction_weight ON ${q}.correction_rules(weight DESC,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_locale_bundles_target ON ${q}.locale_bundles(target_language_id,status,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_ppf_graph_hash ON ${q}.ppf_cache(graph_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_alpha_graph_hash ON ${q}.alpha_traces(graph_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_self_rewrite_status ON ${q}.self_rewrite_episodes(status,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspaces_updated ON ${q}.workspaces(updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_files_status ON ${q}.workspace_source_files(workspace_id,ingestion_status,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_files_hash ON ${q}.workspace_source_files(workspace_id,content_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_workspace_reports_kind ON ${q}.workspace_reports(workspace_id,report_kind,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_interaction_state_conversation ON ${q}.interaction_state_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_dialogue_policy_conversation ON ${q}.dialogue_policy_decision_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_outcome_conversation ON ${q}.conversation_outcome_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_conversation_outcome_prompt ON ${q}.conversation_outcome_records(prompt_hash,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_user_correction_conversation ON ${q}.user_correction_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_style_snapshot_conversation ON ${q}.style_preference_snapshots(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_response_candidate_conversation ON ${q}.response_candidate_records(conversation_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_target_profile_patterns_profile ON ${q}.target_profile_patterns(target_profile_id,pattern_family_id,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_id_time ON ${q}.calibration_observations(calibration_id,task_class,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_subsystem ON ${q}.calibration_observations(subsystem_id,created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${clean(q)}_calibration_observations_source_record ON ${q}.calibration_observations(source_record_id,created_at DESC)`
  ];
}

function clean(q: string): string {
  return q.replace(/[^A-Za-z0-9_]/g, "");
}

function requiredHydrationColumns(): Record<string, string[]> {
  return {
    storage_meta: ["key", "value_json", "updated_at"],
    events: ["id", "episode_id", "type_id", "payload_json", "ledger_hash"],
    conversation_turns: ["id", "session_id", "episode_id", "turn_index", "role_id", "text", "evidence_ids", "metadata_json"],
    blobs: ["content_hash", "media_type", "byte_length", "content"],
    sources: ["id", "namespace", "canonical_uri"],
    source_versions: ["id", "source_id", "content_hash", "media_type", "observed_at", "byte_length", "trust", "metadata_json"],
    evidence_spans: ["id", "source_id", "source_version_id", "content_hash", "byte_start", "byte_end", "text_content", "trust_vector", "provenance_json", "features", "status", "alpha"],
    graph_nodes: ["id", "type_id", "representation_json", "alpha", "evidence_ids", "features", "metadata_json"],
    graph_edges: ["id", "source_node_id", "target_node_id", "relation_id", "alpha", "weight", "evidence_ids", "metadata_json"],
    graph_hyperedges: ["id", "relation_id", "member_node_ids", "weight_vector", "provenance_refs"],
    semantic_proofs: ["id", "claim_id", "verdict", "proof_graph_json", "evidence_ids", "scores_json"],
    construct_graphs: ["id", "episode_id", "force_vector", "graph_json"],
    validation_graphs: ["id", "construct_id", "graph_json", "passed"],
    emission_graphs: ["id", "construct_id", "graph_json", "output_refs"],
    language_profiles: ["id", "source_version_id", "profile_json"],
    ngram_observations: ["id", "stream_id", "language_hint", "order_n", "history", "symbol", "count", "metadata_json"],
    ngram_models: ["id", "stream_id", "language_hint", "max_order", "discount", "model_json"],
    language_units: ["id", "profile_id", "source_version_id", "script", "unit_kind", "unit_text", "features", "competence_vector", "alpha", "evidence_ids", "metadata_json"],
    language_patterns: ["id", "profile_id", "pattern_kind", "support", "entropy", "pattern_json", "evidence_ids"],
    semantic_frames: ["id", "frame_json", "embedding", "evidence_ids", "alpha"],
    translation_alignments: ["id", "source_frame_id", "target_frame_id", "source_language", "target_language", "force", "alignment_json", "evidence_ids"],
    scce2_import_ledger: ["id", "import_run_id", "brain_version", "root_path", "section_id", "section_kind", "force_class", "row_counts_json", "warnings", "metadata_json"],
    brain_import_lifecycle: ["import_run_id", "brain_version", "root_path", "state", "manifest_json", "revision", "created_at", "updated_at"],
    correction_rules: ["id", "episode_id", "rule_kind", "scope", "pattern", "weight", "context_json", "provenance_json"],
    model_state: ["id", "model_json", "updated_at"],
    ppf_cache: ["id", "graph_hash", "personalization_json", "mass_json", "diagnostics_json"],
    alpha_traces: ["id", "graph_hash", "alpha", "trace_json"],
    workspaces: ["id", "root_path", "root_uri", "corpus_id", "status", "metadata_json"],
    workspace_source_files: ["workspace_id", "corpus_id", "path", "absolute_path", "media_type", "evidence_ids", "metadata_json"],
    workspace_reports: ["id", "workspace_id", "corpus_id", "report_kind", "body", "data_json", "source_refs_json"],
    interaction_state_records: ["id", "conversation_id", "turn_id", "state_json", "feature_refs", "signal_refs"],
    dialogue_policy_decision_records: ["id", "conversation_id", "turn_id", "decision_json", "selected_action_ids", "score_trace_refs"],
    conversation_outcome_records: ["id", "conversation_id", "turn_id", "prompt_hash", "response_hash", "requested_constraint_refs", "satisfied_constraint_refs", "failed_constraint_refs"],
    user_correction_records: ["id", "conversation_id", "turn_id", "prompt_hash", "response_hash", "correction_text", "preference_delta_json"],
    style_preference_snapshots: ["id", "conversation_id", "profile_hash", "profile_json", "source_outcome_ids"],
    response_candidate_records: ["id", "conversation_id", "turn_id", "candidate_id", "policy_decision_id", "response_hash", "response_text", "critic_score"],
    target_profile_patterns: ["id", "target_profile_id", "pattern_family_id", "pattern_json", "evidence_ids", "alpha"],
    calibration_observations: ["id", "calibration_id", "subsystem_id", "task_class", "raw_score", "outcome", "final_outcome", "metadata_json"]
  };
}

async function requiredSchemaErrors(client: Pick<PoolClient, "query">, schema: string): Promise<string[]> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema=$1`,
    [schema]
  );
  const tableSet = new Set(tables.rows.map(row => row.table_name));
  const errors = POSTGRES_REQUIRED_TABLES.filter(table => !tableSet.has(table)).map(table => `missing table: ${table}`);
  const columns = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1`,
    [schema]
  );
  const columnMap = new Map<string, Set<string>>();
  for (const row of columns.rows) {
    let set = columnMap.get(row.table_name);
    if (!set) {
      set = new Set();
      columnMap.set(row.table_name, set);
    }
    set.add(row.column_name);
  }
  for (const [table, requiredColumns] of Object.entries(requiredHydrationColumns())) {
    const existing = columnMap.get(table) ?? new Set<string>();
    for (const column of requiredColumns) if (!existing.has(column)) errors.push(`missing column: ${table}.${column}`);
  }
  return errors;
}

async function storedSchemaVersion(storage: Pick<PostgresStorageAdapter, "query" | "table">): Promise<number | undefined> {
  const rows = await storage.query<{ value_json: JsonValue }>(
    `SELECT value_json FROM ${storage.table("storage_meta")} WHERE key='schema_version'`
  );
  const value = rows[0]?.value_json;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const version = (value as Record<string, JsonValue>).version;
  return typeof version === "number" && Number.isInteger(version) ? version : undefined;
}

function isLocalDatabaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function createEventLedger(storage: PostgresStorageAdapter): EventLedger {
  return {
    append: event => storage.events.appendBatch([event]),
    async appendBatch(events) {
      if (events.length === 0) return;
      await storage.tx(async client => {
        let prev = await latestLedgerHash(client, storage.table("events"));
        for (const event of events) {
          const ledgerHash = sha256(`${prev}\u001f${event.hash}`);
          await client.query(
            `INSERT INTO ${storage.table("events")}(id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash)
             VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
             ON CONFLICT(id) DO NOTHING`,
            [event.id, event.episodeId, event.typeId, event.t, JSON.stringify(event.payload), event.parents, event.hash, ledgerHash]
          );
          prev = ledgerHash;
        }
      });
    },
    async readEpisode(episodeId) {
      const rows = await storage.query<EventRow>(`SELECT * FROM ${storage.table("events")} WHERE episode_id=$1 ORDER BY t,id`, [episodeId]);
      return rows.map(rowToEvent);
    },
    async readRange(input: EventRangeQuery) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (input.episodeId) { params.push(input.episodeId); where.push(`episode_id=$${params.length}`); }
      if (input.typeId) { params.push(input.typeId); where.push(`type_id=$${params.length}`); }
      if (input.afterT !== undefined) { params.push(input.afterT); where.push(`t >= $${params.length}`); }
      if (input.beforeT !== undefined) { params.push(input.beforeT); where.push(`t <= $${params.length}`); }
      params.push(input.limit ?? 200);
      const rows = await storage.query<EventRow>(`SELECT * FROM ${storage.table("events")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t DESC,id DESC LIMIT $${params.length}`, params);
      return rows.map(rowToEvent);
    },
    async latestLedgerHash() {
      const rows = await storage.query<{ ledger_hash: string }>(`SELECT ledger_hash FROM ${storage.table("events")} ORDER BY t DESC,id DESC LIMIT 1`);
      return rows[0]?.ledger_hash ?? "";
    }
  };
}

function createConversationStore(storage: PostgresStorageAdapter): ConversationStore {
  return {
    async putTurn(record) {
      await storage.query(
        `INSERT INTO ${storage.table("conversation_turns")}(id,session_id,episode_id,turn_index,role_id,text,evidence_ids,metadata_json,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,TO_TIMESTAMP($9/1000.0))
         ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text, evidence_ids=EXCLUDED.evidence_ids, metadata_json=EXCLUDED.metadata_json`,
        [record.id, record.sessionId, record.episodeId, record.turnIndex, record.roleId, record.text, record.evidenceIds, JSON.stringify(record.metadata), record.createdAt]
      );
    },
    async listTurns(query) {
      const params: unknown[] = [query.sessionId];
      const where = [`session_id=$1`];
      if (query.beforeTurnIndex !== undefined) {
        params.push(query.beforeTurnIndex);
        where.push(`turn_index<$${params.length}`);
      }
      params.push(query.limit ?? 24);
      const rows = await storage.query<ConversationTurnRow>(
        `SELECT * FROM ${storage.table("conversation_turns")} WHERE ${where.join(" AND ")} ORDER BY turn_index DESC,id DESC LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToConversationTurn).reverse();
    }
  };
}

function createIngestionCheckpointStore(storage: PostgresStorageAdapter): IngestionCheckpointStore {
  return {
    async put(checkpoint) {
      await storage.query(
        `INSERT INTO ${storage.table("ingestion_checkpoints")}(id,root_uri,item_uri,phase,status,offset_bytes,content_hash,byte_length,reason,metadata_json,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,TO_TIMESTAMP($11/1000.0))
         ON CONFLICT(id) DO UPDATE SET phase=EXCLUDED.phase,status=EXCLUDED.status,offset_bytes=EXCLUDED.offset_bytes,content_hash=EXCLUDED.content_hash,byte_length=EXCLUDED.byte_length,reason=EXCLUDED.reason,metadata_json=EXCLUDED.metadata_json,updated_at=EXCLUDED.updated_at`,
        [checkpoint.id, checkpoint.rootUri, checkpoint.itemUri, checkpoint.phase, checkpoint.status, checkpoint.offsetBytes, checkpoint.contentHash ?? null, checkpoint.byteLength ?? null, checkpoint.reason ?? null, JSON.stringify(checkpoint.metadata), checkpoint.updatedAt]
      );
    },
    async get(id) {
      const rows = await storage.query<IngestionCheckpointRow>(`SELECT * FROM ${storage.table("ingestion_checkpoints")} WHERE id=$1`, [id]);
      return rows[0] ? rowToIngestionCheckpoint(rows[0]) : null;
    },
    async list(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.rootUri) {
        params.push(query.rootUri);
        where.push(`root_uri=$${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`status=$${params.length}`);
      }
      params.push(query.limit ?? 200);
      const rows = await storage.query<IngestionCheckpointRow>(`SELECT * FROM ${storage.table("ingestion_checkpoints")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT $${params.length}`, params);
      return rows.map(rowToIngestionCheckpoint);
    }
  };
}

function createBlobStore(storage: PostgresStorageAdapter): BlobStore {
  return {
    async put(content, mediaType) {
      const hash = `sha256_${sha256(Buffer.from(content))}` as ContentHash;
      await storage.query(`INSERT INTO ${storage.table("blobs")}(content_hash, media_type, byte_length, content) VALUES($1,$2,$3,$4) ON CONFLICT(content_hash) DO NOTHING`, [hash, mediaType, content.length, Buffer.from(content)]);
      return hash;
    },
    async get(hash) {
      const rows = await storage.query<{ content: Buffer }>(`SELECT content FROM ${storage.table("blobs")} WHERE content_hash=$1`, [hash]);
      if (!rows[0]) throw new Error(`blob not found: ${hash}`);
      return rows[0].content;
    },
    async exists(hash) {
      const rows = await storage.query<{ ok: number }>(`SELECT 1 AS ok FROM ${storage.table("blobs")} WHERE content_hash=$1`, [hash]);
      return rows.length > 0;
    }
  };
}

function createEvidenceStore(storage: PostgresStorageAdapter): EvidenceStore {
  return {
    async putSourceVersion(source) {
      await storage.query(`INSERT INTO ${storage.table("sources")}(id, namespace, canonical_uri, first_seen_at, last_seen_at) VALUES($1,$2,$3,TO_TIMESTAMP($4/1000.0),TO_TIMESTAMP($4/1000.0)) ON CONFLICT(id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`, [source.sourceId, source.namespace, source.canonicalUri, source.observedAt]);
      await storage.query(`INSERT INTO ${storage.table("source_versions")}(id, source_id, content_hash, media_type, observed_at, byte_length, trust, metadata_json) VALUES($1,$2,$3,$4,TO_TIMESTAMP($5/1000.0),$6,$7,$8::jsonb) ON CONFLICT(id) DO NOTHING`, [source.sourceVersionId, source.sourceId, source.contentHash, source.mediaType, source.observedAt, source.byteLength, source.trust, JSON.stringify(source.metadata)]);
    },
    async putEvidenceSpan(span) {
      await putEvidenceSpansBatch(storage, [span]);
    },
    async putEvidenceSpans(spans) {
      await putEvidenceSpansBatch(storage, spans);
    },
    async promoteEvidence(ids, reason) {
      if (ids.length === 0) return 0;
      const rows = await storage.query<{ count: string }>(`UPDATE ${storage.table("evidence_spans")} SET status='promoted', provenance_json=provenance_json || $2::jsonb WHERE id=ANY($1) RETURNING id`, [ids, JSON.stringify({ promotionReason: reason })]);
      return rows.length;
    },
    async getEvidence(id) {
      const rows = await storage.query<EvidenceRow>(`SELECT * FROM ${storage.table("evidence_spans")} WHERE id=$1`, [id]);
      return rows[0] ? rowToEvidence(rows[0]) : null;
    },
    async getEvidenceBatch(ids) {
      if (ids.length === 0) return [];
      const rows = await storage.query<EvidenceRow>(`SELECT * FROM ${storage.table("evidence_spans")} WHERE id=ANY($1)`, [ids]);
      return rows.map(rowToEvidence);
    },
    async searchEvidence(query: EvidenceQuery) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceId) { params.push(query.sourceId); where.push(`ev.source_id=$${params.length}`); }
      if (query.sourceVersionId) { params.push(query.sourceVersionId); where.push(`ev.source_version_id=$${params.length}`); }
      const features = evidenceQueryFeatures(query.features ?? []);
      let featureParamIndex = 0;
      if (features.length) {
        params.push(features);
        featureParamIndex = params.length;
        where.push(`ev.features && $${featureParamIndex}`);
      }
      if (where.length === 0) return [];
      params.push(query.limit ?? 80);
      const overlap = featureParamIndex > 0
        ? `(SELECT COUNT(*) FROM unnest(ev.features) AS f(feature) WHERE f.feature = ANY($${featureParamIndex}::text[]))`
        : "0";
      const rows = await storage.query<EvidenceRow>(`SELECT ev.* FROM ${storage.table("evidence_spans")} ev WHERE ${where.join(" AND ")} ORDER BY ${overlap} DESC, CASE WHEN ev.status='promoted' THEN 0 WHEN ev.status='pending' THEN 1 ELSE 2 END ASC, ev.alpha DESC, ev.observed_at DESC LIMIT $${params.length}`, params);
      return rows.map(row => ({ span: rowToEvidence(row), score: Number(row.alpha), reason: "postgres feature/source bounded evidence search" }));
    },
    async sourceVersionsForEvidence(ids) {
      if (ids.length === 0) return [];
      const rows = await storage.query<SourceVersionRow>(
        `SELECT DISTINCT sv.*, s.namespace, s.canonical_uri FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id JOIN ${storage.table("evidence_spans")} e ON e.source_version_id=sv.id WHERE e.id=ANY($1)`,
        [ids]
      );
      return rows.map(rowToSourceVersion);
    }
  };
}

async function putEvidenceSpansBatch(storage: PostgresStorageAdapter, spans: readonly EvidenceSpan[]): Promise<void> {
  if (!spans.length) return;
  const payload = spans.map(span => ({
    id: span.id,
    source_id: span.sourceId,
    source_version_id: span.sourceVersionId,
    chunk_id: span.chunkId,
    content_hash: span.contentHash,
    media_type: span.mediaType,
    byte_start: span.byteStart,
    byte_end: span.byteEnd,
    char_start: span.charStart,
    char_end: span.charEnd,
    text_preview: span.textPreview,
    text_content: span.text,
    language_hints: span.languageHints,
    script_hints: span.scriptHints,
    trust_vector: span.trustVector,
    provenance_json: span.provenance,
    features_json: span.features,
    status: span.status,
    alpha: span.alpha,
    observed_at_ms: span.observedAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("evidence_spans")} AS ev(id, source_id, source_version_id, chunk_id, content_hash, media_type, byte_start, byte_end, char_start, char_end, text_preview, text_content, language_hints, script_hints, trust_vector, provenance_json, features, status, alpha, observed_at)
     SELECT
       r.id,
       r.source_id,
       r.source_version_id,
       r.chunk_id,
       r.content_hash,
       r.media_type,
       r.byte_start,
       r.byte_end,
       r.char_start,
       r.char_end,
       r.text_preview,
       r.text_content,
       r.language_hints,
       r.script_hints,
       r.trust_vector,
       r.provenance_json,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.features_json) AS v(value)),
       r.status,
       r.alpha,
       TO_TIMESTAMP(r.observed_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       source_id text,
       source_version_id text,
       chunk_id text,
       content_hash text,
       media_type text,
       byte_start bigint,
       byte_end bigint,
       char_start bigint,
       char_end bigint,
       text_preview text,
       text_content text,
       language_hints jsonb,
       script_hints jsonb,
       trust_vector jsonb,
       provenance_json jsonb,
       features_json jsonb,
       status text,
       alpha double precision,
       observed_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET
       status=EXCLUDED.status,
       alpha=GREATEST(ev.alpha, EXCLUDED.alpha),
       trust_vector=ev.trust_vector || EXCLUDED.trust_vector,
       provenance_json=ev.provenance_json || EXCLUDED.provenance_json,
       features=ARRAY(SELECT DISTINCT value FROM unnest(ev.features || EXCLUDED.features) AS merged(value) ORDER BY value)`,
    [JSON.stringify(payload)]
  );
}

function createGraphStore(storage: PostgresStorageAdapter): GraphStore {
  return {
    async upsertNode(node) {
      await upsertGraphNodesBatch(storage, [node]);
    },
    async upsertNodes(nodes) {
      await upsertGraphNodesBatch(storage, nodes);
    },
    async upsertEdge(edge) {
      await upsertGraphEdgesBatch(storage, [edge]);
    },
    async upsertEdges(edges) {
      await upsertGraphEdgesBatch(storage, edges);
    },
    async upsertHyperedge(edge) {
      await upsertGraphHyperedgesBatch(storage, [edge]);
    },
    async upsertHyperedges(edges) {
      await upsertGraphHyperedgesBatch(storage, edges);
    },
    async getSlice(query) {
      const nodes = await queryNodes(storage, query);
      const ids = nodes.map(node => node.id);
      const edgeLimit = query.limitEdges ?? 2000;
      const perSeedEdgeLimit = ids.length ? Math.max(4, Math.ceil(edgeLimit / ids.length)) : 0;
      const edges = ids.length
        ? (await storage.query<GraphEdgeRow>(
          `WITH seeds(seed_id, seed_ord) AS (
             SELECT seed_id, seed_ord
             FROM unnest($1::text[]) WITH ORDINALITY AS seed(seed_id, seed_ord)
           ),
           source_candidates AS (
             SELECT edge_row.*, seeds.seed_ord
             FROM seeds
             CROSS JOIN LATERAL (
               SELECT *
               FROM ${storage.table("graph_edges")}
               WHERE source_node_id=seeds.seed_id
               ORDER BY alpha DESC, updated_at DESC, id
               LIMIT $3
             ) edge_row
           ),
           target_candidates AS (
             SELECT edge_row.*, seeds.seed_ord
             FROM seeds
             CROSS JOIN LATERAL (
               SELECT *
               FROM ${storage.table("graph_edges")}
               WHERE target_node_id=seeds.seed_id
               ORDER BY alpha DESC, updated_at DESC, id
               LIMIT $3
             ) edge_row
           ),
           ranked_candidates AS (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY id ORDER BY seed_ord, alpha DESC, updated_at DESC, id) AS edge_rank
             FROM (
               SELECT * FROM source_candidates
               UNION ALL
               SELECT * FROM target_candidates
             ) candidates
           )
           SELECT *
           FROM ranked_candidates
           WHERE edge_rank=1
           ORDER BY seed_ord, alpha DESC, updated_at DESC, id
           LIMIT $2`,
          [ids, edgeLimit, perSeedEdgeLimit]
        )).map(rowToGraphEdge)
        : [];
      const hyperedgeMemberIds = ids.slice(0, Math.max(32, Math.min(ids.length, Math.floor((query.limitNodes ?? 800) / 3))));
      const hyperedges = ids.length
        ? (await storage.query<HyperedgeRow>(`SELECT * FROM ${storage.table("graph_hyperedges")} WHERE member_node_ids && $1 ORDER BY updated_at DESC LIMIT $2`, [hyperedgeMemberIds, Math.max(64, Math.floor((query.limitEdges ?? 2000) / 4))])).map(rowToHyperedge)
        : [];
      return { nodes, edges, hyperedges, bounded: true, query };
    },
    async getTemporalSlice(query: TemporalGraphQuery): Promise<TemporalGraph> {
      const slice = await this.getSlice(query);
      return { ...slice, temporalQuery: query };
    },
    async materializeAlphaGraph(query) {
      const slice = await this.getSlice(query);
      return createAlphaLayer().buildTrace({ nodes: slice.nodes, edges: slice.edges, activeNodeIds: slice.nodes.map(node => String(node.id)) });
    }
  };
}

async function upsertGraphNodesBatch(storage: PostgresStorageAdapter, nodes: readonly GraphNode[]): Promise<void> {
  if (!nodes.length) return;
  const payload = nodes.map(node => ({
    id: node.id,
    type_id: node.typeId,
    representation_json: node.representation,
    alpha: node.alpha,
    evidence_ids_json: node.evidenceIds,
    features_json: node.features,
    created_at_ms: node.createdAt,
    updated_at_ms: node.updatedAt,
    metadata_json: node.metadata
  }));
  await storage.query(
    `INSERT INTO ${storage.table("graph_nodes")} AS n(id,type_id,representation_json,alpha,evidence_ids,features,created_at,updated_at,metadata_json)
     SELECT
       r.id,
       r.type_id,
       r.representation_json,
       r.alpha,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.features_json) AS v(value)),
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       TO_TIMESTAMP(r.updated_at_ms/1000.0),
       r.metadata_json
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       type_id text,
       representation_json jsonb,
       alpha double precision,
       evidence_ids_json jsonb,
       features_json jsonb,
       created_at_ms double precision,
       updated_at_ms double precision,
       metadata_json jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(n.alpha,EXCLUDED.alpha), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(n.evidence_ids || EXCLUDED.evidence_ids))), features=(SELECT ARRAY(SELECT DISTINCT unnest(n.features || EXCLUDED.features))), updated_at=EXCLUDED.updated_at, metadata_json=n.metadata_json || EXCLUDED.metadata_json`,
    [JSON.stringify(payload)]
  );
}

async function upsertGraphEdgesBatch(storage: PostgresStorageAdapter, edges: readonly GraphEdge[]): Promise<void> {
  if (!edges.length) return;
  const payload = edges.map(edge => ({
    id: edge.id,
    source_node_id: edge.source,
    target_node_id: edge.target,
    relation_id: edge.relationId,
    alpha: edge.alpha,
    weight: edge.weight,
    temporal_scope: edge.temporalScope,
    evidence_ids_json: edge.evidenceIds,
    created_at_ms: edge.createdAt,
    updated_at_ms: edge.updatedAt,
    metadata_json: edge.metadata
  }));
  await storage.query(
    `INSERT INTO ${storage.table("graph_edges")} AS e(id,source_node_id,target_node_id,relation_id,alpha,weight,temporal_scope,evidence_ids,created_at,updated_at,metadata_json)
     SELECT
       r.id,
       r.source_node_id,
       r.target_node_id,
       r.relation_id,
       r.alpha,
       r.weight,
       r.temporal_scope,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       TO_TIMESTAMP(r.updated_at_ms/1000.0),
       r.metadata_json
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       source_node_id text,
       target_node_id text,
       relation_id text,
       alpha double precision,
       weight double precision,
       temporal_scope jsonb,
       evidence_ids_json jsonb,
       created_at_ms double precision,
       updated_at_ms double precision,
       metadata_json jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(e.alpha,EXCLUDED.alpha), weight=GREATEST(e.weight,EXCLUDED.weight), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(e.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at, metadata_json=e.metadata_json || EXCLUDED.metadata_json`,
    [JSON.stringify(payload)]
  );
}

async function upsertGraphHyperedgesBatch(storage: PostgresStorageAdapter, edges: readonly Hyperedge[]): Promise<void> {
  if (!edges.length) return;
  const payload = edges.map(edge => ({
    id: edge.id,
    relation_id: edge.relationId,
    member_node_ids_json: edge.memberNodeIds,
    weight_vector: edge.weightVector,
    temporal_scope: edge.temporalScope,
    provenance_refs_json: edge.provenanceRefs,
    created_at_ms: edge.createdAt,
    updated_at_ms: edge.updatedAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("graph_hyperedges")} AS h(id,relation_id,member_node_ids,weight_vector,temporal_scope,provenance_refs,created_at,updated_at)
     SELECT
       r.id,
       r.relation_id,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.member_node_ids_json) AS v(value)),
       r.weight_vector,
       r.temporal_scope,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.provenance_refs_json) AS v(value)),
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       TO_TIMESTAMP(r.updated_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       relation_id text,
       member_node_ids_json jsonb,
       weight_vector jsonb,
       temporal_scope jsonb,
       provenance_refs_json jsonb,
       created_at_ms double precision,
       updated_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET weight_vector=EXCLUDED.weight_vector, updated_at=EXCLUDED.updated_at`,
    [JSON.stringify(payload)]
  );
}

async function queryNodes(storage: PostgresStorageAdapter, query: GraphSliceQuery): Promise<GraphNode[]> {
  if (query.seedNodeIds?.length) return (await storage.query<GraphNodeRow>(`SELECT * FROM ${storage.table("graph_nodes")} WHERE id=ANY($1) LIMIT $2`, [query.seedNodeIds, query.limitNodes ?? 800])).map(rowToGraphNode);
  if (query.evidenceIds?.length) return (await storage.query<GraphNodeRow>(`SELECT * FROM ${storage.table("graph_nodes")} WHERE evidence_ids && $1 ORDER BY alpha DESC, updated_at DESC LIMIT $2`, [query.evidenceIds, query.limitNodes ?? 800])).map(rowToGraphNode);
  const features = graphQueryFeatures(query);
  if (features.length) return (await storage.query<GraphNodeRow>(
    `SELECT * FROM ${storage.table("graph_nodes")} WHERE features && $1 ORDER BY (SELECT COALESCE(SUM(1.0 / GREATEST(1, array_position($1::text[], feature))), 0) FROM unnest(features) feature WHERE feature=ANY($1)) DESC, alpha DESC, updated_at DESC LIMIT $2`,
    [features, query.limitNodes ?? 800]
  )).map(rowToGraphNode);
  if (query.allowLatestFallback) return (await storage.query<GraphNodeRow>(`SELECT * FROM ${storage.table("graph_nodes")} ORDER BY alpha DESC, updated_at DESC, id LIMIT $1`, [query.limitNodes ?? 800])).map(rowToGraphNode);
  return [];
}

function graphQueryFeatures(query: GraphSliceQuery): string[] {
  const features = new Set<string>();
  for (const feature of query.features ?? []) {
    if (isGraphRetrievalFeature(feature)) features.add(feature);
    if (features.size >= 512) return [...features];
  }
  for (const term of query.topicTerms ?? []) {
    for (const feature of featureSet(term, 96)) {
      if (isGraphRetrievalFeature(feature)) features.add(feature);
      if (features.size >= 512) return [...features];
    }
  }
  return [...features];
}

function evidenceQueryFeatures(features: readonly string[]): string[] {
  return uniquePostgresStrings(features.filter(isEvidenceRetrievalFeature)).slice(0, 512);
}

function isGraphRetrievalFeature(feature: string): boolean {
  const cleanFeature = feature.trim();
  if (!cleanFeature) return false;
  if (cleanFeature.startsWith("tri:") || cleanFeature.startsWith("bi:")) return true;
  if (cleanFeature.startsWith("sym:")) return [...cleanFeature.slice(4)].length >= 5;
  return false;
}

function isEvidenceRetrievalFeature(feature: string): boolean {
  const cleanFeature = feature.trim();
  if (!cleanFeature) return false;
  if (cleanFeature.startsWith("tri:") || cleanFeature.startsWith("bi:")) return true;
  if (cleanFeature.startsWith("sym:")) return [...cleanFeature.slice(4)].length >= 4;
  return false;
}

function uniquePostgresStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function createQuarantineStore(storage: PostgresStorageAdapter): QuarantineStore {
  return {
    async put(source) {
      await storage.query(`INSERT INTO ${storage.table("quarantine_sources")}(id,source_id,source_version_id,uri,content_hash,media_type,fetched_at,trust_vector,permission_vector,license_hint,decision,decision_json) VALUES($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7/1000.0),$8::jsonb,$9::jsonb,$10,$11,$12::jsonb) ON CONFLICT(id) DO UPDATE SET decision=EXCLUDED.decision, decision_json=EXCLUDED.decision_json`, [source.id, source.sourceId, source.sourceVersionId, source.uri, source.contentHash, source.mediaType, source.fetchedAt, JSON.stringify(source.trustVector), JSON.stringify(source.permissionVector), source.licenseHint ?? null, source.decision, JSON.stringify(source.decisionJson ?? null)]);
    },
    async get(id) {
      const rows = await storage.query<QuarantineRow>(`SELECT * FROM ${storage.table("quarantine_sources")} WHERE id=$1`, [id]);
      return rows[0] ? rowToQuarantine(rows[0]) : null;
    },
    async listPending(query) {
      const params: unknown[] = [];
      const where = ["decision='pending'"];
      if (query?.sourceId) { params.push(query.sourceId); where.push(`source_id=$${params.length}`); }
      params.push(query?.limit ?? 100);
      return (await storage.query<QuarantineRow>(`SELECT * FROM ${storage.table("quarantine_sources")} WHERE ${where.join(" AND ")} ORDER BY fetched_at LIMIT $${params.length}`, params)).map(rowToQuarantine);
    },
    async markDecision(id, decision) {
      await storage.query(`UPDATE ${storage.table("quarantine_sources")} SET decision=$2, decision_json=$3::jsonb WHERE id=$1`, [id, decision.decision, JSON.stringify(decision)]);
    }
  };
}

function createProofStore(storage: PostgresStorageAdapter): ProofStore {
  return {
    async putProof(proof) {
      await storage.query(`INSERT INTO ${storage.table("semantic_proofs")}(id,claim_id,verdict,confidence_json,proof_graph_json,evidence_ids,transform_ids,scores_json,validator_version,created_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9,TO_TIMESTAMP($10/1000.0)) ON CONFLICT(id) DO UPDATE SET verdict=EXCLUDED.verdict, confidence_json=EXCLUDED.confidence_json`, [proof.id, proof.claimId, proof.verdict, JSON.stringify(proof.confidence), JSON.stringify(proof.proofGraph), proof.evidenceIds, proof.transformIds, JSON.stringify(proof.scores), proof.validatorVersion, proof.createdAt]);
    },
    async getProof(id) {
      const rows = await storage.query<ProofRow>(`SELECT * FROM ${storage.table("semantic_proofs")} WHERE id=$1`, [id]);
      return rows[0] ? rowToProof(rows[0]) : null;
    },
    async findProofsForClaim(claimId) {
      return (await storage.query<ProofRow>(`SELECT * FROM ${storage.table("semantic_proofs")} WHERE claim_id=$1 ORDER BY created_at DESC`, [claimId])).map(rowToProof);
    }
  };
}

function createConstructStore(storage: PostgresStorageAdapter): ConstructStore {
  return {
    async putConstruct(graph) {
      await storage.query(`INSERT INTO ${storage.table("construct_graphs")}(id,episode_id,force_vector,graph_json) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(id) DO UPDATE SET graph_json=EXCLUDED.graph_json`, [graph.id, graph.episodeId, JSON.stringify(graph.forceVector), JSON.stringify(graph)]);
      for (const artifact of graph.artifacts) await storage.blobs.put(Buffer.from(artifact.content, "utf8"), artifact.mediaType);
    },
    async putValidation(graph) {
      await storage.query(`INSERT INTO ${storage.table("validation_graphs")}(id,construct_id,graph_json,passed) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(id) DO UPDATE SET graph_json=EXCLUDED.graph_json, passed=EXCLUDED.passed`, [graph.id, graph.constructId, JSON.stringify(graph), graph.passed]);
    },
    async putEmission(graph) {
      await storage.query(`INSERT INTO ${storage.table("emission_graphs")}(id,construct_id,graph_json,output_refs) VALUES($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(id) DO UPDATE SET graph_json=EXCLUDED.graph_json, output_refs=EXCLUDED.output_refs`, [graph.id, graph.constructId, JSON.stringify(graph), JSON.stringify(graph.artifacts.map(a => ({ path: a.path, contentHash: a.contentHash })))]);
      for (const artifact of graph.artifacts) await storage.blobs.put(Buffer.from(artifact.content, "utf8"), artifact.mediaType);
    },
    async putBuildTest(episodeId, constructId, result) {
      await storage.query(`INSERT INTO ${storage.table("program_builds")}(id,episode_id,construct_id,result_json,passed) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(id) DO UPDATE SET result_json=EXCLUDED.result_json, passed=EXCLUDED.passed`, [`${constructId}:build-test`, episodeId, constructId, JSON.stringify(result), result.passed]);
    },
    async getConstruct(id) {
      const rows = await storage.query<{ graph_json: ConstructGraph }>(`SELECT graph_json FROM ${storage.table("construct_graphs")} WHERE id=$1`, [id]);
      return rows[0]?.graph_json ?? null;
    }
  };
}

function createCapabilityStore(storage: PostgresStorageAdapter): CapabilityAuditStore {
  return {
    async putPlan(plan) {
      await storage.query(`INSERT INTO ${storage.table("capability_calls")}(id,episode_id,capability_id,phase,status,input_json,result_json,risk_vector,permission_json,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,TO_TIMESTAMP($10/1000.0),$11) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, result_json=EXCLUDED.result_json`, [plan.id, plan.episodeId, plan.capabilityId, plan.phase, plan.status, JSON.stringify(plan.input), JSON.stringify(plan.result ?? null), JSON.stringify(plan.riskVector), JSON.stringify(plan.permission), plan.createdAt, plan.completedAt ? new Date(plan.completedAt) : null]);
    },
    async listByEpisode(episodeId) {
      return (await storage.query<CapabilityRow>(`SELECT * FROM ${storage.table("capability_calls")} WHERE episode_id=$1 ORDER BY created_at`, [episodeId])).map(rowToCapability);
    }
  };
}

function createForecastStore(storage: PostgresStorageAdapter): ForecastStore {
  return {
    async putState(state) {
      await storage.query(`INSERT INTO ${storage.table("forecast_states")}(id,episode_id,t,state_vector,alpha_surface_json,spectrum_json) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT(id) DO UPDATE SET state_vector=EXCLUDED.state_vector`, [state.id, state.episodeId ?? null, state.t, state.stateVector, JSON.stringify(state.alphaSurface), JSON.stringify(state.spectrum)]);
    },
    async putForecast(forecast) {
      await storage.query(`INSERT INTO ${storage.table("forecast_envelopes")}(id,source_state_id,horizon,mean_vector,covariance_json,interval_json,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,TO_TIMESTAMP($7/1000.0)) ON CONFLICT(id) DO UPDATE SET mean_vector=EXCLUDED.mean_vector, interval_json=EXCLUDED.interval_json`, [forecast.id, forecast.sourceStateId, forecast.horizon, forecast.mean, JSON.stringify(forecast.covariance), JSON.stringify(forecast.interval), forecast.createdAt]);
    },
    async getSeries(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.since !== undefined) { params.push(query.since); where.push(`t >= $${params.length}`); }
      if (query.until !== undefined) { params.push(query.until); where.push(`t <= $${params.length}`); }
      params.push(query.limit ?? 50);
      return (await storage.query<ForecastRow>(`SELECT * FROM ${storage.table("forecast_states")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t DESC LIMIT $${params.length}`, params)).map(rowToForecast);
    }
  };
}

function createBenchmarkStore(storage: PostgresStorageAdapter): BenchmarkStore {
  return {
    async putRun(run) {
      await storage.query(`INSERT INTO ${storage.table("benchmark_runs")}(id,config_json,started_at,completed_at,summary_json) VALUES($1,$2::jsonb,TO_TIMESTAMP($3/1000.0),$4,$5::jsonb) ON CONFLICT(id) DO UPDATE SET completed_at=EXCLUDED.completed_at, summary_json=EXCLUDED.summary_json`, [run.id, JSON.stringify(run.config), run.startedAt, run.completedAt ? new Date(run.completedAt) : null, JSON.stringify(run.summary ?? null)]);
    },
    async putCase(result) {
      await storage.query(`INSERT INTO ${storage.table("benchmark_cases")}(id,run_id,case_json,result_json,score_json) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) ON CONFLICT(id) DO UPDATE SET result_json=EXCLUDED.result_json, score_json=EXCLUDED.score_json`, [result.id, result.runId, JSON.stringify(result.case), JSON.stringify(result.result), JSON.stringify(result.score)]);
    },
    async summarize() {
      const rows = await storage.query<{ runs: string; cases: string; mean_score: string }>(`SELECT COUNT(DISTINCT r.id)::text AS runs, COUNT(c.id)::text AS cases, COALESCE(AVG((c.score_json->>'score')::float),0)::text AS mean_score FROM ${storage.table("benchmark_runs")} r LEFT JOIN ${storage.table("benchmark_cases")} c ON c.run_id=r.id`);
      return { runs: Number(rows[0]?.runs ?? 0), cases: Number(rows[0]?.cases ?? 0), meanScore: Number(rows[0]?.mean_score ?? 0) };
    }
  };
}

function createModelStore(storage: PostgresStorageAdapter): ModelStore {
  const defaultModel = (): ModelState => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 });
  return {
    async readModel() {
      const rows = await storage.query<{ model_json: ModelState }>(`SELECT model_json FROM ${storage.table("model_state")} WHERE id='default'`);
      return rows[0]?.model_json ?? defaultModel();
    },
    async writeModel(model) {
      await storage.query(`INSERT INTO ${storage.table("model_state")}(id,model_json,updated_at) VALUES('default',$1::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=NOW()`, [JSON.stringify(model)]);
    },
    async putLanguageProfile(profile) {
      await putLanguageProfilesBatch(storage, [profile]);
    },
    async putLanguageProfiles(profiles) {
      await putLanguageProfilesBatch(storage, profiles);
    },
    async listLanguageProfiles(query) {
      const requestedLimit = typeof query === "number" ? query : query?.limit;
      const boundedLimit = Math.max(1, Math.min(2048, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit!) : 512));
      if (typeof query === "object" && query?.referencedByLanguageMemory) {
        return (await storage.query<{ profile_json: LanguageProfile }>(
          `SELECT lp.profile_json
           FROM ${storage.table("language_profiles")} lp
           WHERE EXISTS (SELECT 1 FROM ${storage.table("language_units")} u WHERE u.profile_id=lp.id)
              OR EXISTS (SELECT 1 FROM ${storage.table("language_patterns")} p WHERE p.profile_id=lp.id)
              OR EXISTS (SELECT 1 FROM ${storage.table("ngram_models")} m WHERE m.model_json->>'profileId'=lp.id)
              OR EXISTS (SELECT 1 FROM ${storage.table("ngram_observations")} o WHERE o.metadata_json->>'profileId'=lp.id)
              OR EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")} f WHERE f.frame_json->>'profileId'=lp.id)
           ORDER BY lp.created_at DESC, lp.id ASC
           LIMIT $1`,
          [boundedLimit]
        )).map(row => row.profile_json);
      }
      return (await storage.query<{ profile_json: LanguageProfile }>(
        `SELECT profile_json FROM ${storage.table("language_profiles")} ORDER BY created_at DESC, id ASC LIMIT $1`,
        [boundedLimit]
      )).map(row => row.profile_json);
    }
  };
}

async function putLanguageProfilesBatch(storage: PostgresStorageAdapter, profiles: readonly LanguageProfile[]): Promise<void> {
  if (!profiles.length) return;
  const payload = profiles.map(profile => ({
    id: profile.id,
    source_version_id: profile.sourceVersionId,
    profile_json: profile,
    created_at_ms: profile.createdAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("language_profiles")}(id,source_version_id,profile_json,created_at)
     SELECT r.id, r.source_version_id, r.profile_json, TO_TIMESTAMP(r.created_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       source_version_id text,
       profile_json jsonb,
       created_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET profile_json=EXCLUDED.profile_json`,
    [JSON.stringify(payload)]
  );
}

function createLanguageMemoryStore(storage: PostgresStorageAdapter): LanguageMemoryStore {
  return {
    async putNgramObservation(observation) {
      await storage.query(
        `INSERT INTO ${storage.table("ngram_observations")} AS n(id,stream_id,language_hint,order_n,history,symbol,count,field_weight,source_version_id,evidence_id,observed_at,metadata_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TO_TIMESTAMP($11/1000.0),$12::jsonb)
         ON CONFLICT(id) DO UPDATE SET count=EXCLUDED.count, field_weight=GREATEST(n.field_weight,EXCLUDED.field_weight), metadata_json=n.metadata_json || EXCLUDED.metadata_json`,
        [observation.id, observation.streamId, observation.languageHint, observation.order, observation.history, observation.symbol, observation.count, observation.fieldWeight, observation.sourceVersionId ?? null, observation.evidenceId ?? null, observation.observedAt, JSON.stringify(observation.metadata)]
      );
    },
    async putNgramObservationsBatch(observations) {
      if (!observations.length) return;
      const payload = observations.map(observation => ({
        id: observation.id,
        stream_id: observation.streamId,
        language_hint: observation.languageHint,
        order_n: observation.order,
        history_json: observation.history,
        symbol: observation.symbol,
        count: observation.count,
        field_weight: observation.fieldWeight,
        source_version_id: observation.sourceVersionId ?? null,
        evidence_id: observation.evidenceId ?? null,
        observed_at_ms: observation.observedAt,
        metadata_json: observation.metadata
      }));
      await storage.query(
        `INSERT INTO ${storage.table("ngram_observations")} AS n(id,stream_id,language_hint,order_n,history,symbol,count,field_weight,source_version_id,evidence_id,observed_at,metadata_json)
         SELECT
           r.id,
           r.stream_id,
           r.language_hint,
           r.order_n,
           (SELECT COALESCE(array_agg(h.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.history_json) AS h(value)),
           r.symbol,
           r.count,
           r.field_weight,
           r.source_version_id,
           r.evidence_id,
           TO_TIMESTAMP(r.observed_at_ms/1000.0),
           r.metadata_json
         FROM jsonb_to_recordset($1::jsonb) AS r(
           id text,
           stream_id text,
           language_hint text,
           order_n integer,
           history_json jsonb,
           symbol text,
           count bigint,
           field_weight double precision,
           source_version_id text,
           evidence_id text,
           observed_at_ms double precision,
           metadata_json jsonb
         )
         ON CONFLICT(id) DO UPDATE SET count=EXCLUDED.count, field_weight=GREATEST(n.field_weight,EXCLUDED.field_weight), metadata_json=n.metadata_json || EXCLUDED.metadata_json`,
        [JSON.stringify(payload)]
      );
    },
    async putNgramModel(model) {
      await putNgramModelsBatch(storage, [model]);
    },
    async putNgramModels(models) {
      await putNgramModelsBatch(storage, models);
    },
    async putLanguageUnit(unit) {
      await putLanguageUnitsBatch(storage, [unit]);
    },
    async putLanguageUnits(units) {
      await putLanguageUnitsBatch(storage, units);
    },
    async putLanguagePattern(pattern) {
      await putLanguagePatternsBatch(storage, [pattern]);
    },
    async putLanguagePatterns(patterns) {
      await putLanguagePatternsBatch(storage, patterns);
    },
    async putSemanticFrame(frame) {
      await putSemanticFramesBatch(storage, [frame]);
    },
    async putSemanticFrames(frames) {
      await putSemanticFramesBatch(storage, frames);
    },
    async putTranslationAlignment(alignment) {
      await storage.query(
        `INSERT INTO ${storage.table("translation_alignments")} AS ta(id,source_frame_id,target_frame_id,source_language,target_language,force,loss_vector,alignment_json,evidence_ids,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,TO_TIMESTAMP($10/1000.0))
         ON CONFLICT(id) DO UPDATE SET force=EXCLUDED.force, loss_vector=EXCLUDED.loss_vector, alignment_json=EXCLUDED.alignment_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(ta.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at`,
        [alignment.id, alignment.sourceFrameId, alignment.targetFrameId, alignment.sourceLanguage, alignment.targetLanguage, alignment.force, JSON.stringify(alignment.lossVector), JSON.stringify(alignment.alignmentJson), alignment.evidenceIds, alignment.updatedAt]
      );
    },
    async listNgramModels(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.streamId) { params.push(query.streamId); where.push(`stream_id=$${params.length}`); }
      if (query.languageHint) { params.push(query.languageHint); where.push(`language_hint=$${params.length}`); }
      if (query.profileIds || query.sourceVersionIds) {
        const ownership: string[] = [];
        if (query.profileIds?.length) {
          params.push([...query.profileIds]);
          ownership.push(`model_json->>'profileId'=ANY($${params.length}::text[])`);
        }
        if (query.sourceVersionIds?.length) {
          params.push([...query.sourceVersionIds]);
          ownership.push(`(NULLIF(model_json->>'profileId','') IS NULL AND model_json->>'sourceVersionId'=ANY($${params.length}::text[]))`);
        }
        if (!ownership.length) return [];
        where.push(`(${ownership.join(" OR ")})`);
      }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`model_json->>'sourceSystem'=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<NgramModelRow>(`SELECT * FROM ${storage.table("ngram_models")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id ASC LIMIT $${params.length}`, params)).map(rowToNgramModel);
    },
    async listNgramObservations(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.streamId) { params.push(query.streamId); where.push(`stream_id=$${params.length}`); }
      if (query.languageHint) { params.push(query.languageHint); where.push(`language_hint=$${params.length}`); }
      if (query.profileIds || query.sourceVersionIds) {
        const ownership: string[] = [];
        if (query.profileIds?.length) {
          params.push([...query.profileIds]);
          ownership.push(`metadata_json->>'profileId'=ANY($${params.length}::text[])`);
        }
        if (query.sourceVersionIds?.length) {
          params.push([...query.sourceVersionIds]);
          ownership.push(`(NULLIF(metadata_json->>'profileId','') IS NULL AND source_version_id=ANY($${params.length}::text[]))`);
        }
        if (!ownership.length) return [];
        where.push(`(${ownership.join(" OR ")})`);
      }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`metadata_json->>'sourceSystem'=$${params.length}`); }
      params.push(query.limit ?? 1000);
      return (await storage.query<NgramObservationRow>(`SELECT * FROM ${storage.table("ngram_observations")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY count DESC, observed_at DESC, id ASC LIMIT $${params.length}`, params)).map(rowToNgramObservation);
    },
    async listLanguageUnits(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        where.push(`profile_id=ANY($${params.length}::text[])`);
      } else if (query.profileId) { params.push(query.profileId); where.push(`profile_id=$${params.length}`); }
      if (query.script) { params.push(query.script); where.push(`script=$${params.length}`); }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`metadata_json->>'sourceSystem'=$${params.length}`); }
      params.push(query.limit ?? 1000);
      return (await storage.query<LanguageUnitRow>(`SELECT * FROM ${storage.table("language_units")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY alpha DESC, id ASC LIMIT $${params.length}`, params)).map(rowToLanguageUnit);
    },
    async listLanguagePatterns(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        where.push(`profile_id=ANY($${params.length}::text[])`);
      } else if (query.profileId) { params.push(query.profileId); where.push(`profile_id=$${params.length}`); }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`pattern_json->>'sourceSystem'=$${params.length}`); }
      params.push(query.limit ?? 1000);
      return (await storage.query<LanguagePatternRow>(`SELECT * FROM ${storage.table("language_patterns")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY support DESC, updated_at DESC, id ASC LIMIT $${params.length}`, params)).map(rowToLanguagePattern);
    },
    async listSemanticFrames(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`frame_json->>'sourceSystem'=$${params.length}`); }
      if (query.profileIds || query.sourceVersionIds) {
        const ownership: string[] = [];
        if (query.profileIds?.length) {
          params.push([...query.profileIds]);
          ownership.push(`frame_json->>'profileId'=ANY($${params.length}::text[])`);
        }
        if (query.sourceVersionIds?.length) {
          params.push([...query.sourceVersionIds]);
          ownership.push(`(NULLIF(frame_json->>'profileId','') IS NULL AND frame_json->>'sourceVersionId'=ANY($${params.length}::text[]))`);
        }
        if (!ownership.length) return [];
        where.push(`(${ownership.join(" OR ")})`);
      }
      params.push(query.limit ?? 500);
      return (await storage.query<SemanticFrameRow>(`SELECT id, frame_json, embedding::text AS embedding, evidence_ids, alpha, created_at FROM ${storage.table("semantic_frames")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY alpha DESC, created_at DESC, id ASC LIMIT $${params.length}`, params)).map(rowToSemanticFrame);
    },
    async listTranslationAlignments(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceLanguage) { params.push(query.sourceLanguage); where.push(`source_language=$${params.length}`); }
      if (query.targetLanguage) { params.push(query.targetLanguage); where.push(`target_language=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<TranslationAlignmentRow>(`SELECT * FROM ${storage.table("translation_alignments")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT $${params.length}`, params)).map(rowToTranslationAlignment);
    }
  };
}

async function putNgramModelsBatch(storage: PostgresStorageAdapter, models: readonly NgramModelRecord[]): Promise<void> {
  if (!models.length) return;
  const payload = models.map(model => ({
    id: model.id,
    stream_id: model.streamId,
    language_hint: model.languageHint,
    max_order: model.maxOrder,
    discount: model.discount,
    model_json: model.modelJson,
    updated_at_ms: model.updatedAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("ngram_models")}(id,stream_id,language_hint,max_order,discount,model_json,updated_at)
     SELECT r.id, r.stream_id, r.language_hint, r.max_order, r.discount, r.model_json, TO_TIMESTAMP(r.updated_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       stream_id text,
       language_hint text,
       max_order integer,
       discount double precision,
       model_json jsonb,
       updated_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET discount=EXCLUDED.discount, model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`,
    [JSON.stringify(payload)]
  );
}

async function putLanguageUnitsBatch(storage: PostgresStorageAdapter, units: readonly LanguageUnitRecord[]): Promise<void> {
  if (!units.length) return;
  const payload = units.map(unit => ({
    id: unit.id,
    profile_id: unit.profileId,
    source_version_id: unit.sourceVersionId,
    script: unit.script,
    unit_kind: unit.unitKind,
    unit_text: unit.text,
    features_json: unit.features,
    competence_vector_json: unit.competenceVector,
    alpha: unit.alpha,
    evidence_ids_json: unit.evidenceIds,
    metadata_json: unit.metadata
  }));
  await storage.query(
    `INSERT INTO ${storage.table("language_units")} AS lu(id,profile_id,source_version_id,script,unit_kind,unit_text,features,competence_vector,alpha,evidence_ids,metadata_json)
     SELECT
       r.id,
       r.profile_id,
       r.source_version_id,
       r.script,
       r.unit_kind,
       r.unit_text,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.features_json) AS v(value)),
       (SELECT COALESCE(array_agg((v.value)::double precision), ARRAY[]::double precision[]) FROM jsonb_array_elements_text(r.competence_vector_json) AS v(value)),
       r.alpha,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       r.metadata_json
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       profile_id text,
       source_version_id text,
       script text,
       unit_kind text,
       unit_text text,
       features_json jsonb,
       competence_vector_json jsonb,
       alpha double precision,
       evidence_ids_json jsonb,
       metadata_json jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(lu.alpha,EXCLUDED.alpha), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(lu.evidence_ids || EXCLUDED.evidence_ids))), metadata_json=lu.metadata_json || EXCLUDED.metadata_json`,
    [JSON.stringify(payload)]
  );
}

async function putLanguagePatternsBatch(storage: PostgresStorageAdapter, patterns: readonly LanguagePatternRecord[]): Promise<void> {
  if (!patterns.length) return;
  const payload = patterns.map(pattern => ({
    id: pattern.id,
    profile_id: pattern.profileId,
    pattern_kind: pattern.patternKind,
    support: pattern.support,
    entropy: pattern.entropy,
    pattern_json: pattern.patternJson,
    evidence_ids_json: pattern.evidenceIds,
    updated_at_ms: pattern.updatedAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("language_patterns")} AS lp(id,profile_id,pattern_kind,support,entropy,pattern_json,evidence_ids,updated_at)
     SELECT
       r.id,
       r.profile_id,
       r.pattern_kind,
       r.support,
       r.entropy,
       r.pattern_json,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       TO_TIMESTAMP(r.updated_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       profile_id text,
       pattern_kind text,
       support double precision,
       entropy double precision,
       pattern_json jsonb,
       evidence_ids_json jsonb,
       updated_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET support=GREATEST(lp.support,EXCLUDED.support), entropy=EXCLUDED.entropy, pattern_json=EXCLUDED.pattern_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(lp.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at`,
    [JSON.stringify(payload)]
  );
}

async function putSemanticFramesBatch(storage: PostgresStorageAdapter, frames: readonly SemanticFrameRecord[]): Promise<void> {
  if (!frames.length) return;
  const payload = frames.map(frame => ({
    id: frame.id,
    frame_json: frame.frameJson,
    embedding: vectorLiteral(frame.embedding, 64),
    evidence_ids_json: frame.evidenceIds,
    alpha: frame.alpha,
    created_at_ms: frame.createdAt
  }));
  await storage.query(
    `INSERT INTO ${storage.table("semantic_frames")} AS sf(id,frame_json,embedding,evidence_ids,alpha,created_at)
     SELECT
       r.id,
       r.frame_json,
       r.embedding::vector,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       r.alpha,
       TO_TIMESTAMP(r.created_at_ms/1000.0)
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       frame_json jsonb,
       embedding text,
       evidence_ids_json jsonb,
       alpha double precision,
       created_at_ms double precision
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(sf.alpha,EXCLUDED.alpha), frame_json=EXCLUDED.frame_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(sf.evidence_ids || EXCLUDED.evidence_ids)))`,
    [JSON.stringify(payload)]
  );
}

function createBrainImportStore(storage: PostgresStorageAdapter): BrainImportStore {
  return {
    async putLedger(record) {
      await storage.query(
        `INSERT INTO ${storage.table("scce2_import_ledger")} AS l(id,import_run_id,brain_version,root_path,section_id,section_kind,force_class,source_path,file_hash,shard_hash,source_version_id,evidence_ids,node_ids,row_counts_json,warnings,metadata_json,imported_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,TO_TIMESTAMP($17/1000.0))
         ON CONFLICT(id) DO UPDATE SET evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(l.evidence_ids || EXCLUDED.evidence_ids))), node_ids=(SELECT ARRAY(SELECT DISTINCT unnest(l.node_ids || EXCLUDED.node_ids))), row_counts_json=l.row_counts_json || EXCLUDED.row_counts_json, warnings=(SELECT ARRAY(SELECT DISTINCT unnest(l.warnings || EXCLUDED.warnings))), metadata_json=l.metadata_json || EXCLUDED.metadata_json, imported_at=EXCLUDED.imported_at`,
        [record.id, record.importRunId, record.brainVersion, record.rootPath, record.sectionId, record.sectionKind, record.forceClass, record.sourcePath ?? null, record.fileHash ?? null, record.shardHash ?? null, record.sourceVersionId ?? null, record.evidenceIds, record.nodeIds, JSON.stringify(record.rowCounts), record.warnings, JSON.stringify(record.metadata), record.importedAt]
      );
    },
    async listLedger(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.importRunId) { params.push(query.importRunId); where.push(`import_run_id=$${params.length}`); }
      if (query.forceClass) { params.push(query.forceClass); where.push(`force_class=$${params.length}`); }
      params.push(query.limit ?? 500);
      return (await storage.query<BrainImportLedgerRow>(`SELECT * FROM ${storage.table("scce2_import_ledger")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY imported_at DESC LIMIT $${params.length}`, params)).map(rowToBrainImportLedger);
    },
    async summarize(query = {}) {
      const rows = await this.listLedger({ importRunId: query.importRunId, limit: query.limit ?? 2000 });
      const active = await this.active();
      const runs = new Map<string, { importRunId: string; brainVersion: string; rootPath: string; importedAt: number; rows: number; forceClasses: Record<string, number>; rowCounts: Record<string, number>; warnings: string[] }>();
      const totals = {
        importedLanguagePriorCount: 0,
        importedGraphPriorCount: 0,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 0,
        importedProgramPriorCount: 0,
        unknownPriorCount: 0
      };
      for (const row of rows) {
        const run = runs.get(row.importRunId) ?? { importRunId: row.importRunId, brainVersion: row.brainVersion, rootPath: row.rootPath, importedAt: row.importedAt, rows: 0, forceClasses: {}, rowCounts: {}, warnings: [] };
        run.rows++;
        run.importedAt = Math.max(run.importedAt, row.importedAt);
        run.forceClasses[row.forceClass] = (run.forceClasses[row.forceClass] ?? 0) + 1;
        for (const [key, count] of Object.entries(row.rowCounts)) run.rowCounts[key] = (run.rowCounts[key] ?? 0) + count;
        run.warnings.push(...row.warnings);
        runs.set(row.importRunId, run);
        if (row.forceClass === "direct_evidence") totals.importedDirectEvidenceCount += row.rowCounts.evidence_spans ?? 0;
        else if (row.forceClass === "profile_excerpt_evidence") totals.profileExcerptEvidenceCount += row.rowCounts.evidence_spans ?? 0;
        else if (row.forceClass === "learned_language_prior") totals.importedLanguagePriorCount += languagePriorRows(row.rowCounts);
        else if (row.forceClass === "learned_concept_prior") totals.importedGraphPriorCount += graphPriorRows(row.rowCounts);
        else if (row.forceClass === "learned_program_prior") totals.importedProgramPriorCount += row.rowCounts.program_patterns ?? sumCounts(row.rowCounts);
        else if (row.forceClass === "unknown_prior") totals.unknownPriorCount += 1;
      }
      totals.importedLearnedPriorCount = totals.importedLanguagePriorCount + totals.importedGraphPriorCount + totals.importedProgramPriorCount;
      return {
        activeBrainVersion: active.activeBrainVersion,
        activeImportRunIds: active.activeImportRunIds,
        ...totals,
        runs: [...runs.values()].sort((a, b) => b.importedAt - a.importedAt).map(run => ({ ...run, warnings: [...new Set(run.warnings)].slice(0, 64) }))
      } satisfies BrainImportSummary;
    },
    async putLifecycle(record) {
      await storage.query(
        `INSERT INTO ${storage.table("brain_import_lifecycle")}(import_run_id,brain_version,root_path,state,manifest_json,validation_json,reason,revision,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,TO_TIMESTAMP($9/1000.0),TO_TIMESTAMP($10/1000.0))
         ON CONFLICT(import_run_id) DO NOTHING`,
        [record.importRunId, record.brainVersion, record.rootPath, record.state, JSON.stringify(record.manifest), record.validation ? JSON.stringify(record.validation) : null, record.reason ?? null, record.revision, record.createdAt, record.updatedAt]
      );
      const stored = await this.getLifecycle(record.importRunId);
      if (!stored || stored.brainVersion !== record.brainVersion || stored.rootPath !== record.rootPath || stored.manifest.manifestHash !== record.manifest.manifestHash) {
        throw new Error(`brain lifecycle identity conflict for ${record.importRunId}`);
      }
    },
    async getLifecycle(importRunId) {
      const rows = await storage.query<BrainLifecycleRow>(
        `SELECT * FROM ${storage.table("brain_import_lifecycle")} WHERE import_run_id=$1`,
        [importRunId]
      );
      return rows[0] ? rowToBrainLifecycle(rows[0]) : null;
    },
    async listLifecycle(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.state) { params.push(query.state); where.push(`state=$${params.length}`); }
      params.push(query.limit ?? 100);
      const rows = await storage.query<BrainLifecycleRow>(
        `SELECT * FROM ${storage.table("brain_import_lifecycle")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, import_run_id LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToBrainLifecycle);
    },
    async transitionLifecycle(input) {
      assertGenericBrainLifecycleTransition(input.expectedState, input.toState);
      const rows = await storage.query<BrainLifecycleRow>(
        `UPDATE ${storage.table("brain_import_lifecycle")}
         SET state=$3, validation_json=COALESCE($4::jsonb,validation_json), reason=$5, revision=revision+1, updated_at=TO_TIMESTAMP($6/1000.0)
         WHERE import_run_id=$1 AND state=$2
         RETURNING *`,
        [input.importRunId, input.expectedState, input.toState, input.validation ? JSON.stringify(input.validation) : null, input.reason ?? null, input.updatedAt]
      );
      if (rows[0]) return rowToBrainLifecycle(rows[0]);
      const current = await this.getLifecycle(input.importRunId);
      if (!current) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
      throw new Error(`brain lifecycle compare-and-set failed for ${input.importRunId}: expected ${input.expectedState}, found ${current.state}`);
    },
    async activateReady(input) {
      return storage.tx(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('scce2.active_brain'))`);
        const targetRows = await client.query<BrainLifecycleRow>(
          `SELECT * FROM ${storage.table("brain_import_lifecycle")} WHERE import_run_id=$1 FOR UPDATE`,
          [input.importRunId]
        );
        const target = targetRows.rows[0] ? rowToBrainLifecycle(targetRows.rows[0]) : null;
        if (!target) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
        if (target.brainVersion !== input.brainVersion) throw new Error(`brain lifecycle version mismatch for ${input.importRunId}`);
        if (target.state !== "READY") throw new Error(`brain activation requires READY, found ${target.state}`);

        // Lifecycle rows are authoritative. Demote every other ACTIVE row,
        // including orphan rows absent from (or hidden behind) a stale marker.
        await client.query(
          `UPDATE ${storage.table("brain_import_lifecycle")}
           SET state='READY', reason=$2, revision=revision+1, updated_at=TO_TIMESTAMP($3/1000.0)
           WHERE state='ACTIVE' AND import_run_id<>$1`,
          [input.importRunId, `deactivated by ${input.importRunId}`, input.updatedAt]
        );
        const activated = await client.query(
          `UPDATE ${storage.table("brain_import_lifecycle")} SET state='ACTIVE', reason=NULL, revision=revision+1, updated_at=TO_TIMESTAMP($2/1000.0) WHERE import_run_id=$1 AND state='READY'`,
          [input.importRunId, input.updatedAt]
        );
        if (activated.rowCount !== 1) throw new Error(`brain activation compare-and-set failed for ${input.importRunId}`);
        const authoritativeActive = await client.query<{ import_run_id: string }>(
          `SELECT import_run_id FROM ${storage.table("brain_import_lifecycle")} WHERE state='ACTIVE' FOR UPDATE`
        );
        if (authoritativeActive.rows.length !== 1 || authoritativeActive.rows[0]?.import_run_id !== input.importRunId) {
          throw new Error(`brain activation invariant failed for ${input.importRunId}`);
        }
        // Lifecycle state is authoritative: replacement demotes the prior
        // ACTIVE row to READY, so the public active marker must not continue
        // advertising rollback candidates as active imports.
        const activeImportRunIds = [input.importRunId];
        await client.query(
          `INSERT INTO ${storage.table("model_state")}(id,model_json,updated_at) VALUES('scce2.active_brain',$1::jsonb,TO_TIMESTAMP($2/1000.0))
           ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`,
          [JSON.stringify({ activeBrainVersion: input.brainVersion, activeImportRunIds, updatedAt: input.updatedAt }), input.updatedAt]
        );
        return { activeBrainVersion: input.brainVersion, activeImportRunIds };
      });
    },
    async active() {
      const rows = await storage.query<{ model_json: JsonValue }>(`SELECT model_json FROM ${storage.table("model_state")} WHERE id='scce2.active_brain'`);
      const record = rows[0]?.model_json;
      if (!record || typeof record !== "object" || Array.isArray(record)) return { activeImportRunIds: [] };
      const activeBrainVersion = typeof record.activeBrainVersion === "string" ? record.activeBrainVersion : undefined;
      const activeImportRunIds = Array.isArray(record.activeImportRunIds) ? record.activeImportRunIds.map(String) : [];
      return { activeBrainVersion, activeImportRunIds };
    }
  };
}

function createCorrectionMemoryStore(storage: PostgresStorageAdapter): CorrectionMemoryStore {
  return {
    async putRule(rule) {
      await storage.query(
        `INSERT INTO ${storage.table("correction_rules")} AS cr(id,episode_id,rule_kind,scope,pattern,replacement,weight,context_json,provenance_json,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,TO_TIMESTAMP($10/1000.0),TO_TIMESTAMP($11/1000.0))
         ON CONFLICT(id) DO UPDATE SET replacement=EXCLUDED.replacement, weight=GREATEST(cr.weight,EXCLUDED.weight), context_json=cr.context_json || EXCLUDED.context_json, provenance_json=cr.provenance_json || EXCLUDED.provenance_json, updated_at=EXCLUDED.updated_at`,
        [
          rule.id,
          rule.episodeId,
          rule.ruleKind,
          rule.scope,
          rule.pattern,
          rule.replacement ?? null,
          rule.weight,
          JSON.stringify(rule.contextJson),
          JSON.stringify(rule.provenanceJson),
          rule.createdAt,
          rule.updatedAt
        ]
      );
    },
    async listRules(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.ruleKind) {
        params.push(query.ruleKind);
        where.push(`rule_kind=$${params.length}`);
      }
      if (query.scope) {
        params.push(query.scope);
        where.push(`(scope=$${params.length} OR scope='global')`);
      }
      params.push(query.limit ?? 100);
      const rows = await storage.query<CorrectionRuleRow>(
        `SELECT * FROM ${storage.table("correction_rules")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY weight DESC, updated_at DESC LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToCorrectionRule);
    }
  };
}

function createLocalizationStore(storage: PostgresStorageAdapter): LocalizationStore {
  return {
    async putBundle(bundle) {
      await storage.query(
        `INSERT INTO ${storage.table("locale_bundles")} AS lb(id,source_locale,target_language_id,target_script_id,status,force,messages_json,missing_terms_json,evidence_ids,translation_alignment_ids,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,TO_TIMESTAMP($11/1000.0),TO_TIMESTAMP($12/1000.0))
         ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status, force=EXCLUDED.force, messages_json=EXCLUDED.messages_json, missing_terms_json=EXCLUDED.missing_terms_json, evidence_ids=EXCLUDED.evidence_ids, translation_alignment_ids=EXCLUDED.translation_alignment_ids, updated_at=EXCLUDED.updated_at`,
        [bundle.id, bundle.sourceLocale, bundle.targetLanguageId, bundle.targetScriptId ?? null, bundle.status, bundle.force, JSON.stringify(bundle.messagesJson), JSON.stringify(bundle.missingTermsJson), bundle.evidenceIds, bundle.translationAlignmentIds, bundle.createdAt, bundle.updatedAt]
      );
    },
    async listBundles(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.targetLanguageId) { params.push(query.targetLanguageId); where.push(`target_language_id=$${params.length}`); }
      if (query.status) { params.push(query.status); where.push(`status=$${params.length}`); }
      params.push(query.limit ?? 100);
      const rows = await storage.query<LocaleBundleRow>(
        `SELECT * FROM ${storage.table("locale_bundles")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToLocaleBundle);
    },
    async promoteBundle(id, promotedAt) {
      await storage.query(`UPDATE ${storage.table("locale_bundles")} SET status='promoted', updated_at=TO_TIMESTAMP($2/1000.0) WHERE id=$1`, [id, promotedAt]);
    }
  };
}

function createFlowCacheStore(storage: PostgresStorageAdapter): FlowCacheStore {
  return {
    async putPpf(record) {
      await storage.query(
        `INSERT INTO ${storage.table("ppf_cache")}(id,graph_hash,beta,personalization_json,mass_json,diagnostics_json,created_at)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,TO_TIMESTAMP($7/1000.0))
         ON CONFLICT(id) DO UPDATE SET beta=EXCLUDED.beta, personalization_json=EXCLUDED.personalization_json, mass_json=EXCLUDED.mass_json, diagnostics_json=EXCLUDED.diagnostics_json`,
        [record.id, record.graphHash, record.beta, JSON.stringify(record.personalizationJson), JSON.stringify(record.massJson), JSON.stringify(record.diagnosticsJson), record.createdAt]
      );
    },
    async getPpf(id) {
      const rows = await storage.query<PpfCacheRow>(`SELECT * FROM ${storage.table("ppf_cache")} WHERE id=$1`, [id]);
      return rows[0] ? rowToPpfCache(rows[0]) : null;
    },
    async putAlphaTrace(record) {
      await storage.query(
        `INSERT INTO ${storage.table("alpha_traces")}(id,graph_hash,alpha,trace_json,created_at)
         VALUES($1,$2,$3,$4::jsonb,TO_TIMESTAMP($5/1000.0))
         ON CONFLICT(id) DO UPDATE SET alpha=EXCLUDED.alpha, trace_json=EXCLUDED.trace_json`,
        [record.id, record.graphHash, record.alpha, JSON.stringify(record.traceJson), record.createdAt]
      );
    },
    async listAlphaTraces(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.graphHash) { params.push(query.graphHash); where.push(`graph_hash=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<AlphaTraceRow>(`SELECT * FROM ${storage.table("alpha_traces")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToAlphaTraceRecord);
    }
  };
}

function createSelfRewriteStore(storage: PostgresStorageAdapter): SelfRewriteStore {
  return {
    async putEpisode(record) {
      await storage.query(
        `INSERT INTO ${storage.table("self_rewrite_episodes")}(id,episode_id,target,program_graph_json,improvement_json,status,created_at)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,TO_TIMESTAMP($7/1000.0))
         ON CONFLICT(id) DO UPDATE SET program_graph_json=EXCLUDED.program_graph_json, improvement_json=EXCLUDED.improvement_json, status=EXCLUDED.status`,
        [record.id, record.episodeId, record.target, JSON.stringify(record.programGraphJson), JSON.stringify(record.improvementJson), record.status, record.createdAt]
      );
    },
    async putPatch(record) {
      await storage.query(
        `INSERT INTO ${storage.table("self_rewrite_patches")}(id,rewrite_episode_id,file_path,before_hash,after_hash,patch_json,score_json,created_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,TO_TIMESTAMP($8/1000.0))
         ON CONFLICT(id) DO UPDATE SET after_hash=EXCLUDED.after_hash, patch_json=EXCLUDED.patch_json, score_json=EXCLUDED.score_json`,
        [record.id, record.rewriteEpisodeId, record.filePath, record.beforeHash ?? null, record.afterHash, JSON.stringify(record.patchJson), JSON.stringify(record.scoreJson), record.createdAt]
      );
    },
    async listEpisodes(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.status) { params.push(query.status); where.push(`status=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<SelfRewriteEpisodeRow>(`SELECT * FROM ${storage.table("self_rewrite_episodes")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToSelfRewriteEpisode);
    },
    async listPatches(rewriteEpisodeId) {
      return (await storage.query<SelfRewritePatchRow>(`SELECT * FROM ${storage.table("self_rewrite_patches")} WHERE rewrite_episode_id=$1 ORDER BY created_at,id`, [rewriteEpisodeId])).map(rowToSelfRewritePatch);
    }
  };
}

function createWorkspaceStore(storage: PostgresStorageAdapter): WorkspaceStore {
  return {
    async putWorkspace(record) {
      await storage.query(
        `INSERT INTO ${storage.table("workspaces")}(id,root_path,root_uri,corpus_id,status,metadata_json,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,TO_TIMESTAMP($7/1000.0),TO_TIMESTAMP($8/1000.0))
         ON CONFLICT(id) DO UPDATE SET root_path=EXCLUDED.root_path, root_uri=EXCLUDED.root_uri, corpus_id=EXCLUDED.corpus_id, status=EXCLUDED.status, metadata_json=EXCLUDED.metadata_json, updated_at=EXCLUDED.updated_at`,
        [record.id, record.rootPath, record.rootUri, record.corpusId, record.status, JSON.stringify(record.metadata), record.createdAt, record.updatedAt]
      );
    },
    async getWorkspace(id) {
      const rows = await storage.query<WorkspaceRow>(`SELECT * FROM ${storage.table("workspaces")} WHERE id=$1`, [id]);
      return rows[0] ? rowToWorkspace(rows[0]) : null;
    },
    async latestWorkspace() {
      const rows = await storage.query<WorkspaceRow>(`SELECT * FROM ${storage.table("workspaces")} WHERE status='active' ORDER BY updated_at DESC LIMIT 1`);
      return rows[0] ? rowToWorkspace(rows[0]) : null;
    },
    async putSourceFile(record) {
      await storage.query(
        `INSERT INTO ${storage.table("workspace_source_files")}(workspace_id,corpus_id,path,absolute_path,media_type,content_hash,modified_time,byte_length,ingestion_status,import_batch_id,source_version_id,evidence_ids,symbol_ids,concept_ids,warnings,errors,metadata_json,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7/1000.0),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,TO_TIMESTAMP($18/1000.0))
         ON CONFLICT(workspace_id,path) DO UPDATE SET absolute_path=EXCLUDED.absolute_path, media_type=EXCLUDED.media_type, content_hash=EXCLUDED.content_hash, modified_time=EXCLUDED.modified_time, byte_length=EXCLUDED.byte_length, ingestion_status=EXCLUDED.ingestion_status, import_batch_id=EXCLUDED.import_batch_id, source_version_id=EXCLUDED.source_version_id, evidence_ids=EXCLUDED.evidence_ids, symbol_ids=EXCLUDED.symbol_ids, concept_ids=EXCLUDED.concept_ids, warnings=EXCLUDED.warnings, errors=EXCLUDED.errors, metadata_json=EXCLUDED.metadata_json, updated_at=EXCLUDED.updated_at`,
        [
          record.workspaceId,
          record.corpusId,
          record.path,
          record.absolutePath,
          record.mediaType,
          record.contentHash ?? null,
          record.modifiedTime,
          record.byteLength,
          record.ingestionStatus,
          record.importBatchId ?? null,
          record.sourceVersionId ?? null,
          record.evidenceIds,
          record.symbolIds,
          record.conceptIds,
          record.warnings,
          record.errors,
          JSON.stringify(record.metadata),
          record.updatedAt
        ]
      );
    },
    async listSourceFiles(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.workspaceId) { params.push(query.workspaceId); where.push(`workspace_id=$${params.length}`); }
      if (query.corpusId) { params.push(query.corpusId); where.push(`corpus_id=$${params.length}`); }
      if (query.status) { params.push(query.status); where.push(`ingestion_status=$${params.length}`); }
      params.push(query.limit ?? 10000);
      return (await storage.query<WorkspaceSourceFileRow>(
        `SELECT * FROM ${storage.table("workspace_source_files")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY path LIMIT $${params.length}`,
        params
      )).map(rowToWorkspaceSourceFile);
    },
    async putReport(record) {
      await storage.query(
        `INSERT INTO ${storage.table("workspace_reports")}(id,workspace_id,corpus_id,report_kind,title,body,data_json,source_refs_json,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,TO_TIMESTAMP($9/1000.0))
         ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, data_json=EXCLUDED.data_json, source_refs_json=EXCLUDED.source_refs_json`,
        [record.id, record.workspaceId, record.corpusId, record.reportKind, record.title, record.body, JSON.stringify(record.data), JSON.stringify(record.sourceRefs), record.createdAt]
      );
    },
    async listReports(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.workspaceId) { params.push(query.workspaceId); where.push(`workspace_id=$${params.length}`); }
      if (query.reportKind) { params.push(query.reportKind); where.push(`report_kind=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<WorkspaceReportRow>(
        `SELECT * FROM ${storage.table("workspace_reports")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      )).map(rowToWorkspaceReport);
    }
  };
}

function createDialogueMemoryStore(storage: PostgresStorageAdapter): DialogueMemoryStore {
  return {
    async putInteractionState(record) {
      await storage.query(
        `INSERT INTO ${storage.table("interaction_state_records")}(id,conversation_id,turn_id,state_json,feature_refs,signal_refs,created_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,TO_TIMESTAMP($7/1000.0))
         ON CONFLICT(id) DO UPDATE SET state_json=EXCLUDED.state_json, feature_refs=EXCLUDED.feature_refs, signal_refs=EXCLUDED.signal_refs`,
        [record.id, record.conversationId, record.turnId, JSON.stringify(record.stateJson), record.featureRefs, record.signalRefs, record.createdAt]
      );
    },
    async compareAndPutInteractionState(record, condition) {
      return storage.tx(async client => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${storage.schema}\u001f${record.conversationId}`]
        );
        const currentRows = await client.query<{ state_id: string; turn_index: string }>(
          `SELECT state_json->>'id' AS state_id, (state_json->>'turnIndex')::numeric::text AS turn_index
           FROM ${storage.table("interaction_state_records")}
           WHERE conversation_id=$1
             AND state_json->>'schema'=$2
             AND jsonb_typeof(state_json->'id')='string'
             AND jsonb_typeof(state_json->'turnIndex')='number'
           ORDER BY (state_json->>'turnIndex')::numeric DESC, created_at DESC, id DESC
           LIMIT 1`,
          [record.conversationId, condition.stateSchema]
        );
        const currentStateId = currentRows.rows[0]?.state_id ?? null;
        const parsedCurrentIndex = currentRows.rows[0] ? Number(currentRows.rows[0].turn_index) : null;
        const currentTurnIndex = parsedCurrentIndex !== null && Number.isSafeInteger(parsedCurrentIndex) && parsedCurrentIndex >= 0
          ? parsedCurrentIndex
          : null;
        if (currentStateId !== condition.expectedStateId || currentTurnIndex !== condition.expectedTurnIndex) {
          return { stored: false, currentStateId, currentTurnIndex, reason: "state_conflict" as const };
        }
        if (condition.nextTurnIndex <= (currentTurnIndex ?? -1)) {
          return { stored: false, currentStateId, currentTurnIndex, reason: "turn_not_monotonic" as const };
        }
        const nextIdentity = interactionStateJsonIdentity(record.stateJson, condition.stateSchema);
        if (!nextIdentity
          || nextIdentity.stateId !== condition.nextStateId
          || nextIdentity.turnIndex !== condition.nextTurnIndex) {
          return { stored: false, currentStateId, currentTurnIndex, reason: "state_conflict" as const };
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO ${storage.table("interaction_state_records")}(id,conversation_id,turn_id,state_json,feature_refs,signal_refs,created_at)
           VALUES($1,$2,$3,$4::jsonb,$5,$6,TO_TIMESTAMP($7/1000.0))
           ON CONFLICT(id) DO NOTHING
           RETURNING id`,
          [record.id, record.conversationId, record.turnId, JSON.stringify(record.stateJson), record.featureRefs, record.signalRefs, record.createdAt]
        );
        if (!inserted.rowCount) {
          return { stored: false, currentStateId, currentTurnIndex, reason: "state_conflict" as const };
        }
        return {
          stored: true,
          currentStateId: condition.nextStateId,
          currentTurnIndex: condition.nextTurnIndex,
          reason: "stored" as const
        };
      });
    },
    async putPolicyDecision(record) {
      await storage.query(
        `INSERT INTO ${storage.table("dialogue_policy_decision_records")}(id,conversation_id,turn_id,decision_json,selected_action_ids,score_trace_refs,created_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,TO_TIMESTAMP($7/1000.0))
         ON CONFLICT(id) DO UPDATE SET decision_json=EXCLUDED.decision_json, selected_action_ids=EXCLUDED.selected_action_ids, score_trace_refs=EXCLUDED.score_trace_refs`,
        [record.id, record.conversationId, record.turnId, JSON.stringify(record.decisionJson), record.selectedActionIds, record.scoreTraceRefs, record.createdAt]
      );
    },
    async putConversationOutcome(record) {
      await storage.query(
        `INSERT INTO ${storage.table("conversation_outcome_records")}(id,conversation_id,turn_id,prompt_hash,answer_graph_hash,response_hash,accepted,rejected,corrected,correction_text,requested_constraint_refs,satisfied_constraint_refs,failed_constraint_refs,score_trace_refs,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::timestamptz)
         ON CONFLICT(id) DO UPDATE SET accepted=EXCLUDED.accepted, rejected=EXCLUDED.rejected, corrected=EXCLUDED.corrected, correction_text=EXCLUDED.correction_text, satisfied_constraint_refs=EXCLUDED.satisfied_constraint_refs, failed_constraint_refs=EXCLUDED.failed_constraint_refs, score_trace_refs=EXCLUDED.score_trace_refs`,
        [record.id, record.conversationId, record.turnId, record.promptHash, record.answerGraphHash ?? null, record.responseHash, record.accepted ?? null, record.rejected ?? null, record.corrected ?? null, record.correctionText ?? null, [...record.requestedConstraintRefs], [...record.satisfiedConstraintRefs], [...record.failedConstraintRefs], [...record.scoreTraceRefs], record.createdAt]
      );
    },
    async putUserCorrection(record) {
      await storage.query(
        `INSERT INTO ${storage.table("user_correction_records")}(id,conversation_id,turn_id,prompt_hash,response_hash,correction_text,rejected_surface_hash,accepted_surface_hash,preference_delta_json,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,TO_TIMESTAMP($10/1000.0))
         ON CONFLICT(id) DO UPDATE SET correction_text=EXCLUDED.correction_text, preference_delta_json=EXCLUDED.preference_delta_json`,
        [record.id, record.conversationId, record.turnId, record.promptHash, record.responseHash, record.correctionText, record.rejectedSurfaceHash ?? null, record.acceptedSurfaceHash ?? null, JSON.stringify(record.preferenceDeltaJson), record.createdAt]
      );
    },
    async putStyleSnapshot(record) {
      await storage.query(
        `INSERT INTO ${storage.table("style_preference_snapshots")}(id,conversation_id,profile_hash,profile_json,source_outcome_ids,created_at)
         VALUES($1,$2,$3,$4::jsonb,$5,TO_TIMESTAMP($6/1000.0))
         ON CONFLICT(id) DO UPDATE SET profile_json=EXCLUDED.profile_json, source_outcome_ids=EXCLUDED.source_outcome_ids`,
        [record.id, record.conversationId, record.profileHash, JSON.stringify(record.profileJson), record.sourceOutcomeIds, record.createdAt]
      );
    },
    async putResponseCandidate(record) {
      await storage.query(
        `INSERT INTO ${storage.table("response_candidate_records")}(id,conversation_id,turn_id,candidate_id,policy_decision_id,answer_graph_hash,response_hash,response_text,critic_score,score_trace_refs,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TO_TIMESTAMP($11/1000.0))
         ON CONFLICT(id) DO UPDATE SET response_text=EXCLUDED.response_text, critic_score=EXCLUDED.critic_score, score_trace_refs=EXCLUDED.score_trace_refs`,
        [record.id, record.conversationId, record.turnId, record.candidateId, record.policyDecisionId, record.answerGraphHash ?? null, record.responseHash, record.responseText, record.criticScore, record.scoreTraceRefs, record.createdAt]
      );
    },
    async putTargetProfilePattern(record) {
      await storage.query(
        `INSERT INTO ${storage.table("target_profile_patterns")}(id,target_profile_id,pattern_family_id,pattern_json,evidence_ids,alpha,created_at,updated_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,TO_TIMESTAMP($7/1000.0),TO_TIMESTAMP($8/1000.0))
         ON CONFLICT(id) DO UPDATE SET pattern_json=EXCLUDED.pattern_json, evidence_ids=EXCLUDED.evidence_ids, alpha=GREATEST(${storage.table("target_profile_patterns")}.alpha,EXCLUDED.alpha), updated_at=EXCLUDED.updated_at`,
        [record.id, record.targetProfileId, record.patternFamilyId, JSON.stringify(record.patternJson), record.evidenceIds, record.alpha, record.createdAt, record.updatedAt]
      );
    },
    async putCalibrationObservation(record) {
      await storage.query(
        `INSERT INTO ${storage.table("calibration_observations")}(id,calibration_id,subsystem_id,task_class,raw_score,outcome,selected_output_hash,accepted,rejected,corrected,unsupported_fact_hit,citation_failure,user_correction_distance,final_outcome,source_trace_id,source_record_id,metadata_json,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,TO_TIMESTAMP($18/1000.0))
         ON CONFLICT(id) DO UPDATE SET raw_score=EXCLUDED.raw_score, outcome=EXCLUDED.outcome, selected_output_hash=EXCLUDED.selected_output_hash, accepted=EXCLUDED.accepted, rejected=EXCLUDED.rejected, corrected=EXCLUDED.corrected, unsupported_fact_hit=EXCLUDED.unsupported_fact_hit, citation_failure=EXCLUDED.citation_failure, user_correction_distance=EXCLUDED.user_correction_distance, final_outcome=EXCLUDED.final_outcome, metadata_json=EXCLUDED.metadata_json`,
        [
          record.id,
          record.calibrationId,
          record.subsystemId,
          record.taskClass,
          record.rawScore,
          record.outcome,
          record.selectedOutputHash ?? null,
          record.accepted ?? null,
          record.rejected ?? null,
          record.corrected ?? null,
          record.unsupportedFactHit ?? null,
          record.citationFailure ?? null,
          record.userCorrectionDistance ?? null,
          record.finalOutcome,
          record.sourceTraceId ?? null,
          record.sourceRecordId ?? null,
          JSON.stringify(record.metadata),
          record.createdAt
        ]
      );
    },
    async listInteractionStates(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<InteractionStateRow>(`SELECT * FROM ${storage.table("interaction_state_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToInteractionState);
    },
    async listPolicyDecisions(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<DialoguePolicyDecisionRow>(`SELECT * FROM ${storage.table("dialogue_policy_decision_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToDialoguePolicyDecision);
    },
    async listResponseCandidates(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      if (query.policyDecisionId) { params.push(query.policyDecisionId); where.push(`policy_decision_id=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<ResponseCandidateRow>(`SELECT * FROM ${storage.table("response_candidate_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY critic_score DESC, created_at DESC LIMIT $${params.length}`, params)).map(rowToResponseCandidate);
    },
    async listConversationOutcomes(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      params.push(query.limit ?? 100);
      return (await storage.query<ConversationOutcomeRow>(`SELECT * FROM ${storage.table("conversation_outcome_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToConversationOutcome);
    },
    async listStyleSnapshots(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      params.push(query.limit ?? 20);
      return (await storage.query<StylePreferenceSnapshotRow>(`SELECT * FROM ${storage.table("style_preference_snapshots")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToStylePreferenceSnapshot);
    },
    async listTargetProfilePatterns(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.targetProfileId) { params.push(query.targetProfileId); where.push(`target_profile_id=$${params.length}`); }
      if (query.patternFamilyId) { params.push(query.patternFamilyId); where.push(`pattern_family_id=$${params.length}`); }
      params.push(query.limit ?? 200);
      return (await storage.query<TargetProfilePatternRow>(`SELECT * FROM ${storage.table("target_profile_patterns")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY alpha DESC, updated_at DESC LIMIT $${params.length}`, params)).map(rowToTargetProfilePattern);
    },
    async listCalibrationObservations(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.calibrationId) { params.push(query.calibrationId); where.push(`calibration_id=$${params.length}`); }
      if (query.subsystemId) { params.push(query.subsystemId); where.push(`subsystem_id=$${params.length}`); }
      if (query.taskClass) { params.push(query.taskClass); where.push(`task_class=$${params.length}`); }
      if (query.sourceRecordId) { params.push(query.sourceRecordId); where.push(`source_record_id=$${params.length}`); }
      params.push(query.limit ?? 500);
      return (await storage.query<CalibrationObservationRow>(`SELECT * FROM ${storage.table("calibration_observations")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToCalibrationObservation);
    }
  };
}

function vectorLiteral(values: number[], dimensions: number): string {
  const bounded = values.slice(0, dimensions).map(value => Number.isFinite(value) ? value : 0);
  while (bounded.length < dimensions) bounded.push(0);
  return `[${bounded.map(value => Number(value).toPrecision(12)).join(",")}]`;
}

async function latestLedgerHash(client: PoolClient, eventsTable: string): Promise<string> {
  const result = await client.query<{ ledger_hash: string }>(`SELECT ledger_hash FROM ${eventsTable} ORDER BY t DESC,id DESC LIMIT 1`);
  return result.rows[0]?.ledger_hash ?? "";
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

interface WorkspaceRow { id: string; root_path: string; root_uri: string; corpus_id: string; status: WorkspaceRecord["status"]; metadata_json: JsonValue; created_at: Date; updated_at: Date }
function rowToWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    rootPath: row.root_path,
    rootUri: row.root_uri,
    corpusId: row.corpus_id,
    status: row.status,
    metadata: row.metadata_json,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime()
  };
}

interface WorkspaceSourceFileRow {
  workspace_id: string;
  corpus_id: string;
  path: string;
  absolute_path: string;
  media_type: string;
  content_hash: string | null;
  modified_time: Date;
  byte_length: string;
  ingestion_status: WorkspaceIngestionStatus;
  import_batch_id: string | null;
  source_version_id: string | null;
  evidence_ids: string[];
  symbol_ids: string[];
  concept_ids: string[];
  warnings: string[];
  errors: string[];
  metadata_json: JsonValue;
  updated_at: Date;
}
function rowToWorkspaceSourceFile(row: WorkspaceSourceFileRow): WorkspaceSourceFileRecord {
  return {
    workspaceId: row.workspace_id,
    corpusId: row.corpus_id,
    path: row.path,
    absolutePath: row.absolute_path,
    mediaType: row.media_type,
    contentHash: row.content_hash ? row.content_hash as ContentHash : undefined,
    modifiedTime: row.modified_time.getTime(),
    byteLength: Number(row.byte_length),
    ingestionStatus: row.ingestion_status,
    importBatchId: row.import_batch_id ?? undefined,
    sourceVersionId: row.source_version_id ? row.source_version_id as SourceVersionId : undefined,
    evidenceIds: row.evidence_ids as EvidenceId[],
    symbolIds: row.symbol_ids,
    conceptIds: row.concept_ids,
    warnings: row.warnings,
    errors: row.errors,
    metadata: row.metadata_json,
    updatedAt: row.updated_at.getTime()
  };
}

interface WorkspaceReportRow { id: string; workspace_id: string; corpus_id: string; report_kind: WorkspaceReportRecord["reportKind"]; title: string; body: string; data_json: JsonValue; source_refs_json: JsonValue; created_at: Date }
function rowToWorkspaceReport(row: WorkspaceReportRow): WorkspaceReportRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    corpusId: row.corpus_id,
    reportKind: row.report_kind,
    title: row.title,
    body: row.body,
    data: row.data_json,
    sourceRefs: row.source_refs_json,
    createdAt: row.created_at.getTime()
  };
}

interface InteractionStateRow { id: string; conversation_id: string; turn_id: string; state_json: JsonValue; feature_refs: string[]; signal_refs: string[]; created_at: Date }
function interactionStateJsonIdentity(value: JsonValue, stateSchema: string): { stateId: string; turnIndex: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as Record<string, JsonValue>;
  return state.schema === stateSchema
    && typeof state.id === "string"
    && typeof state.turnIndex === "number"
    && Number.isSafeInteger(state.turnIndex)
    && state.turnIndex >= 0
    ? { stateId: state.id, turnIndex: state.turnIndex }
    : undefined;
}
function rowToInteractionState(row: InteractionStateRow): InteractionStateRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    stateJson: row.state_json,
    featureRefs: row.feature_refs,
    signalRefs: row.signal_refs,
    createdAt: row.created_at.getTime()
  };
}

interface DialoguePolicyDecisionRow { id: string; conversation_id: string; turn_id: string; decision_json: JsonValue; selected_action_ids: string[]; score_trace_refs: string[]; created_at: Date }
function rowToDialoguePolicyDecision(row: DialoguePolicyDecisionRow): DialoguePolicyDecisionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    decisionJson: row.decision_json,
    selectedActionIds: row.selected_action_ids,
    scoreTraceRefs: row.score_trace_refs,
    createdAt: row.created_at.getTime()
  };
}

interface ResponseCandidateRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  candidate_id: string;
  policy_decision_id: string;
  answer_graph_hash: string | null;
  response_hash: string;
  response_text: string;
  critic_score: string;
  score_trace_refs: string[];
  created_at: Date;
}
function rowToResponseCandidate(row: ResponseCandidateRow): ResponseCandidateRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    candidateId: row.candidate_id,
    policyDecisionId: row.policy_decision_id,
    answerGraphHash: row.answer_graph_hash ?? undefined,
    responseHash: row.response_hash,
    responseText: row.response_text,
    criticScore: Number(row.critic_score),
    scoreTraceRefs: row.score_trace_refs,
    createdAt: row.created_at.getTime()
  };
}

interface ConversationOutcomeRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  prompt_hash: string;
  answer_graph_hash: string | null;
  response_hash: string;
  accepted: boolean | null;
  rejected: boolean | null;
  corrected: boolean | null;
  correction_text: string | null;
  requested_constraint_refs: string[];
  satisfied_constraint_refs: string[];
  failed_constraint_refs: string[];
  score_trace_refs: string[];
  created_at: Date;
}
function rowToConversationOutcome(row: ConversationOutcomeRow): ConversationOutcomeRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    promptHash: row.prompt_hash,
    answerGraphHash: row.answer_graph_hash ?? undefined,
    responseHash: row.response_hash,
    accepted: row.accepted ?? undefined,
    rejected: row.rejected ?? undefined,
    corrected: row.corrected ?? undefined,
    correctionText: row.correction_text ?? undefined,
    requestedConstraintRefs: row.requested_constraint_refs,
    satisfiedConstraintRefs: row.satisfied_constraint_refs,
    failedConstraintRefs: row.failed_constraint_refs,
    scoreTraceRefs: row.score_trace_refs,
    createdAt: row.created_at.toISOString()
  };
}

interface StylePreferenceSnapshotRow { id: string; conversation_id: string; profile_hash: string; profile_json: JsonValue; source_outcome_ids: string[]; created_at: Date }
function rowToStylePreferenceSnapshot(row: StylePreferenceSnapshotRow): StylePreferenceSnapshot {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    profileHash: row.profile_hash,
    profileJson: row.profile_json,
    sourceOutcomeIds: row.source_outcome_ids,
    createdAt: row.created_at.getTime()
  };
}

interface TargetProfilePatternRow { id: string; target_profile_id: string; pattern_family_id: string; pattern_json: JsonValue; evidence_ids: string[]; alpha: string; created_at: Date; updated_at: Date }
function rowToTargetProfilePattern(row: TargetProfilePatternRow): TargetProfilePatternRecord {
  return {
    id: row.id,
    targetProfileId: row.target_profile_id,
    patternFamilyId: row.pattern_family_id,
    patternJson: row.pattern_json,
    evidenceIds: row.evidence_ids as EvidenceId[],
    alpha: Number(row.alpha),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime()
  };
}

interface CalibrationObservationRow {
  id: string;
  calibration_id: string;
  subsystem_id: string;
  task_class: string;
  raw_score: string | number;
  outcome: boolean;
  selected_output_hash: string | null;
  accepted: boolean | null;
  rejected: boolean | null;
  corrected: boolean | null;
  unsupported_fact_hit: boolean | null;
  citation_failure: boolean | null;
  user_correction_distance: string | number | null;
  final_outcome: string;
  source_trace_id: string | null;
  source_record_id: string | null;
  metadata_json: JsonValue;
  created_at: Date;
}
function rowToCalibrationObservation(row: CalibrationObservationRow): CalibrationObservationRecord {
  return {
    schema: "scce.calibration.observation.v1",
    id: row.id,
    calibrationId: row.calibration_id,
    subsystemId: row.subsystem_id,
    taskClass: row.task_class,
    rawScore: Number(row.raw_score),
    outcome: row.outcome,
    selectedOutputHash: row.selected_output_hash ?? undefined,
    accepted: row.accepted ?? undefined,
    rejected: row.rejected ?? undefined,
    corrected: row.corrected ?? undefined,
    unsupportedFactHit: row.unsupported_fact_hit ?? undefined,
    citationFailure: row.citation_failure ?? undefined,
    userCorrectionDistance: row.user_correction_distance === null ? undefined : Number(row.user_correction_distance),
    finalOutcome: row.final_outcome,
    sourceTraceId: row.source_trace_id ?? undefined,
    sourceRecordId: row.source_record_id ?? undefined,
    metadata: row.metadata_json,
    createdAt: row.created_at.getTime()
  };
}

interface EventRow { id: string; episode_id: string; type_id: string; t: string; payload_json: JsonValue; parents: string[]; hash: string }
function rowToEvent(row: EventRow): ScceEvent { return { id: row.id as never, episodeId: row.episode_id as never, typeId: row.type_id as never, t: Number(row.t), payload: row.payload_json, parents: row.parents as never[], hash: row.hash }; }

interface ConversationTurnRow { id: string; session_id: string; episode_id: string; turn_index: string; role_id: string; text: string; evidence_ids: string[]; metadata_json: JsonValue; created_at: Date }
function rowToConversationTurn(row: ConversationTurnRow): ConversationTurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    episodeId: row.episode_id as EpisodeId,
    turnIndex: Number(row.turn_index),
    roleId: row.role_id,
    text: row.text,
    evidenceIds: row.evidence_ids as EvidenceId[],
    metadata: row.metadata_json,
    createdAt: row.created_at.getTime()
  };
}

interface IngestionCheckpointRow { id: string; root_uri: string; item_uri: string; phase: IngestionCheckpoint["phase"]; status: IngestionCheckpoint["status"]; offset_bytes: string; content_hash: string | null; byte_length: string | null; reason: string | null; metadata_json: JsonValue; updated_at: Date }
function rowToIngestionCheckpoint(row: IngestionCheckpointRow): IngestionCheckpoint { return { id: row.id, rootUri: row.root_uri, itemUri: row.item_uri, phase: row.phase, status: row.status, offsetBytes: Number(row.offset_bytes), contentHash: row.content_hash ? row.content_hash as ContentHash : undefined, byteLength: row.byte_length ? Number(row.byte_length) : undefined, reason: row.reason ?? undefined, updatedAt: row.updated_at.getTime(), metadata: row.metadata_json }; }

interface EvidenceRow { id: string; source_id: string; source_version_id: string; chunk_id: string; content_hash: string; media_type: string; byte_start: string; byte_end: string; char_start: string; char_end: string; text_preview: string; text_content: string; language_hints: JsonValue; script_hints: JsonValue; trust_vector: JsonValue; provenance_json: JsonValue; features: string[]; status: "quarantined" | "promoted"; alpha: string; observed_at: Date }
function rowToEvidence(row: EvidenceRow): EvidenceSpan { return { id: row.id as EvidenceId, sourceId: row.source_id as SourceId, sourceVersionId: row.source_version_id as SourceVersionId, chunkId: row.chunk_id as never, contentHash: row.content_hash as ContentHash, mediaType: row.media_type, byteStart: Number(row.byte_start), byteEnd: Number(row.byte_end), charStart: Number(row.char_start), charEnd: Number(row.char_end), textPreview: row.text_preview, text: row.text_content, languageHints: row.language_hints, scriptHints: row.script_hints, trustVector: row.trust_vector, provenance: row.provenance_json, features: row.features, status: row.status, alpha: Number(row.alpha), observedAt: row.observed_at.getTime() }; }

interface SourceVersionRow { id: string; source_id: string; content_hash: string; media_type: string; observed_at: Date; byte_length: string; trust: string; metadata_json: JsonValue; namespace: string; canonical_uri: string }
function rowToSourceVersion(row: SourceVersionRow): SourceVersion { return { sourceId: row.source_id as SourceId, sourceVersionId: row.id as SourceVersionId, namespace: row.namespace, canonicalUri: row.canonical_uri, contentHash: row.content_hash as ContentHash, mediaType: row.media_type, observedAt: row.observed_at.getTime(), byteLength: Number(row.byte_length), trust: Number(row.trust), metadata: row.metadata_json }; }

interface GraphNodeRow { id: string; type_id: string; representation_json: JsonValue; alpha: string; evidence_ids: string[]; features: string[]; created_at: Date; updated_at: Date; metadata_json: JsonValue }
function rowToGraphNode(row: GraphNodeRow): GraphNode { return { id: row.id as never, typeId: row.type_id as never, representation: row.representation_json, alpha: Number(row.alpha), evidenceIds: row.evidence_ids as EvidenceId[], features: row.features, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(), metadata: row.metadata_json }; }

interface GraphEdgeRow { id: string; source_node_id: string; target_node_id: string; relation_id: string; alpha: string; weight: string; temporal_scope: JsonValue; evidence_ids: string[]; created_at: Date; updated_at: Date; metadata_json: JsonValue }
function rowToGraphEdge(row: GraphEdgeRow): GraphEdge { return { id: row.id as never, source: row.source_node_id as never, target: row.target_node_id as never, relationId: row.relation_id as never, alpha: Number(row.alpha), weight: Number(row.weight), temporalScope: row.temporal_scope as never, evidenceIds: row.evidence_ids as EvidenceId[], createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(), metadata: row.metadata_json }; }

interface HyperedgeRow { id: string; relation_id: string; member_node_ids: string[]; weight_vector: JsonValue; temporal_scope: JsonValue; provenance_refs: string[]; created_at: Date; updated_at: Date }
function rowToHyperedge(row: HyperedgeRow): Hyperedge { return { id: row.id as never, relationId: row.relation_id as never, memberNodeIds: row.member_node_ids as never[], weightVector: row.weight_vector, temporalScope: row.temporal_scope, provenanceRefs: row.provenance_refs, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime() }; }

interface QuarantineRow { id: string; source_id: string; source_version_id: string; uri: string; content_hash: string; media_type: string; fetched_at: Date; trust_vector: JsonValue; permission_vector: JsonValue; license_hint: string | null; decision: "pending" | "promoted" | "rejected"; decision_json: JsonValue | null }
function rowToQuarantine(row: QuarantineRow): QuarantineSource { return { id: row.id, sourceId: row.source_id as SourceId, sourceVersionId: row.source_version_id as SourceVersionId, uri: row.uri, contentHash: row.content_hash as ContentHash, mediaType: row.media_type, fetchedAt: row.fetched_at.getTime(), trustVector: row.trust_vector, permissionVector: row.permission_vector, licenseHint: row.license_hint ?? undefined, decision: row.decision, decisionJson: row.decision_json ?? undefined }; }

interface ProofRow { id: string; claim_id: string; verdict: string; confidence_json: JsonValue; proof_graph_json: SemanticProof["proofGraph"]; evidence_ids: string[]; transform_ids: string[]; scores_json: JsonValue; validator_version: string; created_at: Date }
function rowToProof(row: ProofRow): SemanticProof { return { id: row.id as ProofId, claimId: row.claim_id as never, verdict: row.verdict as never, confidence: row.confidence_json, proofGraph: row.proof_graph_json, evidenceIds: row.evidence_ids as EvidenceId[], transformIds: row.transform_ids, scores: row.scores_json, validatorVersion: row.validator_version, createdAt: row.created_at.getTime() }; }

interface CapabilityRow { id: string; episode_id: string; capability_id: string; phase: CapabilityPlan["phase"]; status: CapabilityPlan["status"]; input_json: JsonValue; result_json: JsonValue | null; risk_vector: JsonValue; permission_json: JsonValue; created_at: Date; completed_at: Date | null }
function rowToCapability(row: CapabilityRow): CapabilityPlan { return { id: row.id as never, episodeId: row.episode_id as EpisodeId, capabilityId: row.capability_id, phase: row.phase, status: row.status, input: row.input_json, result: row.result_json ?? undefined, riskVector: row.risk_vector, permission: row.permission_json, createdAt: row.created_at.getTime(), completedAt: row.completed_at?.getTime() }; }

interface ForecastRow { id: string; episode_id: string | null; t: string; state_vector: number[]; alpha_surface_json: AlphaTrace["surfaces"]; spectrum_json: ForecastState["spectrum"] }
function rowToForecast(row: ForecastRow): ForecastState { return { id: row.id as never, episodeId: row.episode_id ? row.episode_id as EpisodeId : undefined, t: Number(row.t), stateVector: row.state_vector.map(Number), alphaSurface: row.alpha_surface_json, spectrum: row.spectrum_json }; }

interface NgramModelRow { id: string; stream_id: string; language_hint: string; max_order: number; discount: string; model_json: JsonValue; updated_at: Date }
function rowToNgramModel(row: NgramModelRow): NgramModelRecord { return { id: row.id, streamId: row.stream_id, languageHint: row.language_hint, maxOrder: Number(row.max_order), discount: Number(row.discount), modelJson: row.model_json, updatedAt: row.updated_at.getTime() }; }

interface NgramObservationRow { id: string; stream_id: string; language_hint: string; order_n: number; history: string[]; symbol: string; count: string; field_weight: string; source_version_id: string | null; evidence_id: string | null; observed_at: Date; metadata_json: JsonValue }
function rowToNgramObservation(row: NgramObservationRow): NgramObservation { return { id: row.id, streamId: row.stream_id, languageHint: row.language_hint, order: Number(row.order_n), history: row.history, symbol: row.symbol, count: Number(row.count), fieldWeight: Number(row.field_weight), sourceVersionId: row.source_version_id ? row.source_version_id as SourceVersionId : undefined, evidenceId: row.evidence_id ? row.evidence_id as EvidenceId : undefined, observedAt: row.observed_at.getTime(), metadata: row.metadata_json }; }

interface LanguageUnitRow { id: string; profile_id: string; source_version_id: string; script: string; unit_kind: LanguageUnitRecord["unitKind"]; unit_text: string; features: string[]; competence_vector: number[]; alpha: string; evidence_ids: string[]; metadata_json: JsonValue }
function rowToLanguageUnit(row: LanguageUnitRow): LanguageUnitRecord { return { id: row.id, profileId: row.profile_id, sourceVersionId: row.source_version_id as SourceVersionId, script: row.script, unitKind: row.unit_kind, text: row.unit_text, features: row.features, competenceVector: row.competence_vector.map(Number), alpha: Number(row.alpha), evidenceIds: row.evidence_ids as EvidenceId[], metadata: row.metadata_json }; }

interface LanguagePatternRow { id: string; profile_id: string; pattern_kind: LanguagePatternRecord["patternKind"]; support: string; entropy: string; pattern_json: JsonValue; evidence_ids: string[]; updated_at: Date }
function rowToLanguagePattern(row: LanguagePatternRow): LanguagePatternRecord { return { id: row.id, profileId: row.profile_id, patternKind: row.pattern_kind, support: Number(row.support), entropy: Number(row.entropy), patternJson: row.pattern_json, evidenceIds: row.evidence_ids as EvidenceId[], updatedAt: row.updated_at.getTime() }; }

interface SemanticFrameRow { id: string; frame_json: JsonValue; embedding: string; evidence_ids: string[]; alpha: string; created_at: Date }
function rowToSemanticFrame(row: SemanticFrameRow): SemanticFrameRecord { return { id: row.id, frameJson: row.frame_json, embedding: parseVectorText(row.embedding, 64), evidenceIds: row.evidence_ids as EvidenceId[], alpha: Number(row.alpha), createdAt: row.created_at.getTime() }; }

function parseVectorText(value: string, dimensions: number): number[] {
  const body = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  const parsed = body ? body.split(",").map(item => Number(item.trim())) : [];
  if (parsed.length !== dimensions || parsed.some(item => !Number.isFinite(item))) return Array.from({ length: dimensions }, () => 0);
  return parsed;
}

interface TranslationAlignmentRow { id: string; source_frame_id: string; target_frame_id: string; source_language: string; target_language: string; force: TranslationAlignmentRecord["force"]; loss_vector: JsonValue; alignment_json: JsonValue; evidence_ids: string[]; updated_at: Date }
function rowToTranslationAlignment(row: TranslationAlignmentRow): TranslationAlignmentRecord { return { id: row.id, sourceFrameId: row.source_frame_id, targetFrameId: row.target_frame_id, sourceLanguage: row.source_language, targetLanguage: row.target_language, force: row.force, lossVector: row.loss_vector, alignmentJson: row.alignment_json, evidenceIds: row.evidence_ids as EvidenceId[], updatedAt: row.updated_at.getTime() }; }

interface BrainImportLedgerRow { id: string; import_run_id: string; brain_version: string; root_path: string; section_id: string; section_kind: BrainImportLedgerRecord["sectionKind"]; force_class: BrainImportLedgerRecord["forceClass"]; source_path: string | null; file_hash: string | null; shard_hash: string | null; source_version_id: string | null; evidence_ids: string[]; node_ids: string[]; row_counts_json: JsonValue; warnings: string[]; metadata_json: JsonValue; imported_at: Date }
function rowToBrainImportLedger(row: BrainImportLedgerRow): BrainImportLedgerRecord {
  return {
    id: row.id,
    importRunId: row.import_run_id,
    brainVersion: row.brain_version,
    rootPath: row.root_path,
    sectionId: row.section_id,
    sectionKind: row.section_kind,
    forceClass: row.force_class,
    sourcePath: row.source_path ?? undefined,
    fileHash: row.file_hash ?? undefined,
    shardHash: row.shard_hash ?? undefined,
    sourceVersionId: row.source_version_id ? row.source_version_id as SourceVersionId : undefined,
    evidenceIds: row.evidence_ids as EvidenceId[],
    nodeIds: row.node_ids,
    rowCounts: numericRecord(row.row_counts_json),
    warnings: row.warnings,
    metadata: row.metadata_json,
    importedAt: row.imported_at.getTime()
  };
}

interface BrainLifecycleRow {
  import_run_id: string;
  brain_version: string;
  root_path: string;
  state: BrainLifecycleState;
  manifest_json: BrainLifecycleRecord["manifest"];
  validation_json: BrainLifecycleRecord["validation"] | null;
  reason: string | null;
  revision: string | number;
  created_at: Date;
  updated_at: Date;
}

function rowToBrainLifecycle(row: BrainLifecycleRow): BrainLifecycleRecord {
  return {
    importRunId: row.import_run_id,
    brainVersion: row.brain_version,
    rootPath: row.root_path,
    state: row.state,
    manifest: row.manifest_json,
    validation: row.validation_json ?? undefined,
    reason: row.reason ?? undefined,
    revision: Number(row.revision),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime()
  };
}

function numericRecord(value: JsonValue): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = typeof raw === "number" ? raw : Number(raw) || 0;
  return out;
}

function sumCounts(value: Record<string, number>): number {
  return Object.values(value).reduce((sum, count) => sum + count, 0);
}

function languagePriorRows(value: Record<string, number>): number {
  return (value.language_units ?? 0) + (value.language_patterns ?? 0) + (value.ngram_observations ?? 0) + (value.ngram_models ?? 0) + (value.semantic_frames ?? 0);
}

function graphPriorRows(value: Record<string, number>): number {
  return (value.graph_nodes ?? 0) + (value.graph_edges ?? 0) + (value.graph_hyperedges ?? 0);
}

interface CorrectionRuleRow { id: string; episode_id: string; rule_kind: CorrectionRuleRecord["ruleKind"]; scope: string; pattern: string; replacement: string | null; weight: string; context_json: JsonValue; provenance_json: JsonValue; created_at: Date; updated_at: Date }
function rowToCorrectionRule(row: CorrectionRuleRow): CorrectionRuleRecord { return { id: row.id, episodeId: row.episode_id as EpisodeId, ruleKind: row.rule_kind, scope: row.scope, pattern: row.pattern, replacement: row.replacement ?? undefined, weight: Number(row.weight), contextJson: row.context_json, provenanceJson: row.provenance_json, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime() }; }

interface LocaleBundleRow { id: string; source_locale: string; target_language_id: string; target_script_id: string | null; status: LocaleBundleRecord["status"]; force: LocaleBundleRecord["force"]; messages_json: JsonValue; missing_terms_json: JsonValue; evidence_ids: string[]; translation_alignment_ids: string[]; created_at: Date; updated_at: Date }
function rowToLocaleBundle(row: LocaleBundleRow): LocaleBundleRecord { return { id: row.id, sourceLocale: row.source_locale, targetLanguageId: row.target_language_id, targetScriptId: row.target_script_id ?? undefined, status: row.status, force: row.force, messagesJson: row.messages_json, missingTermsJson: row.missing_terms_json, evidenceIds: row.evidence_ids as EvidenceId[], translationAlignmentIds: row.translation_alignment_ids, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime() }; }

interface PpfCacheRow { id: string; graph_hash: string; beta: string; personalization_json: JsonValue; mass_json: JsonValue; diagnostics_json: JsonValue; created_at: Date }
function rowToPpfCache(row: PpfCacheRow): PpfCacheRecord { return { id: row.id, graphHash: row.graph_hash, beta: Number(row.beta), personalizationJson: row.personalization_json, massJson: row.mass_json, diagnosticsJson: row.diagnostics_json, createdAt: row.created_at.getTime() }; }

interface AlphaTraceRow { id: string; graph_hash: string; alpha: string; trace_json: JsonValue; created_at: Date }
function rowToAlphaTraceRecord(row: AlphaTraceRow): AlphaTraceRecord { return { id: row.id, graphHash: row.graph_hash, alpha: Number(row.alpha), traceJson: row.trace_json, createdAt: row.created_at.getTime() }; }

interface SelfRewriteEpisodeRow { id: string; episode_id: string; target: string; program_graph_json: JsonValue; improvement_json: JsonValue; status: SelfRewriteEpisodeRecord["status"]; created_at: Date }
function rowToSelfRewriteEpisode(row: SelfRewriteEpisodeRow): SelfRewriteEpisodeRecord { return { id: row.id, episodeId: row.episode_id as EpisodeId, target: row.target, programGraphJson: row.program_graph_json, improvementJson: row.improvement_json, status: row.status, createdAt: row.created_at.getTime() }; }

interface SelfRewritePatchRow { id: string; rewrite_episode_id: string; file_path: string; before_hash: string | null; after_hash: string; patch_json: JsonValue; score_json: JsonValue; created_at: Date }
function rowToSelfRewritePatch(row: SelfRewritePatchRow): SelfRewritePatchRecord { return { id: row.id, rewriteEpisodeId: row.rewrite_episode_id, filePath: row.file_path, beforeHash: row.before_hash ?? undefined, afterHash: row.after_hash, patchJson: row.patch_json, scoreJson: row.score_json, createdAt: row.created_at.getTime() }; }

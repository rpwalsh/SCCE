// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Pool, type PoolClient } from "pg";
import { isSourceOwnedProjectProjection, SOURCE_OWNED_PROJECT_PROJECTION_PREFIX, projectContractDependencyEligibilitySql } from "./source-owned-project-projection.js";
import { consolidateCorpusSegmentation, loadCorpusSegmentationContextSlice } from "./corpus-segmentation-producer.js";
import { createCorpusSegmentationRun, openCorpusSegmentationRun, activateCorpusSegmentationRun, readActiveCorpusSegmentationRun } from "./corpus-segmentation-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { languageUnitMetadataMergeSql, SOURCE_METADATA_BINDING_SCHEMA } from "./unit-source-metadata.js";
import { sourceTranscriptArchiveAppendSql } from "./source-transcript-archive.js";
import { createCanonicalCreativeEventCodec, type CreativeEventStorageHost } from "./canonical-creative-event-store.js";
import { createConstructionSourceDecisionStore } from "./construction-source-decision-store.js";
import { createSourceArtifactMetadataCodec } from "./source-artifact-metadata.js";
import { DECODED_JSON_BYTE_LEDGER_KEY, DECODED_JSON_BYTE_LEDGER_SCHEMA } from "./decoded-json-byte-ledger.js";
import { DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID } from "./dialogue-conversational-checkpoint.js";
import { pooledProfileOwnershipSql, profileSourceOwnershipSql } from "./pooled-profile-ownership.js";
import {
  POSTGRES_REQUIRED_TABLES,
  STORAGE_STATUS_POPULATION_LIMITS,
  type StorageStatusOptions,
  type StorageStatusDetail,
  type StoragePopulationKind,
  POSTGRES_SCHEMA_VERSION,
  assertCanonicalHyperedge,
  createAlphaLayer,
  canonicalStringify,
  codeLanguageForModelRecord,
  createHasher,
  validatePooledLanguageProfileOwnership,
  isPreparedPooledLanguageProfileOwnership,
  languageProfileSignature,
  validateSourceLanguageCompilationHeader,
  validateSourceCompilationModelInventory,
  featureSet,
  anchorSymbolUnits,
  informationLabelAllowsRead,
  joinInformationLabels,
  corpusIdentityMatchSurface,
  normalizeSourceLanguageAlias,
  normalizePriorKey,
  normalizeInformationLabel,
  toJsonValue,
  LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  SOURCE_CODE_FUNCTION_PATTERN_SCHEMA,
  SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID,
  INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
  INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS,
  INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA,
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  hydrateLanguageSegmentationWitness,
  isLanguageSegmentationWitness,
  isLanguageSegmentationWitnessReference,
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
  CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
  REQUEST_SEED_PATTERN_JSON_FIELDS,
  REQUEST_SEED_FRAME_JSON_FIELDS,
  REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
  REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE,
  REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
  SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA,
  SOURCE_COMPUTATION_CONSTRUCTION_RECIPE,
  SOURCE_COMPUTATION_SOURCE_SYSTEM,
  CONTEXTUAL_QA_CONSTRUCTION_RECIPE,
  CONTEXTUAL_QA_SOURCE_SYSTEM,
  requestSeedSemanticFrame,
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
  type EvidenceBackedSourceVersionQuery,
  type ForecastState,
  type ForecastStore,
  type FlowCacheStore,
  type GraphEdge,
  type GraphNode,
  type GraphSliceQuery,
  type GraphStore,
  type Hyperedge,
  type InformationAccessContext,
  type InformationLabel,
  type IngestionCheckpoint,
  type IngestionCheckpointStore,
  type InteractionStateRecord,
  type JsonValue,
  type LanguageMemoryStore,
  type LanguagePatternRecord,
  type LanguagePatternProjection,
  type LanguageProfile,
  type LanguageUnitRecord,
  type LocaleBundleRecord,
  type LocalizationStore,
  type ModelState,
  type ModelStore,
  type NgramModelRecord,
  type NgramObservation,
  type PpfCacheRecord,
  aggregateGenome,
  type DurablePolicyGenome,
  type PolicyEvaluation,
  type PolicyEvolutionStore,
  type ExecutiveEpisodeId,
  type ExecutiveEvent,
  type ExecutiveEventJournal,
  type SparseRankingCheckpoint,
  type SparseRankingModelLifecycle,
  type SparseRankingModelStore,
  type RelationPotentialModelStore,
  type RelationPotentialArtifactRecord,
  type RelationPotentialModel,
  type RelationPotentialValidation,
  assertPromotableRelationPotentialArtifact,
  assertValidRelationPotentialModel,
  type SparseRankingComparisonExample,
  type SparseRankingComparisonLogStore,
  type PairwiseLabelSource,
  foldSegmentationAggregate,
  type SegmentationAggregate,
  type SegmentationAggregateKey,
  type SegmentationAggregateStore,
  type InducedLanguageModel,
  type InducedLanguageModelRecord,
  type InducedLanguageModelStore,
  type LanguageSegmentationWitnessReference,
  type SegmentationPopulationModel,
  type SegmentationPopulationModelRecord,
  type SegmentationPopulationModelStore,
  type LanguageIdentityRecord,
  type LanguageIdentityStore,
  type LanguageProfileSignatureRow,
  type ProofId,
  type ProofStore,
  type QuarantineSource,
  type QuarantineStore,
  type RelationObservationRecord,
  type RelationObservationStore,
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
  type SourceTrust,
  type SourceVersion,
  type SourceVersionId,
  type TargetProfilePatternRecord,
  type TemporalGraph,
  type TemporalGraphQuery,
  type TranslationAlignmentRecord,
  type UserCorrectionRecord,
  type UserModelClaimRecord,
  type UserModelClaimStore,
  type TaskResumptionSnapshotRecord,
  type TaskResumptionSnapshotStore,
  type DocumentGenerationSessionRecord,
  isBrainLifecycleState,
  type DocumentGenerationSessionStore,
  type TranslationSeed,
  type TranslationSeedStore,
  type TranslationConstruction,
  type TranslationConstructionStore,
  type TranslationCorrectionStore,
  type UserCorrectionAlignmentRecord,
  canonicalTranslationTargetKey,
  resolveEvidenceSourceIdentity
} from "@scce/kernel";
import { createHash } from "node:crypto";
import {
  DEFERRED_INDEX_META_KEY,
  DEFERRED_INDEX_RESTORE_SORT_MEMORY,
  DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS,
  BULK_LOAD_DEFERRABLE_TABLES,
  schemaStatements,
  isDuplicateExtensionError,
  freshSchemaIndexStatements,
  requiredHydrationColumns,
  type InformationLabeledTable
} from "./postgres-schema.js";
export {
  DEFERRED_INDEX_META_KEY,
  DEFERRED_INDEX_RESTORE_SORT_MEMORY,
  DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS,
  BULK_LOAD_DEFERRABLE_TABLES,
  schemaStatements,
  isDuplicateExtensionError
} from "./postgres-schema.js";

const ARCHIVAL_LANGUAGE_PATTERN_SCHEMAS = Object.freeze([
  SOURCE_SEGMENTATION_WITNESS_SCHEMA,
  LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA
]);
const INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA_PREFIX = "scce.induced_language_model.syntax_memory.";


export interface PostgresStorageOptions {
  url: string;
  schema: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  informationAccess?: InformationAccessContext;
}

/**
 * How the guarded read is bounded. It decides how the information label is SPELLED, never what it decides.
 *
 * The label is one access decision whose true selectivity is 1.0000 on every guarded table, but spelled as four
 * conjuncts the planner multiplies four unestimable selectivities, estimates one surviving row, and so discards every
 * LIMIT-aware ordered index path. Measured on scce3_runtime, byte-identical results either way:
 *
 *   listNgramModels     2248ms / 318MB (Bitmap Heap Scan)  ->   625ms /  96MB (Index Scan)
 *   listLanguageUnits    900ms / 145MB (Parallel Bitmap)   ->   230ms /  24MB (Index Scan)
 *   listSemanticFrames   507ms /1030MB (Parallel Seq Scan) ->    13ms /   9MB (Index Scan)
 *
 * Only safe where an ORDER BY and a LIMIT bound the read. On an unbounded scan the truthful estimate costs Gather more
 * per row and Postgres drops its parallel workers: listLanguagePatterns measured 18.9s -> 66.7s for the same 6.7GB.
 */
export type InformationAccessReadShape = "unbounded" | "bounded_by_order_and_limit";

export class PostgresStorageAdapter implements ScceStorage {
  readonly pool: Pool;
  readonly schema: string;
  readonly q: string;
  readonly url: string;
  readonly informationAccess?: InformationAccessContext;
  readonly events: EventLedger;
  readonly conversation: ConversationStore;
  readonly ingestion: IngestionCheckpointStore;
  readonly graph: GraphStore;
  readonly evidence: EvidenceStore;
  readonly blobs: BlobStore;
  readonly quarantine: QuarantineStore;
  readonly relationObservations: RelationObservationStore;
  readonly proofs: ProofStore;
  readonly constructs: ConstructStore;
  readonly capabilities: CapabilityAuditStore;
  readonly forecasts: ForecastStore;
  readonly benchmarks: BenchmarkStore;
  readonly model: ModelStore;
  readonly languageMemory: LanguageMemoryStore;
  readonly brainImports: BrainImportStore;
  readonly corrections: CorrectionMemoryStore;
  readonly userModelClaims: UserModelClaimStore;
  readonly taskResumption: TaskResumptionSnapshotStore;
  readonly documentGeneration: DocumentGenerationSessionStore;
  readonly translationSeeds: TranslationSeedStore;
  readonly translationConstructions: TranslationConstructionStore;
  readonly translationCorrections: TranslationCorrectionStore;
  readonly localization: LocalizationStore;
  readonly flowCache: FlowCacheStore;
  readonly selfRewrite: SelfRewriteStore;
  readonly workspace: WorkspaceStore;
  readonly dialogueMemory: DialogueMemoryStore;
  readonly policyEvolution: PolicyEvolutionStore;
  readonly sparseRanking: SparseRankingModelStore;
  readonly relationPotentialModels: RelationPotentialModelStore;
  readonly sparseRankingComparisons: SparseRankingComparisonLogStore;
  readonly segmentationAggregates: SegmentationAggregateStore;
  readonly inducedLanguageModels: InducedLanguageModelStore;
  readonly segmentationPopulations: SegmentationPopulationModelStore;
  readonly corpusSegmentation: import("@scce/kernel").CorpusSegmentationStore & {
    createRun:(input:Parameters<typeof createCorpusSegmentationRun>[1],bounds:Parameters<typeof createCorpusSegmentationRun>[2])=>ReturnType<typeof createCorpusSegmentationRun>;
    openRun:(id:string,bounds:Parameters<typeof openCorpusSegmentationRun>[2])=>ReturnType<typeof openCorpusSegmentationRun>;
    activate:(run:Parameters<typeof activateCorpusSegmentationRun>[1],inference:Parameters<typeof activateCorpusSegmentationRun>[2])=>ReturnType<typeof activateCorpusSegmentationRun>;
  } = {
    consolidate: (input: Omit<Parameters<typeof consolidateCorpusSegmentation>[0],"storage">) => consolidateCorpusSegmentation({...input,storage:this}),
    createRun: (input: Parameters<typeof createCorpusSegmentationRun>[1], bounds: Parameters<typeof createCorpusSegmentationRun>[2]) => createCorpusSegmentationRun(this,input,bounds),
    openRun: (id: string,bounds: Parameters<typeof openCorpusSegmentationRun>[2]) => openCorpusSegmentationRun(this,id,bounds),
    activate: (run: Parameters<typeof activateCorpusSegmentationRun>[1],inference: Parameters<typeof activateCorpusSegmentationRun>[2]) => activateCorpusSegmentationRun(this,run,inference),
    readActive: async (scope: Parameters<typeof readActiveCorpusSegmentationRun>[1],required: Parameters<typeof readActiveCorpusSegmentationRun>[2],bounds: Parameters<typeof readActiveCorpusSegmentationRun>[3],consistency?: Parameters<typeof readActiveCorpusSegmentationRun>[4]) => {
      const active=await readActiveCorpusSegmentationRun(this,scope,required,bounds,consistency);
      if(!active)return null;
      const inference=active.inference;
      return {...active,loader:{identity:{id:inference.id,sourceInventory:inference.sourceInventory,featureContextId:inference.featureContextId,normalizationContractId:inference.normalizationContractId},
        resolve:async(preparations:readonly import("@scce/kernel").PreparedCorpusSegmentationMeasurement[])=>{
          const slices:Array<import("@scce/kernel").VerifiedCorpusSegmentation["slices"][number]>=[];for(const preparation of preparations)slices.push({preparation,contextSlice:await loadCorpusSegmentationContextSlice({storage:this,run:active.run,measurement:preparation,expected:inference})});
          return {populationInference:inference,slices};
        }}};
    }
  };
  readonly languageIdentities: LanguageIdentityStore;
  private readonly transactionContext = new AsyncLocalStorage<PoolClient>();
  private readonly languageRevisionDirty = new WeakSet<PoolClient>();

  constructor(options: PostgresStorageOptions) {
    if (!/^postgres(?:ql)?:\/\//i.test(options.url)) throw new Error("SCCE v3 requires PostgreSQL; storage adapter received a non-Postgres URL.");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.schema)) throw new Error(`unsafe postgres schema: ${options.schema}`);
    this.schema = options.schema;
    this.q = `"${options.schema}"`;
    this.url = options.url;
    this.informationAccess = options.informationAccess;
    this.pool = new Pool({ connectionString: options.url, ssl: options.ssl });
    this.events = createEventLedger(this);
    this.conversation = createConversationStore(this);
    this.ingestion = createIngestionCheckpointStore(this);
    this.blobs = createBlobStore(this);
    this.evidence = createEvidenceStore(this);
    this.graph = createGraphStore(this);
    this.quarantine = createQuarantineStore(this);
    this.relationObservations = createRelationObservationStore(this);
    this.proofs = createProofStore(this);
    this.constructs = createConstructStore(this);
    this.capabilities = createCapabilityStore(this);
    this.forecasts = createForecastStore(this);
    this.benchmarks = createBenchmarkStore(this);
    this.model = createModelStore(this);
    this.languageMemory = createLanguageMemoryStore(this);
    this.brainImports = createBrainImportStore(this);
    this.corrections = createCorrectionMemoryStore(this);
    this.userModelClaims = createUserModelClaimStore(this);
    this.taskResumption = createTaskResumptionSnapshotStore(this);
    this.documentGeneration = createDocumentGenerationSessionStore(this);
    this.translationSeeds = createTranslationSeedStore(this);
    this.translationConstructions = createTranslationConstructionStore(this);
    this.translationCorrections = createTranslationCorrectionStore(this);
    this.localization = createLocalizationStore(this);
    this.flowCache = createFlowCacheStore(this);
    this.selfRewrite = createSelfRewriteStore(this);
    this.workspace = createWorkspaceStore(this);
    this.dialogueMemory = createDialogueMemoryStore(this);
    this.policyEvolution = createPolicyEvolutionStore(this);
    this.sparseRanking = createSparseRankingModelStore(this);
    this.relationPotentialModels = createRelationPotentialModelStore(this);
    this.sparseRankingComparisons = createSparseRankingComparisonLogStore(this);
    this.segmentationAggregates = createSegmentationAggregateStore(this);
    this.inducedLanguageModels = createInducedLanguageModelStore(this);
    this.segmentationPopulations = createSegmentationPopulationModelStore(this);
    this.languageIdentities = createLanguageIdentityStore(this);
  }

  table(name: string): string {
    if (!POSTGRES_REQUIRED_TABLES.includes(name as never)) throw new Error(`unknown SCCE table: ${name}`);
    return `${this.q}."${name}"`;
  }

  /**
   * Normal startup verifies the schema; it does not silently mutate it.
   * Migration is explicit (`pnpm scce db migrate`, `POST /api/db/migrate`,
   * or `resetLocalDevOnly`) except under the local-development opt-in below.
   */
  async init(): Promise<void> {
    if (startupMigrationOptIn()) {
      await this.migrate();
      return;
    }
    const verification = await this.verify();
    if (!verification.ok) {
      throw new Error(
        `SCCE storage schema is missing or incompatible (${verification.errors.slice(0, 8).join("; ")}). ` +
        "Run 'pnpm scce db migrate' (or POST /api/db/migrate) before starting the server, " +
        "or set SCCE_STARTUP_MIGRATE=1 for local development to migrate automatically at startup."
      );
    }
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Asked before anything is created: an absent ngram_models is what makes this schema new rather than migrated.
      const existing = await client.query<{ present: string | null }>(`SELECT to_regclass($1) AS present`, [`${this.schema}.ngram_models`]);
      const freshSchema = existing.rows[0]?.present === null;
      const restoringDeferredIndexes = await this.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM ${this.table("storage_meta")} WHERE key=$1) AS present`,
        [DEFERRED_INDEX_META_KEY]
      ).then(rows => rows[0]?.present === true).catch(() => false);
      await client.query("BEGIN");
      if (restoringDeferredIndexes) {
        // Building an index is a sort. At the 64MB default against a table of this size (measured: 15,465,844
        // observations, 32GB) the sort spills to disk repeatedly and a deferred build is no faster than the
        // per-row maintenance it replaced. SET LOCAL scopes this to the restore transaction only.
        await client.query(`SET LOCAL maintenance_work_mem = '${DEFERRED_INDEX_RESTORE_SORT_MEMORY}'`);
        await client.query(`SET LOCAL max_parallel_maintenance_workers = ${DEFERRED_INDEX_RESTORE_PARALLEL_WORKERS}`);
      }
      for (const statement of schemaStatements(this.q, this.informationAccess)) {
        // An extension is database-wide, so every schema's migration asks for the same one. IF NOT EXISTS does not
        // make that race-safe: two concurrent migrations both pass the check and the loser fails the unique index,
        // rolling back a migration that was otherwise complete. Already-present is the outcome either way.
        if (/^\s*CREATE EXTENSION/iu.test(statement)) {
          await client.query("SAVEPOINT scce_extension");
          try {
            await client.query(statement);
            await client.query("RELEASE SAVEPOINT scce_extension");
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT scce_extension");
            if (!isDuplicateExtensionError(error)) throw error;
          }
          continue;
        }
        await client.query(statement);
      }
      if (freshSchema) for (const statement of freshSchemaIndexStatements(this.q)) await client.query(statement);
      await backfillSemanticFrameSurfaceHashes(this, client);
      const schemaErrors = await requiredSchemaErrors(client, this.schema);
      if (schemaErrors.length) throw new Error(`schema migration incomplete: ${schemaErrors.slice(0, 12).join("; ")}`);
      await client.query(
        `INSERT INTO ${this.table("storage_meta")}(key, value_json, updated_at)
         VALUES('schema_version', $1::jsonb, NOW())
         ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=NOW()`,
        [JSON.stringify({ version: POSTGRES_SCHEMA_VERSION, requiredTables: POSTGRES_REQUIRED_TABLES })]
      );
      // Migration declares every index with CREATE INDEX IF NOT EXISTS, so reaching here means a bulk-load
      // deferral has just been undone. Clearing the marker here is what makes migrate the single way back.
      await client.query(`DELETE FROM ${this.table("storage_meta")} WHERE key=$1`, [DEFERRED_INDEX_META_KEY]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async verify(): Promise<{ ok: boolean; tables: string[]; errors: string[] }> {
    const [rows, vector, columns] = await Promise.all([
      this.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
        [this.schema]
      ),
      this.query<{ installed: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS installed`),
      this.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=$1`,
        [this.schema]
      )
    ]);
    const tables = rows.map(row => row.table_name);
    const missing = POSTGRES_REQUIRED_TABLES.filter(table => !tables.includes(table));
    const errors = missing.map(table => `missing table: ${table}`);
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
    if (tables.includes("storage_meta")) {
      // A brain whose read indexes were dropped for a bulk corpus build answers slowly and ranks wrongly while
      // looking healthy. Verification is the thing that must refuse it, so a half-indexed brain cannot be served.
      const deferred = await deferredBulkLoadIndexes(this).catch(() => []);
      if (deferred.length) errors.push(`indexes deferred for bulk load (run db migrate to restore): ${deferred.join(", ")}`);
    }
    return { ok: errors.length === 0, tables, errors };
  }

  private readonly statusInFlight = new Map<string, Promise<JsonValue>>();

  status(options: StorageStatusOptions = {}): Promise<JsonValue> {
    const detail = options.detail ?? "readiness", population = options.population ?? "launch";
    if (!["readiness", "population", "exact"].includes(detail) || !["launch", "questions"].includes(population)
      || (detail !== "population" && options.population !== undefined)) return Promise.reject(new Error("invalid storage status detail"));
    const key = detail === "population" ? `${detail}:${population}` : detail;
    const pending = this.statusInFlight.get(key);
    if (pending) return pending;
    const load = this.loadStatus(detail, population).finally(() => this.statusInFlight.delete(key));
    this.statusInFlight.set(key, load);
    return load;
  }

  private async loadStatus(detail: StorageStatusDetail, population: StoragePopulationKind): Promise<JsonValue> {
    const countSemantics = detail === "exact" ? "postgres_exact_table_counts"
      : detail === "population" ? "postgres_bounded_population" : "postgres_schema_readiness";
    try {
      const verify = await this.verify();
      const [meta, active] = await Promise.all([
        this.query<{ value_json: JsonValue; updated_at: Date }>(
          `SELECT value_json, updated_at FROM ${this.table("storage_meta")} WHERE key='schema_version'`
        ),
        this.brainImports.active()
      ]);
      const counts: Record<string, number> = {};
      const probes: Record<string, JsonValue> = {};
      const countErrors: string[] = [];
      const limits: Readonly<Record<string, number>> = STORAGE_STATUS_POPULATION_LIMITS[population];
      const tables = detail === "exact" ? POSTGRES_REQUIRED_TABLES : detail === "population" ? Object.keys(limits) : [];
      for (const table of tables) {
        if (!verify.tables.includes(table)) continue;
        try {
          const cap = limits[table]!;
          const rows = detail === "exact"
            ? await this.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${this.table(table)}`)
            : await this.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM (SELECT 1 FROM ${this.table(table)} LIMIT $1) AS population_probe`, [cap]);
          const count = Number(rows[0]?.count);
          if (!Number.isSafeInteger(count) || count < 0 || (detail === "population" && count > cap)) throw new Error("invalid row measurement");
          if (detail === "exact") counts[table] = count;
          else probes[table] = { sampledRows: count, cap, exact: count < cap, capReached: count === cap };
        } catch (error) {
          countErrors.push(`${detail === "exact" ? "exact count" : "population probe"} failed for ${table}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const schemaVersion = meta[0]?.value_json && typeof meta[0].value_json === "object" && !Array.isArray(meta[0].value_json)
        ? (meta[0].value_json as Record<string, JsonValue>).version
        : undefined;
      return {
        schema: "scce.postgres.status.v1",
        detail,
        ok: verify.ok && countErrors.length === 0,
        connected: true,
        database: { schema: this.schema, urlConfigured: true },
        schemaVersion: schemaVersion ?? null,
        expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
        tableCount: verify.tables.length,
        requiredTableCount: POSTGRES_REQUIRED_TABLES.length,
        countSemantics,
        ...(detail === "exact" ? { tableCounts: counts } : detail === "population" ? { population, tablePopulation: probes } : {}),
        health: verify.ok && countErrors.length === 0 ? "ready" : "needs_migration",
        activeBrain: active,
        errors: [...verify.errors, ...countErrors]
      };
    } catch (error) {
      return {
        schema: "scce.postgres.status.v1",
        detail,
        ok: false,
        connected: false,
        database: { schema: this.schema, urlConfigured: true },
        schemaVersion: null,
        expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
        countSemantics,
        ...(detail === "exact" ? { tableCounts: {} } : detail === "population" ? { population, tablePopulation: {} } : {}),
        health: "unreachable",
        activeBrain: { activeImportRunIds: [] },
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  async stats(): Promise<JsonValue> {
    const rows = await this.query<{ relname: string; estimated_rows: string }>(
      `SELECT c.relname,
              GREATEST(COALESCE(s.n_live_tup, 0), COALESCE(c.reltuples, 0), 0)::bigint::text AS estimated_rows
         FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
        WHERE n.nspname=$1 AND c.relkind IN ('r','p')
        ORDER BY c.relname`,
      [this.schema]
    );
    return {
      schema: "scce.postgres.stats.v1",
      exact: false,
      countSemantics: "postgres_planner_estimate",
      tables: rows.map(row => ({ table: row.relname, rows: Number(row.estimated_rows), estimated: true }))
    };
  }

  requireInformationAccess(): InformationAccessContext {
    const access = this.informationAccess;
    if (!access?.tenantId.trim() || !access.principalId.trim()) {
      throw new Error("active cognitive storage query requires an explicit information access context");
    }
    return access;
  }

  requireWritableInformationLabel(label: InformationLabel | undefined): InformationLabel {
    if (!label) throw new Error("new durable cognitive record requires an information label");
    const normalized = normalizeInformationLabel(label);
    if (!informationLabelAllowsRead(normalized, this.requireInformationAccess())) {
      throw new Error("information label write denied for active access context");
    }
    return normalized;
  }

  informationAccessPredicate(
    alias: string,
    firstParameter: number,
    readShape: InformationAccessReadShape = "unbounded"
  ): { sql: string; params: unknown[] } {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("unsafe information-label SQL alias");
    const access = this.requireInformationAccess();
    const exportClasses = informationExportClassesThrough(access.maximumExportClass);
    const decision = `(
        (${alias}.information_label->>'exportClass' = 'public' OR ${alias}.information_label->>'tenantId' = $${firstParameter})
        AND ${alias}.information_label->>'exportClass' = ANY($${firstParameter + 1}::text[])
        AND (
          JSONB_ARRAY_LENGTH(${alias}.information_label->'principals') = 0
          OR (${alias}.information_label->'principals') ? $${firstParameter + 2}
        )
        AND (${alias}.information_label->'compartments') <@ $${firstParameter + 3}::jsonb
      )`;
    return {
      sql: readShape === "bounded_by_order_and_limit" ? `(CASE WHEN ${decision} THEN TRUE ELSE FALSE END)` : decision,
      params: [
        access.tenantId.trim(),
        exportClasses,
        access.principalId.trim(),
        JSON.stringify([...new Set(access.compartments.map(value => value.normalize("NFKC").trim()).filter(Boolean))])
      ]
    };
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
    const result = await (this.transactionContext.getStore() ?? this.pool).query(sql, params);
    return result.rows as T[];
  }

  requireActiveTransaction(operation: string): void {
    if (!this.transactionContext.getStore()) throw new Error(`${operation} requires an active transaction`);
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active) return operation();
    return this.tx(async client => {
      try {
        const result = await this.transactionContext.run(client, operation);
        if (this.languageRevisionDirty.has(client)) await client.query(languageMemoryRevisionIncrementSql(this));
        return result;
      } finally { this.languageRevisionDirty.delete(client); }
    });
  }

  async mutateLanguageMemory(sql: string, params: unknown[] = []): Promise<boolean> {
    return this.transaction(async () => {
      const changed = await this.query(`${sql} RETURNING 1 AS language_memory_changed`, params);
      if (!changed.length) return false;
      this.markLanguageMemoryChanged();
      return true;
    });
  }

  markLanguageMemoryChanged(): void {
    this.requireActiveTransaction("language-memory revision mutation");
    this.languageRevisionDirty.add(this.transactionContext.getStore()!);
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const active = this.transactionContext.getStore();
    if (active) return fn(active);
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

export const LANGUAGE_MEMORY_REVISION_KEY = "language_memory.revision";

function languageMemoryRevisionIncrementSql(storage: PostgresStorageAdapter): string {
  return `INSERT INTO ${storage.table("storage_meta")} AS revision(key,value_json,updated_at)
    VALUES('${LANGUAGE_MEMORY_REVISION_KEY}','1'::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value_json=to_jsonb((revision.value_json #>> '{}')::numeric + 1),updated_at=NOW()`;
}

export async function deferredBulkLoadIndexes(storage: PostgresStorageAdapter): Promise<string[]> {
  const rows = await storage.query<{ value_json: { indexes?: string[] } }>(
    `SELECT value_json FROM ${storage.table("storage_meta")} WHERE key=$1`,
    [DEFERRED_INDEX_META_KEY]
  );
  return rows[0]?.value_json?.indexes ?? [];
}

export async function deferBulkLoadIndexes(
  storage: PostgresStorageAdapter,
  schema: string
): Promise<{ deferred: string[]; alreadyDeferred: string[] }> {
  const alreadyDeferred = await deferredBulkLoadIndexes(storage);
  const present = await storage.query<{ indexname: string; tablename: string }>(
    `SELECT indexname, tablename FROM pg_indexes
     WHERE schemaname=$1 AND tablename=ANY($2) AND indexname NOT LIKE '%\\_pkey'
     ORDER BY indexname`,
    [schema, [...BULK_LOAD_DEFERRABLE_TABLES]]
  );
  const deferred = [...new Set([...alreadyDeferred, ...present.map(row => row.indexname)])].sort();
  if (!deferred.length) return { deferred, alreadyDeferred };
  // The marker is written before the drops so a crash mid-drop still leaves verification refusing the schema.
  await storage.query(
    `INSERT INTO ${storage.table("storage_meta")}(key, value_json, updated_at)
     VALUES($1, $2::jsonb, NOW())
     ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=NOW()`,
    [DEFERRED_INDEX_META_KEY, JSON.stringify({ indexes: deferred, tables: [...BULK_LOAD_DEFERRABLE_TABLES] })]
  );
  for (const row of present) await storage.query(`DROP INDEX IF EXISTS "${schema}"."${row.indexname}"`);
  return { deferred, alreadyDeferred };
}

export async function joinDurableRecordLabels(
  storage: PostgresStorageAdapter,
  table: InformationLabeledTable,
  records: readonly { id: string; informationLabel?: InformationLabel }[]
): Promise<Map<string, InformationLabel>> {
  const access = storage.requireInformationAccess();
  const labelsById = new Map<string, InformationLabel[]>();
  for (const record of records) {
    const label = storage.requireWritableInformationLabel(record.informationLabel);
    labelsById.set(record.id, [...(labelsById.get(record.id) ?? []), label]);
  }
  const ids = [...labelsById.keys()].sort();
  // Advisory xact locks serialize concurrent label-joins on the same record
  // id until COMMIT (a concurrent transaction's read of existing labels must
  // wait for this one's write to land, or its merge silently drops labels).
  // One lock PER RECORD held to commit is the same guarantee with unbounded
  // shared-lock-table use: a single whole-novel training transaction takes
  // tens of thousands of them and dies with Postgres "out of shared memory"
  // (max_locks_per_transaction) -- verified live against a real book.
  // Hashing ids into 256 fixed buckets keeps the exact cross-transaction
  // contention property (two transactions touching the same id always meet
  // on its bucket) while bounding this transaction's lock-table use to at
  // most 256 entries regardless of batch size; unrelated ids sharing a
  // bucket only ever cost a short wait, never a correctness change.
  // Advisory lock keys are database-wide, so the bucket alone made every schema and every labeled table
  // share one 256-bucket space: an ingest into one schema deadlocked an ingest into another over records
  // that have nothing to do with each other. The first key namespaces the buckets to this qualified table.
  // The ORDER BY must sit INSIDE the subquery: in the outer query Postgres evaluates the lock function per
  // unordered row and sorts the results, so the deterministic acquisition order this relies on was not real.
  await storage.query(
    `WITH namespace AS (SELECT (hashtextextended($2, 0) & 2147483647)::int AS key)
     SELECT pg_advisory_xact_lock(namespace.key, buckets.bucket)
     FROM namespace, (
       SELECT DISTINCT (hashtextextended(record_id, 0) & 255)::int AS bucket
       FROM unnest($1::text[]) AS record(record_id)
       ORDER BY bucket
     ) buckets`,
    [ids, storage.table(table)]
  );
  const existing = await storage.query<{ id: string; information_label: InformationLabel }>(
    `SELECT id, information_label
     FROM ${storage.table(table)}
     WHERE id=ANY($1)
     FOR UPDATE`,
    [ids]
  );
  for (const row of existing) {
    labelsById.set(row.id, [normalizeInformationLabel(row.information_label), ...(labelsById.get(row.id) ?? [])]);
  }
  return new Map([...labelsById].map(([id, labels]) => {
    const joined = joinInformationLabels(labels, {
      explicitMergeAuthority: access.explicitMergeAuthority === true
    });
    return [id, storage.requireWritableInformationLabel(joined)];
  }));
}

function appendInformationAccess(
  storage: PostgresStorageAdapter,
  alias: string,
  params: unknown[],
  where: string[],
  readShape: InformationAccessReadShape = "unbounded"
): void {
  const access = storage.informationAccessPredicate(alias, params.length + 1, readShape);
  where.push(access.sql);
  params.push(...access.params);
}

function informationExportClassesThrough(maximum: InformationAccessContext["maximumExportClass"]): string[] {
  const ordered: InformationAccessContext["maximumExportClass"][] = [
    "public",
    "internal",
    "confidential",
    "restricted"
  ];
  return ordered.slice(0, ordered.indexOf(maximum) + 1);
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

function startupMigrationOptIn(): boolean {
  return process.env.SCCE_STARTUP_MIGRATE === "1";
}

function isLocalDatabaseUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

const EVENT_INSERT_COLUMN_TYPES = ["text", "text", "text", "bigint", "jsonb", "text[]", "text", "text"] as const;
// The extended query protocol counts bind parameters in an unsigned 16-bit field, so the wire format -- not a
// tuning choice -- is what splits one batch into more than one statement.
const POSTGRES_BIND_PARAMETER_LIMIT = 65535;
const EVENT_INSERT_MAX_ROWS_PER_STATEMENT = Math.floor(POSTGRES_BIND_PARAMETER_LIMIT / EVENT_INSERT_COLUMN_TYPES.length);
const EVENT_LEDGER_HEAD_KEY = "events.ledger_head.v1";

interface EventLedgerHead { eventId: string; eventHash: string; ledgerHash: string }

function eventIdentityConflict(id: string): Error & { code: "SCCE_EVENT_IDENTITY_CONFLICT" } {
  return Object.assign(new Error(`event identity has different immutable content: ${id}`), { code: "SCCE_EVENT_IDENTITY_CONFLICT" as const });
}

async function readEventLedgerHead(query: (sql: string, params: readonly unknown[]) => Promise<Array<{ value_json: EventLedgerHead }>>, metadataTable: string): Promise<EventLedgerHead | undefined> {
  const rows = await query(`SELECT value_json FROM ${metadataTable} WHERE key=$1`, [EVENT_LEDGER_HEAD_KEY]);
  const head = rows[0]?.value_json;
  if (rows.length && (!head || [head.eventId, head.eventHash, head.ledgerHash].some(value => typeof value !== "string" || !value))) throw new Error("invalid canonical event ledger head");
  return head;
}

function canonicalCodecHost(storage: PostgresStorageAdapter, client?: PoolClient): CreativeEventStorageHost {
  return {
    table: name => storage.table(name),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => client
      ? (await client.query(sql, params)).rows as T[] : storage.query<T>(sql, params),
    transaction: operation => client ? operation() : storage.transaction(operation),
    requireWritableInformationLabel: label => storage.requireWritableInformationLabel(label),
    informationAccessPredicate: (alias, firstParameter) => storage.informationAccessPredicate(alias, firstParameter),
    informationAccess: storage.informationAccess
  };
}

function canonicalCreativeCodec(storage: PostgresStorageAdapter, client?: PoolClient) {
  const host = canonicalCodecHost(storage, client);
  const base = createCanonicalCreativeEventCodec(host);
  const decisions = createConstructionSourceDecisionStore({
    ...host,
    evidence: ids => readEvidenceBatch(host, ids)
  });
  const encodeMany = async (inputs: readonly { value: unknown; informationLabel?: InformationLabel }[]): Promise<unknown[]> => {
    const encoded = await base.encodeMany(inputs);
    return decisions.encodeMany(encoded.map((value, index) => ({
      value, informationLabel: inputs[index]!.informationLabel, logicalValue: inputs[index]!.value
    })));
  };
  return {
    encode: async (value: unknown, informationLabel?: InformationLabel) => (await encodeMany([{ value, informationLabel }]))[0],
    encodeMany,
    async decodeMany(values: readonly unknown[]): Promise<unknown[]> {
      return base.decodeMany(await decisions.decodeMany(values));
    }
  };
}

async function readEvidenceBatch(host: Pick<CreativeEventStorageHost, "table" | "query" | "informationAccessPredicate">, ids: readonly string[]): Promise<EvidenceSpan[]> {
  if (!ids.length) return [];
  const access = host.informationAccessPredicate("evidence", 2);
  const rows = await host.query<EvidenceRow>(`SELECT * FROM ${host.table("evidence_spans")} evidence WHERE id=ANY($1) AND ${access.sql}`, [ids, ...access.params]);
  return rows.map(rowToEvidence);
}

function sourceArtifactMetadataCodec(storage: PostgresStorageAdapter) {
  return createSourceArtifactMetadataCodec(canonicalCodecHost(storage));
}

function sourceArtifactJsonBytesSql(expression: string): string {
  const ledger = `${expression}->'${DECODED_JSON_BYTE_LEDGER_KEY}'`;
  return `CASE WHEN ${ledger}->>'schema'='${DECODED_JSON_BYTE_LEDGER_SCHEMA}'
    AND jsonb_typeof(${ledger}->'decodedJsonbBytes')='number'
    THEN (${ledger}->>'decodedJsonbBytes')::numeric ELSE octet_length(${expression}::text) END`;
}

function isSourceCompilationMetadataHolder(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === "scce.source_language_compilation_receipt.v1";
}

async function mergedSourceArtifactValues(storage: PostgresStorageAdapter, table: "ngram_models" | "language_units", column: "model_json" | "metadata_json", inputs: readonly { id: string; value: JsonValue; sourceVersionId?: string; informationLabel?: InformationLabel }[]): Promise<JsonValue[]> {
  const rows = await storage.query<{ id: string; value: JsonValue; source_version_id?: string; information_label: InformationLabel }>(
    `SELECT id,${column} AS value,information_label${table === "language_units" ? ",source_version_id" : ""} FROM ${storage.table(table)} WHERE id=ANY($1::text[]) FOR UPDATE`, [inputs.map(input => input.id)]);
  if (!rows.length) return inputs.map(input => input.value);
  const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(rows.map(row => ({ value: row.value, informationLabel: row.information_label })));
  if (table === "language_units") {
    const merged = await storage.query<{ id: string; value: JsonValue }>(
      `SELECT lu.id,${languageUnitMetadataMergeSql(storage.table("source_versions"))} AS value
       FROM jsonb_to_recordset($1::jsonb) AS lu(id text,source_version_id text,information_label jsonb,metadata_json jsonb)
       JOIN jsonb_to_recordset($2::jsonb) AS EXCLUDED(id text,source_version_id text,information_label jsonb,metadata_json jsonb) ON EXCLUDED.id=lu.id`,
      [canonicalStringify(rows.map((row, index) => ({ id: row.id, source_version_id: row.source_version_id, information_label: row.information_label, metadata_json: decoded[index] }))),
        canonicalStringify(inputs.map(input => ({ id: input.id, source_version_id: input.sourceVersionId, information_label: input.informationLabel, metadata_json: input.value })))]);
    const values = new Map(merged.map(row => [row.id, row.value]));
    if (merged.length !== rows.length) throw new Error("unit logical metadata merge omitted an existing record");
    return inputs.map(input => values.has(input.id) ? values.get(input.id)! : input.value);
  }
  const prior = new Map(rows.map((row, index) => [row.id, decoded[index] as JsonValue]));
  return inputs.map(input => {
    if (!prior.has(input.id)) return input.value;
    const left = prior.get(input.id)!, right = input.value;
    return left !== null && typeof left === "object" && !Array.isArray(left) && right !== null && typeof right === "object" && !Array.isArray(right)
      ? { ...left, ...right } : [...(Array.isArray(left) ? left : [left]), ...(Array.isArray(right) ? right : [right])];
  });
}

function createEventLedger(storage: PostgresStorageAdapter): EventLedger {
  const appendQueues = new WeakMap<PoolClient, Promise<void>>();
  return {
    append: event => storage.events.appendBatch([event]),
    async appendBatch(events) {
      if (events.length === 0) return;
      const unique = new Map<string, ScceEvent>();
      for (const event of events) {
        const prior = unique.get(String(event.id));
        if (prior && canonicalStringify(prior) !== canonicalStringify(event)) throw eventIdentityConflict(String(event.id));
        unique.set(String(event.id), event);
      }
      await storage.tx(async client => {
        await serializeEventAppend(client, appendQueues, async () => {
          const table = storage.table("events");
          const metadataTable = storage.table("storage_meta");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${table}:ledger_append`]);
          const head = await readEventLedgerHead((sql, params) => client.query<{ value_json: EventLedgerHead }>(sql, [...params]).then(result => result.rows), metadataTable);
          let prev = head?.ledgerHash ?? await latestLedgerHash(client, table);
          const existing = await client.query<{ id: string; hash: string; ledger_hash: string }>(
            `SELECT id, hash, ledger_hash FROM ${table} WHERE id=ANY($1)`,
            [[...unique.keys(), ...(head ? [head.eventId] : [])]]
          );
          const existingById = new Map(existing.rows.map(row => [row.id, row]));
          if (head && (existingById.get(head.eventId)?.hash !== head.eventHash || existingById.get(head.eventId)?.ledger_hash !== head.ledgerHash)) {
            throw new Error("canonical event ledger head does not match its immutable event");
          }
          const repeated = [...unique.values()].filter(event => existingById.has(String(event.id)));
          if (repeated.length) {
            const bodies = await client.query<EventRow>(`SELECT * FROM ${table} WHERE id=ANY($1)`, [repeated.map(event => String(event.id))]);
            const payloads = await canonicalCreativeCodec(storage, client).decodeMany(bodies.rows.map(row => row.payload_json));
            const stored = new Map(bodies.rows.map((row, index) => [row.id, rowToEvent({ ...row, payload_json: payloads[index] as JsonValue })]));
            for (const event of repeated) if (canonicalStringify(stored.get(String(event.id))) !== canonicalStringify(event)) throw eventIdentityConflict(String(event.id));
          }
          const fresh = [...unique.values()].filter(event => !existingById.has(String(event.id)));
          if (!fresh.length) return;
          // Hashing stays synchronous; the queue serializes head selection and persistence on one client.
          const rows: unknown[][] = [];
          const codec = canonicalCreativeCodec(storage, client);
          const payloads = await codec.encodeMany(fresh.map(event => ({ value: event.payload })));
          for (const [index, event] of fresh.entries()) {
            const ledgerHash = sha256(`${prev}\u001f${event.hash}`);
            prev = ledgerHash;
            rows.push([event.id, event.episodeId, event.typeId, event.t, JSON.stringify(payloads[index]), event.parents, event.hash, ledgerHash]);
          }
          for (let start = 0; start < rows.length; start += EVENT_INSERT_MAX_ROWS_PER_STATEMENT) {
            const params: unknown[] = [];
            const tuples = rows.slice(start, start + EVENT_INSERT_MAX_ROWS_PER_STATEMENT).map(row => `(${row.map((value, column) => {
              params.push(value);
              return `$${params.length}::${EVENT_INSERT_COLUMN_TYPES[column]}`;
            }).join(",")})`);
            await client.query(
              `INSERT INTO ${table}(id, episode_id, type_id, t, payload_json, parents, hash, ledger_hash)
               VALUES${tuples.join(",")}
               ON CONFLICT(id) DO NOTHING`,
              params
            );
          }
          const last = fresh[fresh.length - 1]!;
          await client.query(
            `INSERT INTO ${metadataTable}(key,value_json,updated_at) VALUES($1,$2::jsonb,NOW())
             ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=NOW()`,
            [EVENT_LEDGER_HEAD_KEY, JSON.stringify({ eventId: String(last.id), eventHash: last.hash, ledgerHash: prev })]
          );
        });
      });
    },
    async readEpisode(episodeId) {
      const rows = await storage.query<EventRow>(`SELECT * FROM ${storage.table("events")} WHERE episode_id=$1 ORDER BY t,id`, [episodeId]);
      const payloads = await canonicalCreativeCodec(storage).decodeMany(rows.map(row => row.payload_json));
      return rows.map((row, index) => rowToEvent({ ...row, payload_json: payloads[index] as JsonValue }));
    },
    async readEpisodeEventSkeletons(episodeIds) {
      if (!episodeIds.length) return [];
      // Deliberately no payload_json: the batched history-induction callers
      // consume only identity and type, and payloads are the bulk of the
      // detoast cost on this table.
      const rows = await storage.query<{ id: string; episode_id: string; type_id: string }>(
        `SELECT id, episode_id, type_id FROM ${storage.table("events")} WHERE episode_id=ANY($1) ORDER BY t,id`,
        [[...episodeIds]]
      );
      return rows.map(row => ({ id: row.id, episodeId: row.episode_id, typeId: row.type_id }));
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
      const payloads = await canonicalCreativeCodec(storage).decodeMany(rows.map(row => row.payload_json));
      return rows.map((row, index) => rowToEvent({ ...row, payload_json: payloads[index] as JsonValue }));
    },
    async latestLedgerHash() {
      const head = await readEventLedgerHead((sql, params) => storage.query<{ value_json: EventLedgerHead }>(sql, [...params]), storage.table("storage_meta"));
      if (head) return head.ledgerHash;
      const rows = await storage.query<{ ledger_hash: string }>(latestLedgerHashSql(storage.table("events")));
      return rows[0]?.ledger_hash ?? "";
    }
  };
}

async function serializeEventAppend(client: PoolClient, queues: WeakMap<PoolClient, Promise<void>>, operation: () => Promise<void>): Promise<void> {
  const prior = queues.get(client);
  const queued = prior ? prior.then(operation) : Promise.resolve().then(operation);
  queues.set(client, queued);
  void queued.catch(() => undefined);
  try {
    await queued;
  } finally {
    if (queues.get(client) === queued) queues.delete(client);
  }
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
      // Snapshot changes invalidate warm readers, including roots outside this publication window.
      const projectSnapshot = /^oss\.contract\.snapshot\.[a-f0-9]{64}$/u.test(checkpoint.id);
      if (projectSnapshot && (checkpoint.metadata as { schema?: unknown }).schema !== "scce.oss_owned_contract_snapshot.v1") throw new Error("Malformed OSS contract snapshot checkpoint");
      const write = projectSnapshot ? storage.mutateLanguageMemory.bind(storage) : storage.query.bind(storage);
      await write(
        `INSERT INTO ${storage.table("ingestion_checkpoints")}(id,root_uri,item_uri,phase,status,offset_bytes,content_hash,byte_length,reason,metadata_json,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,TO_TIMESTAMP($11/1000.0))
         ON CONFLICT(id) DO UPDATE SET phase=EXCLUDED.phase,status=EXCLUDED.status,offset_bytes=EXCLUDED.offset_bytes,content_hash=EXCLUDED.content_hash,byte_length=EXCLUDED.byte_length,reason=EXCLUDED.reason,metadata_json=EXCLUDED.metadata_json,updated_at=EXCLUDED.updated_at${projectSnapshot ? `
         WHERE (ingestion_checkpoints.phase,ingestion_checkpoints.status,ingestion_checkpoints.offset_bytes,ingestion_checkpoints.content_hash,ingestion_checkpoints.byte_length,ingestion_checkpoints.reason,ingestion_checkpoints.metadata_json)
           IS DISTINCT FROM (EXCLUDED.phase,EXCLUDED.status,EXCLUDED.offset_bytes,EXCLUDED.content_hash,EXCLUDED.byte_length,EXCLUDED.reason,EXCLUDED.metadata_json)` : ""}`,
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
      if (query.phase) {
        params.push(query.phase);
        where.push(`phase=$${params.length}`);
      }
      if (query.itemUriPrefix) {
        params.push(query.itemUriPrefix);
        where.push(`starts_with(item_uri,$${params.length})`);
      }
      params.push(query.limit ?? 200);
      const order = query.orderBy === "offsetBytes" ? "offset_bytes DESC,updated_at DESC,id" : "updated_at DESC,id";
      const rows = await storage.query<IngestionCheckpointRow>(`SELECT * FROM ${storage.table("ingestion_checkpoints")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT $${params.length}`, params);
      return rows.map(rowToIngestionCheckpoint);
    }
  };
}

/**
 * The hash a blob will be stored under, derivable without storing it. Ingest computes a page's records before
 * it writes anything, and a source version needs its content hash while still in that pure phase.
 */
export function blobContentHash(content: Uint8Array | Buffer): ContentHash {
  return `sha256_${sha256(Buffer.from(content))}` as ContentHash;
}

function createBlobStore(storage: PostgresStorageAdapter): BlobStore {
  return {
    async put(content, mediaType) {
      const hash = blobContentHash(content);
      await storage.query(`INSERT INTO ${storage.table("blobs")}(content_hash, media_type, byte_length, content) VALUES($1,$2,$3,$4) ON CONFLICT(content_hash) DO NOTHING`, [hash, mediaType, content.length, Buffer.from(content)]);
      return hash;
    },
    async putBatch(items) {
      if (!items.length) return [];
      // Deduplicated before the write: a page's spans routinely repeat a boilerplate line, and the same hash
      // twice in one statement is a self-conflict Postgres would reject rather than ignore.
      const byHash = new Map<string, { hash: string; mediaType: string; content: Uint8Array }>();
      const order: string[] = [];
      for (const item of items) {
        const hash = blobContentHash(item.content);
        order.push(hash);
        if (!byHash.has(hash)) byHash.set(hash, { hash, mediaType: item.mediaType, content: item.content });
      }
      const unique = [...byHash.values()];
      await storage.query(
        `INSERT INTO ${storage.table("blobs")}(content_hash, media_type, byte_length, content)
         SELECT r.content_hash, r.media_type, r.byte_length, decode(r.content_b64, 'base64')
         FROM jsonb_to_recordset($1::jsonb) AS r(content_hash text, media_type text, byte_length bigint, content_b64 text)
         ON CONFLICT(content_hash) DO NOTHING`,
        [JSON.stringify(unique.map(row => ({
          content_hash: row.hash,
          media_type: row.mediaType,
          byte_length: row.content.length,
          content_b64: Buffer.from(row.content).toString("base64")
        })))]
      );
      // Returned in the caller's order, including the repeats, so a caller can index straight back.
      return order as ContentHash[];
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
      await storage.transaction(async () => {
        const labels = await joinDurableRecordLabels(
          storage,
          "source_versions",
          [{ id: source.sourceVersionId, informationLabel: source.informationLabel }]
        );
        const informationLabel = labels.get(source.sourceVersionId)!;
        await storage.query(`INSERT INTO ${storage.table("sources")}(id, namespace, canonical_uri, first_seen_at, last_seen_at) VALUES($1,$2,$3,TO_TIMESTAMP($4/1000.0),TO_TIMESTAMP($4/1000.0)) ON CONFLICT(id) DO UPDATE SET last_seen_at=GREATEST(sources.last_seen_at,EXCLUDED.last_seen_at)`, [source.sourceId, source.namespace, source.canonicalUri, source.observedAt]);
        const changes = await storage.query(`WITH prior AS MATERIALIZED (
          SELECT id,information_label,metadata_json FROM ${storage.table("source_versions")} WHERE id=$1
        ), written AS (
        INSERT INTO ${storage.table("source_versions")} AS stored(id, source_id, content_hash, media_type, observed_at, byte_length, trust_vector, metadata_json, information_label) VALUES($1,$2,$3,$4,TO_TIMESTAMP($5/1000.0),$6,$7::jsonb,$8::jsonb,$9::jsonb) ON CONFLICT(id) DO UPDATE SET information_label=EXCLUDED.information_label,
          metadata_json=CASE WHEN stored.source_id=EXCLUDED.source_id AND stored.content_hash=EXCLUDED.content_hash
            AND EXCLUDED.metadata_json->>'identityRecipe'='scce.gutenberg.source_identity.v2'
            THEN stored.metadata_json || jsonb_build_object('title', EXCLUDED.metadata_json->'title', 'identity', EXCLUDED.metadata_json->'identity', 'identityRecipe', EXCLUDED.metadata_json->'identityRecipe')
            ELSE stored.metadata_json END
          || CASE WHEN stored.source_id=EXCLUDED.source_id AND stored.content_hash=EXCLUDED.content_hash
            AND stored.information_label=EXCLUDED.information_label
            AND stored.metadata_json ? 'sourceMetadata'
            AND stored.metadata_json->'sourceMetadata'=EXCLUDED.metadata_json->'sourceMetadata'
            AND EXCLUDED.metadata_json->'sourceMetadataBinding'->>'schema'='${SOURCE_METADATA_BINDING_SCHEMA}'
            AND EXCLUDED.metadata_json->'sourceMetadataBinding'->>'sourceVersionId'=stored.id
            AND (NOT (stored.metadata_json ? 'sourceMetadataBinding')
              OR stored.metadata_json->'sourceMetadataBinding'=EXCLUDED.metadata_json->'sourceMetadataBinding')
            THEN jsonb_build_object('sourceMetadataBinding', EXCLUDED.metadata_json->'sourceMetadataBinding') ELSE '{}'::jsonb END
          || ${sourceTranscriptArchiveAppendSql(storage.table("blobs"), storage.table("sources"))}
          RETURNING id,information_label,metadata_json
        ) SELECT 1 AS language_memory_changed FROM written LEFT JOIN prior USING(id)
          WHERE prior.id IS NULL OR (written.information_label,written.metadata_json)
            IS DISTINCT FROM (prior.information_label,prior.metadata_json)`, [source.sourceVersionId, source.sourceId, source.contentHash, source.mediaType, source.observedAt, source.byteLength, JSON.stringify(source.sourceTrust), JSON.stringify(sourceVersionStorageMetadata(source)), JSON.stringify(informationLabel)]);
        if (changes.length) storage.markLanguageMemoryChanged();
      });
    },
    async putEvidenceVisual(input) {
      await storage.query(
        `UPDATE ${storage.table("evidence_spans")} SET visual_embedding=$2::vector, visual_regions=$3::jsonb, provenance_json=provenance_json || jsonb_build_object('visualModel', $4::text) WHERE id=$1`,
        [String(input.evidenceId), vectorLiteral([...input.embedding], 512), JSON.stringify(input.regions.map(region => [...region])), input.model]
      );
    },
    async searchEvidenceByVisual(input) {
      const params: unknown[] = [vectorLiteral([...input.embedding], 512)];
      const where: string[] = ["ev.visual_embedding IS NOT NULL", "ev.status='promoted'"];
      appendInformationAccess(storage, "ev", params, where);
      params.push(Math.max(1, Math.min(256, Math.floor(input.limit))));
      const rows = await storage.query<EvidenceRow & { visual_regions: unknown; visual_score: string }>(
        `SELECT ev.*, (1 - (ev.visual_embedding <=> $1::vector)) AS visual_score
         FROM ${storage.table("evidence_spans")} ev
         WHERE ${where.join(" AND ")}
         ORDER BY ev.visual_embedding <=> $1::vector
         LIMIT ${params.length}`,
        params
      );
      return rows.map(row => ({
        span: rowToEvidence(row),
        score: Number(row.visual_score),
        regions: Array.isArray(row.visual_regions) ? (row.visual_regions as number[][]) : []
      }));
    },
    async putEvidenceSpan(span) {
      await putEvidenceSpansBatch(storage, [span]);
    },
    async putEvidenceSpans(spans) {
      await putEvidenceSpansBatch(storage, spans);
    },
    async promoteEvidence(ids, reason) {
      if (ids.length === 0) return 0;
      return storage.transaction(async () => {
        const rows = await storage.query<{ id: string; admission_changed: boolean }>(`WITH prior AS MATERIALIZED (
          SELECT id,status FROM ${storage.table("evidence_spans")} WHERE id=ANY($1) FOR UPDATE
        ), written AS (UPDATE ${storage.table("evidence_spans")} SET status='promoted', provenance_json=provenance_json || $2::jsonb
          WHERE id IN (SELECT id FROM prior) RETURNING id)
        SELECT written.id,prior.status IS DISTINCT FROM 'promoted' AS admission_changed FROM written JOIN prior USING(id)`, [ids, JSON.stringify({ promotionReason: reason })]);
        if (rows.some(row => row.admission_changed)) storage.markLanguageMemoryChanged();
        return rows.length;
      });
    },
    async getEvidence(id) {
      const access = storage.informationAccessPredicate("evidence", 2);
      const rows = await storage.query<EvidenceRow>(`SELECT * FROM ${storage.table("evidence_spans")} evidence WHERE id=$1 AND ${access.sql}`, [id, ...access.params]);
      return rows[0] ? rowToEvidence(rows[0]) : null;
    },
    async getEvidenceSourceVersions(ids: readonly string[]) {
      if (!ids.length) return [];
      const rows = await storage.query<{ id: string; source_version_id: string }>(
        `SELECT id, source_version_id FROM ${storage.table("evidence_spans")} WHERE id = ANY($1::text[])`,
        [[...ids]]
      );
      return rows.map(row => ({ id: row.id, sourceVersionId: row.source_version_id }));
    },
    async getEvidenceBatch(ids) {
      return readEvidenceBatch(storage, ids);
    },
    async openingEvidenceForSourceVersions(sourceVersionIds) {
      if (sourceVersionIds.length === 0) return [];
      const access = storage.informationAccessPredicate("evidence", 2);
      const rows = await storage.query<EvidenceRow>(
        `SELECT * FROM ${storage.table("evidence_spans")} evidence
         WHERE source_version_id=ANY($1) AND char_start=0 AND status='promoted' AND id LIKE 'evidence_span.%' AND ${access.sql}
         ORDER BY alpha DESC, observed_at DESC`,
        [sourceVersionIds, ...access.params]
      );
      return rows.map(rowToEvidence);
    },
    async sourceIdentityArbitration(input) {
      // Which of the corpus's own titles appear in this request. Asked in this direction it is one query whatever
      // the request's length, and it needs no segmentation: a title matches inside unspaced text the same way it
      // matches between spaces. Enumerating the request's sub-runs instead was quadratic -- 299 database
      // measurements for one coding request in a single turn.
      const normalized = String(input.text ?? "").normalize("NFC").toLocaleLowerCase().replace(IDENTITY_UNIT_SEPARATOR, " ").trim();
      const surface = " " + normalized + " ";
      const unspaced = normalized.length > 0 && !normalized.includes(" ");
      // The title list is loaded ONCE and matched in memory. Asking the database per request was a 19.5 second
      // unindexed DISTINCT over every span, and because the result was cached per request TEXT, every new question
      // paid it in full -- the single largest cost in a turn, larger than retrieval and realization together.
      // Matching is a substring test over ~22k short strings, which is microseconds, and the corpus only changes
      // when something is ingested.
      // Its own predicate: the title query carries no leading parameters, so the access placeholders start at $1.
      const titles = normalized ? await sourceTitlesCached(storage, storage.informationAccessPredicate("evidence", 1)) : [];
      // Binding marks are orthography, not identity: the corpus writes "moby dick" and a request writes "Moby-Dick".
      const foldedSurface = " " + corpusIdentityMatchSurface(normalized) + " ";
      const named = new Set(
        titles
          .filter(title => {
            if (surface.includes(" " + title + " ") || (unspaced && surface.includes(title))) return true;
            const folded = corpusIdentityMatchSurface(title);
            return Boolean(folded) && (foldedSurface.includes(" " + folded + " ") || (unspaced && foldedSurface.includes(folded)));
          })
          .sort((left, right) => right.length - left.length)
          .slice(0, IDENTITY_MATCH_LIMIT)
      );
      // Spread for the runs the corpus is not titled with, one round trip via a lateral join.
      const candidates = [...new Set(input.runs.map(run => run.trim().toLocaleLowerCase()).filter(Boolean))]
        .filter(run => !named.has(run));
      const spread = new Map<string, number>();
      if (candidates.length) {
        const spreadRows = await measureCanonicalSourceSpreads(storage, candidates);
        for (const row of spreadRows) spread.set(row.run, Number(row.sources ?? 0));
      }
      return { identities: [...named], spread };
    },
    async sourceSpreadDistribution(sampleSize: number) {
      // The identity vocabulary sampled at random, then measured the same way a request's runs are, so the
      // threshold derived from it is on the same scale as what it will be compared against.
      const vocabularyAccess = storage.informationAccessPredicate("evidence", 2);
      const sampleLimit = Math.max(1, Math.trunc(sampleSize));
      const vocabulary = await storage.query<{ unit: string }>(
        `SELECT unit FROM (
           SELECT DISTINCT unnest(string_to_array(source_title, ' ')) AS unit
           FROM ${storage.table("evidence_spans")} evidence WHERE source_title <> ''
             AND evidence.status='promoted' AND ${vocabularyAccess.sql}
         ) units WHERE unit <> '' ORDER BY md5(unit), unit LIMIT $1`,
        [sampleLimit, ...vocabularyAccess.params]
      );
      if (!vocabulary.length) return [];
      const units = uniquePostgresStrings(vocabulary.flatMap(row => anchorSymbolUnits(row.unit))).slice(0, sampleLimit);
      const rows = await measureCanonicalSourceSpreads(storage, units);
      return rows.map(row => Number(row.sources ?? 0)).filter(value => value > 0);
    },
    async searchEvidence(query: EvidenceQuery) {
      if (query.sourceSampleSeed !== undefined && (!query.sourceVersionId || query.text || query.features?.length)) {
        throw new Error("evidence source sampling requires an exact source version without retrieval features");
      }
      const features = evidenceQueryFeatures(query.features ?? []);
      const openingBlockPrior = query.openingBlockPrior !== false;
      if (features.length && features.every(isEvidenceAnchorFeature) && !query.sourceId && !query.sourceVersionId) {
        const access = storage.informationAccessPredicate("evidence", 3);
        // Okapi BM25 ranking over anchor postings, with presence-only term
        // frequency (the index stores a feature SET, so tf is 1 wherever a
        // feature occurs and the tf saturation term collapses to a constant).
        //
        // Ranking by raw COUNT(*) treated every matched feature as equally
        // informative, so a match on "the" counted exactly as much as a match
        // on "zaragoza". Measured on this corpus: for "which building at
        // Zaragoza University is called the Ada Byron Building", the ten
        // top-ranked spans all scored overlap=8 purely on {the, and, in,
        // computer, science, building}, and the article that actually answers
        // the question never surfaced. IDF is what separates those; length
        // normalisation is what stops a long span winning simply by
        // containing more words to match.
        //
        // Document frequency is computed within the candidate set rather than
        // the whole corpus: it needs no extra scan beyond the join already
        // being performed, and only the RELATIVE rarity of the query's own
        // features affects the ordering.
        const rows = await queryIndexedEvidence<EvidenceRow>(storage,
          `WITH requested_features AS (
             SELECT feature, feature_ord
             FROM unnest($1::text[]) WITH ORDINALITY AS requested(feature, feature_ord)
           ),
           -- Postings are capped per feature. Without this the CTE
           -- materialises every posting of every query term, and a query
           -- carrying "the" pulls essentially the whole corpus into an
           -- intermediate that is then COUNT(DISTINCT)-ed twice and joined
           -- back for lengths: measured at 279817ms for ONE retrieval on
           -- 23k spans.
           --
           -- The cap is not just a speed knob, it is also the right ranking
           -- behaviour. A term present in more documents than the cap is not
           -- discriminative, and capping its posting list drives its df to
           -- the ceiling and its IDF toward zero, which is exactly where a
           -- stopword belongs. Selective terms have shorter posting lists
           -- than the cap and are unaffected, so the terms that decide the
           -- ranking are the ones carried in full.
           -- A feature over the cap must not decide which spans exist as candidates: LIMIT without ORDER BY
           -- picked an arbitrary slice of "born"'s postings, so the lead sentence of the very article asked
           -- about lost its "born" match while unrelated biographies kept theirs, and it fell out of the top
           -- of "When was Ada Lovelace born?". Candidates are seeded by the selective features (their postings
           -- fit under the cap); a common feature then scores against those candidates only, for every one
           -- of them that carries it. Its IDF is still driven toward zero by the cap, as the ranking intends.
           feature_postings AS (
             SELECT requested.feature, requested.feature_ord,
                    (SELECT COUNT(*) FROM (
                       SELECT 1 FROM ${storage.table("evidence_anchor_index")} probe
                       WHERE probe.features @> ARRAY[requested.feature]::text[]
                       LIMIT ${EVIDENCE_FEATURE_POSTING_CAP + 1}
                     ) bounded) AS posting_count
             FROM requested_features requested
           ),
           seed_hits AS (
             SELECT anchor_index.evidence_id AS id, postings.feature, postings.feature_ord
             FROM feature_postings postings
             JOIN ${storage.table("evidence_anchor_index")} anchor_index
               ON anchor_index.features @> ARRAY[postings.feature]::text[]
             WHERE postings.posting_count <= ${EVIDENCE_FEATURE_POSTING_CAP}
           ),
           -- The subject seeds even when it is over the cap: "ada|lovelace" carries 409 postings against a cap
           -- of 400, so the article about her could only be reached through "lovelace|born", six postings that
           -- were all the owner's source comments. The leading feature is the request subject (features arrive
           -- in priority order), and its postings are admitted where the span's title carries the subject, which
           -- bounds the seed to the documents that are about it rather than an arbitrary slice of its postings.
           -- Only a phrase can be a subject here: a lone over-cap symbol is a function word ("which", "was") or a
           -- subject the no-selective-feature fallback already seeds. And only a phrase whose postings the fallback
           -- cap could carry: "united|states" is a phrase in tens of thousands of spans, and title-checking every one
           -- of them cost 25s on one question (measured); the title check scans every posting, so a phrase seeds this way
           -- only while its postings are within twice the selectivity cap.
           subject_hits AS (
             SELECT anchor_index.evidence_id AS id, chosen.feature, chosen.feature_ord
             FROM (
               SELECT feature, feature_ord FROM feature_postings
               WHERE posting_count > ${EVIDENCE_FEATURE_POSTING_CAP}
                 AND feature LIKE 'anchor:bi:%'
                 AND (SELECT COUNT(*) FROM (
                        SELECT 1 FROM ${storage.table("evidence_anchor_index")} probe
                        WHERE probe.features @> ARRAY[feature_postings.feature]::text[]
                        LIMIT ${EVIDENCE_FEATURE_POSTING_CAP * 2 + 1}
                      ) bounded) <= ${EVIDENCE_FEATURE_POSTING_CAP * 2}
               ORDER BY feature_ord ASC
               LIMIT 1
             ) chosen
             JOIN ${storage.table("evidence_anchor_index")} anchor_index
               ON anchor_index.features @> ARRAY[chosen.feature]::text[]
             JOIN ${storage.table("evidence_spans")} evidence ON evidence.id = anchor_index.evidence_id
             WHERE ${titleMatchExpression("evidence", 4 + access.params.length)}
             LIMIT ${EVIDENCE_FEATURE_FALLBACK_CAP}
           ),
           common_hits AS (
             SELECT seeds.id, postings.feature, postings.feature_ord
             FROM (SELECT id FROM seed_hits UNION SELECT id FROM subject_hits) seeds
             JOIN ${storage.table("evidence_anchor_index")} anchor_index ON anchor_index.evidence_id = seeds.id
             JOIN feature_postings postings
               ON postings.posting_count > ${EVIDENCE_FEATURE_POSTING_CAP}
              AND anchor_index.features @> ARRAY[postings.feature]::text[]
           ),
           -- A request whose every feature is over the cap still has to be searched.
           --
           -- Over-cap features cannot seed, which is right when they are stopwords and wrong when they are the
           -- subject: "apollo" carries 438 postings against a cap of 400, so "When did Apollo 11 land on the
           -- Moon?" seeded nothing, retrieved nothing, and the turn declined over a corpus holding 39 promoted
           -- spans of that article. Einstein (258) and a selective bigram both seed, which is why the same
           -- question shape answers for one subject and not another.
           --
           -- When nothing is selective, the least common feature seeds anyway, bounded so a genuine stopword
           -- query cannot materialise the corpus. Features arrive in priority order and the subject leads, so
           -- the one chosen here is the request subject rather than whichever term happened to be first.
           selective_features AS (
             SELECT COUNT(*) AS n FROM feature_postings WHERE posting_count <= ${EVIDENCE_FEATURE_POSTING_CAP}
           ),
           fallback_hits AS (
             SELECT anchor_index.evidence_id AS id, chosen.feature, chosen.feature_ord
             FROM (
               SELECT feature, feature_ord FROM feature_postings
               WHERE (SELECT n FROM selective_features) = 0
               ORDER BY posting_count ASC, feature_ord ASC
               LIMIT 1
             ) chosen
             JOIN ${storage.table("evidence_anchor_index")} anchor_index
               ON anchor_index.features @> ARRAY[chosen.feature]::text[]
             LIMIT ${EVIDENCE_FEATURE_FALLBACK_CAP}
           ),
           feature_hits AS (
             SELECT * FROM seed_hits
             UNION
             SELECT * FROM subject_hits
             UNION
             SELECT * FROM common_hits
             UNION
             SELECT * FROM fallback_hits
           ),
           candidate_count AS (SELECT GREATEST(1, COUNT(DISTINCT id))::float8 AS n FROM feature_hits),
           feature_df AS (SELECT feature, COUNT(DISTINCT id)::float8 AS df FROM feature_hits GROUP BY feature),
           candidate_length AS (
             -- Length from the char range, not from the text: OCTET_LENGTH detoasted every candidate span (36k of
             -- them once the posting cap admitted real subjects), 20-30s of a turn for a normalisation term.
             SELECT hits.id, GREATEST(1, evidence.char_end - evidence.char_start)::float8 AS len
             FROM (SELECT DISTINCT id FROM feature_hits) hits
             JOIN ${storage.table("evidence_spans")} evidence ON evidence.id=hits.id
           ),
           mean_length AS (SELECT GREATEST(1, AVG(len)) AS len FROM candidate_length),
           candidate_hits AS (
             SELECT feature_hits.id,
                    SUM(LN(1 + ((SELECT n FROM candidate_count) - feature_df.df + 0.5) / (feature_df.df + 0.5)))
                      / (0.25 + 0.75 * (candidate_length.len / (SELECT len FROM mean_length))) AS score,
                    COUNT(*) AS overlap_count,
                    MIN(feature_hits.feature_ord) AS first_feature_ord
             FROM feature_hits
             JOIN feature_df ON feature_df.feature = feature_hits.feature
             JOIN candidate_length ON candidate_length.id = feature_hits.id
             GROUP BY feature_hits.id, candidate_length.len
           )
           -- Rank and filter on the narrow columns first, then read the wide rows for the winners only: joining
           -- evidence.* for every candidate detoasted ~250 spans of text to return 17 (measured 530ms of a 745ms
           -- query on this corpus).
           ${evidenceAnchorRankingTail({
             spansTable: storage.table("evidence_spans"),
             statusCondition: evidenceStatusCondition("evidence", query.status),
             accessCondition: access.sql,
             titleMatch: titleMatchExpression("evidence", 4 + access.params.length),
             titleExact: titleExactExpression("evidence", 4 + access.params.length),
             sourceKindExclusion: sourceKindExclusion("provenance.source_kind", query, 3 + access.params.length),
             sourceKindDeprioritized: sourceKindDeprioritized("provenance.source_kind", 3 + access.params.length),
             forceClassExclusion: forceClassExclusion("provenance.force_class", 5 + access.params.length),
             limitParameter: "$2",
             openingBlockPrior
           })}`,
          [features, query.limit ?? 80, ...access.params, query.deprioritizeSourceKinds ?? [], query.titleUnits ?? [], query.excludeForceClasses ?? []]
        );
        return rows.map(row => ({ span: rowToEvidence(row), score: Number(row.alpha), reason: "postgres anchor-posting BM25 evidence search" }));
      }
      if (features.length && !query.sourceId && !query.sourceVersionId) {
        // Same posting cap as the BM25 branch: an uncapped common feature
        // materialises the whole corpus per branch.
        const featureBranches = features.map((_, index) =>
          `(SELECT id, ${index + 1}::bigint AS feature_ord FROM ${storage.table("evidence_spans")} WHERE features @> ARRAY[$${index + 1}]::text[] LIMIT ${EVIDENCE_FEATURE_POSTING_CAP})`
        );
        const limitIndex = features.length + 1;
        const access = storage.informationAccessPredicate("ev", limitIndex + 1);
        const rows = await storage.query<EvidenceRow>(
          `WITH feature_hits AS MATERIALIZED (
             ${featureBranches.join("\nUNION ALL\n")}
           ),
           candidate_hits AS (
             SELECT id, COUNT(*) AS overlap_count, MIN(feature_ord) AS first_feature_ord
             FROM feature_hits
             GROUP BY id
           )
           SELECT ev.*
           FROM candidate_hits hits
           JOIN ${storage.table("evidence_spans")} ev ON ev.id=hits.id
           WHERE ${evidenceStatusCondition("ev", query.status)}
             AND ${access.sql}
           ORDER BY ${sourceKindDeprioritized(evidenceSourceKindExpression("ev"), limitIndex + 1 + access.params.length)} ASC,
                    hits.overlap_count DESC,
                    hits.first_feature_ord ASC,
                    CASE WHEN ev.status='promoted' THEN 0 WHEN ev.status='pending' THEN 1 ELSE 2 END ASC,
                    ev.alpha DESC,
                    ev.observed_at DESC
           LIMIT $${limitIndex}`,
          [...features, query.limit ?? 80, ...access.params, query.deprioritizeSourceKinds ?? []]
        );
        return rows.map(row => ({ span: rowToEvidence(row), score: Number(row.alpha), reason: "postgres GIN feature-hit evidence search" }));
      }
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceId) { params.push(query.sourceId); where.push(`ev.source_id=$${params.length}`); }
      if (query.sourceVersionId) { params.push(query.sourceVersionId); where.push(`ev.source_version_id=$${params.length}`); }
      let featureParamIndex = 0;
      if (features.length) {
        params.push(features);
        featureParamIndex = params.length;
        where.push(`ev.features && $${featureParamIndex}`);
      }
      if (where.length === 0) return [];
      where.push(evidenceStatusCondition("ev", query.status));
      const access = storage.informationAccessPredicate("ev", params.length + 1);
      where.push(access.sql);
      params.push(...access.params);
      const sourceKindRank = query.sourceSampleSeed === undefined
        ? sourceKindDeprioritized(evidenceSourceKindExpression("ev"), params.push(query.deprioritizeSourceKinds ?? [])) : "0::int";
      const sampleOrder = query.sourceSampleSeed !== undefined
        ? `md5(ev.id || $${params.push(query.sourceSampleSeed)}) ASC, ev.id ASC` : undefined;
      params.push(query.limit ?? 80);
      // A bare integer literal in ORDER BY is a positional column reference
      // in Postgres, not a constant -- "ORDER BY 0" is invalid (positions
      // start at 1) and throws "ORDER BY position 0 is not in select
      // list" for any searchEvidence call with no anchor/GIN features
      // (e.g. querying by sourceVersionId/status alone). Cast to make it
      // an expression instead of a position reference.
      const overlap = featureParamIndex > 0
        ? `(SELECT COUNT(*) FROM unnest(ev.features) AS f(feature) WHERE f.feature = ANY($${featureParamIndex}::text[]))`
        : "0::int";
      const rows = await storage.query<EvidenceRow>(`SELECT ev.* FROM ${storage.table("evidence_spans")} ev WHERE ${where.join(" AND ")} ORDER BY ${sampleOrder ?? `${sourceKindRank} ASC, ${overlap} DESC, CASE WHEN ev.status='promoted' THEN 0 WHEN ev.status='pending' THEN 1 ELSE 2 END ASC, ev.alpha DESC, ev.observed_at DESC`} LIMIT $${params.length}`, params);
      return rows.map(row => ({ span: rowToEvidence(row), score: Number(row.alpha), reason: "postgres feature/source bounded evidence search" }));
    },
    async sourceVersionsForEvidence(ids) {
      if (ids.length === 0) return [];
      const evidenceAccess = storage.informationAccessPredicate("e", 2);
      const versionAccess = storage.informationAccessPredicate("sv", 6);
      const rows = await storage.query<SourceVersionRow>(
        `SELECT DISTINCT sv.*, s.namespace, s.canonical_uri FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id JOIN ${storage.table("evidence_spans")} e ON e.source_version_id=sv.id WHERE e.id=ANY($1) AND ${evidenceAccess.sql} AND ${versionAccess.sql}`,
        [ids, ...evidenceAccess.params, ...versionAccess.params]
      );
      return rows.map(rowToSourceVersion);
    },
    async sourceVersionById(id) {
      const access = storage.informationAccessPredicate("sv", 2);
      const rows = await storage.query<SourceVersionRow>(
        `SELECT sv.*, s.namespace, s.canonical_uri FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id WHERE sv.id=$1 AND ${access.sql}`,
        [id, ...access.params]
      );
      return rows[0] ? rowToSourceVersion(rows[0]) : null;
    },
    async sourceVersionsByContentHashes(hashes) {
      if (!hashes.length) return [];
      const versionAccess = storage.informationAccessPredicate("sv", 2);
      const rows = await storage.query<SourceVersionRow>(
        `SELECT sv.*, s.namespace, s.canonical_uri FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id WHERE sv.content_hash=ANY($1) AND ${versionAccess.sql}`,
        [[...hashes], ...versionAccess.params]
      );
      return rows.map(rowToSourceVersion);
    },
    async countEvidenceBackedSourceVersions(query = {}) {
      const { params, where } = evidenceBackedSourcePredicates(storage, query, false, false);
      const min = query.minByteLength !== undefined ? `$${params.push(Math.floor(query.minByteLength))}` : undefined;
      const max = query.maxByteLength !== undefined ? `$${params.push(Math.floor(query.maxByteLength))}` : undefined;
      const notDerived = query.excludeTrainingDerived ? `NOT (${DERIVED_TRAINING_SOURCE_SQL})` : "TRUE";
      const eligible = [notDerived, min ? `sv.byte_length >= ${min}` : "TRUE", max ? `sv.byte_length <= ${max}` : "TRUE"].join(" AND ");
      const rows = await storage.query<{ total: string | number; derived: string | number; eligible: string | number; below: string | number; above: string | number }>(
        `SELECT COUNT(DISTINCT sv.id) AS total,
          COUNT(DISTINCT sv.id) FILTER (WHERE ${query.excludeTrainingDerived ? DERIVED_TRAINING_SOURCE_SQL : "FALSE"}) AS derived,
          COUNT(DISTINCT sv.id) FILTER (WHERE ${eligible}) AS eligible,
          COUNT(DISTINCT sv.id) FILTER (WHERE ${notDerived} AND ${min ? `sv.byte_length < ${min}` : "FALSE"}) AS below,
          COUNT(DISTINCT sv.id) FILTER (WHERE ${notDerived} AND ${max ? `sv.byte_length > ${max}` : "FALSE"}) AS above
         FROM ${storage.table("source_versions")} sv
         JOIN ${storage.table("sources")} s ON s.id=sv.source_id
         JOIN ${storage.table("evidence_spans")} e ON e.source_version_id=sv.id
         WHERE ${where.join(" AND ")}`, params);
      const row = rows[0];
      return { evidenceBackedSources: Number(row?.total ?? 0), derivedTrainingSources: Number(row?.derived ?? 0), eligibleSources: Number(row?.eligible ?? 0),
        belowMinArticleBytes: Number(row?.below ?? 0), aboveMaxArticleBytes: Number(row?.above ?? 0) };
    },
    async listEvidenceBackedSourceVersions(query = {}) {
      const { params, where, sourceWhere, evidenceWhere } = evidenceBackedSourcePredicates(storage, query, true);
      params.push(Math.max(1, Math.min(100000, Math.floor(query.limit ?? 10000))));
      const rows = await storage.query<{
        id: string;
        content_hash: string;
        canonical_uri: string;
        byte_length: string | number;
        max_alpha: number;
        promoted_span_count: string | number;
      }>(
        query.orderBySourceVersionId || query.afterSourceVersionId !== undefined
          ? `WITH selected_sources AS (
               SELECT sv.id, sv.content_hash, s.canonical_uri, sv.byte_length
               FROM ${storage.table("source_versions")} sv
               JOIN ${storage.table("sources")} s ON s.id=sv.source_id
               WHERE ${sourceWhere.join(" AND ")} AND EXISTS (
                 SELECT 1 FROM ${storage.table("evidence_spans")} e
                 WHERE e.source_version_id=sv.id AND ${evidenceWhere.join(" AND ")})
               ORDER BY sv.id COLLATE "C" ASC LIMIT $${params.length}
             )
             SELECT sv.id, sv.content_hash, sv.canonical_uri, sv.byte_length,
                    MAX(e.alpha) AS max_alpha, COUNT(e.id) AS promoted_span_count
             FROM selected_sources sv
             JOIN ${storage.table("evidence_spans")} e ON e.source_version_id=sv.id
             WHERE ${evidenceWhere.join(" AND ")}
             GROUP BY sv.id, sv.content_hash, sv.canonical_uri, sv.byte_length
             ORDER BY sv.id COLLATE "C" ASC`
          : `SELECT sv.id, sv.content_hash, s.canonical_uri, sv.byte_length,
                MAX(e.alpha) AS max_alpha, COUNT(e.id) AS promoted_span_count
             FROM ${storage.table("source_versions")} sv
             JOIN ${storage.table("sources")} s ON s.id=sv.source_id
             JOIN ${storage.table("evidence_spans")} e ON e.source_version_id=sv.id
             WHERE ${where.join(" AND ")}
             GROUP BY sv.id, sv.content_hash, s.canonical_uri, sv.byte_length
             ORDER BY MAX(e.alpha) DESC, COUNT(e.id) DESC, sv.id ASC
             LIMIT $${params.length}`,
        params
      );
      return rows.map(row => ({
        sourceVersionId: row.id as SourceVersionId,
        contentHash: row.content_hash as ContentHash,
        canonicalUri: row.canonical_uri,
        byteLength: Number(row.byte_length),
        maxAlpha: Number(row.max_alpha),
        promotedSpanCount: Number(row.promoted_span_count)
      }));
    }
  };
}

const DERIVED_TRAINING_SOURCE_SQL = "(s.canonical_uri LIKE 'scce://construction-training/%' OR s.canonical_uri LIKE 'scce://construction-probe/%' OR sv.metadata_json->>'derivation' IN ('construction_training', 'construction_probe') OR sv.metadata_json->>'sourceKind' = 'construction_probe' OR sv.metadata_json->>'lane' = 'stored-corpus-construction-training' OR sv.metadata_json->>'sourceClass' = 'generated' OR sv.metadata_json->'sourceAdmission'->>'sourceClass' = 'generated') IS TRUE";

function evidenceBackedSourcePredicates(storage: PostgresStorageAdapter, query: EvidenceBackedSourceVersionQuery, applyByteBounds: boolean, applyDerivedFilter = true): { params: unknown[]; where: string[]; sourceWhere: string[]; evidenceWhere: string[] } {
  const params: unknown[] = [];
  const where: string[] = [];
  const evidenceWhere = ["e.status='promoted'"];
  if (query.sourceSystem) { params.push(query.sourceSystem); evidenceWhere.push(`e.provenance_json->>'sourceSystem' = $${params.length}`); }
  for (const prefix of query.excludeUriPrefixes ?? []) { params.push(`${prefix}%`); where.push(`s.canonical_uri NOT LIKE $${params.length}`); }
  if (query.includeUriPrefixes?.length) {
    where.push(`(${query.includeUriPrefixes.map(prefix => { params.push(`${prefix}%`); return `s.canonical_uri LIKE $${params.length}`; }).join(" OR ")})`);
  }
  if (query.sourceVersionIds?.length) { params.push([...query.sourceVersionIds]); where.push(`sv.id = ANY($${params.length}::text[])`); }
  if (applyByteBounds && query.minByteLength !== undefined) { params.push(Math.floor(query.minByteLength)); where.push(`sv.byte_length >= $${params.length}`); }
  if (applyByteBounds && query.maxByteLength !== undefined) { params.push(Math.floor(query.maxByteLength)); where.push(`sv.byte_length <= $${params.length}`); }
  if (query.sourceSystems?.length) {
    params.push([...query.sourceSystems]);
    where.push(`COALESCE(sv.metadata_json->>'sourceSystemId', sv.metadata_json->>'sourceSystem') = ANY($${params.length}::text[])`);
  }
  if (query.afterSourceVersionId !== undefined) { params.push(query.afterSourceVersionId); where.push(`sv.id COLLATE "C" > $${params.length}::text COLLATE "C"`); }
  if (applyDerivedFilter && query.excludeTrainingDerived) where.push(`NOT (${DERIVED_TRAINING_SOURCE_SQL})`);
  const access = applyByteBounds
    ? storage.informationAccessPredicate("sv", params.length + 1, "bounded_by_order_and_limit")
    : storage.informationAccessPredicate("sv", params.length + 1);
  params.push(...access.params);
  where.push(access.sql);
  return { params, sourceWhere: where, evidenceWhere, where: [...evidenceWhere, ...where] };
}

async function putEvidenceSpansBatch(storage: PostgresStorageAdapter, spans: readonly EvidenceSpan[]): Promise<void> {
  if (!spans.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(storage, "evidence_spans", spans.map(span => ({ id: span.id, informationLabel: span.informationLabel })));
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
    observed_at_ms: span.observedAt,
      information_label: labels.get(span.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      const changes = await storage.query(
        `WITH prior AS MATERIALIZED (
       SELECT id,status,alpha,trust_vector,provenance_json,information_label,features
       FROM ${storage.table("evidence_spans")}
       WHERE id IN (SELECT value->>'id' FROM jsonb_array_elements($1::jsonb) AS input(value))
     ), upserted AS (
       INSERT INTO ${storage.table("evidence_spans")} AS ev(id, source_id, source_version_id, chunk_id, content_hash, media_type, byte_start, byte_end, char_start, char_end, text_preview, text_content, language_hints, script_hints, trust_vector, provenance_json, features, status, alpha, observed_at, information_label)
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
       TO_TIMESTAMP(r.observed_at_ms/1000.0),
       r.information_label
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
       observed_at_ms double precision,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET
       -- Re-observing the same bytes is not a reason to unlearn them: a span the owner promoted stays
       -- promoted, so asking again after confirming a source cannot silently re-quarantine it.
       status=CASE WHEN ev.status='promoted' THEN ev.status ELSE EXCLUDED.status END,
       alpha=GREATEST(ev.alpha, EXCLUDED.alpha),
       trust_vector=ev.trust_vector || EXCLUDED.trust_vector,
       provenance_json=ev.provenance_json || EXCLUDED.provenance_json,
       information_label=EXCLUDED.information_label,
       features=ARRAY(SELECT DISTINCT value FROM unnest(ev.features || EXCLUDED.features) AS merged(value) ORDER BY value)
     RETURNING id,status,alpha,trust_vector,provenance_json,information_label,features
     ), anchors AS (
     INSERT INTO ${storage.table("evidence_anchor_index")} AS anchor_index(evidence_id,features)
     SELECT upserted.id,
            ARRAY(
              SELECT feature
              FROM unnest(upserted.features) AS feature
              WHERE feature LIKE 'anchor:bi:%' OR feature LIKE 'anchor:sym:%'
              ORDER BY feature
            )
     FROM upserted
     WHERE EXISTS (
       SELECT 1
       FROM unnest(upserted.features) AS feature
       WHERE feature LIKE 'anchor:bi:%' OR feature LIKE 'anchor:sym:%'
     )
     ON CONFLICT(evidence_id) DO UPDATE SET
       features=ARRAY(
         SELECT DISTINCT feature
         FROM unnest(anchor_index.features || EXCLUDED.features) AS feature
         ORDER BY feature
       ) RETURNING evidence_id
     ) SELECT 1 AS language_memory_changed FROM upserted LEFT JOIN prior USING(id)
       WHERE prior.id IS NULL OR (upserted.status,upserted.alpha,upserted.trust_vector,upserted.provenance_json,upserted.information_label,upserted.features)
         IS DISTINCT FROM (prior.status,prior.alpha,prior.trust_vector,prior.provenance_json,prior.information_label,prior.features)`,
        [payloadChunk]
      );
      if (changes.length) storage.markLanguageMemoryChanged();
    }
  });
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
    async listEdgePage(query: { limit: number; offset?: number }) {
      // Cost bounds: one page per call, and endpoint-pair ordering so same-pair competitors share a page.
      const limit = Math.max(1, Math.min(200_000, Math.floor(query.limit)));
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      const rows = await storage.query<GraphEdgeRow>(
        `SELECT * FROM ${storage.table("graph_edges")} ORDER BY source_node_id, target_node_id, id LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows.map(rowToGraphEdge);
    },
    async getSlice(query) {
      const nodesPromise = queryNodes(storage, query);
      const edgeLimit = query.limitEdges ?? 2000;
      if (query.evidenceBoundOnly && query.evidenceIds?.length) {
        const evidenceIds = [...new Set(query.evidenceIds.map(String))];
        const access = storage.informationAccessPredicate("edge_row", 3);
        const groups: string[][] = [];
        for (let index = 0; index < evidenceIds.length; index += EVIDENCE_LOOKUP_GROUP) groups.push(evidenceIds.slice(index, index + EVIDENCE_LOOKUP_GROUP));
        const edgeRowsByGroup = await queryEvidenceGroups(groups, group => storage.query<GraphEdgeRow>(
            `SELECT * FROM ${storage.table("graph_edges")} AS edge_row
             WHERE evidence_ids && $1::text[] AND ${access.sql}
             ORDER BY alpha DESC, updated_at DESC, id LIMIT $2`,
            [group, edgeLimit, ...access.params]
          ));
        const edgeRows = new Map<string, GraphEdgeRow>();
        for (const rows of edgeRowsByGroup) for (const row of rows) if (!edgeRows.has(row.id)) edgeRows.set(row.id, row);
        const hyperedgeLimit = Math.max(1, Math.min(edgeLimit, Math.floor(edgeLimit / 2) || 1));
        const hyperedgeAccess = storage.informationAccessPredicate("hyperedge", 3);
        const hyperedgeRowsByGroup = await queryEvidenceGroups(groups, group => storage.query<HyperedgeRow>(
            `SELECT * FROM ${storage.table("graph_hyperedges")} AS hyperedge
             WHERE evidence_ids && $1::text[] AND ${hyperedgeAccess.sql}
             ORDER BY updated_at DESC LIMIT $2`,
            [group, hyperedgeLimit, ...hyperedgeAccess.params]
          ));
        const hyperedgeRows = new Map<string, HyperedgeRow>();
        for (const rows of hyperedgeRowsByGroup) for (const row of rows) if (!hyperedgeRows.has(row.id)) hyperedgeRows.set(row.id, row);
        const nodes = await nodesPromise;
        return {
          nodes,
          edges: [...edgeRows.values()].slice(0, edgeLimit).map(rowToGraphEdge),
          hyperedges: [...hyperedgeRows.values()].slice(0, hyperedgeLimit).map(rowToHyperedge),
          bounded: true,
          query
        };
      }
      const nodes = await nodesPromise;
      const ids = nodes.map(node => node.id);
      const perSeedEdgeLimit = ids.length ? Math.max(4, Math.ceil(edgeLimit / ids.length)) : 0;
      const edgeAccess = storage.informationAccessPredicate("edge_row", 4);
      const edges = ids.length
        ? (await storage.query<GraphEdgeRow>(
          `WITH seeds(seed_id, seed_ord) AS (
             SELECT seed_id, seed_ord
             FROM unnest($1::text[]) WITH ORDINALITY AS seed(seed_id, seed_ord)
           ),
           source_candidates AS (
             SELECT edge_row.id, edge_row.alpha, edge_row.updated_at, seeds.seed_ord
             FROM seeds
             CROSS JOIN LATERAL (
               SELECT id, alpha, updated_at
               FROM ${storage.table("graph_edges")}
               WHERE source_node_id=seeds.seed_id
               ORDER BY alpha DESC, updated_at DESC, id
               LIMIT $3
             ) edge_row
           ),
           target_candidates AS (
             SELECT edge_row.id, edge_row.alpha, edge_row.updated_at, seeds.seed_ord
             FROM seeds
             CROSS JOIN LATERAL (
               SELECT id, alpha, updated_at
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
           SELECT edge_row.*, ranked_candidates.seed_ord, ranked_candidates.edge_rank
           FROM ranked_candidates
           JOIN ${storage.table("graph_edges")} edge_row ON edge_row.id=ranked_candidates.id
           WHERE edge_rank=1
             AND ${edgeAccess.sql}
           ORDER BY ranked_candidates.seed_ord, edge_row.alpha DESC, edge_row.updated_at DESC, edge_row.id
           LIMIT $2`,
          [ids, edgeLimit, perSeedEdgeLimit, ...edgeAccess.params]
        )).map(rowToGraphEdge)
        : [];
      const hyperedgeMemberIds = ids.slice(0, Math.max(32, Math.min(ids.length, Math.floor((query.limitNodes ?? 800) / 3))));
      const hyperedgeAccess = storage.informationAccessPredicate("hyperedge", 3);
      // The same overlap-estimate cliff as the node lookup: 20ms at 32 member ids, 765ms at 213, for the same
      // rows. Asking in index-sized groups keeps it on the GIN index.
      const hyperedgeLimit = Math.max(64, Math.floor((query.limitEdges ?? 2000) / 4));
      const hyperedgeRows = new Map<string, HyperedgeRow>();
      for (let index = 0; index < hyperedgeMemberIds.length; index += EVIDENCE_LOOKUP_GROUP) {
        const group = hyperedgeMemberIds.slice(index, index + EVIDENCE_LOOKUP_GROUP);
        const rows = await storage.query<HyperedgeRow>(
          `SELECT *
           FROM ${storage.table("graph_hyperedges")} hyperedge
           WHERE member_node_ids && $1
             AND ${hyperedgeAccess.sql}
           ORDER BY updated_at DESC
           LIMIT $2`,
          [group, hyperedgeLimit, ...hyperedgeAccess.params]
        );
        for (const row of rows) if (!hyperedgeRows.has(row.id)) hyperedgeRows.set(row.id, row);
        if (hyperedgeRows.size >= hyperedgeLimit) break;
      }
      const hyperedges = [...hyperedgeRows.values()]
        .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
        .slice(0, hyperedgeLimit)
        .map(rowToHyperedge);
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
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(
      storage,
      "graph_nodes",
      nodes.map(node => ({ id: node.id, informationLabel: node.informationLabel }))
    );
    const payload = nodes.map(node => ({
      id: node.id,
      type_id: node.typeId,
      representation_json: node.representation,
      alpha: node.alpha,
      evidence_ids_json: node.evidenceIds,
      features_json: ginIndexableFeatures(node.features),
      created_at_ms: node.createdAt,
      updated_at_ms: node.updatedAt,
      metadata_json: node.metadata,
      information_label: labels.get(node.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.query(
        `INSERT INTO ${storage.table("graph_nodes")} AS n(id,type_id,representation_json,alpha,evidence_ids,features,created_at,updated_at,metadata_json,information_label)
     SELECT
       r.id,
       r.type_id,
       r.representation_json,
       r.alpha,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.features_json) AS v(value)),
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       TO_TIMESTAMP(r.updated_at_ms/1000.0),
       r.metadata_json,
       r.information_label
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       type_id text,
       representation_json jsonb,
       alpha double precision,
       evidence_ids_json jsonb,
       features_json jsonb,
       created_at_ms double precision,
       updated_at_ms double precision,
       metadata_json jsonb,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(n.alpha,EXCLUDED.alpha), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(n.evidence_ids || EXCLUDED.evidence_ids))), features=(SELECT ARRAY(SELECT DISTINCT unnest(n.features || EXCLUDED.features))), updated_at=EXCLUDED.updated_at, metadata_json=n.metadata_json || EXCLUDED.metadata_json, information_label=EXCLUDED.information_label
     -- Rewrite only a row this page would actually change.
     --
     -- The unions above are unconditional, so a node every page touches was re-sorted and rewritten every
     -- page whether or not anything new arrived. Measured on scce5: two observation_store nodes had reached
     -- 34,592 evidence ids and 2,297 kB, and writing 21 nodes cost 3,858ms while writing 231 in the next call
     -- cost 992ms -- the cost was in re-materialising arrays that already contained everything being added,
     -- then re-indexing 2.3MB in a 288MB GIN, twice a page.
     --
     -- The containment test is "is contained by": when this page's evidence ids and features are already
     -- present, its alpha is no higher, and its metadata and label add nothing, the row is unchanged and is
     -- left alone. updated_at is
     -- deliberately NOT a reason to rewrite: a node that nothing new was learned about was not updated, and
     -- treating the clock as a change makes every row dirty on every page.
     WHERE EXCLUDED.alpha > n.alpha
        OR NOT (EXCLUDED.evidence_ids <@ n.evidence_ids)
        OR NOT (EXCLUDED.features <@ n.features)
        OR n.metadata_json <> (n.metadata_json || EXCLUDED.metadata_json)
        OR n.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

async function upsertGraphEdgesBatch(storage: PostgresStorageAdapter, edges: readonly GraphEdge[]): Promise<void> {
  if (!edges.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(
      storage,
      "graph_edges",
      edges.map(edge => ({ id: edge.id, informationLabel: edge.informationLabel }))
    );
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
      metadata_json: edge.metadata,
      information_label: labels.get(edge.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.query(
        `INSERT INTO ${storage.table("graph_edges")} AS e(id,source_node_id,target_node_id,relation_id,alpha,weight,temporal_scope,evidence_ids,created_at,updated_at,metadata_json,information_label)
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
       r.metadata_json,
       r.information_label
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
       metadata_json jsonb,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(e.alpha,EXCLUDED.alpha), weight=GREATEST(e.weight,EXCLUDED.weight), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(e.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at, metadata_json=e.metadata_json || EXCLUDED.metadata_json, information_label=EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

async function upsertGraphHyperedgesBatch(storage: PostgresStorageAdapter, edges: readonly Hyperedge[]): Promise<void> {
  if (!edges.length) return;
  for (const edge of edges) assertCanonicalHyperedge(edge);
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(
      storage,
      "graph_hyperedges",
      edges.map(edge => ({ id: edge.id, informationLabel: edge.informationLabel }))
    );
    const payload = edges.map(edge => ({
      id: edge.id,
      schema_id: edge.schema,
      relation_id: edge.relationId,
      participant_ports_json: edge.participantPorts,
      member_node_ids_json: edge.memberNodeIds,
      qualifiers_json: edge.qualifiers,
      modality_json: edge.modality,
      evidence_ids_json: edge.evidenceIds,
      weight_vector: edge.weightVector,
      temporal_scope: edge.temporalScope,
      provenance_refs_json: edge.provenanceRefs,
      created_at_ms: edge.createdAt,
      updated_at_ms: edge.updatedAt,
      information_label: labels.get(edge.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.query(
        `INSERT INTO ${storage.table("graph_hyperedges")} AS h(id,schema_id,relation_id,participant_ports,member_node_ids,qualifiers_json,modality_json,evidence_ids,weight_vector,temporal_scope,provenance_refs,created_at,updated_at,information_label)
     SELECT
       r.id,
       r.schema_id,
       r.relation_id,
       r.participant_ports_json,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.member_node_ids_json) AS v(value)),
       r.qualifiers_json,
       r.modality_json,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       r.weight_vector,
       r.temporal_scope,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.provenance_refs_json) AS v(value)),
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       TO_TIMESTAMP(r.updated_at_ms/1000.0),
       r.information_label
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       schema_id text,
       relation_id text,
       participant_ports_json jsonb,
       member_node_ids_json jsonb,
       qualifiers_json jsonb,
       modality_json jsonb,
       evidence_ids_json jsonb,
       weight_vector jsonb,
       temporal_scope jsonb,
       provenance_refs_json jsonb,
       created_at_ms double precision,
       updated_at_ms double precision,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET schema_id=EXCLUDED.schema_id, participant_ports=EXCLUDED.participant_ports, member_node_ids=EXCLUDED.member_node_ids, qualifiers_json=EXCLUDED.qualifiers_json, modality_json=EXCLUDED.modality_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(h.evidence_ids || EXCLUDED.evidence_ids))), weight_vector=EXCLUDED.weight_vector, temporal_scope=EXCLUDED.temporal_scope, provenance_refs=(SELECT ARRAY(SELECT DISTINCT unnest(h.provenance_refs || EXCLUDED.provenance_refs))), updated_at=EXCLUDED.updated_at, information_label=EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

/** Evidence ids per graph lookup: small enough that the planner keeps using the GIN index. */
/**
 * Cost bound on a spread measurement, not a modeling parameter: it is the same for a request's runs and for the
 * sampled distribution the threshold is derived from, so both sides of the comparison are measured on one scale.
 * A unit the whole corpus uses saturates it, and saturation is the answer for such a unit.
 */
const SPREAD_SCAN_CAP = 1500;

/** Anchor postings lead; accessibility is checked by exact evidence id before the shared sampling bound. */
async function measureCanonicalSourceSpreads(storage: PostgresStorageAdapter, runs: readonly string[]): Promise<Array<{ run: string; sources: number }>> {
  if (!runs.length) return [];
  const access = storage.informationAccessPredicate("evidence", 2);
  return queryIndexedEvidence<{ run: string; sources: number }>(storage,
    `SELECT candidate.run AS run, measured.sources AS sources
     FROM jsonb_to_recordset($1::jsonb) AS candidate(run text, features text[])
     CROSS JOIN LATERAL (
       SELECT count(DISTINCT source_id)::int AS sources FROM (
         SELECT admitted.source_id FROM ${storage.table("evidence_anchor_index")} anchor_index
         CROSS JOIN LATERAL (
           SELECT evidence.source_id FROM ${storage.table("evidence_spans")} evidence
           WHERE evidence.id=anchor_index.evidence_id AND evidence.status='promoted' AND ${access.sql}
           OFFSET 0
         ) admitted
         WHERE cardinality(candidate.features)>0 AND anchor_index.features @> candidate.features
         LIMIT ${SPREAD_SCAN_CAP}
       ) sampled
     ) measured`,
    [JSON.stringify(runs.map(run => ({ run, features: uniquePostgresStrings(anchorSymbolUnits(run).map(unit => `anchor:sym:${unit}`)) }))), ...access.params]
  );
}

/** TOAST pointers understate array-membership cost; scope indexed retrieval to its transaction and restore the caller. */
async function queryIndexedEvidence<T>(storage: PostgresStorageAdapter, sql: string, params: unknown[]): Promise<T[]> {
  return storage.transaction(async () => {
    const [planner] = await storage.query<{ enabled: string }>("SELECT current_setting('enable_seqscan') AS enabled");
    if (!planner) throw new Error("PostgreSQL planner setting is unavailable");
    await storage.query("SET LOCAL enable_seqscan = off");
    const rows = await storage.query<T>(sql, params);
    await storage.query("SELECT set_config('enable_seqscan', $1, true)", [planner.enabled]);
    return rows;
  });
}

/** Unit separators the writing system supplies; a script that marks none yields a single unit. */
const IDENTITY_UNIT_SEPARATOR = /[^\p{L}\p{M}\p{N}'â€™-]+/gu;
/** Cost bound on the reversed identity scan; titles come back longest first, so the specific ones survive it. */
const IDENTITY_MATCH_LIMIT = 24;
/**
 * Every source title the corpus holds, loaded once per process.
 *
 * There is no index on the generated title column, so the DISTINCT that used to run per request was a full scan
 * of every span: measured at 19.5 seconds against 81,005 spans. It was cached by request text, which hid it on
 * repeats and charged it in full for every question the process had not seen before. The corpus changes only when
 * something is ingested, so this is refreshed on an interval rather than asked per turn, and a refresh that fails
 * keeps serving the titles it already has rather than making a turn wait on it.
 */
const SOURCE_TITLE_REFRESH_MS = 10 * 60 * 1000;
let sourceTitleCache: { titles: string[]; loadedAt: number } | undefined;
let sourceTitleInFlight: Promise<string[]> | undefined;

/** Test seam: forget the loaded title list, so a test starts from a corpus this process has not read. */
export function clearSourceTitleCache(): void {
  sourceTitleCache = undefined;
  sourceTitleInFlight = undefined;
}

async function sourceTitlesCached(
  storage: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]>; table: (name: string) => string },
  access: { sql: string; params: unknown[] }
): Promise<string[]> {
  const now = Date.now();
  if (sourceTitleCache && now - sourceTitleCache.loadedAt < SOURCE_TITLE_REFRESH_MS) return sourceTitleCache.titles;
  // A stale list still answers; only the first caller of a cold process waits.
  if (sourceTitleCache) {
    if (!sourceTitleInFlight) {
      sourceTitleInFlight = loadSourceTitles(storage, access)
        .then(titles => { sourceTitleCache = { titles, loadedAt: Date.now() }; return titles; })
        .catch(() => sourceTitleCache?.titles ?? [])
        .finally(() => { sourceTitleInFlight = undefined; });
    }
    return sourceTitleCache.titles;
  }
  sourceTitleInFlight ??= loadSourceTitles(storage, access)
    .then(titles => { sourceTitleCache = { titles, loadedAt: Date.now() }; return titles; })
    .finally(() => { sourceTitleInFlight = undefined; });
  return await sourceTitleInFlight;
}

async function loadSourceTitles(
  storage: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]>; table: (name: string) => string },
  access: { sql: string; params: unknown[] }
): Promise<string[]> {
  const rows = await storage.query<{ title: string }>(
    `SELECT DISTINCT evidence.source_title AS title
     FROM ${storage.table("evidence_spans")} evidence
     WHERE evidence.source_title <> '' AND ${access.sql}`,
    access.params
  );
  // Read the way a request is read. The request is reduced to the units its writing system supplies before the
  // containment test; a title that kept its own punctuation could never be found inside it, which is 4,153 of
  // 22,224 titles here -- every "Star Trek: Deep Space Nine", "Mercury (planet)" and "Halifax, Nova Scotia".
  const normalized = new Set(
    rows.map(row => String(row.title ?? "").normalize("NFC").toLocaleLowerCase().replace(IDENTITY_UNIT_SEPARATOR, " ").trim())
  );
  normalized.delete("");
  return [...normalized];
}
const EVIDENCE_LOOKUP_GROUP = 32;
const EVIDENCE_LOOKUP_CONCURRENCY = 3;

async function queryEvidenceGroups<T>(
  groups: readonly string[][],
  query: (group: string[]) => Promise<T[]>
): Promise<T[][]> {
  const results: T[][] = Array.from({ length: groups.length }, () => []);
  let nextGroup = 0;
  const worker = async (): Promise<void> => {
    while (nextGroup < groups.length) {
      const groupIndex = nextGroup++;
      results[groupIndex] = await query(groups[groupIndex]!);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(EVIDENCE_LOOKUP_CONCURRENCY, groups.length) },
    () => worker()
  ));
  return results;
}

async function queryNodes(storage: PostgresStorageAdapter, query: GraphSliceQuery): Promise<GraphNode[]> {
  if (query.seedNodeIds?.length) {
    const access = storage.informationAccessPredicate("node", 3);
    return (await storage.query<GraphNodeRow>(
      `SELECT * FROM ${storage.table("graph_nodes")} node WHERE id=ANY($1) AND ${access.sql} LIMIT $2`,
      [query.seedNodeIds, query.limitNodes ?? 800, ...access.params]
    )).map(rowToGraphNode);
  }
  if (query.evidenceIds?.length) {
    const access = storage.informationAccessPredicate("node", 3);
    const limit = query.limitNodes ?? 800;
    // Evidence spans carry the answer surface. A giant raw representation
    // cannot improve an evidence-addressed proof route, and transferring one
    // makes a small factual turn depend on source-file size.
    const representationBound = query.maxRepresentationBytes && query.maxRepresentationBytes > 0
      ? ` AND pg_column_size(node.representation_json) <= ${Math.floor(query.maxRepresentationBytes)}`
      : "";
    // An overlap test against a long array loses the planner's selectivity estimate: past roughly a hundred ids
    // it stops trusting the GIN index and sequentially scans every node (measured on a 1.39M-node corpus: 19ms
    // at 20 ids, 19.8s at 200, for the same answer). Asking in index-sized groups keeps every lookup on the
    // index and returns the same rows, ordered the same way.
    const groups: string[][] = [];
    for (let index = 0; index < query.evidenceIds.length; index += EVIDENCE_LOOKUP_GROUP) {
      groups.push([...query.evidenceIds.slice(index, index + EVIDENCE_LOOKUP_GROUP)] as string[]);
    }
    const rowsByGroup = await queryEvidenceGroups(groups, group => storage.query<GraphNodeRow>(
        `WITH evidence_candidates AS MATERIALIZED (
       SELECT *
       FROM ${storage.table("graph_nodes")} node
       WHERE evidence_ids && $1
         AND ${access.sql}${representationBound}
     )
     SELECT *
     FROM evidence_candidates
     ORDER BY alpha DESC, updated_at DESC
     LIMIT $2`,
        [group, limit, ...access.params]
      ));
    const seen = new Map<string, GraphNodeRow>();
    for (const rows of rowsByGroup) for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
    return [...seen.values()]
      .sort((left, right) =>
        Number(right.alpha ?? 0) - Number(left.alpha ?? 0)
        || new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())
      .slice(0, limit)
      .map(rowToGraphNode);
  }
  const features = graphQueryFeatures(query);
  if (features.length) {
    const access = storage.informationAccessPredicate("node", 3);
    return (await storage.query<GraphNodeRow>(
      `SELECT * FROM ${storage.table("graph_nodes")} node WHERE features && $1 AND ${access.sql} ORDER BY (SELECT COALESCE(SUM(1.0 / GREATEST(1, array_position($1::text[], feature))), 0) FROM unnest(features) feature WHERE feature=ANY($1)) DESC, alpha DESC, updated_at DESC LIMIT $2`,
      [features, query.limitNodes ?? 800, ...access.params]
    )).map(rowToGraphNode);
  }
  if (query.allowLatestFallback) {
    const access = storage.informationAccessPredicate("node", 2);
    // A warm-up asks for the highest-alpha nodes, and on a repo-ingested corpus those are code observations
    // carrying whole source files: measured 180KB average and 15MB maximum against a 641-byte corpus average,
    // so one warm-up dragged roughly 116MB across the connection mid-turn. A node too large to be worth caching
    // is simply not cached; a lookup that actually needs it still fetches it by id.
    const bound = query.maxRepresentationBytes;
    return (await storage.query<GraphNodeRow>(
      `SELECT * FROM ${storage.table("graph_nodes")} node WHERE ${access.sql}${bound ? " AND pg_column_size(node.representation_json) <= " + Math.floor(bound) : ""} ORDER BY alpha DESC, updated_at DESC, id LIMIT $1`,
      [query.limitNodes ?? 800, ...access.params]
    )).map(rowToGraphNode);
  }
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

/**
 * Maximum postings read per query feature during BM25 candidate generation.
 * Bounds retrieval work at (query features x this) rather than the size of
 * the largest posting list, and simultaneously floors the IDF of any term
 * common enough to hit it.
 */
// A feature seeds candidates when its postings fit this many rows. The rows are (id, feature, ordinal) and cost
// nothing at this size; the cap is where a term stops being a subject and starts being a stopword for this corpus.
const EVIDENCE_FEATURE_POSTING_CAP = 4096;
/** How many postings a last-resort seed may pull when no feature of the request is selective. */
// The last-resort seed pulls at most twice the selectivity cap: a lone over-cap word ("which") seeded 16,384 postings
// and 26s of candidate scoring on one question (measured); a subject just over the cap still fits in twice it.
const EVIDENCE_FEATURE_FALLBACK_CAP = EVIDENCE_FEATURE_POSTING_CAP * 2;

/**
 * Whether language_profiles carries the precomputed
 * referenced_by_language_memory column. Probed once per process: the answer
 * only changes when a migration runs, and probing per query would reintroduce
 * a round trip on the very path this exists to shorten.
 */
let referencedProfileFlagProbe: Promise<boolean> | undefined;

function referencedProfileFlagAvailable(store: { query<T>(sql: string, params?: unknown[]): Promise<T[]>; schema: string }): Promise<boolean> {
  referencedProfileFlagProbe ??= store.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='language_profiles' AND column_name='referenced_by_language_memory') AS present`,
    [store.schema]
  ).then(rows => rows[0]?.present === true).catch(() => false);
  return referencedProfileFlagProbe;
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
  if (cleanFeature.startsWith("anchor:bi:")) return true;
  if (cleanFeature.startsWith("anchor:sym:")) return [...cleanFeature.slice("anchor:sym:".length)].length >= 3;
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
      await storage.query(`INSERT INTO ${storage.table("quarantine_sources")} AS quarantine(id,source_id,source_version_id,uri,content_hash,media_type,fetched_at,trust_vector,permission_vector,license_hint,decision,decision_json) VALUES($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7/1000.0),$8::jsonb,$9::jsonb,$10,$11,$12::jsonb) ON CONFLICT(id) DO UPDATE SET decision=CASE WHEN quarantine.decision <> 'pending' THEN quarantine.decision ELSE EXCLUDED.decision END, decision_json=CASE WHEN quarantine.decision <> 'pending' THEN quarantine.decision_json ELSE EXCLUDED.decision_json END`, [source.id, source.sourceId, source.sourceVersionId, source.uri, source.contentHash, source.mediaType, source.fetchedAt, JSON.stringify(source.trustVector), JSON.stringify(source.permissionVector), source.licenseHint ?? null, source.decision, JSON.stringify(source.decisionJson ?? null)]);
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

interface RelationObservationRow {
  candidate_id: string;
  relation_seed_id: string;
  channel: string;
  source_id: string;
  source_family_id: string;
  signature: string;
  observed_at: Date | string;
}

function createRelationObservationStore(storage: PostgresStorageAdapter): RelationObservationStore {
  return {
    async put(rows) {
      for (const row of rows) {
        await storage.query(
          `INSERT INTO ${storage.table("relation_observations")}(relation_seed_id,channel,source_family_id,signature,candidate_id,source_id,observed_at) VALUES($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7/1000.0)) ON CONFLICT(relation_seed_id,channel,source_family_id,signature) DO NOTHING`,
          [row.relationSeedId, row.channel, row.sourceFamilyId, row.signature, row.candidateId, row.sourceId, row.observedAt]
        );
      }
    },
    async sourceFamilyCountsForSeeds(relationSeedIds) {
      if (!relationSeedIds.length) return new Map<string, number>();
      // relation_seed_id leads both indexes on this table, so this is bounded by the caller's seeds.
      const rows = await storage.query<{ relation_seed_id: string; families: string }>(
        `SELECT relation_seed_id, count(DISTINCT source_family_id)::bigint AS families
           FROM ${storage.table("relation_observations")}
          WHERE relation_seed_id = ANY($1)
          GROUP BY relation_seed_id`,
        [[...relationSeedIds]]
      );
      return new Map(rows.map(row => [row.relation_seed_id, Number(row.families)]));
    },
    async list(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query?.channel) { params.push(query.channel); where.push(`channel=$${params.length}`); }
      // Corroboration across independent sources is what promotion measures, so a default row cap silently decides
      // it; and observed_at alone ties across every row one backfill writes, which made the surviving slice
      // non-deterministic. Unbounded unless a caller asks, ordered by the primary key after the timestamp.
      let tail = "";
      if (typeof query?.limit === "number") { params.push(query.limit); tail = ` LIMIT $${params.length}`; }
      const rows = await storage.query<RelationObservationRow>(
        `SELECT * FROM ${storage.table("relation_observations")} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY observed_at DESC, relation_seed_id, channel, source_family_id, signature${tail}`,
        params
      );
      return rows.map(row => ({
        candidateId: row.candidate_id,
        relationSeedId: row.relation_seed_id,
        channel: row.channel,
        sourceId: row.source_id,
        sourceFamilyId: row.source_family_id,
        signature: row.signature,
        observedAt: new Date(row.observed_at).getTime()
      }));
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

interface PolicyGenomeRow {
  policy_fingerprint: string;
  objective_schema_id: string;
  vector_json: Record<string, number>;
  aggregated_objectives: number[];
  evaluation_count: number;
  information_label: JsonValue;
  first_evaluated_at: Date;
  last_evaluated_at: Date;
}

function rowToPolicyGenome(row: PolicyGenomeRow): DurablePolicyGenome {
  return {
    policyFingerprint: row.policy_fingerprint,
    objectiveSchemaId: row.objective_schema_id,
    vector: row.vector_json,
    aggregatedObjectives: row.aggregated_objectives.map(Number),
    evaluationCount: Number(row.evaluation_count),
    firstEvaluatedAt: row.first_evaluated_at.getTime(),
    lastEvaluatedAt: row.last_evaluated_at.getTime(),
    informationLabel: normalizeInformationLabel(row.information_label as never)
  };
}

/**
 * Durable, versioned policy-evaluation history. `putEvaluation` never
 * invents a genome by itself â€” it only ever records a real evaluation the
 * caller already computed and folds it into the running per-fingerprint
 * aggregate inside one transaction (read current aggregate, compute the
 * next one via the pure `aggregateGenome`, upsert), so concurrent
 * evaluations of the same policy can't race into a corrupted average.
 */
function createPolicyEvolutionStore(storage: PostgresStorageAdapter): PolicyEvolutionStore {
  return {
    async putEvaluation(evaluation: PolicyEvaluation) {
      await storage.transaction(async () => {
        await storage.query(
          `INSERT INTO ${storage.table("policy_evaluations")}(id,policy_fingerprint,objective_schema_id,vector_json,objectives,evaluation_window_json,observations,information_label,created_at)
           VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8::jsonb,TO_TIMESTAMP($9/1000.0))
           ON CONFLICT(id) DO NOTHING`,
          [
            evaluation.id,
            evaluation.policyFingerprint,
            evaluation.objectiveSchemaId,
            JSON.stringify(evaluation.vector),
            evaluation.objectives,
            JSON.stringify(evaluation.evaluationWindow),
            evaluation.observations,
            JSON.stringify(evaluation.informationLabel),
            evaluation.createdAt
          ]
        );
        const existing = await storage.query<PolicyGenomeRow>(
          `SELECT * FROM ${storage.table("policy_genomes")} WHERE policy_fingerprint=$1 AND objective_schema_id=$2`,
          [evaluation.policyFingerprint, evaluation.objectiveSchemaId]
        );
        const previous = existing[0] ? rowToPolicyGenome(existing[0]) : undefined;
        const next = aggregateGenome(previous, evaluation);
        await storage.query(
          `INSERT INTO ${storage.table("policy_genomes")}(policy_fingerprint,objective_schema_id,vector_json,aggregated_objectives,evaluation_count,information_label,first_evaluated_at,last_evaluated_at)
           VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb,TO_TIMESTAMP($7/1000.0),TO_TIMESTAMP($8/1000.0))
           ON CONFLICT(policy_fingerprint,objective_schema_id) DO UPDATE SET
             vector_json=EXCLUDED.vector_json,
             aggregated_objectives=EXCLUDED.aggregated_objectives,
             evaluation_count=EXCLUDED.evaluation_count,
             information_label=EXCLUDED.information_label,
             last_evaluated_at=EXCLUDED.last_evaluated_at`,
          [
            next.policyFingerprint,
            next.objectiveSchemaId,
            JSON.stringify(next.vector),
            next.aggregatedObjectives,
            next.evaluationCount,
            JSON.stringify(next.informationLabel),
            next.firstEvaluatedAt,
            next.lastEvaluatedAt
          ]
        );
      });
    },
    async listGenomes(query) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query?.objectiveSchemaId) {
        params.push(query.objectiveSchemaId);
        where.push(`objective_schema_id=$${params.length}`);
      }
      params.push(Math.max(1, Math.min(500, query?.limit ?? 100)));
      const rows = await storage.query<PolicyGenomeRow>(
        `SELECT * FROM ${storage.table("policy_genomes")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY last_evaluated_at DESC LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToPolicyGenome);
    }
  };
}

interface SparseRankingModelRow {
  model_id: string;
  task_class: string;
  feature_schema_id: string;
  lifecycle: string;
  state_json: JsonValue;
  training_window_json: JsonValue;
  examples_seen: string | number;
  evaluation_json: JsonValue | null;
  previous_active_model_id: string | null;
  rollback_reason: string | null;
  information_label: JsonValue;
  created_at: Date;
}

function rowToSparseRankingCheckpoint(row: SparseRankingModelRow): SparseRankingCheckpoint {
  return {
    modelId: row.model_id,
    taskClass: row.task_class,
    featureSchemaId: row.feature_schema_id,
    lifecycle: row.lifecycle as SparseRankingModelLifecycle,
    state: row.state_json as never,
    trainingWindow: row.training_window_json as never,
    examplesSeen: Number(row.examples_seen),
    evaluation: row.evaluation_json ?? undefined,
    previousActiveModelId: row.previous_active_model_id ?? undefined,
    rollbackReason: row.rollback_reason ?? undefined,
    informationLabel: normalizeInformationLabel(row.information_label as never),
    createdAt: row.created_at.getTime()
  };
}

/**
 * Durable FTRL reranker model lifecycle store (Part A finding 9, stage 5).
 * `activate()` structurally enforces the held-out-evaluation-gate
 * requirement -- it refuses to move a model into the single active slot
 * for its (taskClass, featureSchemaId) unless that model's own stored row
 * already has lifecycle "approved". Nothing here decides *when* to approve
 * a model; that judgment belongs to a held-out evaluation pass (not yet
 * built -- see the handoff doc) that would call `putCheckpoint` with an
 * "approved" lifecycle once it is satisfied.
 */
function createSparseRankingModelStore(storage: PostgresStorageAdapter): SparseRankingModelStore {
  return {
    async readActive(taskClass, featureSchemaId) {
      const activeRows = await storage.query<{ model_id: string }>(
        `SELECT model_id FROM ${storage.table("sparse_ranking_active_model")} WHERE task_class=$1 AND feature_schema_id=$2`,
        [taskClass, featureSchemaId]
      );
      const modelId = activeRows[0]?.model_id;
      if (!modelId) return undefined;
      const rows = await storage.query<SparseRankingModelRow>(
        `SELECT * FROM ${storage.table("sparse_ranking_models")} WHERE model_id=$1`,
        [modelId]
      );
      return rows[0] ? rowToSparseRankingCheckpoint(rows[0]) : undefined;
    },
    async putCheckpoint(checkpoint) {
      await storage.query(
        `INSERT INTO ${storage.table("sparse_ranking_models")}(model_id,task_class,feature_schema_id,lifecycle,state_json,training_window_json,examples_seen,evaluation_json,previous_active_model_id,rollback_reason,information_label,created_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9,$10,$11::jsonb,TO_TIMESTAMP($12/1000.0))
         ON CONFLICT(model_id) DO UPDATE SET
           lifecycle=EXCLUDED.lifecycle,
           state_json=EXCLUDED.state_json,
           training_window_json=EXCLUDED.training_window_json,
           examples_seen=EXCLUDED.examples_seen,
           evaluation_json=EXCLUDED.evaluation_json,
           previous_active_model_id=EXCLUDED.previous_active_model_id,
           rollback_reason=EXCLUDED.rollback_reason`,
        [
          checkpoint.modelId,
          checkpoint.taskClass,
          checkpoint.featureSchemaId,
          checkpoint.lifecycle,
          JSON.stringify(checkpoint.state),
          JSON.stringify(checkpoint.trainingWindow),
          checkpoint.examplesSeen,
          checkpoint.evaluation === undefined ? null : JSON.stringify(checkpoint.evaluation),
          checkpoint.previousActiveModelId ?? null,
          checkpoint.rollbackReason ?? null,
          JSON.stringify(checkpoint.informationLabel),
          checkpoint.createdAt
        ]
      );
    },
    async activate(input) {
      await storage.transaction(async () => {
        const targetRows = await storage.query<SparseRankingModelRow>(
          `SELECT * FROM ${storage.table("sparse_ranking_models")} WHERE model_id=$1 FOR UPDATE`,
          [input.modelId]
        );
        const target = targetRows[0];
        if (!target) throw new Error(`sparse ranking model not found: ${input.modelId}`);
        if (target.lifecycle !== "approved") {
          throw new Error(`sparse ranking model ${input.modelId} cannot activate from lifecycle "${target.lifecycle}" -- only "approved" models may activate`);
        }
        if (target.task_class !== input.taskClass || target.feature_schema_id !== input.featureSchemaId) {
          throw new Error(`sparse ranking model ${input.modelId} does not match the requested task/feature-schema class`);
        }
        const currentRows = await storage.query<{ model_id: string }>(
          `SELECT model_id FROM ${storage.table("sparse_ranking_active_model")} WHERE task_class=$1 AND feature_schema_id=$2 FOR UPDATE`,
          [input.taskClass, input.featureSchemaId]
        );
        const currentModelId = currentRows[0]?.model_id;
        if (input.expectedCurrentModelId !== undefined && (currentModelId ?? null) !== (input.expectedCurrentModelId ?? null)) {
          throw new Error(`sparse ranking active model conflict: expected ${input.expectedCurrentModelId ?? "none"}, found ${currentModelId ?? "none"}`);
        }
        if (currentModelId && currentModelId !== input.modelId) {
          await storage.query(
            `UPDATE ${storage.table("sparse_ranking_models")} SET lifecycle='approved' WHERE model_id=$1 AND lifecycle='active'`,
            [currentModelId]
          );
        }
        await storage.query(
          `INSERT INTO ${storage.table("sparse_ranking_active_model")}(task_class,feature_schema_id,model_id,activated_at)
           VALUES($1,$2,$3,NOW())
           ON CONFLICT(task_class,feature_schema_id) DO UPDATE SET model_id=EXCLUDED.model_id, activated_at=EXCLUDED.activated_at`,
          [input.taskClass, input.featureSchemaId, input.modelId]
        );
        await storage.query(
          `UPDATE ${storage.table("sparse_ranking_models")} SET lifecycle='active' WHERE model_id=$1`,
          [input.modelId]
        );
      });
    },
    async rollback(input) {
      await storage.transaction(async () => {
        const currentRows = await storage.query<{ model_id: string }>(
          `SELECT model_id FROM ${storage.table("sparse_ranking_active_model")} WHERE task_class=$1 AND feature_schema_id=$2 FOR UPDATE`,
          [input.taskClass, input.featureSchemaId]
        );
        const currentModelId = currentRows[0]?.model_id;
        if (!currentModelId) throw new Error(`no active sparse ranking model to roll back for ${input.taskClass}/${input.featureSchemaId}`);
        const currentModelRows = await storage.query<SparseRankingModelRow>(
          `SELECT * FROM ${storage.table("sparse_ranking_models")} WHERE model_id=$1 FOR UPDATE`,
          [currentModelId]
        );
        const previousActiveModelId = currentModelRows[0]?.previous_active_model_id ?? undefined;
        await storage.query(
          `UPDATE ${storage.table("sparse_ranking_models")} SET lifecycle='rolled_back', rollback_reason=$2 WHERE model_id=$1`,
          [currentModelId, input.reason]
        );
        if (previousActiveModelId) {
          await storage.query(
            `UPDATE ${storage.table("sparse_ranking_models")} SET lifecycle='active' WHERE model_id=$1`,
            [previousActiveModelId]
          );
          await storage.query(
            `INSERT INTO ${storage.table("sparse_ranking_active_model")}(task_class,feature_schema_id,model_id,activated_at)
             VALUES($1,$2,$3,NOW())
             ON CONFLICT(task_class,feature_schema_id) DO UPDATE SET model_id=EXCLUDED.model_id, activated_at=EXCLUDED.activated_at`,
            [input.taskClass, input.featureSchemaId, previousActiveModelId]
          );
        } else {
          await storage.query(
            `DELETE FROM ${storage.table("sparse_ranking_active_model")} WHERE task_class=$1 AND feature_schema_id=$2`,
            [input.taskClass, input.featureSchemaId]
          );
        }
      });
    }
  };
}

interface SparseRankingComparisonRow {
  id: string;
  task_class: string;
  feature_schema_id: string;
  recorded_at: Date;
  candidates_json: JsonValue;
  preferred_index: number;
  weight: number;
  source: string;
  information_label: JsonValue;
}

function rowToSparseRankingComparisonExample(row: SparseRankingComparisonRow): SparseRankingComparisonExample {
  return {
    id: row.id,
    taskClass: row.task_class,
    featureSchemaId: row.feature_schema_id,
    recordedAt: row.recorded_at.getTime(),
    candidates: row.candidates_json as never,
    preferredIndex: row.preferred_index,
    weight: row.weight,
    source: row.source as PairwiseLabelSource,
    informationLabel: normalizeInformationLabel(row.information_label as never)
  };
}

function createSparseRankingComparisonLogStore(storage: PostgresStorageAdapter): SparseRankingComparisonLogStore {
  return {
    async append(example) {
      await storage.query(
        `INSERT INTO ${storage.table("sparse_ranking_comparisons")}(id,task_class,feature_schema_id,recorded_at,candidates_json,preferred_index,weight,source,information_label)
         VALUES($1,$2,$3,TO_TIMESTAMP($4/1000.0),$5::jsonb,$6,$7,$8,$9::jsonb)
         ON CONFLICT(id) DO NOTHING`,
        [
          example.id,
          example.taskClass,
          example.featureSchemaId,
          example.recordedAt,
          JSON.stringify(example.candidates),
          example.preferredIndex,
          example.weight,
          example.source,
          JSON.stringify(example.informationLabel)
        ]
      );
    },
    async listRecent(input) {
      const rows = await storage.query<SparseRankingComparisonRow>(
        `SELECT * FROM (
           SELECT * FROM ${storage.table("sparse_ranking_comparisons")}
           WHERE task_class=$1 AND feature_schema_id=$2
           ORDER BY recorded_at DESC
           LIMIT $3
         ) recent ORDER BY recorded_at ASC`,
        [input.taskClass, input.featureSchemaId, input.limit]
      );
      return rows.map(rowToSparseRankingComparisonExample);
    }
  };
}

interface SegmentationAggregateRow {
  segmentation_version: string;
  language_cluster: string;
  tenant_id: string;
  corpus_role: string;
  active_import_version: string;
  documents_observed: string | number;
  lexical_segments_observed: string | number;
  spaced_boundary_observations: string | number;
  total_boundary_observations: string | number;
  first_observed_at: Date;
  last_observed_at: Date;
}

function rowToSegmentationAggregate(row: SegmentationAggregateRow): SegmentationAggregate {
  return {
    key: {
      segmentationVersion: row.segmentation_version,
      languageCluster: row.language_cluster,
      tenantId: row.tenant_id,
      corpusRole: row.corpus_role,
      activeImportVersion: row.active_import_version
    },
    documentsObserved: Number(row.documents_observed),
    lexicalSegmentsObserved: Number(row.lexical_segments_observed),
    spacedBoundaryObservations: Number(row.spaced_boundary_observations),
    totalBoundaryObservations: Number(row.total_boundary_observations),
    firstObservedAt: row.first_observed_at.getTime(),
    lastObservedAt: row.last_observed_at.getTime()
  };
}

/**
 * Durable per-language-cluster segmentation v2 boundary-signal aggregate
 * (Part B step 2). `observeDocument` reads the current aggregate for the
 * key, folds in the one real document's evidence via the pure
 * `foldSegmentationAggregate`, and upserts -- inside one transaction, same
 * read-fold-upsert shape as `createPolicyEvolutionStore` -- so concurrent
 * observations for the same key serialize correctly rather than racing.
 */
function createSegmentationAggregateStore(storage: PostgresStorageAdapter): SegmentationAggregateStore {
  const readOne = async (key: SegmentationAggregateKey): Promise<SegmentationAggregate | undefined> => {
    const rows = await storage.query<SegmentationAggregateRow>(
      `SELECT * FROM ${storage.table("segmentation_aggregates")}
        WHERE segmentation_version=$1 AND language_cluster=$2 AND tenant_id=$3 AND corpus_role=$4 AND active_import_version=$5`,
      [key.segmentationVersion, key.languageCluster, key.tenantId, key.corpusRole, key.activeImportVersion]
    );
    return rows[0] ? rowToSegmentationAggregate(rows[0]) : undefined;
  };
  return {
    readAggregate: readOne,
    async observeDocument(input) {
      return storage.transaction(async () => {
        const previous = await readOne(input.key);
        const next = foldSegmentationAggregate(previous, input.key, input.model, input.observedAt);
        await storage.query(
          `INSERT INTO ${storage.table("segmentation_aggregates")}(segmentation_version,language_cluster,tenant_id,corpus_role,active_import_version,documents_observed,lexical_segments_observed,spaced_boundary_observations,total_boundary_observations,first_observed_at,last_observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TO_TIMESTAMP($10/1000.0),TO_TIMESTAMP($11/1000.0))
           ON CONFLICT(segmentation_version,language_cluster,tenant_id,corpus_role,active_import_version) DO UPDATE SET
             documents_observed=EXCLUDED.documents_observed,
             lexical_segments_observed=EXCLUDED.lexical_segments_observed,
             spaced_boundary_observations=EXCLUDED.spaced_boundary_observations,
             total_boundary_observations=EXCLUDED.total_boundary_observations,
             last_observed_at=EXCLUDED.last_observed_at`,
          [
            next.key.segmentationVersion,
            next.key.languageCluster,
            next.key.tenantId,
            next.key.corpusRole,
            next.key.activeImportVersion,
            next.documentsObserved,
            next.lexicalSegmentsObserved,
            next.spacedBoundaryObservations,
            next.totalBoundaryObservations,
            next.firstObservedAt,
            next.lastObservedAt
          ]
        );
        return next;
      });
    }
  };
}

interface InducedLanguageModelRow {
  id: string;
  training_plan_id: string;
  model_json: JsonValue;
  information_label: JsonValue;
  created_at: Date;
}

function rowToInducedLanguageModelRecord(row: InducedLanguageModelRow): InducedLanguageModelRecord {
  return {
    id: row.id,
    model: row.model_json as unknown as InducedLanguageModel,
    trainingPlanId: row.training_plan_id,
    createdAt: row.created_at.getTime(),
    informationLabel: normalizeInformationLabel(row.information_label as never)
  };
}

function inducedModelObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function inducedLanguageWitnessManifest(
  storage: PostgresStorageAdapter,
  reference: LanguageSegmentationWitnessReference
): Promise<LanguagePatternRecord> {
  const rows = await storage.languageMemory.listLanguagePatterns({
    patternIds: [reference.manifestPatternId],
    limit: 1
  });
  if (rows.length !== 1) throw new Error("induced language model segmentation witness manifest is unavailable");
  return rows[0]!;
}

function inducedLanguageManifestSourcePatternIds(manifest: LanguagePatternRecord): string[] {
  const body = inducedModelObject(manifest.patternJson);
  const populations = Array.isArray(body.populations) ? body.populations : [];
  return populations.flatMap(population => {
    const sources = inducedModelObject(population).sourceWitnesses;
    return Array.isArray(sources) ? sources.flatMap(source => {
      const patternId = inducedModelObject(source).patternId;
      return typeof patternId === "string" && patternId ? [patternId] : [];
    }) : [];
  });
}

function validateInducedLanguageWitnessManifestIdentity(
  reference: LanguageSegmentationWitnessReference,
  manifest: LanguagePatternRecord,
  expectedWitnessId?: string
): string {
  const body = inducedModelObject(manifest.patternJson);
  const witnessId = body.id;
  if (body.schema !== LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA
    || body.witnessSchema !== LANGUAGE_SEGMENTATION_WITNESS_SCHEMA
    || typeof witnessId !== "string" || !witnessId
    || (expectedWitnessId !== undefined && witnessId !== expectedWitnessId)) {
    throw new Error("induced language model segmentation witness differs from its canonical manifest");
  }
  const expectedPatternId = `segmentation_archive.${createHasher().digestHex(canonicalStringify([witnessId, manifest.profileId]))}`;
  if (manifest.id !== reference.manifestPatternId || manifest.id !== expectedPatternId) {
    throw new Error("induced language model segmentation witness manifest identity changed");
  }
  return witnessId;
}

async function hydrateInducedLanguageModel(
  storage: PostgresStorageAdapter,
  stored: JsonValue
): Promise<InducedLanguageModel> {
  const model = inducedModelObject(stored);
  const value = model.segmentationWitness;
  if (value === undefined) {
    throw new Error("induced language model is missing its canonical segmentation witness reference");
  }
  if (inducedModelObject(value).schema === LANGUAGE_SEGMENTATION_WITNESS_SCHEMA) {
    throw new Error("embedded induced language segmentation witnesses are retired; reproject the model through canonical witness archives");
  }
  if (!isLanguageSegmentationWitnessReference(value)) {
    throw new Error("induced language model has an invalid segmentation witness reference");
  }
  const manifest = await inducedLanguageWitnessManifest(storage, value);
  const sourcePatternIds = inducedLanguageManifestSourcePatternIds(manifest);
  const sourceWitnesses = sourcePatternIds.length
    ? await storage.languageMemory.listLanguagePatterns({ patternIds: sourcePatternIds, limit: sourcePatternIds.length })
    : [];
  const segmentationWitness = hydrateLanguageSegmentationWitness({
    reference: value,
    manifest,
    sourceWitnesses
  });
  return { ...model, segmentationWitness } as unknown as InducedLanguageModel;
}

async function inducedLanguageModelForStorage(
  storage: PostgresStorageAdapter,
  record: InducedLanguageModelRecord
): Promise<JsonValue> {
  const model = inducedModelObject(record.model);
  const witness = model.segmentationWitness;
  if (witness === undefined) {
    throw new Error("induced language model is missing its canonical segmentation witness");
  }
  if (!isLanguageSegmentationWitness(witness)) {
    if (isLanguageSegmentationWitnessReference(witness)) {
      const manifest = await inducedLanguageWitnessManifest(storage, witness);
      validateInducedLanguageWitnessManifestIdentity(witness, manifest);
      return record.model as unknown as JsonValue;
    }
    throw new Error("induced language model has an invalid segmentation witness");
  }
  const reference = record.segmentationWitnessReference;
  if (!reference || !isLanguageSegmentationWitnessReference(reference)) {
    throw new Error("full induced language segmentation witnesses require a canonical archive reference");
  }
  const manifest = await inducedLanguageWitnessManifest(storage, reference);
  validateInducedLanguageWitnessManifestIdentity(reference, manifest, witness.id);
  return toJsonValue({ ...model, segmentationWitness: reference });
}

/** Durable full induction-model persistence (Part B step 3). */
function createInducedLanguageModelStore(storage: PostgresStorageAdapter): InducedLanguageModelStore {
  return {
    async putModel(record) {
      await storage.transaction(async () => {
      const checkpoint = await inducedLanguageModelForStorage(storage, record);
      const model = await canonicalCreativeCodec(storage).encode(checkpoint, record.informationLabel);
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("induced_language_models")}(id,training_plan_id,model_json,corpus_documents,vocabulary_size,information_label,created_at)
         VALUES($1,$2,$3::jsonb,$4,$5,$6::jsonb,TO_TIMESTAMP($7/1000.0))
         ON CONFLICT(id) DO NOTHING`,
        [
          record.id,
          record.trainingPlanId,
          JSON.stringify(model),
          record.model.corpusDocuments,
          record.model.vocabularySize,
          JSON.stringify(record.informationLabel),
          record.createdAt
        ]
      );
      });
    },
    async readById(id) {
      const rows = await storage.query<InducedLanguageModelRow>(
        `SELECT * FROM ${storage.table("induced_language_models")} WHERE id=$1`,
        [id]
      );
      if (!rows[0]) return undefined;
      const [stored] = await canonicalCreativeCodec(storage).decodeMany([rows[0].model_json]);
      const model = await hydrateInducedLanguageModel(storage, stored as JsonValue);
      return rowToInducedLanguageModelRecord({ ...rows[0], model_json: model as unknown as JsonValue });
    },
    async listRecent(query = {}) {
      const limit = Math.max(1, Math.min(200, query.limit ?? 20));
      const rows = await storage.query<InducedLanguageModelRow>(
        `SELECT * FROM ${storage.table("induced_language_models")} ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      const stored = await canonicalCreativeCodec(storage).decodeMany(rows.map(row => row.model_json));
      const models = await Promise.all(stored.map(model => hydrateInducedLanguageModel(storage, model as JsonValue)));
      return rows.map((row, index) => rowToInducedLanguageModelRecord({ ...row, model_json: models[index] as unknown as JsonValue }));
    }
  };
}

interface SegmentationPopulationModelRow {
  id: string;
  training_plan_id: string;
  model_json: SegmentationPopulationModel;
  profile_ids: string[];
  source_version_ids: SourceVersionId[];
  information_label: JsonValue;
  created_at: Date;
}

function rowToSegmentationPopulationModelRecord(
  row: SegmentationPopulationModelRow
): SegmentationPopulationModelRecord {
  return {
    id: row.id,
    model: row.model_json,
    trainingPlanId: row.training_plan_id,
    profileIds: row.profile_ids,
    sourceVersionIds: row.source_version_ids,
    createdAt: row.created_at.getTime(),
    informationLabel: normalizeInformationLabel(row.information_label as never)
  };
}

function createSegmentationPopulationModelStore(
  storage: PostgresStorageAdapter
): SegmentationPopulationModelStore {
  return {
    async putModel(record) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("segmentation_population_models")}(id,training_plan_id,model_json,profile_ids,source_version_ids,population_count,mdl_gain_nats,information_label,created_at)
         VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,$8::jsonb,TO_TIMESTAMP($9/1000.0))
         ON CONFLICT(id) DO NOTHING`,
        [
          record.id,
          record.trainingPlanId,
          JSON.stringify(record.model),
          [...new Set(record.profileIds)].sort(),
          [...new Set(record.sourceVersionIds.map(String))].sort(),
          record.model.populations.length,
          record.model.selection.mdlGainNats,
          JSON.stringify(record.informationLabel),
          record.createdAt
        ]
      );
    },
    async readById(id) {
      const rows = await storage.query<SegmentationPopulationModelRow>(
        `SELECT * FROM ${storage.table("segmentation_population_models")} WHERE id=$1`,
        [id]
      );
      return rows[0] ? rowToSegmentationPopulationModelRecord(rows[0]) : undefined;
    },
    async listRecent(query = {}) {
      const limit = Math.max(1, Math.min(200, query.limit ?? 20));
      const profileIds = [...new Set(query.profileIds ?? [])].sort();
      const rows = await storage.query<SegmentationPopulationModelRow>(
        profileIds.length
          ? `SELECT * FROM ${storage.table("segmentation_population_models")} WHERE profile_ids && $1::text[] ORDER BY created_at DESC,id LIMIT $2`
          : `SELECT * FROM ${storage.table("segmentation_population_models")} ORDER BY created_at DESC,id LIMIT $1`,
        profileIds.length ? [profileIds, limit] : [limit]
      );
      return rows.map(rowToSegmentationPopulationModelRecord);
    }
  };
}

// Every corpus ingester records its source system as the source's `corpus:<sourceSystemId>` namespace; this reads it back.
const CORPUS_NAMESPACE_PREFIX = "corpus:";
function sourceSystemFromCorpusNamespace(namespace: string | null): string {
  return namespace?.startsWith(CORPUS_NAMESPACE_PREFIX) ? namespace.slice(CORPUS_NAMESPACE_PREFIX.length) : "";
}

function createLanguageIdentityStore(storage: PostgresStorageAdapter): LanguageIdentityStore {
  const writeIdentities = async (records: readonly LanguageIdentityRecord[]) => {
    for (const record of records) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("language_identities")} AS identity(id,identity_json,created_at,information_label)
         VALUES($1,$2::jsonb,TO_TIMESTAMP($3/1000.0),$4::jsonb)
         ON CONFLICT(id) DO UPDATE SET identity_json=EXCLUDED.identity_json, information_label=EXCLUDED.information_label
         WHERE identity.identity_json IS DISTINCT FROM EXCLUDED.identity_json OR identity.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [record.id, JSON.stringify(record), record.createdAt, JSON.stringify(storage.requireWritableInformationLabel(record.informationLabel))]
      );
    }
  };
  return {
    async putIdentities(records) {
      await storage.transaction(() => writeIdentities(records));
    },
    async replaceIdentities(records) {
      await storage.transaction(async () => {
        await writeIdentities(records);
        const access = storage.informationAccessPredicate("identity", 2);
        await storage.mutateLanguageMemory(
          `DELETE FROM ${storage.table("language_identities")} identity WHERE NOT (identity.id = ANY($1::text[])) AND ${access.sql}`,
          [records.map(record => record.id), ...access.params]
        );
      });
    },
    async listIdentities() {
      const access = storage.informationAccessPredicate("li", 1);
      const rows = await storage.query<{ identity_json: LanguageIdentityRecord }>(
        `SELECT li.identity_json FROM ${storage.table("language_identities")} li WHERE ${access.sql} ORDER BY li.id`, access.params);
      return rows.map(row => row.identity_json);
    },
    async assignProfileLanguages(assignments) {
      for (let offset = 0; offset < assignments.length; offset += 5000) {
        const chunk = assignments.slice(offset, offset + 5000);
        await storage.mutateLanguageMemory(
          `UPDATE ${storage.table("language_profiles")} lp SET language_id = r.language_id
           FROM jsonb_to_recordset($1::jsonb) AS r(profile_id text, language_id text)
           WHERE lp.id = r.profile_id AND lp.language_id IS DISTINCT FROM r.language_id`,
          [JSON.stringify(chunk.map(row => ({ profile_id: row.profileId, language_id: row.languageId })))]
        );
      }
    },
    async listProfileLanguages(query) {
      const profileIds = query ? [...new Set(query.profileIds.filter(Boolean))].sort() : undefined;
      if (profileIds && !profileIds.length) return [];
      const params: unknown[] = profileIds ? [profileIds] : [];
      const profileAccess = storage.informationAccessPredicate("lp", params.length + 1); params.push(...profileAccess.params);
      // Source access belongs to the labeled version; sources stores only identity metadata.
      const ownerSql = profileSourceOwnershipSql(storage, params, "lp");
      const rows = await storage.query<{ id: string; language_id: string }>(
        `SELECT lp.id, lp.language_id FROM ${storage.table("language_profiles")} lp
         WHERE ${profileIds ? "lp.id=ANY($1::text[]) AND" : ""} lp.language_id IS NOT NULL
           AND ${profileAccess.sql} AND ${ownerSql}
         ORDER BY lp.id`, params);
      return rows.map(row => ({ profileId: row.id, languageId: row.language_id }));
    },
    async listPooledProfileSignatures(query) {
      const params: unknown[] = [query.afterId ?? "", Math.max(1, Math.min(4000, Math.floor(query.limit)))];
      const profileAccess = storage.informationAccessPredicate("lp", params.length + 1); params.push(...profileAccess.params);
      const ownerSql = pooledProfileOwnershipSql(storage, params, "lp.id", "lp.source_version_id", "(lp.profile_json->'pooledSourceBinding')");
      const rows = await storage.query<{ profile_json: LanguageProfile }>(`SELECT lp.profile_json FROM ${storage.table("language_profiles")} lp
        WHERE lp.id>$1 AND ${profileAccess.sql} AND ${ownerSql} ORDER BY lp.id LIMIT $2`, params);
      return rows.flatMap(row => {
        validatePooledLanguageProfileOwnership(row.profile_json, createHasher());
        const signature = languageProfileSignature(row.profile_json, "");
        return [{ id: row.profile_json.id, sourceVersionId: row.profile_json.sourceVersionId, sourceSystem: "", sourceUri: "",
          scripts: [...row.profile_json.scripts], direction: row.profile_json.direction,
          topContinuation: (signature?.topContinuation ?? []).map(([word, count]) => [word, count] as [string, number]) }];
      });
    },
    async profileAssignments() {
      const params: unknown[] = [];
      const profileAccess = storage.informationAccessPredicate("lp", params.length + 1); params.push(...profileAccess.params);
      const versionAccess = storage.informationAccessPredicate("sv", params.length + 1); params.push(...versionAccess.params);
      const newerAccess = storage.informationAccessPredicate("newer_version", params.length + 1); params.push(...newerAccess.params);
      const evidenceAccess = storage.informationAccessPredicate("newer_evidence", params.length + 1); params.push(...evidenceAccess.params);
      const pooledOwnerSql = pooledProfileOwnershipSql(storage, params, "lp.id", "lp.source_version_id", "(lp.profile_json->'pooledSourceBinding')");
      const rows = await storage.query<{ id: string; source_version_id: string; language_id: string | null }>(
        `SELECT lp.id,lp.source_version_id,lp.language_id FROM ${storage.table("language_profiles")} lp
         LEFT JOIN ${storage.table("source_versions")} sv ON sv.id=lp.source_version_id
         WHERE ${profileAccess.sql} AND (sv.id IS NOT NULL AND ${versionAccess.sql} OR ${pooledOwnerSql})
           AND NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} newer_version
             WHERE newer_version.source_id=sv.source_id AND (newer_version.observed_at,newer_version.id)>(sv.observed_at,sv.id)
               AND ${newerAccess.sql} AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} newer_evidence
                 WHERE newer_evidence.source_version_id=newer_version.id AND newer_evidence.source_id=newer_version.source_id
                   AND newer_evidence.status='promoted' AND ${evidenceAccess.sql}))
         ORDER BY lp.id`, params);
      return rows.map(row => ({ profileId: row.id, sourceVersionId: row.source_version_id as SourceVersionId, languageId: row.language_id }));
    },
    async putProfileSignatures({ rows, informationLabel }) {
      if (!rows.length) return;
      const label = storage.requireWritableInformationLabel(informationLabel);
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("language_profile_signatures")} AS signature(id, source_version_id, scripts, direction, top_continuation, created_at, information_label)
         SELECT r.id, r.source_version_id, r.scripts, r.direction, r.top_continuation, NOW(), $2::jsonb
         FROM jsonb_to_recordset($1::jsonb) AS r(
           id text, source_version_id text, scripts jsonb, direction text, top_continuation jsonb
         )
         ON CONFLICT(id) DO UPDATE
         SET scripts=EXCLUDED.scripts, direction=EXCLUDED.direction, top_continuation=EXCLUDED.top_continuation
         WHERE signature.scripts IS DISTINCT FROM EXCLUDED.scripts OR signature.direction IS DISTINCT FROM EXCLUDED.direction OR signature.top_continuation IS DISTINCT FROM EXCLUDED.top_continuation`,
        [
          JSON.stringify(rows.map(row => ({
            id: row.id,
            source_version_id: row.sourceVersionId,
            scripts: row.scripts,
            direction: row.direction,
            top_continuation: row.topContinuation
          }))),
          JSON.stringify(label)
        ]
      );
    },
    async listProfileSignatures(query) {
      const params: unknown[] = [query.afterId ?? "", Math.max(1, Math.min(10000, Math.floor(query.limit)))];
      const profileAccess = storage.informationAccessPredicate("src", params.length + 1); params.push(...profileAccess.params);
      const versionAccess = storage.informationAccessPredicate("sv", params.length + 1); params.push(...versionAccess.params);
      const newerAccess = storage.informationAccessPredicate("newer_version", params.length + 1); params.push(...newerAccess.params);
      const evidenceAccess = storage.informationAccessPredicate("newer_evidence", params.length + 1); params.push(...evidenceAccess.params);
      const preferredProfileAccess = storage.informationAccessPredicate("preferred_full", params.length + 1); params.push(...preferredProfileAccess.params);
      // Trained shard profiles and page signatures are one discovery population. Unioned rather than replaced:
      // a brain ingested before page signatures existed still has only shard profiles, and must still discover.
      const rows = await storage.query<{ id: string; source_version_id: string; source_uri: string | null; namespace: string | null; model_source_system: string | null; scripts: JsonValue; direction: string | null; top: JsonValue }>(
        `SELECT src.id, src.source_version_id, s.canonical_uri AS source_uri, s.namespace AS namespace,
                ngram_source.source_system AS model_source_system,
                src.scripts AS scripts, src.direction AS direction, src.top AS top
         FROM (
           SELECT lp.id, lp.source_version_id, lp.information_label,
                  lp.profile_json->'scripts' AS scripts, lp.profile_json->>'direction' AS direction,
                  lp.profile_json->'kneserNey'->'topContinuation' AS top
           FROM ${storage.table("language_profiles")} lp WHERE lp.profile_json->'pooledSourceBinding' IS NULL
           UNION ALL
           SELECT ps.id, ps.source_version_id, ps.information_label, ps.scripts, ps.direction, ps.top_continuation
           FROM ${storage.table("language_profile_signatures")} ps
           WHERE NOT EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} preferred_full
             WHERE preferred_full.source_version_id=ps.source_version_id
               AND preferred_full.profile_json->'pooledSourceBinding' IS NULL AND ${preferredProfileAccess.sql})
         ) src
         JOIN ${storage.table("source_versions")} sv ON sv.id = src.source_version_id
         LEFT JOIN ${storage.table("sources")} s ON s.id = sv.source_id
         LEFT JOIN LATERAL (
           SELECT m.model_json->>'sourceSystem' AS source_system
           FROM ${storage.table("ngram_models")} m
           WHERE (s.namespace IS NULL OR s.namespace NOT LIKE 'corpus:%')
             AND m.model_json->>'profileId' = src.id
             AND NULLIF(m.model_json->>'sourceSystem', '') IS NOT NULL
           ORDER BY m.updated_at DESC, m.id
           LIMIT 1
         ) ngram_source ON TRUE
         WHERE src.id > $1 AND ${profileAccess.sql} AND ${versionAccess.sql}
           AND NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} newer_version
             WHERE newer_version.source_id=sv.source_id AND (newer_version.observed_at,newer_version.id)>(sv.observed_at,sv.id)
               AND ${newerAccess.sql} AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} newer_evidence
                 WHERE newer_evidence.source_version_id=newer_version.id AND newer_evidence.source_id=newer_version.source_id
                   AND newer_evidence.status='promoted' AND ${evidenceAccess.sql}))
         ORDER BY src.id LIMIT $2`, params
      );
      return rows.map(row => ({
        id: row.id,
        sourceVersionId: row.source_version_id as SourceVersionId,
        sourceSystem: sourceSystemFromCorpusNamespace(row.namespace) || row.model_source_system || "",
        sourceUri: row.source_uri ?? "",
        scripts: Array.isArray(row.scripts) ? (row.scripts as Array<{ script: string; mass: number }>) : [],
        direction: row.direction ?? "unknown",
        topContinuation: Array.isArray(row.top)
          ? (row.top as JsonValue[]).filter((pair): pair is JsonValue[] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number").map(pair => [String(pair[0]), Number(pair[1])] as [string, number])
          : []
      }));
    }
  };
}

// A non-public label requires at least one principal (see
// packages/kernel/src/information-flow.ts's normalizeInformationLabel) --
// "system" is the coherent self-referential principal for this tenant-less
// executive telemetry, not an empty array that would fail validation on
// every later read.
const EXECUTIVE_SYSTEM_INFORMATION_LABEL = {
  tenantId: "system",
  principals: ["system"] as string[],
  compartments: [] as string[],
  exportClass: "internal" as const,
  mergePolicy: "isolated" as const
};

interface ExecutiveEventRow {
  event_json: ExecutiveEvent;
}

/**
 * Postgres-backed ExecutiveEventJournal: one durable row per executive
 * event (not one row per command with an embedded array), because a single
 * command can emit multiple events and the journal's own contract requires
 * `snapshot.revision === snapshot.events.length` on replay. Duplicate
 * commands are detected before expectedRevision is even compared, so
 * retrying an already-committed command reports "duplicate", never
 * "conflict".
 *
 * Information labels on individual executive events are not yet plumbed
 * through `ExecutiveJournalAppend` (that interface predates this adapter);
 * every event is stored under a fixed system-internal label until that
 * interface is extended to carry a real one per event.
 */
export function createExecutiveEventJournal(storage: PostgresStorageAdapter): ExecutiveEventJournal {
  return {
    async read(episodeId: ExecutiveEpisodeId) {
      const episodeRows = await storage.query<{ revision: string }>(
        `SELECT revision FROM ${storage.table("executive_episode")} WHERE episode_id=$1`,
        [episodeId]
      );
      const revision = episodeRows[0] ? Number(episodeRows[0].revision) : 0;
      const eventRows = await storage.query<ExecutiveEventRow>(
        `SELECT event_json FROM ${storage.table("executive_event")} WHERE episode_id=$1 ORDER BY revision ASC`,
        [episodeId]
      );
      return { episodeId, revision, events: eventRows.map(row => row.event_json) };
    },

    async append(input) {
      return storage.transaction(async () => {
        await storage.query(
          `INSERT INTO ${storage.table("executive_episode")}(episode_id,revision,updated_at) VALUES($1,0,NOW()) ON CONFLICT(episode_id) DO NOTHING`,
          [input.episodeId]
        );
        const locked = await storage.query<{ revision: string }>(
          `SELECT revision FROM ${storage.table("executive_episode")} WHERE episode_id=$1 FOR UPDATE`,
          [input.episodeId]
        );
        const currentRevision = Number(locked[0]?.revision ?? 0);

        const duplicate = await storage.query<{ episode_id: string }>(
          `SELECT episode_id FROM ${storage.table("executive_command")} WHERE episode_id=$1 AND command_id=$2`,
          [input.episodeId, input.commandId]
        );
        if (duplicate.length > 0) return { status: "duplicate" as const, revision: currentRevision };

        if (currentRevision !== input.expectedRevision) {
          return { status: "conflict" as const, revision: currentRevision };
        }

        if (input.events.length === 0) return { status: "appended" as const, revision: currentRevision };

        input.events.forEach((event, index) => {
          const expected = input.expectedRevision + index + 1;
          if (event.revision !== expected) {
            throw new Error(`executive event ${index} has revision ${event.revision}, expected consecutive revision ${expected}`);
          }
          if (event.episodeId !== input.episodeId || event.commandId !== input.commandId) {
            throw new Error(`executive event ${index} does not match its own command/episode`);
          }
        });
        const revisionEnd = input.expectedRevision + input.events.length;

        await storage.query(
          `INSERT INTO ${storage.table("executive_command")}(episode_id,command_id,revision_start,revision_end,created_at) VALUES($1,$2,$3,$4,NOW())`,
          [input.episodeId, input.commandId, input.expectedRevision + 1, revisionEnd]
        );
        for (const event of input.events) {
          await storage.query(
            `INSERT INTO ${storage.table("executive_event")}(episode_id,revision,command_id,event_json,information_label,created_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,TO_TIMESTAMP($6/1000.0))`,
            [input.episodeId, event.revision, input.commandId, JSON.stringify(event), JSON.stringify(EXECUTIVE_SYSTEM_INFORMATION_LABEL), event.occurredAt]
          );
        }
        await storage.query(
          `UPDATE ${storage.table("executive_episode")} SET revision=$2, updated_at=NOW() WHERE episode_id=$1`,
          [input.episodeId, revisionEnd]
        );
        return { status: "appended" as const, revision: revisionEnd };
      });
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
    async listLanguageProfileHeaders(query) {
      if (!query.profileIds.length) return [];
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0) throw new Error("profile header limit must be a positive safe integer");
      const params: unknown[] = [[...new Set(query.profileIds)]];
      const where = ["lp.id=ANY($1::text[])"];
      appendInformationAccess(storage, "lp", params, where);
      where.push(profileSourceOwnershipSql(storage, params, "lp"));
      params.push(query.limit);
      return (await storage.query<{ id: string; source_version_id: SourceVersionId; parent_source_version_ids: SourceVersionId[] | null; information_label: InformationLabel }>(
        `SELECT lp.id,lp.source_version_id,lp.information_label,
           CASE WHEN NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} direct_owner WHERE direct_owner.id=lp.source_version_id)
             AND jsonb_typeof(lp.profile_json->'pooledSourceBinding'->'parents')='array'
             THEN ARRAY(SELECT jsonb_array_elements_text(lp.profile_json->'pooledSourceBinding'->'parents')) ELSE NULL END AS parent_source_version_ids FROM ${storage.table("language_profiles")} lp
         WHERE ${where.join(" AND ")} ORDER BY lp.id COLLATE "C" LIMIT $${params.length}`, params))
        .map(row => ({ id: row.id, sourceVersionId: row.source_version_id, informationLabel: row.information_label,
          ...(row.parent_source_version_ids ? { parentSourceVersionIds: row.parent_source_version_ids } : {}) }));
    },
    async listLanguageProfiles(query) {
      const requestedLimit = typeof query === "number" ? query : query?.limit;
      const boundedLimit = Math.max(1, Math.min(8192, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit!) : 512));
      if (typeof query === "object" && query?.surfaceNgrams !== undefined) {
        const ngrams = [...new Set(query.surfaceNgrams.map(value => value.normalize("NFC").toLowerCase()).filter(Boolean))].slice(0, 1024);
        if (!ngrams.length) return [];
        // These EXISTS answer a question that does not depend on the
        // request: is this profile referenced by language memory at all?
        // On the trigram path the prefilter cannot reduce the rows they
        // run over -- measured, ngram_keys && $1 matches 22390 of 22463
        // profiles -- so they execute per row across the whole table on
        // every turn, which is the bulk of runtime.seed.surface_cluster.
        //
        // tools/migrations/2026-08-18-language-profile-referenced-flag.sql
        // precomputes and trigger-maintains that answer as a column. It is
        // used when present and the correlated form kept when not, so this
        // is correct both before and after that migration runs. Hoisting
        // the EXISTS into a MATERIALIZED union instead was measured at
        // 16148ms against 794ms and rejected: the cost is the repetition,
        // not the probe.
        const referencedFilter = query.referencedByLanguageMemory
          ? (await referencedProfileFlagAvailable(storage))
            ? "AND lp.referenced_by_language_memory"
            : `AND (
               EXISTS (SELECT 1 FROM ${storage.table("language_units")} u WHERE u.profile_id=lp.id OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("language_patterns")} p WHERE p.profile_id=lp.id AND p.pattern_kind<>'source_compilation' OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("ngram_models")} m WHERE m.model_json->>'profileId'=lp.id OFFSET 0)
               OR ${observationReferencedProfileFilterSql(storage)}
               OR EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")} f WHERE f.frame_json->>'profileId'=lp.id OFFSET 0)
             )`
          : "";
        const access = storage.informationAccessPredicate("lp", 3);
        return (await storage.query<{ profile_json: LanguageProfile }>(
          `SELECT lp.profile_json || jsonb_build_object('informationLabel', lp.information_label) AS profile_json
           FROM ${storage.table("language_profiles")} lp
           WHERE lp.ngram_keys && $1::text[]
             ${referencedFilter}
             AND ${access.sql}
           ORDER BY (
             SELECT COUNT(*)
             FROM unnest(lp.ngram_keys) key
             WHERE key=ANY($1::text[])
           ) DESC, lp.created_at DESC, lp.id ASC
           LIMIT $2`,
          [ngrams, boundedLimit, ...access.params]
        )).map(row => row.profile_json);
      }
      if (typeof query === "object" && query?.sourceDerivedAliases !== undefined) {
        const aliasKeys = [...new Set(query.sourceDerivedAliases
          .map(normalizeSourceLanguageAlias)
          .filter(Boolean))].sort();
        if (!aliasKeys.length) return [];
        // These EXISTS answer a question that does not depend on the
        // request: is this profile referenced by language memory at all?
        // On the trigram path the prefilter cannot reduce the rows they
        // run over -- measured, ngram_keys && $1 matches 22390 of 22463
        // profiles -- so they execute per row across the whole table on
        // every turn, which is the bulk of runtime.seed.surface_cluster.
        //
        // tools/migrations/2026-08-18-language-profile-referenced-flag.sql
        // precomputes and trigger-maintains that answer as a column. It is
        // used when present and the correlated form kept when not, so this
        // is correct both before and after that migration runs. Hoisting
        // the EXISTS into a MATERIALIZED union instead was measured at
        // 16148ms against 794ms and rejected: the cost is the repetition,
        // not the probe.
        const referencedFilter = query.referencedByLanguageMemory
          ? (await referencedProfileFlagAvailable(storage))
            ? "AND lp.referenced_by_language_memory"
            : `AND (
               EXISTS (SELECT 1 FROM ${storage.table("language_units")} u WHERE u.profile_id=lp.id OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("language_patterns")} p WHERE p.profile_id=lp.id AND p.pattern_kind<>'source_compilation' OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("ngram_models")} m WHERE m.model_json->>'profileId'=lp.id OFFSET 0)
               OR ${observationReferencedProfileFilterSql(storage)}
               OR EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")} f WHERE f.frame_json->>'profileId'=lp.id OFFSET 0)
             )`
          : "";
        const access = storage.informationAccessPredicate("lp", 3);
        return (await storage.query<{ profile_json: LanguageProfile }>(
          `SELECT lp.profile_json || jsonb_build_object('informationLabel', lp.information_label) AS profile_json
           FROM ${storage.table("language_profile_aliases")} alias
           JOIN ${storage.table("language_profiles")} lp
             ON lp.id=alias.profile_id
            AND lp.source_version_id=alias.source_version_id
           WHERE alias.alias_key=ANY($1)
             AND (
               alias.source_version_id=ANY(alias.source_version_refs)
               OR EXISTS (
                 SELECT 1
                 FROM ${storage.table("evidence_spans")} e
                 WHERE e.id=ANY(alias.evidence_refs)
                   AND e.source_version_id=alias.source_version_id
               )
             )
             ${referencedFilter}
             AND ${access.sql}
           ORDER BY alias.confidence DESC,alias.updated_at DESC,lp.id ASC
           LIMIT $2`,
          [aliasKeys, boundedLimit, ...access.params]
        )).map(row => row.profile_json);
      }
      if (typeof query === "object" && query?.sourceVersionIds !== undefined) {
        const sourceVersionIds = uniquePostgresStrings(query.sourceVersionIds.map(String).filter(Boolean)).slice(0, 512);
        if (!sourceVersionIds.length) return [];
        const referencedFilter = query.referencedByLanguageMemory
          ? (await referencedProfileFlagAvailable(storage))
            ? "AND lp.referenced_by_language_memory"
            : `AND (
               EXISTS (SELECT 1 FROM ${storage.table("language_units")} u WHERE u.profile_id=lp.id OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("language_patterns")} p WHERE p.profile_id=lp.id AND p.pattern_kind<>'source_compilation' OFFSET 0)
               OR EXISTS (SELECT 1 FROM ${storage.table("ngram_models")} m WHERE m.model_json->>'profileId'=lp.id OFFSET 0)
               OR ${observationReferencedProfileFilterSql(storage)}
               OR EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")} f WHERE f.frame_json->>'profileId'=lp.id OFFSET 0)
             )`
          : "";
        const access = storage.informationAccessPredicate("lp", 3);
        return (await storage.query<{ profile_json: LanguageProfile }>(
          `SELECT lp.profile_json || jsonb_build_object('informationLabel', lp.information_label) AS profile_json
           FROM ${storage.table("language_profiles")} lp
           WHERE lp.source_version_id=ANY($1::text[])
             ${referencedFilter}
             AND ${access.sql}
           ORDER BY lp.created_at DESC, lp.id ASC
           LIMIT $2`,
          [sourceVersionIds, boundedLimit, ...access.params]
        )).map(row => row.profile_json);
      }
      if (typeof query === "object" && query?.referencedByLanguageMemory) {
        const access = storage.informationAccessPredicate("lp", 2);
        return (await storage.query<{ profile_json: LanguageProfile }>(
          `SELECT lp.profile_json || jsonb_build_object('informationLabel', lp.information_label) AS profile_json
           FROM ${storage.table("language_profiles")} lp
           WHERE (
                EXISTS (SELECT 1 FROM ${storage.table("language_units")} u WHERE u.profile_id=lp.id OFFSET 0)
             OR EXISTS (SELECT 1 FROM ${storage.table("language_patterns")} p WHERE p.profile_id=lp.id AND p.pattern_kind<>'source_compilation' OFFSET 0)
             OR EXISTS (SELECT 1 FROM ${storage.table("ngram_models")} m WHERE m.model_json->>'profileId'=lp.id OFFSET 0)
             OR ${observationReferencedProfileFilterSql(storage)}
             OR EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")} f WHERE f.frame_json->>'profileId'=lp.id OFFSET 0)
           )
             AND ${access.sql}
           ORDER BY lp.created_at DESC, lp.id ASC
           LIMIT $1`,
          [boundedLimit, ...access.params]
        )).map(row => row.profile_json);
      }
      const access = storage.informationAccessPredicate("lp", 2);
      return (await storage.query<{ profile_json: LanguageProfile }>(
        `SELECT lp.profile_json || jsonb_build_object('informationLabel', lp.information_label) AS profile_json
         FROM ${storage.table("language_profiles")} lp
         WHERE ${access.sql}
         ORDER BY created_at DESC, id ASC
         LIMIT $1`,
        [boundedLimit, ...access.params]
      )).map(row => row.profile_json);
    }
  };
}

// ngram_observations is a multi-GB table with only tens of distinct
// profileIds. A correlated `EXISTS (... WHERE metadata_json->>'profileId'
// = lp.id)` makes the planner seq-scan the whole table once per candidate
// profile that has no observations (verified live: the profile-cluster
// query sat in IO DataFileRead for 25+ minutes after whole-novel
// training). This recursive skip scan over the profile expression index
// enumerates the distinct profileIds in one index probe per distinct value
// (verified live: 53ms vs 3.5 minutes for the same 23 values), and because
// the IN subquery is uncorrelated it is hashed once per query instead of
// re-run per row.
function observationReferencedProfileFilterSql(storage: PostgresStorageAdapter): string {
  const observations = storage.table("ngram_observations");
  const profileId = ngramObservationProfileIdExpression("o");
  return `lp.id IN (
    WITH RECURSIVE obs_profiles(pid) AS (
      (SELECT ${profileId} FROM ${observations} o
       WHERE ${profileId} IS NOT NULL
       ORDER BY ${profileId} LIMIT 1)
      UNION ALL
      SELECT (SELECT ${profileId} FROM ${observations} o
              WHERE ${profileId} > op.pid
              ORDER BY ${profileId} LIMIT 1)
      FROM obs_profiles op WHERE op.pid IS NOT NULL
    )
    SELECT pid FROM obs_profiles WHERE pid IS NOT NULL
  )`;
}

async function putLanguageProfilesBatch(storage: PostgresStorageAdapter, profiles: readonly LanguageProfile[]): Promise<void> {
  if (!profiles.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(
      storage,
      "language_profiles",
      profiles.map(profile => ({ id: profile.id, informationLabel: profile.informationLabel }))
    );
    const labeledProfiles = profiles.map(profile => ({
      ...profile,
      informationLabel: labels.get(profile.id)!
    }));
    for (const profile of labeledProfiles) {
      const ownership = validatePooledLanguageProfileOwnership(profile, createHasher());
      if (!ownership) continue;
      if (!isPreparedPooledLanguageProfileOwnership(ownership)) {
        const existing = await storage.query<{ ownership: JsonValue }>(`SELECT profile_json->'pooledSourceBinding' AS ownership FROM ${storage.table("language_profiles")} WHERE id=$1`, [profile.id]);
        if (canonicalStringify(existing[0]?.ownership ?? null) !== canonicalStringify(ownership)) throw new Error("pooled profile ownership requires a verified source preparation");
      }
      await storage.query(`SELECT pooled_source.id FROM ${storage.table("sources")} pooled_source
        JOIN ${storage.table("source_versions")} pooled_version ON pooled_version.source_id=pooled_source.id
        JOIN ${storage.table("evidence_spans")} pooled_span ON pooled_span.source_version_id=pooled_version.id AND pooled_span.source_id=pooled_source.id
        WHERE pooled_span.id=ANY($1::text[]) ORDER BY pooled_source.id,pooled_version.id,pooled_span.id FOR UPDATE OF pooled_source,pooled_version,pooled_span`,
      [ownership.evidence.map(row => String(row.id)).sort()]);
      const params: unknown[] = [JSON.stringify(ownership), profile.id, profile.sourceVersionId];
      const ownerSql = pooledProfileOwnershipSql(storage, params, "$2::text", "$3::text", "$1::jsonb");
      const rows = await storage.query<{ accepted: boolean }>(`SELECT ${ownerSql} AS accepted`, params);
      if (rows[0]?.accepted !== true) throw new Error("pooled profile parents are not current accessible promoted evidence");
    }
    const payload = labeledProfiles.map(profile => ({
      id: profile.id,
      source_version_id: profile.sourceVersionId,
      profile_json: profile,
      ngram_keys: [...new Set(profile.charNgrams.map(row => row.ngram.normalize("NFC").toLowerCase()))].slice(0, 1024),
      created_at_ms: profile.createdAt,
      information_label: profile.informationLabel
    }));
    const aliases = sourceOwnedLanguageAliasRows(labeledProfiles);
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("language_profiles")} AS lp(id,source_version_id,profile_json,ngram_keys,created_at,information_label)
       SELECT r.id, r.source_version_id, r.profile_json, r.ngram_keys, TO_TIMESTAMP(r.created_at_ms/1000.0), r.information_label
       FROM jsonb_to_recordset($1::jsonb) AS r(
         id text,
         source_version_id text,
         profile_json jsonb,
         ngram_keys text[],
         created_at_ms double precision,
         information_label jsonb
       )
       ON CONFLICT(id) DO UPDATE SET profile_json=EXCLUDED.profile_json, ngram_keys=EXCLUDED.ngram_keys, information_label=EXCLUDED.information_label
       WHERE lp.profile_json IS DISTINCT FROM EXCLUDED.profile_json OR lp.ngram_keys IS DISTINCT FROM EXCLUDED.ngram_keys OR lp.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
    await storage.mutateLanguageMemory(
      `DELETE FROM ${storage.table("language_profile_aliases")} alias WHERE profile_id=ANY($1) AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) incoming(alias_key text,profile_id text)
        WHERE incoming.alias_key=alias.alias_key AND incoming.profile_id=alias.profile_id
      )`,
      [profiles.map(profile => profile.id), JSON.stringify(aliases)]
    );
    if (aliases.length) {
      await storage.mutateLanguageMemory(
        `WITH rows AS (
           SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS r(
             alias_key text,
             alias_surface text,
             profile_id text,
             source_version_id text,
             evidence_refs text[],
             source_version_refs text[],
             confidence double precision,
             updated_at_ms double precision
           )
         )
         INSERT INTO ${storage.table("language_profile_aliases")} AS alias(
           alias_key,alias_surface,profile_id,source_version_id,evidence_refs,source_version_refs,confidence,updated_at
         )
         SELECT r.alias_key,r.alias_surface,r.profile_id,r.source_version_id,
                r.evidence_refs,r.source_version_refs,r.confidence,TO_TIMESTAMP(r.updated_at_ms/1000.0)
         FROM rows r
         WHERE r.source_version_id=ANY(r.source_version_refs)
            OR EXISTS (
              SELECT 1
              FROM ${storage.table("evidence_spans")} e
              WHERE e.id=ANY(r.evidence_refs)
                AND e.source_version_id=r.source_version_id
            )
         ON CONFLICT(alias_key,profile_id) DO UPDATE SET
           alias_surface=EXCLUDED.alias_surface,
           source_version_id=EXCLUDED.source_version_id,
           evidence_refs=EXCLUDED.evidence_refs,
           source_version_refs=EXCLUDED.source_version_refs,
           confidence=EXCLUDED.confidence,
           updated_at=EXCLUDED.updated_at
         WHERE alias.alias_surface IS DISTINCT FROM EXCLUDED.alias_surface OR alias.source_version_id IS DISTINCT FROM EXCLUDED.source_version_id
           OR alias.evidence_refs IS DISTINCT FROM EXCLUDED.evidence_refs OR alias.source_version_refs IS DISTINCT FROM EXCLUDED.source_version_refs
           OR alias.confidence IS DISTINCT FROM EXCLUDED.confidence`,
        [JSON.stringify(aliases)]
      );
    }
  });
}

function isEvidenceAnchorFeature(feature: string): boolean {
  const cleanFeature = feature.trim();
  return cleanFeature.startsWith("anchor:bi:") || cleanFeature.startsWith("anchor:sym:");
}

function sourceOwnedLanguageAliasRows(profiles: readonly LanguageProfile[]): Array<{
  alias_key: string;
  alias_surface: string;
  profile_id: string;
  source_version_id: string;
  evidence_refs: string[];
  source_version_refs: string[];
  confidence: number;
  updated_at_ms: number;
}> {
  const byOwner = new Map<string, {
    alias_key: string;
    alias_surface: string;
    profile_id: string;
    source_version_id: string;
    evidence_refs: string[];
    source_version_refs: string[];
    confidence: number;
    updated_at_ms: number;
  }>();
  for (const profile of profiles) {
    for (const name of profile.discoveredNames ?? []) {
      const aliasKey = normalizeSourceLanguageAlias(name.surface);
      if (!aliasKey) continue;
      const evidenceRefs = [...new Set(name.evidenceRefs.map(String).filter(Boolean))].sort();
      const sourceVersionRefs = [...new Set((name.sourceVersionRefs ?? []).map(String).filter(Boolean))].sort();
      if (!evidenceRefs.length && !sourceVersionRefs.includes(String(profile.sourceVersionId))) continue;
      const candidate = {
        alias_key: aliasKey,
        alias_surface: name.surface.normalize("NFC").trim(),
        profile_id: profile.id,
        source_version_id: String(profile.sourceVersionId),
        evidence_refs: evidenceRefs,
        source_version_refs: sourceVersionRefs,
        confidence: Math.max(0, Math.min(1, Number.isFinite(name.confidence) ? name.confidence : 0)),
        updated_at_ms: profile.updatedAt ?? profile.createdAt
      };
      const key = `${aliasKey}\u001f${profile.id}`;
      const existing = byOwner.get(key);
      if (!existing || candidate.confidence > existing.confidence) byOwner.set(key, candidate);
    }
  }
  return [...byOwner.values()].sort((left, right) =>
    left.alias_key.localeCompare(right.alias_key)
    || left.profile_id.localeCompare(right.profile_id)
  );
}

const NGRAM_OBSERVATION_BATCH_MAX_JSON_BYTES = 32 * 1024 * 1024;
const NGRAM_OBSERVATION_BATCH_MAX_ROWS = 50_000;

interface NgramObservationBatchRow {
  id: string;
  stream_id: string;
  language_hint: string;
  order_n: number;
  history_json: string[];
  symbol: string;
  count: number;
  field_weight: number;
  source_version_id: string | null;
  evidence_id: string | null;
  observed_at_ms: number;
  metadata_json: JsonValue;
  information_label: InformationLabel;
}

function ngramObservationBatchRow(observation: NgramObservation): NgramObservationBatchRow {
  return {
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
    metadata_json: observation.metadata,
    information_label: normalizeInformationLabel(observation.informationLabel!)
  };
}

/**
 * Chunk any batch payload below Postgres's hard 268435455-byte jsonb
 * limit (verified live: little-women's language-pattern batch -- 5x more
 * promoted constructions after the promotion-gate recalibration, each
 * bundle carrying full source examples -- exceeded it in one statement
 * and failed the whole book). Batches split at a conservative 64MB; a
 * single row larger than that ships alone (it is still storable up to
 * the ~200MB margin); a single row beyond the margin cannot be stored at
 * all and throws with the row identified.
 */
const JSON_ROW_BATCH_TARGET_BYTES = 64 * 1024 * 1024;
const JSON_ROW_HARD_LIMIT_BYTES = 200 * 1024 * 1024;

function* serializedJsonRowBatches(rows: readonly unknown[], rowLabel: (row: unknown) => string): Generator<string> {
  let current: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(text, "utf8");
    if (rowBytes + 2 > JSON_ROW_HARD_LIMIT_BYTES) {
      throw new Error(`batch row ${rowLabel(row)} serializes to ${rowBytes} bytes, beyond the storable jsonb margin`);
    }
    const separator = current.length ? 1 : 0;
    if (current.length && (bytes + separator + rowBytes > JSON_ROW_BATCH_TARGET_BYTES)) {
      yield `[${current.join(",")}]`;
      current = [];
      bytes = 2;
    }
    if (current.length) bytes++;
    current.push(text);
    bytes += rowBytes;
  }
  if (current.length) yield `[${current.join(",")}]`;
}

function batchRowId(row: unknown): string {
  return String((row as { id?: unknown })?.id ?? "(no id)");
}

function* serializedNgramObservationBatches(observations: readonly NgramObservation[]): Generator<string> {
  let rows: string[] = [];
  let payloadBytes = 2;
  for (const observation of observations) {
    const row = JSON.stringify(ngramObservationBatchRow(observation));
    const rowBytes = Buffer.byteLength(row, "utf8");
    if (rowBytes + 2 > NGRAM_OBSERVATION_BATCH_MAX_JSON_BYTES) {
      throw new Error(
        `ngram observation ${observation.id} serialized payload exceeds ${NGRAM_OBSERVATION_BATCH_MAX_JSON_BYTES} bytes`
      );
    }
    const separatorBytes = rows.length ? 1 : 0;
    if (
      rows.length >= NGRAM_OBSERVATION_BATCH_MAX_ROWS
      || payloadBytes + separatorBytes + rowBytes > NGRAM_OBSERVATION_BATCH_MAX_JSON_BYTES
    ) {
      yield `[${rows.join(",")}]`;
      rows = [];
      payloadBytes = 2;
    }
    if (rows.length) payloadBytes++;
    rows.push(row);
    payloadBytes += rowBytes;
  }
  if (rows.length) yield `[${rows.join(",")}]`;
}

interface CurrentCompilationHeaderRow {
  id: string; stream_id: string;
  profile_id: string; source_system: string; source_id: string; source_version_id: string; content_hash: string; model_metadata: JsonValue; compilation_receipt: JsonValue;
}

interface LanguagePatternOwner { profileId: string; sourceSystem: string | null }

async function currentLanguagePatternCompilations(storage: PostgresStorageAdapter, query: Parameters<LanguageMemoryStore["listLanguagePatterns"]>[0], requestedOwners?: readonly LanguagePatternOwner[]) {
  if (requestedOwners && !requestedOwners.length) return [];
  const params: unknown[] = [];
  let models = `${storage.table("ngram_models")} model`;
  if (requestedOwners) {
    params.push(canonicalStringify(requestedOwners));
    // Keep each indexed owner lookup ahead of model JSON extraction.
    models = `jsonb_to_recordset($${params.length}::jsonb) AS requested_owner("profileId" text,"sourceSystem" text)
     CROSS JOIN LATERAL (
       SELECT model.id,model.stream_id,model.profile_id,model.source_system,model.model_json,model.information_label
       FROM ${storage.table("ngram_models")} model
       WHERE model.profile_id=requested_owner."profileId"
         AND model.source_system IS NOT DISTINCT FROM requested_owner."sourceSystem"
       OFFSET 0
     ) model`;
  }
  const where: string[] = ['metadata."sourceCompilation" IS NOT NULL'];
  const profileIds = query?.profileIds ?? (query?.profileId ? [query.profileId] : undefined);
  if (profileIds) { params.push([...profileIds]); where.push(`model.profile_id=ANY($${params.length}::text[])`); }
  if (query?.sourceSystem) { params.push(query.sourceSystem); where.push(`model.source_system=$${params.length}`); }
  if (query?.languageId) { params.push(query.languageId); where.push(`(profile.language_id=$${params.length} OR profile.language_id IS NULL)`); }
  for (const alias of ["model", "profile", "version"]) appendInformationAccess(storage, alias, params, where);
  const receiptAccess = storage.informationAccessPredicate("receipt", params.length + 1);
  params.push(...receiptAccess.params);
  const rows = await storage.query<CurrentCompilationHeaderRow>(
    `SELECT model.id,model.stream_id,model.profile_id,model.source_system,version.source_id,version.id AS source_version_id,version.content_hash,
       jsonb_build_object('profileId',metadata."profileId",'sourceVersionId',metadata."sourceVersionId",'sourceSystem',metadata."sourceSystem",'sourceCompilation',metadata."sourceCompilation") AS model_metadata,
       receipt.pattern_json->'compilation' AS compilation_receipt
     FROM ${models}
     JOIN ${storage.table("language_profiles")} profile ON profile.id=model.profile_id
     JOIN ${storage.table("source_versions")} version ON version.id=profile.source_version_id
     CROSS JOIN LATERAL jsonb_to_record(model.model_json) AS metadata("sourceCompilation" jsonb,"profileId" text,"sourceVersionId" text,"sourceSystem" text)
     LEFT JOIN ${storage.table("language_patterns")} receipt ON receipt.id='source.language.compilation.' || (metadata."sourceCompilation"->>'compilationId')
       AND receipt.profile_id=model.profile_id AND receipt.source_system=model.source_system AND receipt.pattern_kind='source_compilation'
       AND receipt.pattern_json->>'schema'='scce.source_language_compilation_receipt.v1'
       AND ${receiptAccess.sql}
     WHERE ${where.join(" AND ")}`, params);
  const hasher = createHasher();
  const groups = new Map<string, { row: CurrentCompilationHeaderRow; rows: CurrentCompilationHeaderRow[]; compilationId: string; valid: boolean }>();
  for (const row of rows) {
    const key = canonicalStringify([row.profile_id, row.source_system]);
    const previous = groups.get(key);
    let compilationId = "";
    try {
      compilationId = validateSourceLanguageCompilationHeader({ owner: { sourceId: row.source_id as SourceId, sourceVersionId: row.source_version_id as SourceVersionId,
        contentHash: row.content_hash as ContentHash }, profileId: row.profile_id, sourceSystem: row.source_system, modelJson: row.model_metadata,
        compilationReceipt: row.compilation_receipt, validationPolicy: "read_stored", hasher });
    } catch { /* Invalid compiler ownership never authorizes owned artifacts. */ }
    const modelRows = previous?.rows ?? [];
    modelRows.push(row);
    groups.set(key, { row, rows: modelRows, compilationId, valid: Boolean(compilationId) && (!previous || previous.valid && previous.compilationId === compilationId) });
  }
  return [...groups.values()].filter(group => {
    if (!group.valid) return false;
    try {
      validateSourceCompilationModelInventory(group.row.compilation_receipt, group.rows.map(row => {
        const compilation = (row.model_metadata as { sourceCompilation: { chunk: JsonValue; modelDigest: string } }).sourceCompilation;
        return { id: row.id, streamId: row.stream_id, chunk: compilation.chunk, modelDigest: compilation.modelDigest };
      }), hasher);
      return true;
    } catch { return false; }
  }).map(({ row, compilationId }) => ({ profileId: row.profile_id,
    sourceSystem: row.source_system, sourceVersionId: row.source_version_id, compilationId }));
}

function jsonbArraySql(value: string): string {
  return `CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END`;
}

function jsonbFieldsSql(value: string, fields: readonly string[]): string {
  if (!fields.length) return "'{}'::jsonb";
  const keys = fields.map(field => `'${field.replaceAll("'", "''")}'`).join(",");
  const columns = fields.map(field => `"${field.replaceAll('"', '""')}" jsonb`).join(",");
  const object = `CASE WHEN jsonb_typeof(${value})='object' THEN ${value} ELSE '{}'::jsonb END`;
  // Unselected bodies never enter a tuplestore; original keys distinguish missing fields from JSON null.
  return `(WITH seed_original_keys AS MATERIALIZED (
      SELECT key FROM jsonb_object_keys(${object}) seed_key(key)
      WHERE seed_key.key=ANY(ARRAY[${keys}]::text[])
    ), seed_selected_fields AS MATERIALIZED (
      SELECT to_jsonb(seed_record) AS value FROM jsonb_to_record(${object}) AS seed_record(${columns})
    ) SELECT COALESCE(jsonb_object_agg(seed_field.key,seed_field.value),'{}'::jsonb)
    FROM seed_original_keys seed_key CROSS JOIN seed_selected_fields seed_selected
    CROSS JOIN LATERAL (SELECT seed_key.key AS key,seed_selected.value->seed_key.key AS value) seed_field)`;
}

function requestSeedPatternJsonSql(value: string, schema: string): string {
  const declared = (roles: string, flag: string) => `(${value}->'${flag}'='true'::jsonb OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(${jsonbArraySql(`${value}#>'{bundle,sourceExamples}'`)}) seed_example(value)
    CROSS JOIN LATERAL jsonb_array_elements(${jsonbArraySql(`seed_example.value->'${roles}'`)}) seed_role(value)
    WHERE jsonb_typeof(seed_role.value->'graphBinding')='object'))`;
  const entities = `(WITH seed_entity_constructions AS MATERIALIZED (
      SELECT construction.ordinality, jsonb_build_object(
        'evidenceIds',COALESCE(NULLIF(construction.value->'evidenceIds','null'::jsonb),'[]'::jsonb),
        'slots',entity_slots.value) AS value
      FROM jsonb_array_elements(${jsonbArraySql(`${value}->'graphBoundConstructions'`)}) WITH ORDINALITY construction(value,ordinality)
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('semanticRole','entity',
          'observedFillers',COALESCE(NULLIF(slot.value->'observedFillers','null'::jsonb),'[]'::jsonb),
          'lexicalClassId',COALESCE(slot.value->'lexicalClassId','null'::jsonb)) ORDER BY slot.ordinality) AS value
        FROM jsonb_array_elements(${jsonbArraySql("construction.value->'slots'")}) WITH ORDINALITY slot(value,ordinality)
        WHERE slot.value->>'semanticRole'='entity'
      ) entity_slots WHERE entity_slots.value IS NOT NULL
    ), seed_entity_classes AS MATERIALIZED (
      SELECT DISTINCT slot.value->>'lexicalClassId' AS id FROM seed_entity_constructions construction
      CROSS JOIN LATERAL jsonb_array_elements(construction.value->'slots') slot(value)
      WHERE jsonb_typeof(slot.value->'lexicalClassId')='string'
    ) SELECT jsonb_build_object(
      'graphBoundConstructions',(SELECT COALESCE(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) FROM seed_entity_constructions),
      'lexicalClasses',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',lexical.value->'id',
        'members',(SELECT COALESCE(jsonb_agg(jsonb_build_object('symbol',COALESCE(member.value->'symbol','null'::jsonb)) ORDER BY member.ordinality),'[]'::jsonb)
          FROM jsonb_array_elements(${jsonbArraySql("lexical.value->'members'")}) WITH ORDINALITY member(value,ordinality))) ORDER BY lexical.ordinality),'[]'::jsonb)
        FROM jsonb_array_elements(${jsonbArraySql(`${value}->'lexicalClasses'`)}) WITH ORDINALITY lexical(value,ordinality)
        WHERE jsonb_typeof(lexical.value->'id')='string' AND lexical.value->>'id' IN (SELECT id FROM seed_entity_classes))))`;
  return `(CASE WHEN ${schema}='scce.request_requirement_pattern.v1' THEN ${value}
    ELSE ${jsonbFieldsSql(value, REQUEST_SEED_PATTERN_JSON_FIELDS)} || CASE
      WHEN ${schema}='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}' OR left(${schema},length('scce.creative_event_construction_pattern.'))='scce.creative_event_construction_pattern.'
        THEN jsonb_build_object('requestConstructionCandidate',CASE WHEN ${schema}='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}'
          THEN COALESCE(${declared("nullRoles", "requestConstructionCandidate")},FALSE) ELSE FALSE END,
          'sourceConstructionCandidate',CASE WHEN ${schema}='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}'
          THEN COALESCE(${declared("roles", "sourceConstructionCandidate")},FALSE) ELSE FALSE END)
      WHEN ${schema}='${INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA}' THEN jsonb_build_object('templates','[]'::jsonb)
      WHEN ${schema}='scce.induced_language_model.semantic_memory.v1' THEN ${entities}
      ELSE '{}'::jsonb END END)`;
}

const semanticFrameSurfaceHasher = createHasher();
const SEMANTIC_FRAME_SURFACE_BACKFILL_PAGE_ROWS = 256;

function semanticFrameSurfaceHash(surface: string): string {
  return semanticFrameSurfaceHasher.digestHex(normalizePriorKey(surface));
}

function semanticFrameSurface(frameJson: JsonValue): string | undefined {
  return frameJson && typeof frameJson === "object" && !Array.isArray(frameJson) && typeof frameJson.surface === "string"
    ? frameJson.surface : undefined;
}

async function backfillSemanticFrameSurfaceHashes(storage: PostgresStorageAdapter, client: PoolClient): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const { rows }: { rows: Array<{ id: string; surface: string }> } = await client.query<{ id: string; surface: string }>(
      `SELECT id,frame_json->>'surface' AS surface FROM ${storage.table("semantic_frames")}
       WHERE normalized_surface_hash IS NULL AND jsonb_typeof(frame_json->'surface')='string'
         AND ($1::text IS NULL OR id>$1) ORDER BY id ASC LIMIT $2`, [afterId, SEMANTIC_FRAME_SURFACE_BACKFILL_PAGE_ROWS]);
    if (!rows.length) break;
    if (rows.some(row => typeof row.id !== "string" || typeof row.surface !== "string" || row.id === afterId)
      || new Set(rows.map(row => row.id)).size !== rows.length) {
      throw new Error("semantic-frame surface backfill received an invalid primary-key page");
    }
    const payload = rows.map(row => ({ id: row.id, surface: row.surface, hash: semanticFrameSurfaceHash(row.surface) }));
    for (const chunk of serializedJsonRowBatches(payload, batchRowId)) await client.query(
      `UPDATE ${storage.table("semantic_frames")} frame SET normalized_surface_hash=observed.hash
       FROM jsonb_to_recordset($1::jsonb) AS observed(id text,surface text,hash text)
       WHERE frame.id=observed.id AND frame.normalized_surface_hash IS NULL
         AND jsonb_typeof(frame.frame_json->'surface')='string' AND frame.frame_json->>'surface'=observed.surface`, [chunk]);
    afterId = rows.at(-1)!.id;
  }
  const pending = await client.query<{ pending: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${storage.table("semantic_frames")}
     WHERE normalized_surface_hash IS NULL AND jsonb_typeof(frame_json->'surface')='string') AS pending`);
  if (pending.rows[0]?.pending) throw new Error("semantic-frame surface backfill changed during migration; retry migration");
}

function createLanguageMemoryStore(storage: PostgresStorageAdapter): LanguageMemoryStore {
  let observedRevision: string | undefined;
  return {
    async readRevision() {
      const [row] = await storage.query<{ revision: string }>(`SELECT value_json #>> '{}' AS revision FROM ${storage.table("storage_meta")} WHERE key=$1`, [LANGUAGE_MEMORY_REVISION_KEY]);
      const revision = row?.revision ?? "0";
      if (observedRevision !== revision) { clearResidentNgramModelJson(); observedRevision = revision; }
      return revision;
    },
    async putNgramObservation(observation) {
      await storage.transaction(async () => {
        const labels = await joinDurableRecordLabels(
          storage,
          "ngram_observations",
          [{ id: observation.id, informationLabel: observation.informationLabel }]
        );
        const informationLabel = labels.get(observation.id)!;
        await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("ngram_observations")} AS n(id,stream_id,language_hint,order_n,history,symbol,count,field_weight,source_version_id,evidence_id,observed_at,metadata_json,information_label)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TO_TIMESTAMP($11/1000.0),$12::jsonb,$13::jsonb)
         ON CONFLICT(id) DO UPDATE
         SET count=EXCLUDED.count,
             field_weight=GREATEST(n.field_weight,EXCLUDED.field_weight),
             metadata_json=EXCLUDED.metadata_json,
             information_label=EXCLUDED.information_label
         WHERE n.count IS DISTINCT FROM EXCLUDED.count
            OR n.field_weight IS DISTINCT FROM GREATEST(n.field_weight,EXCLUDED.field_weight)
            OR n.metadata_json IS DISTINCT FROM EXCLUDED.metadata_json
            OR n.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [observation.id, observation.streamId, observation.languageHint, observation.order, observation.history, observation.symbol, observation.count, observation.fieldWeight, observation.sourceVersionId ?? null, observation.evidenceId ?? null, observation.observedAt, JSON.stringify(observation.metadata), JSON.stringify(informationLabel)]
        );
      });
    },
    async putNgramObservationsBatch(observations) {
      if (!observations.length) return;
      await storage.transaction(async () => {
        const labels = await joinDurableRecordLabels(
          storage,
          "ngram_observations",
          observations.map(observation => ({ id: observation.id, informationLabel: observation.informationLabel }))
        );
        const labeledObservations = observations.map(observation => ({
          ...observation,
          informationLabel: labels.get(observation.id)!
        }));
        for (const payload of serializedNgramObservationBatches(labeledObservations)) {
          await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("ngram_observations")} AS n(id,stream_id,language_hint,order_n,history,symbol,count,field_weight,source_version_id,evidence_id,observed_at,metadata_json,information_label)
         SELECT
           r.id,
           r.stream_id,
           r.language_hint,
           r.order_n,
           COALESCE(r.history_json, ARRAY[]::text[]),
           r.symbol,
           r.count,
           r.field_weight,
           r.source_version_id,
           r.evidence_id,
           TO_TIMESTAMP(r.observed_at_ms/1000.0),
           r.metadata_json,
           r.information_label
         FROM jsonb_to_recordset($1::jsonb) AS r(
           id text,
           stream_id text,
           language_hint text,
           order_n integer,
           -- Declared text[] so jsonb_to_recordset converts the history array itself; the correlated
           -- array_agg over jsonb_array_elements_text it replaces ran once per row (measured 165k times
           -- per statement, 68% of all ingest database time).
           history_json text[],
           symbol text,
           count bigint,
           field_weight double precision,
           source_version_id text,
           evidence_id text,
           observed_at_ms double precision,
           metadata_json jsonb,
           information_label jsonb
         )
         ON CONFLICT(id) DO UPDATE
         SET count=EXCLUDED.count,
             field_weight=GREATEST(n.field_weight,EXCLUDED.field_weight),
             metadata_json=EXCLUDED.metadata_json,
             information_label=EXCLUDED.information_label
         WHERE n.count IS DISTINCT FROM EXCLUDED.count
            OR n.field_weight IS DISTINCT FROM GREATEST(n.field_weight,EXCLUDED.field_weight)
            OR n.metadata_json IS DISTINCT FROM EXCLUDED.metadata_json
            OR n.information_label IS DISTINCT FROM EXCLUDED.information_label`,
          [payload]
          );
        }
      });
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
    async getLanguagePatternProjection(query) {
      const contextualQa = query.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE;
      if (contextualQa && (query.patternSchema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA || query.sourceSystem !== CONTEXTUAL_QA_SOURCE_SYSTEM)) return undefined;
      if (query.patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA
        && (query.componentRecipe !== SOURCE_COMPUTATION_CONSTRUCTION_RECIPE || query.sourceSystem !== SOURCE_COMPUTATION_SOURCE_SYSTEM)) return undefined;
      const informationLabel = normalizeInformationLabel(query.informationLabel);
      if (!informationLabelAllowsRead(informationLabel, storage.requireInformationAccess())) return undefined;
      const key = activeLanguagePatternProjectionKey({ ...query, tenantId: informationLabel.tenantId });
      const computation = query.patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA;
      const projectContract = query.patternSchema === "scce.source_owned_test_contract.v1" && isSourceOwnedProjectProjection(query.componentRecipe);
      const strictAuxiliary = computation || contextualQa;
      const strictOwnership = strictAuxiliary || projectContract;
      const projectionParams: unknown[] = [key];
      const projectionAccess = strictOwnership ? storage.informationAccessPredicate("active_projection", projectionParams.length + 1) : undefined;
      if (projectionAccess) projectionParams.push(...projectionAccess.params);
      const dependencyGuard = projectContract ? projectContractDependencyEligibilitySql(storage, projectionParams) : strictAuxiliary ? conversationalProjectionEligibilitySql(storage, projectionParams) : undefined;
      const found = await storage.query<{ value_json: JsonValue }>(
        strictOwnership ? `SELECT value_json FROM (SELECT value_json,value_json->'informationLabel' AS information_label
          FROM ${storage.table("storage_meta")} WHERE key=$1) active_projection
          WHERE ${projectionAccess!.sql} AND ${dependencyGuard}`
          : `SELECT value_json FROM ${storage.table("storage_meta")} WHERE key=$1`, projectionParams);
      const value = found[0]?.value_json;
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      if (value.schema !== "scce.language_pattern_active_projection.v1"
        || value.profileId !== query.profileId || value.sourceId !== query.sourceId || value.sourceVersionId !== query.sourceVersionId
        || value.sourceSystem !== query.sourceSystem || value.patternSchema !== query.patternSchema || value.componentRecipe !== query.componentRecipe
        || canonicalStringify(value.informationLabel) !== canonicalStringify(informationLabel)
        || !Array.isArray(value.patternIds) || value.patternIds.some(id => typeof id !== "string")
        || new Set(value.patternIds).size !== value.patternIds.length) return undefined;
      const patternIds = [...value.patternIds as string[]].sort();
      if (projectContract && canonicalStringify(value.sourceContractRoot) !== canonicalStringify(query.sourceContractRoot)) return undefined;
      if ((query.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID || strictAuxiliary || projectContract)
        && (!Array.isArray(value.sourceDependencies) || (query.sourceDependencies !== undefined
          && canonicalStringify(query.sourceDependencies) !== canonicalStringify(value.sourceDependencies)))) return undefined;
      if (query.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID || strictAuxiliary || query.componentRecipe === REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE || projectContract) {
        const params: unknown[] = [patternIds, query.profileId, query.sourceVersionId, query.sourceSystem, query.patternSchema, query.componentRecipe];
        if (strictAuxiliary) params.push([...new Set((Array.isArray(value.sourceDependencies) ? value.sourceDependencies : []).flatMap(dependency =>
          dependency && typeof dependency === "object" && !Array.isArray(dependency) && Array.isArray(dependency.evidenceIds)
            ? dependency.evidenceIds.filter((id): id is string => typeof id === "string") : []))]);
        const access = storage.informationAccessPredicate("pattern", params.length + 1); params.push(...access.params);
        const held = await storage.query<{ id: string }>(`SELECT pattern.id FROM ${storage.table("language_patterns")} pattern
          WHERE pattern.id=ANY($1::text[]) AND pattern.profile_id=$2 AND pattern.owned_source_version_id=$3 AND pattern.source_system=$4
            AND pattern.pattern_schema=$5 AND pattern.component_recipe=$6
            ${strictAuxiliary ? "AND pattern.pattern_kind='semantic_role' AND COALESCE(array_length(pattern.evidence_ids,1),0)>0 AND pattern.evidence_ids <@ $7::text[]" : ""}
            AND ${access.sql} ORDER BY pattern.id`, params);
        if (canonicalStringify(held.map(row => row.id)) !== canonicalStringify(patternIds)) return undefined;
      }
      if (query.sourceCompilationId) {
        const params: unknown[] = [query.profileId, query.patternSchema, query.sourceCompilationId];
        const access = storage.informationAccessPredicate("pattern", params.length + 1);
        params.push(...access.params);
        const inventory = await storage.query<{ id: string }>(
          `SELECT pattern.id FROM ${storage.table("language_patterns")} pattern
           WHERE pattern.profile_id=$1 AND pattern.pattern_json->>'schema'=$2
             AND pattern.pattern_json->>'sourceCompilationId'=$3 AND ${access.sql} ORDER BY pattern.id`, params);
        if (canonicalStringify(inventory.map(row => row.id)) !== canonicalStringify(patternIds)) return undefined;
      }
      return { profileId: query.profileId, sourceId: query.sourceId, sourceVersionId: query.sourceVersionId, sourceSystem: query.sourceSystem,
        patternSchema: query.patternSchema, componentRecipe: query.componentRecipe, informationLabel, patternIds,
        ...(Array.isArray(value.sourceDependencies) ? { sourceDependencies: value.sourceDependencies as unknown as LanguagePatternProjection["sourceDependencies"] } : {}),
        ...(projectContract ? {sourceContractRoot: value.sourceContractRoot as unknown as LanguagePatternProjection["sourceContractRoot"]} : {}) };
    },
    async replaceLanguagePatternProjection(input) {
      const projection = input.projection;
      const patternIds = [...new Set(projection.patternIds)].sort();
      if (!projection.profileId.trim() || !projection.sourceId || !projection.sourceVersionId || !projection.sourceSystem.trim()
        || !((projection.patternSchema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA && (projection.componentRecipe === LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID
            || projection.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID
            || (projection.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE && projection.sourceSystem === CONTEXTUAL_QA_SOURCE_SYSTEM)))
          || (projection.patternSchema === SOURCE_CODE_FUNCTION_PATTERN_SCHEMA && projection.componentRecipe === SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID)
          || (projection.patternSchema === "scce.source_owned_test_contract.v1" && (projection.componentRecipe === "scce.source_owned_test_contract_projection.v1" || isSourceOwnedProjectProjection(projection.componentRecipe)))
          || (projection.patternSchema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA && projection.componentRecipe === CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID)
          || (INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.includes(projection.patternSchema) && projection.componentRecipe === INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID)
          || (projection.patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA && projection.componentRecipe === REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE
            && projection.sourceSystem === REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM)
          || (projection.patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA && projection.componentRecipe === SOURCE_COMPUTATION_CONSTRUCTION_RECIPE
            && projection.sourceSystem === SOURCE_COMPUTATION_SOURCE_SYSTEM))
        || patternIds.length !== projection.patternIds.length) {
        throw new Error("invalid active language-pattern projection scope");
      }
      const rows = new Map(input.patterns.map(pattern => [pattern.id, pattern]));
      const conversational = projection.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID;
      const computation = projection.patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA;
      const contextualQa = projection.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE;
      const projectContract = projection.patternSchema === "scce.source_owned_test_contract.v1" && isSourceOwnedProjectProjection(projection.componentRecipe);
      const sourceDependent = conversational || computation || contextualQa || projectContract;
      const dependencies = projection.sourceDependencies;
      if (sourceDependent && ((projectContract ? projection.sourceSystem !== "oss_code" : projection.sourceSystem !== "dialogue") || !Array.isArray(dependencies)
        || (patternIds.length > 0 && dependencies.length === 0)
        || (patternIds.length > 0 && !dependencies.some(dependency => dependency?.sourceId === projection.sourceId && dependency.sourceVersionId === projection.sourceVersionId))
        || dependencies.some(dependency => !dependency || typeof dependency.sourceId !== "string" || !dependency.sourceId
          || typeof dependency.sourceVersionId !== "string" || !dependency.sourceVersionId || !Array.isArray(dependency.evidenceIds) || !dependency.evidenceIds.length
          || dependency.evidenceIds.some((id: string) => typeof id !== "string" || !id)))) throw new Error("invalid conversational source dependencies");
      if (patternIds.some(id => {
        const row = rows.get(id);
        const metadata = row?.patternJson && typeof row.patternJson === "object" && !Array.isArray(row.patternJson)
          ? row.patternJson as Record<string, JsonValue>
          : {};
        return !row || row.profileId !== projection.profileId || metadata.schema !== projection.patternSchema
          || metadata.sourceSystem !== projection.sourceSystem
          || (projection.componentRecipe === LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID
            && (metadata.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID || metadata.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE))
          || (projection.patternSchema === SOURCE_CODE_FUNCTION_PATTERN_SCHEMA
            && (row.patternKind !== "source_code_function" || metadata.sourceVersionId !== projection.sourceVersionId))
          || (projection.patternSchema === "scce.source_owned_test_contract.v1"
            && (row.patternKind !== "source_code_assertion_contract" || metadata.sourceVersionId !== projection.sourceVersionId))
          || (projection.patternSchema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA
            && (row.patternKind !== "semantic_role" || metadata.sourceId !== projection.sourceId || metadata.sourceVersionId !== projection.sourceVersionId))
          || (INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.includes(projection.patternSchema)
            && (metadata.profileId !== projection.profileId || metadata.sourceVersionId !== projection.sourceVersionId
              || metadata.componentRecipe !== projection.componentRecipe))
          || (projection.patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA
            && (row.patternKind !== "discourse" || metadata.profileId !== projection.profileId || metadata.sourceId !== projection.sourceId
              || metadata.sourceVersionId !== projection.sourceVersionId || metadata.componentRecipe !== REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE || !row.evidenceIds.length))
          || (sourceDependent && !projectContract && (row.patternKind !== "semantic_role" || metadata.sourceId !== projection.sourceId || metadata.sourceVersionId !== projection.sourceVersionId
            || ((computation || contextualQa) && metadata.profileId !== projection.profileId)
            || metadata.componentRecipe !== projection.componentRecipe || !row.evidenceIds.length
            || row.evidenceIds.some(id => !dependencies!.some(dependency => dependency.evidenceIds.includes(id)))));
      })) throw new Error("active language-pattern IDs must name rows in the replacement batch");
      if (projectContract && (!projection.sourceContractRoot || !projection.sourceContractRoot.checkpointId || !projection.sourceContractRoot.snapshotCheckpointId || !projection.sourceContractRoot.snapshotHash || !/^[a-f0-9]{64}$/u.test(projection.sourceContractRoot.scopeIdentity) || !/^[a-f0-9]{64}$/u.test(projection.sourceContractRoot.inputDigest)
        || projection.componentRecipe !== `${SOURCE_OWNED_PROJECT_PROJECTION_PREFIX}${createHasher().digestHex(String(projection.sourceContractRoot.sourceId))}`
        || !dependencies?.length || dependencies.some(dependency => !dependency.contentHash || !dependency.originalContentHash || !dependency.originalSourceVersionId)
        || !dependencies.some(dependency => dependency.sourceId === projection.sourceContractRoot!.sourceId && dependency.sourceVersionId === projection.sourceContractRoot!.sourceVersionId)
        || patternIds.some(id => { const metadata = rows.get(id)!.patternJson as Record<string, JsonValue>; return metadata.componentRecipe !== projection.componentRecipe
          || !metadata.sourceContractClosure || typeof metadata.sourceContractClosure !== "object" || Array.isArray(metadata.sourceContractClosure)
          || metadata.sourceContractClosure.digest !== projection.sourceContractRoot!.inputDigest; }))) throw new Error("invalid owned project contract root/dependencies");
      const informationLabel = storage.requireWritableInformationLabel(projection.informationLabel);
      const key = activeLanguagePatternProjectionKey({ ...projection, tenantId: informationLabel.tenantId });
      const value = {
        schema: "scce.language_pattern_active_projection.v1",
        profileId: projection.profileId,
        sourceId: projection.sourceId,
        sourceVersionId: projection.sourceVersionId,
        sourceSystem: projection.sourceSystem,
        patternSchema: projection.patternSchema,
        componentRecipe: projection.componentRecipe,
        patternIds,
        informationLabel,
        ...(sourceDependent ? { sourceDependencies: dependencies } : {}),
        ...(projectContract ? {sourceContractRoot: projection.sourceContractRoot} : {})
      };
      await storage.transaction(async () => {
        if (sourceDependent || projection.patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA) {
          const params: unknown[] = [projection.profileId, projection.sourceVersionId, projection.sourceId];
          const profileAccess = storage.informationAccessPredicate("owner_profile", params.length + 1); params.push(...profileAccess.params);
          const versionAccess = storage.informationAccessPredicate("owner_version", params.length + 1); params.push(...versionAccess.params);
          const owner = await storage.query<{ source_owner_valid: boolean }>(`SELECT TRUE AS source_owner_valid
            FROM ${storage.table("language_profiles")} owner_profile JOIN ${storage.table("source_versions")} owner_version ON owner_version.id=owner_profile.source_version_id
            WHERE owner_profile.id=$1 AND owner_version.id=$2 AND owner_version.source_id=$3 AND ${profileAccess.sql} AND ${versionAccess.sql}`, params);
          if (!owner[0]?.source_owner_valid) throw new Error("auxiliary projection does not own its accessible source profile/version");
        }
        if (projectContract) {
          const versionIds = [...new Set(dependencies!.flatMap(dependency => [dependency.sourceVersionId, dependency.originalSourceVersionId!]))].sort();
          const evidenceIds = [...new Set(dependencies!.flatMap(dependency => dependency.evidenceIds))].sort();
          const versionAccess = storage.informationAccessPredicate("locked_version", 2);
          await storage.query(`SELECT locked_version.id FROM ${storage.table("source_versions")} locked_version WHERE locked_version.id=ANY($1::text[]) AND ${versionAccess.sql} ORDER BY locked_version.id FOR SHARE`, [versionIds,...versionAccess.params]);
          const evidenceAccess = storage.informationAccessPredicate("locked_evidence", 2);
          await storage.query(`SELECT locked_evidence.id FROM ${storage.table("evidence_spans")} locked_evidence WHERE locked_evidence.id=ANY($1::text[]) AND ${evidenceAccess.sql} ORDER BY locked_evidence.id FOR SHARE`, [evidenceIds,...evidenceAccess.params]);
          await storage.query(`SELECT id FROM ${storage.table("ingestion_checkpoints")} WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, [[projection.sourceContractRoot!.checkpointId,projection.sourceContractRoot!.snapshotCheckpointId].sort()]);
          await storage.query(`SELECT id FROM ${storage.table("language_profiles")} WHERE id=$1 FOR SHARE`, [projection.profileId]);
          const dependencyParams: unknown[] = [JSON.stringify(toJsonValue(value))];
          const guard = projectContractDependencyEligibilitySql(storage, dependencyParams, patternIds.length === 0);
          const valid = await storage.query<{project_contract_scope_valid:boolean}>(`SELECT TRUE AS project_contract_scope_valid FROM (SELECT $1::jsonb AS value_json) active_projection WHERE ${guard}`, dependencyParams);
          if (!valid[0]?.project_contract_scope_valid) throw new Error("owned project contract dependency/root is stale, revoked or foreign");
        }
        await putLanguagePatternsBatch(storage, input.patterns);
        await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("storage_meta")} AS metadata(key,value_json,updated_at)
           VALUES($1,$2::jsonb,NOW())
           ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=NOW()
           WHERE metadata.value_json IS DISTINCT FROM EXCLUDED.value_json
           ${projection.patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA || computation || contextualQa ? `AND NOT EXISTS (
             SELECT 1 FROM ${storage.table("source_versions")} previous_version, ${storage.table("source_versions")} incoming_version
             WHERE previous_version.id=metadata.value_json->>'sourceVersionId' AND incoming_version.id=EXCLUDED.value_json->>'sourceVersionId'
               AND previous_version.source_id=incoming_version.source_id
               AND (previous_version.observed_at,previous_version.id)>(incoming_version.observed_at,incoming_version.id))` : ""}`,
          [key, JSON.stringify(toJsonValue(value))]
        );
      });
    },
    async replaceRequestRequirementPatterns(input) {
      await replaceRequestRequirementPatterns(storage, input);
    },
    async putSemanticFrame(frame) {
      await putSemanticFramesBatch(storage, [frame]);
    },
    async putSemanticFrames(frames) {
      await putSemanticFramesBatch(storage, frames);
    },
    async putTranslationAlignment(alignment) {
      await storage.transaction(async () => {
        const labels = await joinDurableRecordLabels(
          storage,
          "translation_alignments",
          [{ id: alignment.id, informationLabel: alignment.informationLabel }]
        );
        await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("translation_alignments")} AS ta(id,source_frame_id,target_frame_id,source_language,target_language,force,loss_vector,alignment_json,evidence_ids,updated_at,information_label)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,TO_TIMESTAMP($10/1000.0),$11::jsonb)
           ON CONFLICT(id) DO UPDATE SET force=EXCLUDED.force, loss_vector=EXCLUDED.loss_vector, alignment_json=EXCLUDED.alignment_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(ta.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at, information_label=EXCLUDED.information_label
           WHERE ta.force IS DISTINCT FROM EXCLUDED.force OR ta.loss_vector IS DISTINCT FROM EXCLUDED.loss_vector OR ta.alignment_json IS DISTINCT FROM EXCLUDED.alignment_json
             OR NOT (ta.evidence_ids @> EXCLUDED.evidence_ids) OR ta.information_label IS DISTINCT FROM EXCLUDED.information_label`,
          [alignment.id, alignment.sourceFrameId, alignment.targetFrameId, alignment.sourceLanguage, alignment.targetLanguage, alignment.force, JSON.stringify(alignment.lossVector), JSON.stringify(alignment.alignmentJson), alignment.evidenceIds, alignment.updatedAt, JSON.stringify(labels.get(alignment.id)!)]
        );
      });
    },
    async continuationPopulation(query) {
      if (!query.languageId.trim()) return undefined;
      const params: unknown[] = [query.languageId];
      const profileWhere = ["lp.language_id=$1"];
      appendInformationAccess(storage, "lp", params, profileWhere);
      const modelAccess: string[] = [];
      appendInformationAccess(storage, "model", params, modelAccess);
      profileWhere.push(profileSourceOwnershipSql(storage, params, "lp"));
      const modelWhere = [
        `model.model_json->>'profileId'=ANY(ARRAY(
           SELECT lp.id FROM ${storage.table("language_profiles")} lp WHERE ${profileWhere.join(" AND ")}
         ))`, ...modelAccess
      ];
      const rows = await storage.query<{ symbol: string | null; contexts: string | null; model_count: number }>(
        `WITH population AS MATERIALIZED (
           SELECT model.id, model.model_json->'model'->'continuationCounts' AS counts
           FROM ${storage.table("ngram_models")} model
           WHERE ${modelWhere.join(" AND ")}
         ), totals AS (
           SELECT item.key AS symbol, SUM(item.value::numeric) AS contexts
           FROM population
           CROSS JOIN LATERAL jsonb_each_text(COALESCE(population.counts, '{}'::jsonb)) item
           GROUP BY item.key
         )
         SELECT totals.symbol, totals.contexts::text, measured.model_count
         FROM (SELECT COUNT(*)::int AS model_count FROM population) measured
         LEFT JOIN totals ON true
         ORDER BY totals.symbol`,
        params
      );
      const modelCount = rows[0]?.model_count;
      if (modelCount === undefined || modelCount === 0) return undefined;
      const continuationCounts = Object.fromEntries(rows.flatMap(row => {
        if (row.symbol === null || row.contexts === null) return [];
        const count = Number(row.contexts);
        if (!Number.isFinite(count) || count < 0) throw new Error("invalid corpus continuation count");
        return [[row.symbol, count] as const];
      }));
      return { languageId: query.languageId, modelCount, continuationCounts };
    },
    async listSourceCompilationArtifactIds(query) {
      const family = query.family === "units" ? { table: "language_units", json: "metadata_json", profile: "artifact.profile_id" }
        : query.family === "patterns" ? { table: "language_patterns", json: "pattern_json", profile: "artifact.profile_id" }
        : { table: "semantic_frames", json: "frame_json", profile: "artifact.frame_json->>'profileId'" };
      const params: unknown[] = [query.compilationId, query.profileId];
      const where = [`artifact.${family.json}->>'sourceCompilationId'=$1`, `${family.profile}=$2`];
      if (query.afterId !== undefined) { params.push(query.afterId); where.push(`artifact.id COLLATE "C">$${params.length} COLLATE "C"`); }
      appendInformationAccess(storage, "artifact", params, where);
      params.push(Math.max(1, Math.min(256, Math.floor(query.limit))));
      const rows = await storage.query<{ id: string }>(`SELECT artifact.id FROM ${storage.table(family.table)} artifact WHERE ${where.join(" AND ")} ORDER BY artifact.id COLLATE "C" LIMIT $${params.length}`, params);
      return rows.map(row => row.id);
    },
    async listNgramModelHeaders(query) {
      if (!query.modelIds.length || query.profileIds?.length === 0) return [];
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0) throw new Error("model header limit must be a positive safe integer");
      const params: unknown[] = [[...new Set(query.modelIds)]];
      const where = ["model.id=ANY($1::text[])"];
      if (query.profileIds) { params.push([...new Set(query.profileIds)]); where.push(`model.profile_id=ANY($${params.length}::text[])`); }
      appendInformationAccess(storage, "model", params, where);
      const access = storage.informationAccessPredicate("model_profile", params.length + 1); params.push(...access.params);
      where.push(`EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} model_profile WHERE model_profile.id=model.profile_id
        AND ${access.sql} AND ${profileSourceOwnershipSql(storage, params, "model_profile")})`);
      params.push(query.limit);
      return (await storage.query<{ id: string; profile_id: string; information_label: InformationLabel }>(
        `SELECT model.id,model.profile_id,model.information_label FROM ${storage.table("ngram_models")} model
         WHERE ${where.join(" AND ")} ORDER BY model.id COLLATE "C" LIMIT $${params.length}`, params))
        .map(row => ({ id: row.id, profileId: row.profile_id, informationLabel: row.information_label }));
    },
    async listNgramModels(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.streamId) { params.push(query.streamId); where.push(`model.stream_id=$${params.length}`); }
      if (query.languageHint) { params.push(query.languageHint); where.push(`model.language_hint=$${params.length}`); }
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        where.push(`${ngramModelProfileIdExpression("model")}=ANY($${params.length}::text[])`);
      }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`${ngramModelSourceSystemExpression("model")}=$${params.length}`); }
      if (query.formalLanguage !== undefined) {
        if (!query.formalLanguage.trim()) return [];
        const legacyParams = [...params];
        const legacyWhere = [...where, `(jsonb_typeof(model.model_json->'formalLanguage') IS DISTINCT FROM 'string'
          OR NULLIF(BTRIM(model.model_json->>'formalLanguage'), '') IS NULL)`];
        appendInformationAccess(storage, "model", legacyParams, legacyWhere);
        const legacy = await storage.query<{ id: string; stream_id: string; source_identity_json: JsonValue }>(
          `SELECT model.id, model.stream_id, jsonb_build_object(
             'formalLanguage', model.model_json->'formalLanguage',
             'relativePath', model.model_json->'relativePath',
             'streamUri', model.model_json->'streamUri') AS source_identity_json
           FROM ${storage.table("ngram_models")} model WHERE ${legacyWhere.join(" AND ")}`,
          legacyParams
        );
        const legacyIds = legacy.filter(row => codeLanguageForModelRecord({ streamId: row.stream_id, modelJson: row.source_identity_json }) === query.formalLanguage)
          .map(row => row.id).sort();
        params.push(query.formalLanguage);
        const declared = `(jsonb_typeof(model.model_json->'formalLanguage')='string' AND model.model_json->>'formalLanguage'=$${params.length})`;
        if (legacyIds.length) {
          params.push(legacyIds);
          where.push(`(${declared} OR model.id=ANY($${params.length}::text[]))`);
        } else where.push(declared);
      }
      appendInformationAccess(storage, "model", params, where, "bounded_by_order_and_limit");
      const ownerAccess = storage.informationAccessPredicate("model_profile", params.length + 1); params.push(...ownerAccess.params);
      where.push(`EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} model_profile WHERE model_profile.id=model.profile_id
        AND ${ownerAccess.sql} AND ${profileSourceOwnershipSql(storage, params, "model_profile")})`);
      params.push(query.limit ?? 100);
      const limitParam = params.length;
      const trainedMass = ngramModelTrainedMassExpression("model");
      // Cumulative byte budget in the same relevance order as the count
      // limit: whole-novel training grew single model_json blobs to tens
      // of MB, so a count limit alone stopped bounding memory (a 4GB
      // server heap OOMed at warmup, verified live). The window sum
      // admits records until the budget is exhausted; the first record
      // always loads so a budget smaller than the best model degrades to
      // exactly one record instead of zero.
      if (query.maxTotalJsonBytes && query.maxTotalJsonBytes > 0) {
        params.push(Math.floor(query.maxTotalJsonBytes));
        // The running-byte window used to scan the WHOLE filtered set:
        // octet_length(...::text) detoasts and serialises every matching
        // JSONB blob before LIMIT applies, so admitting 6 models read
        // hundreds of MB (the table is 1087MB) -- the dominant cost of the
        // 473s hydration a traced creative turn attributed to
        // candidate.language.hydrate. The budget filter and the count limit
        // both only ever shrink a prefix of the SAME relevance ordering, so
        // windowing over the top-LIMIT prefetch is provably identical
        // output at LIMIT-rows serialisation cost instead of table-wide.
        // Two windows: pg_column_size reads the stored size without detoasting, so the top-LIMIT prefetch admits
        // candidates cheaply (a 24MB model detoasted 64 times was 50s of a warmup); the exact JSON-text window then
        // runs over the admitted rows only, which are read anyway. Stored size never exceeds text size, so the
        // second window's result is exactly the single-window result.
        //
        // Both windows now run here rather than in SQL, over exactly the same ordering and the same byte counts, so
        // that the second one does not have to read a blob this process already holds: octet_length(model_json::text)
        // detoasts and re-serialises every admitted row server-side, measured at 4.5-7.3s for 12 rows against the
        // 0.6-1.5s the candidate ranking costs on its own.
        const budgetBytes = Math.floor(query.maxTotalJsonBytes);
        const candidates = await storage.query<NgramCandidateRow>(
          `SELECT model.id, model.stream_id, model.language_hint, model.max_order, model.discount, model.updated_at, model.information_label,
             pg_column_size(model.model_json) AS stored_bytes
           FROM ${storage.table("ngram_models")} model
           WHERE ${where.join(" AND ")}
           ORDER BY ${trainedMass} DESC, model.updated_at DESC, model.id ASC
           LIMIT $${limitParam}`,
          params.slice(0, limitParam)
        );
        let runningStoredBytes = 0;
        const sized = candidates.filter((row, index) => {
          runningStoredBytes += Number(row.stored_bytes);
          return runningStoredBytes <= budgetBytes || index === 0;
        });
        const jsonById = new Map<string, { json: JsonValue; jsonBytes: number; updatedAtMs: number }>();
        const readBlobs = async (ids: readonly string[]): Promise<void> => {
          const blobParams: unknown[] = [[...ids]];
          const blobWhere = [`model.id=ANY($1::text[])`];
          appendInformationAccess(storage, "model", blobParams, blobWhere);
          const blobs = await storage.query<{ id: string; updated_at: Date; model_json: JsonValue; json_bytes: string }>(
            `SELECT model.id, model.updated_at, model.model_json, ${sourceArtifactJsonBytesSql("model.model_json")} AS json_bytes
             FROM ${storage.table("ngram_models")} model WHERE ${blobWhere.join(" AND ")}`,
            blobParams
          );
          for (const blob of blobs) {
            // The ranking and the blobs are two snapshots; a row rewritten between them reports the version it was read at.
            const entry = { json: blob.model_json, jsonBytes: Number(blob.json_bytes), updatedAtMs: blob.updated_at.getTime() };
            jsonById.set(blob.id, entry);
            rememberNgramModelJson(storage, blob.id, entry.updatedAtMs, entry);
          }
        };
        // The budget needs every candidate's JSON size but only the admitted candidates' JSON. Sizes outlive the blobs
        // for that reason, so a row the budget rejects is measured once and never read again.
        const unmeasured = sized.filter(row => ngramModelJsonBytes(storage, row.id, row.updated_at.getTime()) === undefined).map(row => row.id);
        if (unmeasured.length) await readBlobs(unmeasured);
        let runningJsonBytes = 0;
        const admitted = sized.filter((row, index) => {
          const jsonBytes = ngramModelJsonBytes(storage, row.id, row.updated_at.getTime());
          if (jsonBytes === undefined) return false;
          runningJsonBytes += jsonBytes;
          return runningJsonBytes <= budgetBytes || index === 0;
        });
        const unread = admitted.filter(row => {
          if (jsonById.has(row.id)) return false;
          const held = residentNgramModelJson(storage, row.id, row.updated_at.getTime());
          if (held) { jsonById.set(row.id, { ...held, updatedAtMs: row.updated_at.getTime() }); return false; }
          return true;
        }).map(row => row.id);
        if (unread.length) await readBlobs(unread);
        const records = admitted.flatMap(row => {
          const held = jsonById.get(row.id);
          if (!held) return [];
          return [candidateToNgramModel({ ...row, updated_at: new Date(held.updatedAtMs) }, held.json)];
        }).filter(record => query.formalLanguage === undefined || codeLanguageForModelRecord(record) === query.formalLanguage)
          .slice(0, Number(params[limitParam - 1]));
        const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(records.map(record => ({ value: record.modelJson, informationLabel: record.informationLabel })));
        return records.map((record, index) => ({ ...record, modelJson: decoded[index] as JsonValue }));
      }
      const records = (await storage.query<NgramModelRow>(`SELECT * FROM ${storage.table("ngram_models")} model WHERE ${where.join(" AND ")} ORDER BY ${trainedMass} DESC, model.updated_at DESC, model.id ASC LIMIT $${limitParam}`, params)).map(rowToNgramModel)
        .filter(record => query.formalLanguage === undefined || codeLanguageForModelRecord(record) === query.formalLanguage);
      const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(records.map(record => ({ value: record.modelJson, informationLabel: record.informationLabel })));
      return records.map((record, index) => ({ ...record, modelJson: decoded[index] as JsonValue }));
    },
    async listNgramObservations(query = {}) {
      const profileIds = query.profileIds?.length ? [...query.profileIds] : undefined;
      if (query.profileIds && !profileIds) return [];
      const table = storage.table("ngram_observations");
      const limit = query.limit ?? 1000;
      const scopedRows = async (
        ownerIds: readonly string[]
      ): Promise<NgramObservationRow[]> => {
        const params: unknown[] = [];
        const sharedWhere: string[] = [];
        if (query.streamId) { params.push(query.streamId); sharedWhere.push(`observation.stream_id=$${params.length}`); }
        if (query.languageHint) { params.push(query.languageHint); sharedWhere.push(`observation.language_hint=$${params.length}`); }
        if (query.sourceSystem) { params.push(query.sourceSystem); sharedWhere.push(`${ngramObservationSourceSystemExpression("observation")}=$${params.length}`); }
        appendInformationAccess(storage, "observation", params, sharedWhere);
        params.push([...ownerIds]);
        const ownersParam = params.length;
        params.push(limit);
        const limitParam = params.length;
        return storage.query<NgramObservationRow>(
          `SELECT scoped.*
           FROM unnest($${ownersParam}::text[]) AS owner(owner_id)
           CROSS JOIN LATERAL (
             SELECT observation.*
             FROM ${table} observation
             WHERE ${sharedWhere.length ? `${sharedWhere.join(" AND ")} AND ` : ""}${ngramObservationProfileIdExpression("observation")}=owner.owner_id
             ORDER BY observation.count DESC, observation.observed_at DESC, observation.id ASC
             LIMIT $${limitParam}
           ) scoped
           ORDER BY scoped.count DESC, scoped.observed_at DESC, scoped.id ASC
           LIMIT $${limitParam}`,
          params
        );
      };
      if (profileIds) {
        const exactRows = await scopedRows(profileIds);
        return exactRows.map(rowToNgramObservation);
      }
      // Index-first prefetch. The flat form of this query -- all predicates
      // in one WHERE with ORDER BY count DESC LIMIT -- planned as a parallel
      // seq scan over the whole 30GB / 13.5M-row table: pg_stat_activity
      // caught it live at 375s (wait=IO/DataFileRead) inside a single
      // creative turn's hydration. The cause is not a missing index (the
      // expression index exists and is valid) but estimation: the
      // information-access predicate's jsonb containment operators (<@, ?)
      // carry fixed default selectivities the planner cannot learn, even
      // with expression statistics (added; estimate went 1 -> ~1700 against
      // 9.16M actual, still seq-scanning at 42s warm). No statistics object
      // fixes an operator whose selectivity is a hard-coded constant, so
      // the query shape has to make the index walk non-optional.
      //
      // The inner subquery matches idx_..._ngram_source_system_rank's
      // expression and ordering exactly and carries no other predicates, so
      // it can only be an index walk; the access filter then applies to the
      // 2x-overscanned prefix. Measured on the exact live parameters:
      // 43.9ms against the flat form's 42000ms, full LIMIT returned.
      //
      // Trade, stated plainly: if the access filter rejects more than half
      // of the top-ranked prefix, the result may come back shorter than
      // `limit` even though deeper admissible rows exist. Corpus rows all
      // carry the public label in this deployment, so the filter passes
      // ~everything; a deployment where labels reject most corpus rows
      // should raise the overscan, not remove the prefetch.
      const params: unknown[] = [];
      const innerWhere: string[] = [];
      if (query.streamId) { params.push(query.streamId); innerWhere.push(`observation.stream_id=$${params.length}`); }
      if (query.languageHint) { params.push(query.languageHint); innerWhere.push(`observation.language_hint=$${params.length}`); }
      if (query.sourceSystem) { params.push(query.sourceSystem); innerWhere.push(`${ngramObservationSourceSystemExpression("observation")}=$${params.length}`); }
      const accessWhere: string[] = [];
      appendInformationAccess(storage, "scoped", params, accessWhere);
      params.push(Math.max(1, limit) * 2);
      const prefetchParam = params.length;
      params.push(limit);
      return (await storage.query<NgramObservationRow>(
        `SELECT scoped.* FROM (
           SELECT * FROM ${table} observation
           ${innerWhere.length ? `WHERE ${innerWhere.join(" AND ")}` : ""}
           ORDER BY count DESC, observed_at DESC
           LIMIT $${prefetchParam}
         ) scoped
         WHERE ${accessWhere.join(" AND ")}
         ORDER BY scoped.count DESC, scoped.observed_at DESC, scoped.id ASC
         LIMIT $${params.length}`,
        params
      )).map(rowToNgramObservation);
    },
    async listUnitSourceMetadataPage(query) {
      if (!Number.isSafeInteger(query.limit) || query.limit <= 0 || !Number.isSafeInteger(query.maxTotalJsonBytes) || query.maxTotalJsonBytes <= 0) {
        throw new Error("unit metadata maintenance requires positive safe integer row and byte bounds");
      }
      const access = storage.informationAccessPredicate("unit", 4, "bounded_by_order_and_limit");
      const rows = await storage.query<{ id: string; decoded_bytes: string | number; running_decoded_bytes: string | number; unit_json: LanguageUnitRow | null }>(
        `WITH candidates AS MATERIALIZED (
           SELECT unit.id
           FROM ${storage.table("language_units")} unit
           WHERE unit.id>$1 AND unit.metadata_json ? 'sourceMetadata' AND ${access.sql}
           ORDER BY unit.id LIMIT $2 FOR UPDATE
         ), sized AS MATERIALIZED (
           SELECT unit.id, octet_length(to_jsonb(unit)::text)::bigint AS decoded_bytes
           FROM candidates JOIN ${storage.table("language_units")} unit ON unit.id=candidates.id
         ), ranked AS (
           SELECT sized.*, SUM(CASE WHEN decoded_bytes<=$3 THEN decoded_bytes ELSE 0 END)
             OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS running_decoded_bytes
           FROM sized
         )
         SELECT ranked.id, ranked.decoded_bytes, ranked.running_decoded_bytes,
           CASE WHEN ranked.decoded_bytes<=$3 AND ranked.running_decoded_bytes<=$3 THEN to_jsonb(unit) ELSE NULL END AS unit_json
         FROM ranked JOIN ${storage.table("language_units")} unit ON unit.id=ranked.id ORDER BY ranked.id`,
        [query.afterId ?? "", query.limit, query.maxTotalJsonBytes, ...access.params]);
      const units: LanguageUnitRecord[] = [], oversized: Array<{ id: string; byteLength: number }> = [];
      let nextAfterId = query.afterId, processed = 0, decodedBytes = 0;
      for (const row of rows) {
        const byteLength = Number(row.decoded_bytes);
        if (byteLength <= query.maxTotalJsonBytes && Number(row.running_decoded_bytes) > query.maxTotalJsonBytes) break;
        nextAfterId = row.id;
        processed++;
        if (byteLength > query.maxTotalJsonBytes) oversized.push({ id: row.id, byteLength });
        else if (row.unit_json) { units.push(rowToLanguageUnit(row.unit_json)); decodedBytes += byteLength; }
        else throw new Error("bounded unit metadata page omitted an admissible payload");
      }
      return { units, decodedBytes, oversized, nextAfterId, hasMore: processed < rows.length || rows.length === query.limit };
    },
    async listLanguageUnits(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        where.push(`unit.profile_id=ANY($${params.length}::text[])`);
      } else if (query.profileId) { params.push(query.profileId); where.push(`unit.profile_id=$${params.length}`); }
      if (query.script) { params.push(query.script); where.push(`unit.script=$${params.length}`); }
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`unit.metadata_json->>'sourceSystem'=$${params.length}`); }
      appendInformationAccess(storage, "unit", params, where, "bounded_by_order_and_limit");
      params.push(query.limit ?? 1000);
      const unitLimitParam = params.length;
      // Same cumulative byte budget as listNgramModels (see the note
      // there): language_units grew to ~660KB average per row after
      // whole-novel training, so count limits stopped bounding memory.
      if (query.maxTotalJsonBytes && query.maxTotalJsonBytes > 0) {
        params.push(Math.floor(query.maxTotalJsonBytes));
        // Same prefetch equivalence as listNgramModels above.
        const rows = await storage.query<LanguageUnitRow>(
          `SELECT ranked.* FROM (
             SELECT unit.*,
               SUM((${sourceArtifactJsonBytesSql("unit.metadata_json")}) + octet_length(unit.unit_text)) OVER (ORDER BY unit.alpha DESC, unit.id ASC ROWS UNBOUNDED PRECEDING) AS running_json_bytes,
               ROW_NUMBER() OVER (ORDER BY unit.alpha DESC, unit.id ASC) AS relevance_rank
             FROM (
               SELECT * FROM ${storage.table("language_units")} unit
               WHERE ${where.join(" AND ")}
               ORDER BY unit.alpha DESC, unit.id ASC
               LIMIT $${unitLimitParam}
             ) unit
           ) ranked
           WHERE ranked.running_json_bytes <= $${params.length} OR ranked.relevance_rank = 1
           ORDER BY ranked.alpha DESC, ranked.id ASC LIMIT $${unitLimitParam}`,
          params
        );
        const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(rows.map(row => ({ value: row.metadata_json, profileId: row.profile_id, sourceVersionId: row.source_version_id, informationLabel: row.information_label })));
        return rows.map((row, index) => rowToLanguageUnit({ ...row, metadata_json: decoded[index] as JsonValue }));
      }
      const rows = await storage.query<LanguageUnitRow>(`SELECT * FROM ${storage.table("language_units")} unit WHERE ${where.join(" AND ")} ORDER BY alpha DESC, id ASC LIMIT $${unitLimitParam}`, params);
      const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(rows.map(row => ({ value: row.metadata_json, profileId: row.profile_id, sourceVersionId: row.source_version_id, informationLabel: row.information_label })));
      return rows.map((row, index) => rowToLanguageUnit({ ...row, metadata_json: decoded[index] as JsonValue }));
    },
    async listLanguagePatterns(query = {}) {
      if (query.requireComplete && (!Number.isSafeInteger(query.limit) || query.limit! <= 0
        || !Number.isSafeInteger(query.maxTotalJsonBytes) || query.maxTotalJsonBytes! <= 0)) throw new Error("complete pattern reads require positive finite row and decoded byte bounds");
      const requestedPatternIds = query.patternIds ? [...new Set(query.patternIds)] : undefined;
      const params: unknown[] = [];
      const projectionSets: string[] = [];
      const projectionScope: string[] = [];
      const scopeWhere: string[] = query.patternKind ? [] : ["pattern.pattern_kind<>'source_compilation'"];
      const where: string[] = [];
      if (query.contextualQaRequestFeatures !== undefined) {
        if (!Array.isArray(query.contextualQaRequestFeatures) || query.contextualQaRequestFeatures.some(value => typeof value !== "string" || !value)) throw new Error("contextual QA features must be nonempty strings");
        if (!query.contextualQaRequestFeatures.length || query.sourceComputationBindingId !== undefined
          || (query.sourceSystem !== undefined && query.sourceSystem !== CONTEXTUAL_QA_SOURCE_SYSTEM)
          || (query.patternSchemas && !query.patternSchemas.includes(LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA))
          || (query.patternKind !== undefined && query.patternKind !== "semantic_role")) return [];
        params.push([...new Set(query.contextualQaRequestFeatures)]);
        scopeWhere.push(`pattern.pattern_kind='semantic_role'`, `pattern.pattern_json->>'schema'='${LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA}'`,
          `pattern.pattern_json->>'componentRecipe'='${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}'`, `pattern.source_system='${CONTEXTUAL_QA_SOURCE_SYSTEM}'`,
          `pattern.pattern_json->'contextualQaRequestFeatures' ?| $${params.length}::text[]`);
      }
      if (query.sourceComputationBindingId !== undefined) {
        if (typeof query.sourceComputationBindingId !== "string" || !query.sourceComputationBindingId) throw new Error("source computation binding must be a nonempty opaque ID");
        if ((query.sourceSystem !== undefined && query.sourceSystem !== SOURCE_COMPUTATION_SOURCE_SYSTEM)
          || (query.patternSchemas && !query.patternSchemas.includes(SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA))
          || (query.patternKind !== undefined && query.patternKind !== "semantic_role")) return [];
        params.push(query.sourceComputationBindingId);
        scopeWhere.push(`pattern.pattern_json->>'schema'='${SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA}'`,
          `pattern.source_system='${SOURCE_COMPUTATION_SOURCE_SYSTEM}'`, `pattern.pattern_json->>'bindingId'=$${params.length}`);
      }
      if (query.patternIds) {
        if (!query.patternIds.length) return [];
        params.push(requestedPatternIds!);
        scopeWhere.push(`pattern.id=ANY($${params.length}::text[])`);
      }
      // Segmentation witnesses are durable audit evidence, not generative/search memory. They are visible only
      // through an ordinary exact-ID audit read; request-seed projection must never hydrate their large bodies.
      if (!requestedPatternIds || query.view === "request_seed") {
        // IS DISTINCT FROM is intentional: historical active language patterns predate the generated schema
        // header and therefore carry NULL. SQL NOT IN would turn that legitimate row into UNKNOWN and drop it.
        scopeWhere.push(`(${ARCHIVAL_LANGUAGE_PATTERN_SCHEMAS
          .map(schema => `pattern.pattern_schema IS DISTINCT FROM '${schema}'`).join(" AND ")})`);
      }
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        scopeWhere.push(`pattern.profile_id=ANY($${params.length}::text[])`);
        projectionScope.push(`active_projection.value_json->>'profileId'=ANY($${params.length}::text[])`);
      } else if (query.profileId) {
        params.push(query.profileId); scopeWhere.push(`pattern.profile_id=$${params.length}`);
        projectionScope.push(`active_projection.value_json->>'profileId'=$${params.length}`);
      }
      if (query.sourceSystem) {
        params.push(query.sourceSystem); scopeWhere.push(`${languagePatternSourceSystemExpression("pattern")}=$${params.length}`);
        projectionScope.push(`active_projection.value_json->>'sourceSystem'=$${params.length}`);
      }
      if (query.patternSchemas) {
        if (!query.patternSchemas.length) return [];
        params.push([...new Set(query.patternSchemas)]);
        scopeWhere.push(`pattern.pattern_schema=ANY($${params.length}::text[])`);
      }
      if (query.patternKind) { params.push(query.patternKind); scopeWhere.push(`pattern.pattern_kind=$${params.length}`); }
      if (query.formalLanguage !== undefined) { params.push(query.formalLanguage); scopeWhere.push(`pattern.pattern_json->>'formalLanguage'=$${params.length}`); }
      if (query.parameterCount !== undefined) {
        if (!Number.isSafeInteger(query.parameterCount) || query.parameterCount < 0) throw new Error("language pattern parameterCount must be a non-negative integer");
        params.push(String(query.parameterCount)); scopeWhere.push(`pattern.pattern_json->>'parameterCount'=$${params.length}`);
      }
      if (query.languageId) {
        // sourceSystem alone mixes identities: "wikipedia" carries a small minority of profiles under other
        // learned identities too (measured live -- a 569-profile code/license-header identity still owns 9
        // wikipedia-attributed profiles). Filtering by identity before the row budget is spent, rather than after
        // scopeLanguageMemoryStateToLanguage discards off-identity rows post-hoc, means the budget itself only
        // ever competes among patterns that actually belong to the language being hydrated.
        // Unmeasured is not foreign: discovery assigns identities once, so a profile written afterwards carries
        // none and this filter silently dropped its patterns -- the same admission the in-memory language scope makes.
        params.push(query.languageId);
        scopeWhere.push(`EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} lp WHERE lp.id=pattern.profile_id AND (lp.language_id=$${params.length} OR lp.language_id IS NULL))`);
      }
      appendInformationAccess(storage, "pattern", params, scopeWhere);
      let requestedOwners: LanguagePatternOwner[] | undefined;
      let requestedOwnerProjectionBound = false;
      if (query.patternIds || query.sourceComputationBindingId !== undefined || query.contextualQaRequestFeatures !== undefined) {
        const owners = await storage.query<{ profile_id: string; source_system: string | null }>(
          `SELECT DISTINCT pattern.profile_id,pattern.source_system FROM ${storage.table("language_patterns")} pattern
           WHERE ${scopeWhere.join(" AND ")} ORDER BY pattern.profile_id,pattern.source_system`, [...params]);
        requestedOwners = owners.map(row => ({ profileId: row.profile_id, sourceSystem: row.source_system }));
        if ((query.sourceComputationBindingId !== undefined || query.contextualQaRequestFeatures !== undefined) && !requestedOwners.length) return [];
      }
      if (query.patternKind !== "source_compilation") {
        params.push(canonicalStringify(await currentLanguagePatternCompilations(storage, query, requestedOwners)));
        where.push(`(NOT (pattern.has_source_compilation) OR EXISTS (
          SELECT 1 FROM jsonb_to_recordset($${params.length}::jsonb) AS current_compilation("profileId" text,"sourceSystem" text,"sourceVersionId" text,"compilationId" text)
          WHERE current_compilation."profileId"=pattern.profile_id AND current_compilation."sourceSystem"=pattern.source_system
            AND current_compilation."compilationId"=pattern.source_compilation_id
            AND (NOT (pattern.has_source_version) OR current_compilation."sourceVersionId"=pattern.owned_source_version_id)
        ))`);
      }
      const inducedSyntaxSchemaParam = params.length + 1;
      params.push(INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA);
      const inducedSyntaxRecipeParam = params.length + 1;
      params.push(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
      // Retired syntax generations carried the full segmentation witness. They are inert even when no current
      // row exists; only the compact current schema+recipe may proceed to the active-projection ownership gate.
      where.push(`(pattern.pattern_schema IS NULL
        OR NOT starts_with(pattern.pattern_schema,'${INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA_PREFIX}')
        OR (pattern.pattern_schema=$${inducedSyntaxSchemaParam} AND pattern.component_recipe=$${inducedSyntaxRecipeParam}))`);
      for (const [patternSchema, componentRecipe] of [
        [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID],
        [SOURCE_CODE_FUNCTION_PATTERN_SCHEMA, SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID],
        ["scce.source_owned_test_contract.v1", "scce.source_owned_test_contract_projection.v1"],
        [CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID],
        [REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA, REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE],
        [SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE],
        ...INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.map(schema => [schema, INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID] as const)
      ] as const) {
        if (query.patternSchemas && !query.patternSchemas.includes(patternSchema)) continue;
        if (patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA && query.sourceSystem && query.sourceSystem !== SOURCE_COMPUTATION_SOURCE_SYSTEM) {
          params.push(patternSchema);
          where.push(`pattern.pattern_schema IS DISTINCT FROM $${params.length}`);
          continue;
        }
        // A scoped read may select no active-projection schema at all. Bind
        // this parameter only when a CTE actually consumes it; an unused $n
        // otherwise makes PostgreSQL reject the entire valid read with 42P18.
        if (requestedOwners && !requestedOwnerProjectionBound) {
          params.push(canonicalStringify(requestedOwners));
          projectionScope.push(`EXISTS (
            SELECT 1 FROM jsonb_to_recordset($${params.length}::jsonb) AS requested_projection_owner("profileId" text,"sourceSystem" text)
            WHERE requested_projection_owner."profileId"=active_projection.value_json->>'profileId'
              AND requested_projection_owner."sourceSystem" IS NOT DISTINCT FROM active_projection.value_json->>'sourceSystem'
          )`);
          requestedOwnerProjectionBound = true;
        }
        const constructionSchemaParam = params.length + 1;
        params.push(patternSchema);
        const constructionRecipeParam = params.length + 1;
        params.push(componentRecipe);
        const projectionAccess = storage.informationAccessPredicate("active_projection", params.length + 1);
        params.push(...projectionAccess.params);
        const ownedAct = patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA;
        const computation = patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA;
        const induced = INDUCED_LANGUAGE_MEMORY_PATTERN_SCHEMAS.includes(patternSchema);
        const actAccess = ownedAct ? storage.informationAccessPredicate("owned_evidence", params.length + 1) : undefined;
        if (actAccess) params.push(...actAccess.params);
        const actProfileAccess = ownedAct ? storage.informationAccessPredicate("projection_profile", params.length + 1) : undefined;
        if (actProfileAccess) params.push(...actProfileAccess.params);
        const actVersionAccess = ownedAct ? storage.informationAccessPredicate("projection_version", params.length + 1) : undefined;
        if (actVersionAccess) params.push(...actVersionAccess.params);
        const newerActVersionAccess = ownedAct ? storage.informationAccessPredicate("newer_act_version", params.length + 1) : undefined;
        if (newerActVersionAccess) params.push(...newerActVersionAccess.params);
        const newerActEvidenceAccess = ownedAct ? storage.informationAccessPredicate("newer_act_evidence", params.length + 1) : undefined;
        if (newerActEvidenceAccess) params.push(...newerActEvidenceAccess.params);
        const projectionSet = `active_projection_ids_${projectionSets.length}`;
        const conversationalGuard = patternSchema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA ? conversationalProjectionEligibilitySql(storage, params) : undefined;
        const computationGuard = computation ? conversationalProjectionEligibilitySql(storage, params) : undefined;
        const projectGuard = patternSchema === "scce.source_owned_test_contract.v1" ? projectContractDependencyEligibilitySql(storage, params) : undefined;
        projectionSets.push(`${projectionSet}_headers AS MATERIALIZED (
          SELECT active_projection.value_json->>'profileId' AS profile_id,
            active_projection.value_json->>'sourceSystem' AS source_system,
            active_projection.value_json->>'patternSchema' AS pattern_schema,
            active_projection.value_json->>'componentRecipe' AS projection_recipe,
            active_projection.value_json->'patternIds' AS pattern_ids${computation || conversationalGuard || induced ? `,active_projection.value_json->>'sourceVersionId' AS source_version_id,
            active_projection.value_json->'sourceDependencies' AS source_dependencies` : ""}
          FROM (SELECT value_json,value_json->'informationLabel' AS information_label FROM ${storage.table("storage_meta")}) active_projection
          WHERE ${projectionAccess.sql}
            AND active_projection.value_json->>'schema'='scce.language_pattern_active_projection.v1'
            AND active_projection.value_json->>'patternSchema'=$${constructionSchemaParam}
            AND (active_projection.value_json->>'componentRecipe'=$${constructionRecipeParam}${conversationalGuard ? ` OR active_projection.value_json->>'componentRecipe' IN ('${DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID}','${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}')` : ""}${projectGuard ? ` OR starts_with(active_projection.value_json->>'componentRecipe','${SOURCE_OWNED_PROJECT_PROJECTION_PREFIX}')` : ""})
            ${conversationalGuard ? `AND (active_projection.value_json->>'componentRecipe' NOT IN ('${DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID}','${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}') OR (${conversationalGuard}))` : ""}
            ${computationGuard ? `AND active_projection.value_json->>'sourceSystem'='${SOURCE_COMPUTATION_SOURCE_SYSTEM}' AND (${computationGuard})` : ""}
            ${projectGuard ? `AND (active_projection.value_json->>'componentRecipe'=$${constructionRecipeParam} OR (${projectGuard}))` : ""}
            ${patternSchema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA || ownedAct ? `AND EXISTS (
              SELECT 1 FROM ${storage.table("language_profiles")} projection_profile
              JOIN ${storage.table("source_versions")} projection_version ON projection_version.id=projection_profile.source_version_id
              WHERE projection_profile.id=active_projection.value_json->>'profileId'
                AND projection_profile.source_version_id=active_projection.value_json->>'sourceVersionId'
                AND projection_version.source_id=active_projection.value_json->>'sourceId'
                ${ownedAct ? `AND ${actProfileAccess!.sql} AND ${actVersionAccess!.sql}
                AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} owned_evidence
                  WHERE owned_evidence.source_version_id=projection_version.id AND owned_evidence.status='promoted' AND ${actAccess!.sql})
                AND NOT EXISTS (SELECT 1 FROM ${storage.table("source_versions")} newer_act_version
                  WHERE newer_act_version.source_id=projection_version.source_id
                    AND (newer_act_version.observed_at,newer_act_version.id)>(projection_version.observed_at,projection_version.id)
                    AND ${newerActVersionAccess!.sql} AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} newer_act_evidence
                      WHERE newer_act_evidence.source_version_id=newer_act_version.id AND newer_act_evidence.status='promoted' AND ${newerActEvidenceAccess!.sql}))` : ""}
            )` : ""}
            ${projectionScope.map(scope => `AND ${scope}`).join("\n            ")}
        )${computation || conversationalGuard ? `, ${projectionSet}_dependencies AS MATERIALIZED (
          SELECT scoped.*, ARRAY(SELECT DISTINCT requested.evidence_id FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(scoped.source_dependencies)='array' THEN scoped.source_dependencies ELSE '[]'::jsonb END) dependency(value)
            CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(dependency.value->'evidenceIds')='array'
              THEN dependency.value->'evidenceIds' ELSE '[]'::jsonb END) requested(evidence_id)) AS dependency_evidence_ids
          FROM ${projectionSet}_headers scoped
        )` : ""}, ${projectionSet} AS MATERIALIZED (
          SELECT header.profile_id,header.source_system,header.pattern_schema,header.projection_recipe,member.pattern_id${computation || induced ? ",header.source_version_id" : ""}
          FROM ${projectionSet}_${computation || conversationalGuard ? "dependencies" : "headers"} header
          CROSS JOIN LATERAL jsonb_array_elements_text(CASE
            WHEN jsonb_typeof(header.pattern_ids)='array' THEN header.pattern_ids
            ELSE '[]'::jsonb END) member(pattern_id)
          ${computation ? `JOIN ${storage.table("language_patterns")} computation_member ON computation_member.id=member.pattern_id
            AND computation_member.profile_id=header.profile_id AND computation_member.source_system=header.source_system
            AND computation_member.pattern_schema=header.pattern_schema AND computation_member.component_recipe=header.projection_recipe
            AND computation_member.owned_source_version_id=header.source_version_id AND computation_member.pattern_kind='semantic_role'
            AND COALESCE(array_length(computation_member.evidence_ids,1),0)>0 AND computation_member.evidence_ids <@ header.dependency_evidence_ids` : ""}
        )`);
        const recipeKey = patternSchema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA
          ? `,CASE WHEN pattern.component_recipe IN ('${DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID}','${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}') THEN pattern.component_recipe ELSE $${constructionRecipeParam} END`
          : computation || induced ? ",pattern.component_recipe,pattern.owned_source_version_id" : projectGuard ? `,COALESCE(pattern.component_recipe,$${constructionRecipeParam})` : "";
        where.push(`(pattern.pattern_schema IS DISTINCT FROM $${constructionSchemaParam}
        OR (pattern.profile_id,pattern.source_system,pattern.pattern_schema,pattern.id${recipeKey}) IN (
          SELECT profile_id,source_system,pattern_schema,pattern_id${recipeKey ? ",projection_recipe" : ""}${computation || induced ? ",source_version_id" : ""} FROM ${projectionSet}
        )${patternSchema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA || induced ? ` OR NOT EXISTS (
          SELECT 1 FROM ${projectionSet}_headers published
          WHERE published.profile_id=pattern.profile_id AND published.source_system=pattern.source_system AND published.pattern_schema=pattern.pattern_schema
            ${induced ? "AND published.source_version_id=pattern.owned_source_version_id" : ""}
        )` : ""})`);
        if (conversationalGuard) where.push(`(pattern.component_recipe IS DISTINCT FROM '${CONTEXTUAL_QA_CONSTRUCTION_RECIPE}' OR (
          pattern.pattern_kind='semantic_role' AND COALESCE(array_length(pattern.evidence_ids,1),0)>0
          AND EXISTS (SELECT 1 FROM ${projectionSet}_dependencies qa_header
            WHERE qa_header.profile_id=pattern.profile_id AND qa_header.source_system=pattern.source_system
              AND qa_header.pattern_schema=pattern.pattern_schema AND qa_header.projection_recipe=pattern.component_recipe
              AND qa_header.source_version_id=pattern.owned_source_version_id
              AND pattern.evidence_ids <@ qa_header.dependency_evidence_ids)))`);
        if (computation) where.push(`(pattern.pattern_schema IS DISTINCT FROM $${constructionSchemaParam} OR (
          pattern.pattern_kind='semantic_role' AND COALESCE(array_length(pattern.evidence_ids,1),0)>0))`);
        if (ownedAct) where.push(`(pattern.pattern_schema IS DISTINCT FROM $${constructionSchemaParam} OR (
          pattern.component_recipe=$${constructionRecipeParam} AND COALESCE(array_length(pattern.evidence_ids,1),0)>0
          AND NOT EXISTS (SELECT 1 FROM unnest(pattern.evidence_ids) requested(evidence_id)
            LEFT JOIN ${storage.table("evidence_spans")} owned_evidence ON owned_evidence.id=requested.evidence_id
              AND owned_evidence.source_version_id=pattern.owned_source_version_id AND owned_evidence.status='promoted' AND ${actAccess!.sql}
              AND EXISTS (SELECT 1 FROM ${storage.table("source_versions")} evidence_owner
                WHERE evidence_owner.id=owned_evidence.source_version_id AND evidence_owner.source_id=owned_evidence.source_id)
            WHERE owned_evidence.id IS NULL)))`);
      }
      params.push(query.limit ?? 1000);
      const limitParam = params.length;
      // Ranked on the narrow indexed columns first. The previous shape materialised pattern_json for every
      // matching row before ranking: a construction pattern's bundle averages 700KB, so a corpus with 14,784
      // patterns detoasted ~2GB per call (measured 40-128s per hydration, even when 13 rows came back).
      // pg_column_size reads the stored size without detoasting, so the byte window admits candidates
      // cheaply; the exact JSON-text window then runs over those admitted rows only, which are read anyway.
      const byteBudget = query.maxTotalJsonBytes && query.maxTotalJsonBytes > 0 ? Math.floor(query.maxTotalJsonBytes) : undefined;
      if (byteBudget) params.push(byteBudget);
      const order = (alias: string) => `${alias}.support DESC, ${alias}.updated_at DESC, ${alias}.id ASC`;
      // Same categorisation as candidate_pool's, recomputed from id (cheap, no extra column to thread through
      // scoped_patterns/eligible_patterns). Both byte-budget windows below rank and accumulate PER CATEGORY --
      // otherwise a byte budget sized for the row-count cap's fair split gets spent the same unfair way the row
      // cap used to be, on whichever category's pattern_json blobs are cheapest per unit of "support DESC": measured
      // live, real construction-bundle rows survived the row-count cap (row-fair fix, previous commit) but were
      // then entirely squeezed back out by this exact same global-support byte window, still ordering across
      // categories with incomparable scales.
      const category = (alias: string) => `CASE
        WHEN ${alias}.id LIKE 'surface.construction.bundle.%' THEN 'construction_bundle'
        WHEN ${alias}.id LIKE 'surface.creative_event.bundle.%' THEN 'creative_event_bundle'
        WHEN ${alias}.id LIKE 'reversible_construction.%' THEN 'reversible_construction'
        WHEN ${alias}.id LIKE 'request_requirement_pattern_%' THEN 'request_requirement'
        WHEN ${alias}.id LIKE 'optional_null_realization_pattern.%' THEN 'optional_null'
        ELSE 'other'
      END`;
      const narrow = "decoded_jsonb_bytes,id,profile_id,pattern_kind,support,entropy,evidence_ids,updated_at,information_label,pattern_schema,pattern_language,source_system";
      const decodedJsonbBytes = query.view === "request_seed" ? "CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_artifact_jsonb_bytes ELSE NULL::numeric END" : "pattern.decoded_artifact_jsonb_bytes";
      // Exact prerequisites share one budget; category quotas apply only to searches.
      const partition = (alias: string) => query.patternIds ? "" : `PARTITION BY ${category(alias)} `;
      const byteAllowance = query.patternIds ? `$${params.length}` : `CEIL($${params.length}::numeric / category_counts.n)`;
      // Seed admission measures projected metadata after the bounded candidate selection.
      const admitted = byteBudget && query.view !== "request_seed"
        ? `SELECT ${narrow} FROM (
             SELECT candidate.*,
               SUM(candidate.stored_bytes) OVER (${partition("candidate")}ORDER BY ${order("candidate")} ROWS UNBOUNDED PRECEDING) AS running_stored_bytes,
               ROW_NUMBER() OVER (${partition("candidate")}ORDER BY ${order("candidate")}) AS category_relevance_rank
             FROM candidates candidate
           ) sized CROSS JOIN category_counts
           WHERE sized.running_stored_bytes <= ${byteAllowance}${requestedPatternIds ? "" : " OR sized.category_relevance_rank = 1"}`
        : `SELECT ${narrow} FROM candidates`;
      const finalSelect = byteBudget
        ? `SELECT ranked.id,ranked.profile_id,ranked.pattern_kind,ranked.support,ranked.entropy,ranked.pattern_json,ranked.evidence_ids,ranked.updated_at,ranked.information_label
           FROM (
             SELECT eligible.*,
               SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))) OVER (${partition("eligible")}ORDER BY ${order("eligible")} ROWS UNBOUNDED PRECEDING) AS running_json_bytes,
               ROW_NUMBER() OVER (${partition("eligible")}ORDER BY ${order("eligible")}) AS category_relevance_rank
             FROM eligible_patterns eligible
           ) ranked CROSS JOIN category_counts
           WHERE ranked.running_json_bytes <= ${byteAllowance}${requestedPatternIds ? "" : " OR ranked.category_relevance_rank = 1"}
           ORDER BY ${order("ranked")} LIMIT $${limitParam}`
        : `SELECT * FROM eligible_patterns eligible ORDER BY ${order("eligible")} LIMIT $${limitParam}`;
      const resultSelect = query.requireComplete
        ? `, complete_read AS MATERIALIZED (${finalSelect})
           SELECT * FROM complete_read
           WHERE (SELECT COUNT(*) FROM candidate_pool)=(SELECT COUNT(*) FROM complete_read)
             AND (SELECT COALESCE(SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))),0)
               FROM eligible_patterns eligible JOIN complete_read selected ON selected.id=eligible.id) <= $${params.length}
           ORDER BY ${order("complete_read")}`
        : finalSelect;
      // Carry checked scalar headers through admission instead of rescanning their materialized population.
      const rows = await storage.query<LanguagePatternRow>(
        `WITH ${projectionSets.length ? `${projectionSets.join(",\n")},` : ""}
         pattern_headers AS MATERIALIZED (
           SELECT pattern.id, pattern.profile_id, pattern.pattern_kind, pattern.support, pattern.entropy,
             pattern.evidence_ids, pattern.updated_at, pattern.information_label, pattern.source_system,
             pg_column_size(pattern.pattern_json) AS stored_bytes,
             ${decodedJsonbBytes} AS decoded_jsonb_bytes,
             pattern.pattern_schema,
             pattern.component_recipe,
             pattern.source_compilation_id,
             pattern.owned_source_version_id,
             pattern.pattern_language,
             pattern.has_source_compilation,
             pattern.has_source_version
           FROM ${storage.table("language_patterns")} pattern
           ${scopeWhere.length ? `WHERE ${scopeWhere.join(" AND ")}` : ""}
         ),
         candidate_pool AS MATERIALIZED (
           SELECT pattern.id, pattern.profile_id, pattern.pattern_kind, pattern.support, pattern.entropy, pattern.evidence_ids, pattern.updated_at, pattern.information_label,
                  pattern.pattern_schema, pattern.pattern_language, pattern.source_system, pattern.stored_bytes, pattern.decoded_jsonb_bytes,
                  -- A flat "ORDER BY support DESC, capped to the row budget" ranked every pattern kind on one
                  -- scale, but the scales are not comparable: measured live, a construction-bundle pattern's support tops out at ~1.0
                  -- while a creative-event bundle's routinely runs into the hundreds (avg 667 of 169 rows, against
                  -- 14,623 real construction-bundle rows averaging 0.51) -- so creative-event bundles filled the
                  -- entire row budget before a single real relation-filling bundle was ever admitted, on every
                  -- hydration, regardless of how much real construction-bundle data existed. id prefixes are
                  -- assigned deliberately at write time (surface.construction.bundle.*, surface.creative_event.
                  -- bundle.*, etc. -- language-construction-memory.ts) and cost nothing extra to read here, unlike
                  -- pattern_json's schema field.
                  ${category("pattern")} AS support_category
           FROM pattern_headers pattern
           ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ),
         category_counts AS MATERIALIZED (
           SELECT GREATEST(COUNT(DISTINCT support_category), 1) AS n FROM candidate_pool
         ),
         ranked_pool AS (
           SELECT pool.*,
             ROW_NUMBER() OVER (PARTITION BY pool.support_category ORDER BY pool.support DESC, pool.updated_at DESC, pool.id ASC) AS category_rank
           FROM candidate_pool pool
         ),
         candidates AS MATERIALIZED (
           SELECT ranked.id, ranked.profile_id, ranked.pattern_kind, ranked.support, ranked.entropy, ranked.evidence_ids, ranked.updated_at, ranked.information_label,
             ranked.pattern_schema, ranked.pattern_language, ranked.source_system, ranked.stored_bytes, ranked.decoded_jsonb_bytes
           FROM ranked_pool ranked CROSS JOIN category_counts
           -- Each pattern kind gets an even share of the row budget, ranked by its own support within that share --
           -- fair representation across kinds, not a hardcoded per-kind quota.
           WHERE ${query.patternIds ? "TRUE" : `ranked.category_rank <= CEIL($${limitParam}::numeric / category_counts.n)`}
           ORDER BY ${order("ranked")}
           LIMIT $${limitParam}
         ),
         admitted AS (${admitted}),
         scoped_patterns AS MATERIALIZED (
           SELECT
             admitted.id, admitted.profile_id, admitted.pattern_kind, admitted.support, admitted.entropy, admitted.evidence_ids, admitted.updated_at, admitted.information_label,
             ${query.view === "request_seed"
               ? requestSeedPatternJsonSql("pattern.pattern_json", "admitted.pattern_schema")
               : "pattern.pattern_json"} AS pattern_json,
             admitted.pattern_schema,
             admitted.decoded_jsonb_bytes,
             profile.source_version_id,
             version.source_id,
             version.observed_at AS source_observed_at,
             COALESCE(
               NULLIF(admitted.pattern_language,''),
               NULLIF(version.metadata_json->>'language',''),
               NULLIF(version.metadata_json->>'languageHint',''),
               'language.unspecified'
             ) AS source_language,
             COALESCE(NULLIF(admitted.source_system,''), 'source.unspecified') AS source_system
           FROM admitted
           JOIN ${storage.table("language_patterns")} pattern ON pattern.id=admitted.id
           LEFT JOIN ${storage.table("language_profiles")} profile ON profile.id=admitted.profile_id
           LEFT JOIN ${storage.table("source_versions")} version ON version.id=profile.source_version_id
         ),
         ranked_request_patterns AS (
           SELECT
             scoped.*,
             DENSE_RANK() OVER (
               PARTITION BY scoped.source_system, scoped.source_language, COALESCE(scoped.source_id, scoped.profile_id)
               ORDER BY scoped.source_observed_at DESC NULLS LAST, scoped.source_version_id DESC NULLS LAST
             ) AS source_version_rank
           FROM scoped_patterns scoped
           WHERE scoped.pattern_schema='scce.request_requirement_pattern.v1'
         ),
         eligible_patterns AS (
           SELECT decoded_jsonb_bytes,id,profile_id,pattern_kind,support,entropy,pattern_json,evidence_ids,updated_at,information_label
           FROM scoped_patterns
           WHERE pattern_schema IS DISTINCT FROM 'scce.request_requirement_pattern.v1'
           UNION ALL
           SELECT decoded_jsonb_bytes,id,profile_id,pattern_kind,support,entropy,pattern_json,evidence_ids,updated_at,information_label
           FROM ranked_request_patterns
           WHERE source_version_rank=1
         )
         ${resultSelect}`,
        params
      );
      if (requestedPatternIds) {
        const returnedPatternIds = new Set(rows.map(row => row.id));
        if (rows.length !== requestedPatternIds.length || requestedPatternIds.some(id => !returnedPatternIds.has(id))) return [];
      }
      const patterns = await sourceArtifactMetadataCodec(storage).decodeMany(rows.map(row => ({ value: row.pattern_json, profileId: row.profile_id, informationLabel: row.information_label })));
      const indices = patterns.flatMap((value, index) => isSourceCompilationMetadataHolder(value) ? [] : [index]);
      const decoded = await canonicalCreativeCodec(storage).decodeMany(indices.map(index => patterns[index]));
      indices.forEach((index, position) => { patterns[index] = decoded[position]; });
      return rows.map((row, index) => rowToLanguagePattern({ ...row, pattern_json: patterns[index] as JsonValue }));
    },
    async listSemanticFrames(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      const normalizedRequestSurface = query.requestSurface === undefined ? undefined : normalizePriorKey(query.requestSurface);
      if (query.sourceSystem) { params.push(query.sourceSystem); where.push(`frame.frame_json->>'sourceSystem'=$${params.length}`); }
      if (query.surface) {
        params.push(query.surface); where.push(`frame.frame_json->>'surface'=$${params.length}`);
        params.push(semanticFrameSurfaceHash(query.surface));
        where.push(`(frame.normalized_surface_hash=$${params.length} OR (frame.normalized_surface_hash IS NULL AND jsonb_typeof(frame.frame_json->'surface') IS DISTINCT FROM 'string'))`);
      }
      if (query.requestSurface !== undefined) {
        params.push(semanticFrameSurfaceHasher.digestHex(normalizedRequestSurface!));
        where.push("jsonb_typeof(frame.frame_json->'surface')='string'",
          `frame.normalized_surface_hash=$${params.length}`);
      }
      if (query.view === "request_seed") {
        where.push("jsonb_typeof(frame.frame_json->'surface')='string'",
          "btrim(frame.frame_json->>'surface',E' \\t\\n\\r')<>''",
          "jsonb_typeof(frame.frame_json->'requirementCoefficients')='object'");
      }
      if (query.profileIds) {
        if (!query.profileIds.length) return [];
        params.push([...query.profileIds]);
        where.push(`frame.frame_json->>'profileId'=ANY($${params.length}::text[])`);
      }
      appendInformationAccess(storage, "frame", params, where, "bounded_by_order_and_limit");
      params.push(query.limit ?? 500);
      const rows = await storage.query<SemanticFrameRow>(`SELECT id, ${query.view === "request_seed" ? `${jsonbFieldsSql("frame.frame_json", REQUEST_SEED_FRAME_JSON_FIELDS)} AS frame_json, '[]'::text AS embedding` : "frame_json, embedding::text AS embedding"}, evidence_ids, alpha, created_at, information_label FROM ${storage.table("semantic_frames")} frame WHERE ${where.join(" AND ")} ORDER BY alpha DESC, created_at DESC, id ASC LIMIT $${params.length}`, params);
      const decoded = await sourceArtifactMetadataCodec(storage).decodeMany(rows.map(row => ({ value: row.frame_json, informationLabel: row.information_label })));
      const frames = rows.map((row, index) => rowToSemanticFrame({ ...row, frame_json: decoded[index] as JsonValue }));
      const matched = query.requestSurface === undefined ? frames : frames.filter(frame => {
        const surface = semanticFrameSurface(frame.frameJson);
        return surface !== undefined && normalizePriorKey(surface) === normalizedRequestSurface;
      });
      return query.view === "request_seed" ? matched.flatMap(frame => requestSeedSemanticFrame(frame) ?? []) : matched;
    },
    async listTranslationAlignments(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceLanguage) { params.push(query.sourceLanguage); where.push(`alignment.source_language=$${params.length}`); }
      if (query.targetLanguage) { params.push(query.targetLanguage); where.push(`alignment.target_language=$${params.length}`); }
      appendInformationAccess(storage, "alignment", params, where);
      params.push(query.limit ?? 100);
      return (await storage.query<TranslationAlignmentRow>(`SELECT * FROM ${storage.table("translation_alignments")} alignment WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${params.length}`, params)).map(rowToTranslationAlignment);
    }
  };
}

async function putNgramModelsBatch(storage: PostgresStorageAdapter, models: readonly NgramModelRecord[]): Promise<void> {
  if (!models.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(storage, "ngram_models", models.map(model => ({ id: model.id, informationLabel: model.informationLabel })));
    for (const model of models) {
      const key = ngramModelVersionKey(storage, model.id, model.updatedAt);
      residentNgramModelJsonByVersion.delete(key);
      ngramModelJsonBytesByVersion.delete(key);
    }
    const merged = await mergedSourceArtifactValues(storage, "ngram_models", "model_json", models.map(model => ({ id: model.id, value: model.modelJson })));
    const encoded = await sourceArtifactMetadataCodec(storage).encodeMany(models.map((model, index) => ({ value: merged[index], informationLabel: labels.get(model.id)! })));
    const payload = models.map((model, index) => ({
      id: model.id,
      stream_id: model.streamId,
      language_hint: model.languageHint,
      max_order: model.maxOrder,
      discount: model.discount,
      model_json: encoded[index],
      updated_at_ms: model.updatedAt,
      information_label: labels.get(model.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("ngram_models")} AS n(id,stream_id,language_hint,max_order,discount,model_json,updated_at,information_label)
     SELECT r.id, r.stream_id, r.language_hint, r.max_order, r.discount, r.model_json, TO_TIMESTAMP(r.updated_at_ms/1000.0), r.information_label
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       stream_id text,
       language_hint text,
       max_order integer,
       discount double precision,
       model_json jsonb,
       updated_at_ms double precision,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET discount=EXCLUDED.discount, model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at, information_label=EXCLUDED.information_label
     WHERE n.discount IS DISTINCT FROM EXCLUDED.discount OR n.model_json IS DISTINCT FROM EXCLUDED.model_json
       OR n.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

async function putLanguageUnitsBatch(storage: PostgresStorageAdapter, units: readonly LanguageUnitRecord[]): Promise<void> {
  if (!units.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(storage, "language_units", units.map(unit => ({ id: unit.id, informationLabel: unit.informationLabel })));
    const merged = await mergedSourceArtifactValues(storage, "language_units", "metadata_json", units.map(unit => ({ id: unit.id, value: unit.metadata, sourceVersionId: unit.sourceVersionId, informationLabel: labels.get(unit.id)! })));
    const encoded = await sourceArtifactMetadataCodec(storage).encodeMany(units.map((unit, index) => ({ value: merged[index], profileId: unit.profileId, sourceVersionId: unit.sourceVersionId, informationLabel: labels.get(unit.id)! })));
    const payload = units.map((unit, index) => ({
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
      metadata_json: encoded[index],
      information_label: labels.get(unit.id)!
    }));
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("language_units")} AS lu(id,profile_id,source_version_id,script,unit_kind,unit_text,features,competence_vector,alpha,evidence_ids,metadata_json,information_label)
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
       r.metadata_json,
       r.information_label
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
       metadata_json jsonb,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(lu.alpha,EXCLUDED.alpha), evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(lu.evidence_ids || EXCLUDED.evidence_ids))), metadata_json=EXCLUDED.metadata_json, information_label=EXCLUDED.information_label
     WHERE lu.alpha IS DISTINCT FROM GREATEST(lu.alpha,EXCLUDED.alpha) OR NOT (lu.evidence_ids @> EXCLUDED.evidence_ids)
       OR lu.metadata_json IS DISTINCT FROM EXCLUDED.metadata_json OR lu.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

async function putLanguagePatternsBatch(storage: PostgresStorageAdapter, patterns: readonly LanguagePatternRecord[]): Promise<void> {
  if (!patterns.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(storage, "language_patterns", patterns.map(pattern => ({ id: pattern.id, informationLabel: pattern.informationLabel })));
    const codec = canonicalCreativeCodec(storage), payload = [];
    const values: unknown[] = patterns.map(pattern => pattern.patternJson);
    const indices = values.flatMap((value, index) => isSourceCompilationMetadataHolder(value) ? [] : [index]);
    const creative = await codec.encodeMany(indices.map(index => ({ value: values[index], informationLabel: labels.get(patterns[index]!.id)! })));
    indices.forEach((index, position) => { values[index] = creative[position]; });
    const encoded = await sourceArtifactMetadataCodec(storage).encodeMany(patterns.map((pattern, index) => ({ artifactFamily: "language_pattern" as const, value: values[index], logicalValue: pattern.patternJson, profileId: pattern.profileId, informationLabel: labels.get(pattern.id)! })));
    for (const [index, pattern] of patterns.entries()) payload.push({
    id: pattern.id,
    profile_id: pattern.profileId,
    pattern_kind: pattern.patternKind,
    support: pattern.support,
    entropy: pattern.entropy,
    pattern_json: encoded[index],
    evidence_ids_json: pattern.evidenceIds,
      updated_at_ms: pattern.updatedAt,
      information_label: labels.get(pattern.id)!
    });
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("language_patterns")} AS lp(id,profile_id,pattern_kind,support,entropy,pattern_json,evidence_ids,updated_at,information_label)
     SELECT
       r.id,
       r.profile_id,
       r.pattern_kind,
       r.support,
       r.entropy,
       r.pattern_json,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       TO_TIMESTAMP(r.updated_at_ms/1000.0),
       r.information_label
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       profile_id text,
       pattern_kind text,
       support double precision,
       entropy double precision,
       pattern_json jsonb,
       evidence_ids_json jsonb,
       updated_at_ms double precision,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET support=GREATEST(lp.support,EXCLUDED.support), entropy=EXCLUDED.entropy, pattern_json=jsonb_strip_nulls(jsonb_build_object('sourceCompilationId',lp.pattern_json->'sourceCompilationId')) || EXCLUDED.pattern_json, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(lp.evidence_ids || EXCLUDED.evidence_ids))), updated_at=EXCLUDED.updated_at, information_label=EXCLUDED.information_label
     WHERE lp.support IS DISTINCT FROM GREATEST(lp.support,EXCLUDED.support) OR lp.entropy IS DISTINCT FROM EXCLUDED.entropy
       OR lp.pattern_json IS DISTINCT FROM (jsonb_strip_nulls(jsonb_build_object('sourceCompilationId',lp.pattern_json->'sourceCompilationId')) || EXCLUDED.pattern_json)
       OR NOT (lp.evidence_ids @> EXCLUDED.evidence_ids) OR lp.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
}

async function putSemanticFramesBatch(storage: PostgresStorageAdapter, frames: readonly SemanticFrameRecord[]): Promise<void> {
  if (!frames.length) return;
  await storage.transaction(async () => {
    const labels = await joinDurableRecordLabels(storage, "semantic_frames", frames.map(frame => ({ id: frame.id, informationLabel: frame.informationLabel })));
    const encoded = await sourceArtifactMetadataCodec(storage).encodeMany(frames.map(frame => ({ value: frame.frameJson, informationLabel: labels.get(frame.id)! })));
    const payload = frames.map((frame, index) => {
      const surface = semanticFrameSurface(frame.frameJson);
      return { id: frame.id, frame_json: encoded[index],
        normalized_surface_hash: surface === undefined ? null : semanticFrameSurfaceHash(surface),
        embedding: vectorLiteral(frame.embedding, 64), evidence_ids_json: frame.evidenceIds, alpha: frame.alpha,
        created_at_ms: frame.createdAt, information_label: labels.get(frame.id)! };
    });
    for (const payloadChunk of serializedJsonRowBatches(payload, batchRowId)) {
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("semantic_frames")} AS sf(id,frame_json,normalized_surface_hash,embedding,evidence_ids,alpha,created_at,information_label)
     SELECT
       r.id,
       r.frame_json,
       r.normalized_surface_hash,
       r.embedding::vector,
       (SELECT COALESCE(array_agg(v.value), ARRAY[]::text[]) FROM jsonb_array_elements_text(r.evidence_ids_json) AS v(value)),
       r.alpha,
       TO_TIMESTAMP(r.created_at_ms/1000.0),
       r.information_label
     FROM jsonb_to_recordset($1::jsonb) AS r(
       id text,
       frame_json jsonb,
       normalized_surface_hash text,
       embedding text,
       evidence_ids_json jsonb,
       alpha double precision,
       created_at_ms double precision,
       information_label jsonb
     )
     ON CONFLICT(id) DO UPDATE SET alpha=GREATEST(sf.alpha,EXCLUDED.alpha), frame_json=EXCLUDED.frame_json, normalized_surface_hash=EXCLUDED.normalized_surface_hash, evidence_ids=(SELECT ARRAY(SELECT DISTINCT unnest(sf.evidence_ids || EXCLUDED.evidence_ids))), information_label=EXCLUDED.information_label
     WHERE sf.alpha IS DISTINCT FROM GREATEST(sf.alpha,EXCLUDED.alpha) OR sf.frame_json IS DISTINCT FROM EXCLUDED.frame_json
       OR sf.normalized_surface_hash IS DISTINCT FROM EXCLUDED.normalized_surface_hash
       OR NOT (sf.evidence_ids @> EXCLUDED.evidence_ids) OR sf.information_label IS DISTINCT FROM EXCLUDED.information_label`,
        [payloadChunk]
      );
    }
  });
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
      return storage.transaction(() => storage.tx(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('scce2.active_brain'))`);
        const targetRows = await client.query<BrainLifecycleRow>(
          `SELECT * FROM ${storage.table("brain_import_lifecycle")} WHERE import_run_id=$1 FOR UPDATE`,
          [input.importRunId]
        );
        const target = targetRows.rows[0] ? rowToBrainLifecycle(targetRows.rows[0]) : null;
        if (!target) throw new Error(`brain lifecycle not found for ${input.importRunId}`);
        if (target.brainVersion !== input.brainVersion) throw new Error(`brain lifecycle version mismatch for ${input.importRunId}`);
        if (target.state !== "READY") throw new Error(`brain activation requires READY, found ${target.state}`);

        if (input.requireNoActive) {
          const activeRows = await client.query<{ import_run_id: string }>(
            `SELECT import_run_id FROM ${storage.table("brain_import_lifecycle")} WHERE state='ACTIVE' FOR UPDATE`
          );
          if (activeRows.rows.length) throw new Error("brain activation requires no existing active brain");
          const markerRows = await client.query<{ model_json: JsonValue }>(
            `SELECT model_json FROM ${storage.table("model_state")} WHERE id='scce2.active_brain' FOR UPDATE`
          );
          const marker = markerRows.rows[0]?.model_json;
          const markerVersion = marker && typeof marker === "object" && !Array.isArray(marker)
            ? marker.activeBrainVersion : undefined;
          const markerRuns = marker && typeof marker === "object" && !Array.isArray(marker)
            && Array.isArray(marker.activeImportRunIds) ? marker.activeImportRunIds : [];
          if (markerVersion || markerRuns.length) {
            throw new Error("brain activation requires no existing active brain");
          }
        }

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
        await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("model_state")}(id,model_json,updated_at) VALUES('scce2.active_brain',$1::jsonb,TO_TIMESTAMP($2/1000.0))
           ON CONFLICT(id) DO UPDATE SET model_json=EXCLUDED.model_json, updated_at=EXCLUDED.updated_at`,
          [JSON.stringify({ activeBrainVersion: input.brainVersion, activeImportRunIds, updatedAt: input.updatedAt }), input.updatedAt]
        );
        return { activeBrainVersion: input.brainVersion, activeImportRunIds };
      }));
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

function createUserModelClaimStore(storage: PostgresStorageAdapter): UserModelClaimStore {
  return {
    async putClaim(claim) {
      await storage.query(
        `INSERT INTO ${storage.table("user_model_claims")} (id,conversation_id,kind,subject,value,source,scope,confidence,observed_at,evidence_ids,supersedes_claim_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,TO_TIMESTAMP($9/1000.0),$10,$11)
         ON CONFLICT(conversation_id,id) DO NOTHING`,
        [
          claim.id,
          claim.conversationId,
          claim.kind,
          claim.subject,
          claim.value,
          claim.source,
          claim.scope,
          claim.confidence,
          claim.observedAt,
          claim.evidenceIds,
          claim.supersedesClaimId ?? null
        ]
      );
    },
    async listClaims(query) {
      // conversation_id is always in the WHERE clause -- real tenant
      // isolation, not an optional filter a caller could forget to pass.
      const params: unknown[] = [query.conversationId];
      const where: string[] = [`conversation_id=$1`];
      if (query.subject) {
        params.push(query.subject);
        where.push(`subject=$${params.length}`);
      }
      if (query.scope) {
        params.push(query.scope);
        where.push(`scope=$${params.length}`);
      }
      params.push(query.limit ?? 200);
      // DESC + LIMIT so a conversation with more claims than the limit
      // keeps its most recent claims, not its oldest -- `claimHistory`/
      // `activeClaim` (user-model-store.ts) re-sort by `observedAt`
      // themselves, so returning newest-first here is safe regardless of
      // caller order expectations.
      const rows = await storage.query<UserModelClaimRow>(
        `SELECT * FROM ${storage.table("user_model_claims")} WHERE ${where.join(" AND ")} ORDER BY observed_at DESC LIMIT $${params.length}`,
        params
      );
      return rows.map(rowToUserModelClaim);
    },
    async deleteClaim(query) {
      // Real removal, not a superseding tombstone: the module's promise is that a claim is deletable, and a row that
      // survives deletion under another name keeps governing what the turn believes about its owner.
      const rows = await storage.query<{ id: string }>(
        `DELETE FROM ${storage.table("user_model_claims")} WHERE conversation_id=$1 AND id=$2 RETURNING id`,
        [query.conversationId, query.claimId]
      );
      return rows.length > 0;
    }
  };
}

function createTaskResumptionSnapshotStore(storage: PostgresStorageAdapter): TaskResumptionSnapshotStore {
  return {
    async putSnapshot(record) {
      await storage.query(
        `INSERT INTO ${storage.table("task_resumption_snapshots")} (id,goal_id,snapshot_json,captured_at)
         VALUES($1,$2,$3::jsonb,TO_TIMESTAMP($4/1000.0))
         ON CONFLICT(id) DO UPDATE SET captured_at = GREATEST(${storage.table("task_resumption_snapshots")}.captured_at, EXCLUDED.captured_at)`,
        [record.id, record.goalId, JSON.stringify(record.snapshotJson), record.capturedAt]
      );
    },
    async getLatestSnapshot(goalId) {
      const rows = await storage.query<TaskResumptionSnapshotRow>(
        `SELECT * FROM ${storage.table("task_resumption_snapshots")} WHERE goal_id=$1 ORDER BY captured_at DESC LIMIT 1`,
        [goalId]
      );
      const row = rows[0];
      return row ? rowToTaskResumptionSnapshot(row) : null;
    }
  };
}

interface TranslationSeedRow {
  target_language: string;
  source_symbol: string;
  source_language: string;
  target_symbol: string;
  score: number;
  basis: string;
  evidence_ids: string[];
  observed_at: string | Date;
}

function rowToTranslationSeed(row: TranslationSeedRow): TranslationSeed {
  return {
    sourceSymbol: row.source_symbol,
    targetSymbol: row.target_symbol,
    score: Number(row.score),
    basis: row.basis as TranslationSeed["basis"],
    evidenceIds: row.evidence_ids as TranslationSeed["evidenceIds"]
  };
}

function createTranslationSeedStore(storage: PostgresStorageAdapter): TranslationSeedStore {
  return {
    async putSeeds(input) {
      if (!input.seeds.length) return;
      for (const seed of input.seeds) {
        // Only ever raises the durably-held score for (targetLanguage,
        // sourceSymbol) -- a weaker request-scoped induction than what is
        // already on file must never regress a stronger prior finding.
        await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("translation_seeds")} (target_language,source_symbol,source_language,target_symbol,score,basis,evidence_ids,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,TO_TIMESTAMP($8/1000.0))
           ON CONFLICT(target_language,source_symbol) DO UPDATE SET
             source_language=EXCLUDED.source_language,
             target_symbol=EXCLUDED.target_symbol,
             score=EXCLUDED.score,
             basis=EXCLUDED.basis,
             evidence_ids=EXCLUDED.evidence_ids,
             observed_at=EXCLUDED.observed_at
           WHERE EXCLUDED.score > ${storage.table("translation_seeds")}.score`,
          [input.targetLanguage, seed.sourceSymbol, input.sourceLanguage, seed.targetSymbol, seed.score, seed.basis, seed.evidenceIds, input.observedAt]
        );
      }
    },
    async listSeeds(targetLanguage, limit = 500) {
      const rows = await storage.query<TranslationSeedRow>(
        `SELECT * FROM ${storage.table("translation_seeds")} WHERE target_language=$1 ORDER BY score DESC LIMIT $2`,
        [targetLanguage, limit]
      );
      return rows.map(rowToTranslationSeed);
    }
  };
}

interface TranslationConstructionRow {
  target_language: string;
  source_symbol_a: string;
  source_symbol_b: string;
  target_symbol_a: string;
  target_symbol_b: string;
  score: number;
  evidence_ids: string[];
  observed_at: string | Date;
}

function rowToTranslationConstruction(row: TranslationConstructionRow): TranslationConstruction {
  return {
    sourceSymbols: [row.source_symbol_a, row.source_symbol_b],
    targetSymbols: [row.target_symbol_a, row.target_symbol_b],
    score: Number(row.score),
    evidenceIds: row.evidence_ids
  };
}

function createTranslationConstructionStore(storage: PostgresStorageAdapter): TranslationConstructionStore {
  return {
    async putConstructions(input) {
      if (!input.constructions.length) return;
      for (const construction of input.constructions) {
        // Canonical symbol order in the key so (a,b) and (b,a) are the
        // same construction; same raise-only upsert discipline as
        // translation_seeds.
        const ordered = construction.sourceSymbols[0] <= construction.sourceSymbols[1]
          ? construction
          : {
            ...construction,
            sourceSymbols: [construction.sourceSymbols[1], construction.sourceSymbols[0]] as [string, string],
            targetSymbols: [construction.targetSymbols[1], construction.targetSymbols[0]] as [string, string]
          };
        await storage.mutateLanguageMemory(
          `INSERT INTO ${storage.table("translation_constructions")} (target_language,source_symbol_a,source_symbol_b,target_symbol_a,target_symbol_b,score,evidence_ids,observed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,TO_TIMESTAMP($8/1000.0))
           ON CONFLICT(target_language,source_symbol_a,source_symbol_b) DO UPDATE SET
             target_symbol_a=EXCLUDED.target_symbol_a,
             target_symbol_b=EXCLUDED.target_symbol_b,
             score=EXCLUDED.score,
             evidence_ids=EXCLUDED.evidence_ids,
             observed_at=EXCLUDED.observed_at
           WHERE EXCLUDED.score > ${storage.table("translation_constructions")}.score`,
          [input.targetLanguage, ordered.sourceSymbols[0], ordered.sourceSymbols[1], ordered.targetSymbols[0], ordered.targetSymbols[1], ordered.score, ordered.evidenceIds, input.observedAt]
        );
      }
    },
    async listConstructions(targetLanguage, limit = 500) {
      const rows = await storage.query<TranslationConstructionRow>(
        `SELECT * FROM ${storage.table("translation_constructions")} WHERE target_language=$1 ORDER BY score DESC LIMIT $2`,
        [targetLanguage, limit]
      );
      return rows.map(rowToTranslationConstruction);
    }
  };
}

async function replaceRequestRequirementPatterns(
  storage: PostgresStorageAdapter,
  input: {
    profileId: string;
    sourceVersionId: string;
    sourceSystem: string;
    schema: string;
    compilerFingerprint: string;
    patterns: readonly LanguagePatternRecord[];
  }
): Promise<void> {
  await storage.transaction(async () => {
    const params: unknown[] = [input.profileId, input.schema, input.sourceVersionId, input.sourceSystem];
    const where = [
      "pattern.profile_id=$1",
      "pattern.pattern_json->>'schema'=$2",
      "pattern.pattern_json->>'sourceVersionId'=$3",
      "pattern.pattern_json->>'sourceSystem'=$4"
    ];
    appendInformationAccess(storage, "pattern", params, where);
    params.push(input.patterns.map(pattern => pattern.id));
    where.push(`NOT (pattern.id=ANY($${params.length}::text[]))`);
    // Retained identities update in place; only obsolete members leave the compiler scope.
    await storage.mutateLanguageMemory(
      `DELETE FROM ${storage.table("language_patterns")} AS pattern WHERE ${where.join(" AND ")}`,
      params
    );
    await putLanguagePatternsBatch(storage, input.patterns);
  });
}

function activeLanguagePatternProjectionKey(input: {
  profileId: string;
  sourceSystem: string;
  sourceId: string;
  patternSchema: string;
  tenantId: string;
  componentRecipe?: string;
}): string {
  if (input.componentRecipe === DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID
    || (input.patternSchema === LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA && input.componentRecipe === CONTEXTUAL_QA_CONSTRUCTION_RECIPE)
    || (input.patternSchema === SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA && input.componentRecipe === SOURCE_COMPUTATION_CONSTRUCTION_RECIPE)) return `active_language_pattern_projection:${JSON.stringify([
    "source-owned", input.tenantId, input.sourceSystem, input.sourceId, input.patternSchema, input.componentRecipe
  ])}`;
  if (input.patternSchema === "scce.source_owned_test_contract.v1" && input.componentRecipe && isSourceOwnedProjectProjection(input.componentRecipe)) return `active_language_pattern_projection:${JSON.stringify(["source-owned",input.tenantId,input.sourceSystem,input.sourceId,input.patternSchema,input.componentRecipe])}`;
  if (input.patternSchema === SOURCE_CODE_FUNCTION_PATTERN_SCHEMA || input.patternSchema === "scce.source_owned_test_contract.v1"
    || input.patternSchema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA) {
    return `active_language_pattern_projection:${JSON.stringify([
      "source-owned", input.tenantId, input.sourceSystem, input.sourceId, input.patternSchema
    ])}`;
  }
  return `active_language_pattern_projection:${JSON.stringify([
    input.tenantId,
    input.profileId,
    input.sourceSystem,
    input.sourceId,
    input.patternSchema
  ])}`;
}

function conversationalProjectionEligibilitySql(storage: PostgresStorageAdapter, params: unknown[]): string {
  const access = (alias: string) => {
    const predicate = storage.informationAccessPredicate(alias, params.length + 1);
    params.push(...predicate.params);
    return predicate.sql;
  };
  const profileAccess = access("auxiliary_profile"), ownerAccess = access("auxiliary_owner");
  const versionAccess = access("dependency_version"), evidenceAccess = access("dependency_evidence");
  const newerVersionAccess = access("newer_dependency_version"), newerEvidenceAccess = access("newer_dependency_evidence");
  return `EXISTS (SELECT 1 FROM ${storage.table("language_profiles")} auxiliary_profile
    JOIN ${storage.table("source_versions")} auxiliary_owner ON auxiliary_owner.id=auxiliary_profile.source_version_id
    WHERE auxiliary_profile.id=active_projection.value_json->>'profileId'
      AND auxiliary_owner.id=active_projection.value_json->>'sourceVersionId'
      AND auxiliary_owner.source_id=active_projection.value_json->>'sourceId' AND ${profileAccess} AND ${ownerAccess})
    AND (jsonb_array_length(CASE WHEN jsonb_typeof(active_projection.value_json->'patternIds')='array'
      THEN active_projection.value_json->'patternIds' ELSE '[]'::jsonb END)=0 OR (
      jsonb_typeof(active_projection.value_json->'sourceDependencies')='array'
      AND jsonb_array_length(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array'
        THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END)>0
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array'
        THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END) owner_dependency(value)
        WHERE owner_dependency.value->>'sourceId'=active_projection.value_json->>'sourceId'
          AND owner_dependency.value->>'sourceVersionId'=active_projection.value_json->>'sourceVersionId')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(active_projection.value_json->'sourceDependencies')='array'
        THEN active_projection.value_json->'sourceDependencies' ELSE '[]'::jsonb END) dependency_value(value)
        CROSS JOIN LATERAL (SELECT dependency_value.value->>'sourceId' AS "sourceId", dependency_value.value->>'sourceVersionId' AS "sourceVersionId",
          dependency_value.value->'evidenceIds' AS "evidenceIds") dependency
        LEFT JOIN ${storage.table("source_versions")} dependency_version ON dependency_version.id=dependency."sourceVersionId"
          AND dependency_version.source_id=dependency."sourceId" AND ${versionAccess}
        WHERE dependency_version.id IS NULL OR jsonb_typeof(dependency_value.value->'sourceId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(dependency_value.value->'sourceVersionId') IS DISTINCT FROM 'string' OR jsonb_typeof(dependency."evidenceIds") IS DISTINCT FROM 'array'
          OR jsonb_array_length(CASE WHEN jsonb_typeof(dependency."evidenceIds")='array' THEN dependency."evidenceIds" ELSE '[]'::jsonb END)=0
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(dependency."evidenceIds")='array'
            THEN dependency."evidenceIds" ELSE '[]'::jsonb END) requested(evidence_id)
            LEFT JOIN ${storage.table("evidence_spans")} dependency_evidence ON dependency_evidence.id=requested.evidence_id
              AND dependency_evidence.source_version_id=dependency_version.id AND dependency_evidence.source_id=dependency_version.source_id
              AND dependency_evidence.status='promoted' AND ${evidenceAccess} WHERE dependency_evidence.id IS NULL)
          OR EXISTS (SELECT 1 FROM ${storage.table("source_versions")} newer_dependency_version
            WHERE newer_dependency_version.source_id=dependency_version.source_id
              AND (newer_dependency_version.observed_at,newer_dependency_version.id)>(dependency_version.observed_at,dependency_version.id)
              AND ${newerVersionAccess} AND EXISTS (SELECT 1 FROM ${storage.table("evidence_spans")} newer_dependency_evidence
                WHERE newer_dependency_evidence.source_version_id=newer_dependency_version.id AND newer_dependency_evidence.status='promoted'
                  AND ${newerEvidenceAccess})))) )`;
}

interface TranslationCorrectionRow {
  id: string;
  source_language: string;
  target_language: string;
  correction_json: JsonValue;
  observed_at: Date;
}

function createTranslationCorrectionStore(storage: PostgresStorageAdapter): TranslationCorrectionStore {
  return {
    async putCorrection(record) {
      await storage.query(
        `INSERT INTO ${storage.table("translation_corrections")}(id,source_language,target_language,correction_json,observed_at)
         VALUES($1,$2,$3,$4::jsonb,TO_TIMESTAMP($5/1000.0))
         ON CONFLICT(id) DO UPDATE SET correction_json=EXCLUDED.correction_json, observed_at=EXCLUDED.observed_at`,
        [
          record.id,
          canonicalTranslationTargetKey(record.sourceLanguage),
          canonicalTranslationTargetKey(record.targetLanguage),
          JSON.stringify(toJsonValue(record)),
          record.createdAt
        ]
      );
    },
    async listCorrections(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.sourceLanguage) { params.push(canonicalTranslationTargetKey(query.sourceLanguage)); where.push(`source_language=$${params.length}`); }
      if (query.targetLanguage) { params.push(canonicalTranslationTargetKey(query.targetLanguage)); where.push(`target_language=$${params.length}`); }
      params.push(query.limit ?? 200);
      const rows = await storage.query<TranslationCorrectionRow>(
        `SELECT * FROM ${storage.table("translation_corrections")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY observed_at DESC, id ASC LIMIT $${params.length}`,
        params
      );
      return rows.map(row => row.correction_json as unknown as UserCorrectionAlignmentRecord);
    }
  };
}

function createDocumentGenerationSessionStore(storage: PostgresStorageAdapter): DocumentGenerationSessionStore {
  return {
    async putSession(record) {
      // Real tenant isolation: the table's primary key is (conversation_id,
      // id), not id alone, so a caller-chosen sessionId in one conversation
      // can never collide with, be read by, or be overwritten by a
      // different conversation reusing or guessing the same id.
      await storage.query(
        `INSERT INTO ${storage.table("document_generation_sessions")} AS dgs(id,conversation_id,session_json,updated_at)
         VALUES($1,$2,$3::jsonb,TO_TIMESTAMP($4/1000.0))
         ON CONFLICT(conversation_id,id) DO UPDATE SET session_json=EXCLUDED.session_json, updated_at=EXCLUDED.updated_at`,
        [record.id, record.conversationId, JSON.stringify(record.sessionJson), record.updatedAt]
      );
    },
    async getSession(id, conversationId) {
      const rows = await storage.query<DocumentGenerationSessionRow>(
        `SELECT * FROM ${storage.table("document_generation_sessions")} WHERE id=$1 AND conversation_id=$2`,
        [id, conversationId]
      );
      const row = rows[0];
      return row ? rowToDocumentGenerationSession(row) : null;
    },
    async compareAndPutSession(record, expectedUpdatedAt) {
      return storage.tx(async client => {
        // Session-scoped advisory lock, same real pattern already used by
        // compareAndPutInteractionState -- serializes concurrent writers
        // against this exact (conversation, session) pair for the
        // duration of this transaction, so the read-then-conditional-write
        // below is not itself racy.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${storage.schema}${record.conversationId}${record.id}`]
        );
        const currentRows = await client.query<{ updated_at: Date }>(
          `SELECT updated_at FROM ${storage.table("document_generation_sessions")} WHERE conversation_id=$1 AND id=$2`,
          [record.conversationId, record.id]
        );
        const currentUpdatedAt = currentRows.rows[0] ? currentRows.rows[0].updated_at.getTime() : null;
        if (currentUpdatedAt !== expectedUpdatedAt) {
          return { stored: false, currentUpdatedAt };
        }
        await client.query(
          `INSERT INTO ${storage.table("document_generation_sessions")} AS dgs(id,conversation_id,session_json,updated_at)
           VALUES($1,$2,$3::jsonb,TO_TIMESTAMP($4/1000.0))
           ON CONFLICT(conversation_id,id) DO UPDATE SET session_json=EXCLUDED.session_json, updated_at=EXCLUDED.updated_at`,
          [record.id, record.conversationId, JSON.stringify(record.sessionJson), record.updatedAt]
        );
        return { stored: true, currentUpdatedAt: record.updatedAt };
      });
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
      await storage.mutateLanguageMemory(
        `INSERT INTO ${storage.table("target_profile_patterns")} AS target(id,target_profile_id,pattern_family_id,pattern_json,evidence_ids,alpha,created_at,updated_at)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,TO_TIMESTAMP($7/1000.0),TO_TIMESTAMP($8/1000.0))
         ON CONFLICT(id) DO UPDATE SET pattern_json=EXCLUDED.pattern_json, evidence_ids=EXCLUDED.evidence_ids, alpha=GREATEST(target.alpha,EXCLUDED.alpha), updated_at=EXCLUDED.updated_at
         WHERE target.pattern_json IS DISTINCT FROM EXCLUDED.pattern_json OR target.evidence_ids IS DISTINCT FROM EXCLUDED.evidence_ids OR target.alpha IS DISTINCT FROM GREATEST(target.alpha,EXCLUDED.alpha)`,
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
    async putCalibrationObservations(records) {
      if (!records.length) return;
      const params: unknown[] = [];
      const tuples = records.map(record => {
        const base = params.length;
        params.push(
          record.id, record.calibrationId, record.subsystemId, record.taskClass, record.rawScore, record.outcome,
          record.selectedOutputHash ?? null, record.accepted ?? null, record.rejected ?? null, record.corrected ?? null,
          record.unsupportedFactHit ?? null, record.citationFailure ?? null, record.userCorrectionDistance ?? null,
          record.finalOutcome, record.sourceTraceId ?? null, record.sourceRecordId ?? null,
          JSON.stringify(record.metadata), record.createdAt
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17}::jsonb,TO_TIMESTAMP($${base + 18}/1000.0))`;
      });
      await storage.query(
        `INSERT INTO ${storage.table("calibration_observations")}(id,calibration_id,subsystem_id,task_class,raw_score,outcome,selected_output_hash,accepted,rejected,corrected,unsupported_fact_hit,citation_failure,user_correction_distance,final_outcome,source_trace_id,source_record_id,metadata_json,created_at)
         VALUES${tuples.join(",")}
         ON CONFLICT(id) DO UPDATE SET raw_score=EXCLUDED.raw_score, outcome=EXCLUDED.outcome, final_outcome=EXCLUDED.final_outcome, metadata_json=EXCLUDED.metadata_json`,
        params
      );
    },
    async listInteractionStates(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      // The compare-and-set head order, served by the partial head index instead of a scan of every stored state.
      if (query.headSchema) { params.push(query.headSchema); where.push(`state_json->>'schema'=$${params.length}`, `jsonb_typeof(state_json->'turnIndex')='number'`); }
      const order = query.headSchema ? "(state_json->>'turnIndex')::numeric DESC, created_at DESC, id DESC" : "created_at DESC";
      params.push(query.limit ?? 100);
      return (await storage.query<InteractionStateRow>(`SELECT * FROM ${storage.table("interaction_state_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT $${params.length}`, params)).map(rowToInteractionState);
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
    async listUserCorrections(query = {}) {
      const params: unknown[] = [];
      const where: string[] = [];
      if (query.conversationId) { params.push(query.conversationId); where.push(`conversation_id=$${params.length}`); }
      if (query.turnId) { params.push(query.turnId); where.push(`turn_id=$${params.length}`); }
      params.push(query.limit ?? 128);
      return (await storage.query<UserCorrectionRow>(`SELECT * FROM ${storage.table("user_correction_records")} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT $${params.length}`, params)).map(rowToUserCorrection);
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

/**
 * The ledger tail by plain `ORDER BY t DESC, id DESC LIMIT 1` has no index to
 * serve it and plans as a parallel sequential scan plus sort of the whole
 * events table (measured live on 841,671 rows / 697MB heap: 840-1250ms, paid
 * once per appendBatch, i.e. once per turn). The existing
 * `(type_id, t DESC)` index already answers it exactly: the maximum by
 * (t, id) over the table is the maximum of the per-type maxima, so a
 * recursive loose index scan walks the 64 distinct type ids by index descent
 * and takes one indexed tail per type. Measured live: p50 2.48ms for an
 * identical ledger_hash, and it needs no new index on a table this size.
 */
function latestLedgerHashSql(eventsTable: string): string {
  return `WITH RECURSIVE ledger_type_ids AS (
      (SELECT type_id FROM ${eventsTable} ORDER BY type_id LIMIT 1)
      UNION ALL
      SELECT (SELECT next.type_id FROM ${eventsTable} next WHERE next.type_id > ledger_type_ids.type_id ORDER BY next.type_id LIMIT 1)
      FROM ledger_type_ids WHERE ledger_type_ids.type_id IS NOT NULL
    )
    SELECT tail.ledger_hash
    FROM ledger_type_ids
    CROSS JOIN LATERAL (
      SELECT tail.ledger_hash, tail.t, tail.id
      FROM ${eventsTable} tail
      WHERE tail.type_id = ledger_type_ids.type_id
      ORDER BY tail.t DESC, tail.id DESC
      LIMIT 1
    ) tail
    WHERE ledger_type_ids.type_id IS NOT NULL
    ORDER BY tail.t DESC, tail.id DESC
    LIMIT 1`;
}

async function latestLedgerHash(client: PoolClient, eventsTable: string): Promise<string> {
  const result = await client.query<{ ledger_hash: string }>(latestLedgerHashSql(eventsTable));
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

interface UserCorrectionRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  prompt_hash: string;
  response_hash: string;
  correction_text: string;
  rejected_surface_hash: string | null;
  accepted_surface_hash: string | null;
  preference_delta_json: JsonValue;
  created_at: Date;
}
function rowToUserCorrection(row: UserCorrectionRow): UserCorrectionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    promptHash: row.prompt_hash,
    responseHash: row.response_hash,
    correctionText: row.correction_text,
    rejectedSurfaceHash: row.rejected_surface_hash ?? undefined,
    acceptedSurfaceHash: row.accepted_surface_hash ?? undefined,
    preferenceDeltaJson: row.preference_delta_json,
    createdAt: row.created_at.getTime()
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

interface EvidenceRow { id: string; source_id: string; source_version_id: string; chunk_id: string; content_hash: string; media_type: string; byte_start: string; byte_end: string; char_start: string; char_end: string; text_preview: string; text_content: string; language_hints: JsonValue; script_hints: JsonValue; trust_vector: JsonValue; provenance_json: JsonValue; features: string[]; status: "quarantined" | "promoted"; alpha: string; observed_at: Date; information_label: JsonValue }
function rowToEvidence(row: EvidenceRow): EvidenceSpan { return { id: row.id as EvidenceId, sourceId: row.source_id as SourceId, sourceVersionId: row.source_version_id as SourceVersionId, chunkId: row.chunk_id as never, contentHash: row.content_hash as ContentHash, mediaType: row.media_type, byteStart: Number(row.byte_start), byteEnd: Number(row.byte_end), charStart: Number(row.char_start), charEnd: Number(row.char_end), textPreview: row.text_preview, text: row.text_content, languageHints: row.language_hints, scriptHints: row.script_hints, trustVector: row.trust_vector, provenance: row.provenance_json, features: row.features, status: row.status, alpha: Number(row.alpha), observedAt: row.observed_at.getTime(),
  // The tenancy/compartment label is a security artifact stored NOT NULL on
  // every row; dropping it on read made every hydrated span unlabeled, so
  // any consumer that (correctly) refuses unlabeled evidence -- the
  // training path's own guard, for one -- failed on data that was in fact
  // fully labeled in the database.
  // Title, identity and source kind resolved once, here, so no consumer re-derives them from raw provenance_json.
  sourceIdentity: resolveEvidenceSourceIdentity(row.provenance_json as never),
  informationLabel: normalizeInformationLabel(row.information_label as never) }; }

interface SourceVersionRow { id: string; source_id: string; content_hash: string; media_type: string; observed_at: Date; byte_length: string; trust_vector: JsonValue; metadata_json: JsonValue; namespace: string; canonical_uri: string; information_label: JsonValue }
function rowToSourceVersion(row: SourceVersionRow): SourceVersion {
  const storedMetadata = sourceVersionMetadataRecord(row.metadata_json);
  const internal = sourceVersionMetadataRecord(storedMetadata._scceSourceVersion);
  const metadata = { ...storedMetadata };
  delete metadata._scceSourceVersion;
  return {
    sourceId: row.source_id as SourceId,
    sourceVersionId: row.id as SourceVersionId,
    namespace: row.namespace,
    canonicalUri: row.canonical_uri,
    contentHash: row.content_hash as ContentHash,
    mediaType: row.media_type,
    observedAt: row.observed_at.getTime(),
    byteLength: Number(row.byte_length),
    sourceTrust: sourceTrustFromJson(row.trust_vector),
    metadata,
    role: internal.role === "original" || internal.role === "evidence-derivative"
      ? internal.role
      : undefined,
    derivation: internal.derivation && typeof internal.derivation === "object" && !Array.isArray(internal.derivation)
      ? internal.derivation as unknown as SourceVersion["derivation"]
      : undefined,
    informationLabel: normalizeInformationLabel(row.information_label as never)
  };
}

function sourceVersionStorageMetadata(source: SourceVersion): JsonValue {
  return {
    ...sourceVersionMetadataRecord(source.metadata),
    _scceSourceVersion: {
      role: source.role ?? null,
      derivation: source.derivation ? toJsonValue(source.derivation) : null
    }
  };
}

function sourceVersionMetadataRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function sourceTrustFromJson(value: JsonValue): SourceTrust {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source version trust_vector must be an object");
  }
  const record = value as Record<string, JsonValue>;
  const score = (key: "identity" | "integrity" | "parserReliability" | "directness" | "authority" | "freshness"): number => {
    const item = record[key];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1) {
      throw new Error(`source version trust_vector.${key} must be a finite number in [0,1]`);
    }
    return item;
  };
  const text = (key: "independenceGroup" | "accessScope" | "licenseStatus"): string => {
    const item = record[key];
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`source version trust_vector.${key} must be a non-empty string`);
    }
    return item;
  };
  return {
    identity: score("identity"),
    integrity: score("integrity"),
    parserReliability: score("parserReliability"),
    directness: score("directness"),
    authority: score("authority"),
    freshness: score("freshness"),
    independenceGroup: text("independenceGroup"),
    accessScope: text("accessScope"),
    licenseStatus: text("licenseStatus")
  };
}

/**
 * Feature sets bounded to what the GIN index can actually hold.
 *
 * Postgres refuses an index row over ~2712 bytes, and the refusal fails the whole insert: a node whose feature set
 * grew past it is not written at all, and neither is anything batched with it. Found by re-projecting the corpus,
 * where a single node reached 3304 bytes and stopped a 400-source backfill dead -- which is a plausible reason
 * those sources carried evidence and no graph nodes in the first place. Truncation loses retrieval signal on one
 * over-featured node; refusing the write loses the node, its edges and its whole batch.
 *
 * Deterministic and stable: original order is preserved, so the same node yields the same kept prefix every time.
 */
const GIN_INDEXABLE_FEATURE_BYTES = 2000;
function ginIndexableFeatures(features: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const feature of features) {
    const size = Buffer.byteLength(feature, "utf8") + 1;
    if (size > GIN_INDEXABLE_FEATURE_BYTES) continue;
    if (bytes + size > GIN_INDEXABLE_FEATURE_BYTES) break;
    kept.push(feature);
    bytes += size;
  }
  return kept;
}

/**
 * Rank keys for the anchor-posting search, in order.
 *
 * `opening_block` is a positional prior, and it sat above the BM25 score, so every candidate at char_start 0 beat
 * every candidate deeper in its document whatever the score said. That is right for a request that asks ABOUT a
 * subject -- the lead states what the document is -- and exactly wrong for a request that quotes one of the
 * corpus's own sentences, which is answered wherever that sentence sits. Measured on this corpus: the span
 * carrying "She became fascinated with the machine ... to visit Babbage" holds 17 of the request's 18 adjacent
 * bigrams and did not appear in the top 64 of a query for all 17, because unrelated document openings carrying one
 * of them outranked it. Callers that do not say otherwise keep the prior. Pure.
 */
export function evidenceRankOrder(input: { rank: string; score: string; row: string; openingBlockPrior: boolean; sourceKindRank?: string }): string {
  const { rank, score, row, openingBlockPrior, sourceKindRank } = input;
  return [
    // The source-kind prior leads, and it is a narrow integer the partition already computed -- never a read of
    // provenance_json, which the rank fence exists to keep out of the sort. Deprioritized rows therefore hold
    // only the positions the admitted pass left empty, and every other row keeps the position it had.
    ...(sourceKindRank ? [`${sourceKindRank} ASC`] : []),
    `${rank}title_exact DESC`,
    `${rank}title_match DESC`,
    ...(openingBlockPrior ? [`${rank}opening_block DESC`] : []),
    `${score}score DESC`,
    `${score}overlap_count DESC`,
    `${score}first_feature_ord ASC`,
    `CASE WHEN ${row}status='promoted' THEN 0 WHEN ${row}status='pending' THEN 1 ELSE 2 END ASC`,
    `${row}alpha DESC`,
    `${row}observed_at DESC`,
    // Total order: without a unique last key the sort permutes ties freely, so replay could differ from itself
    // and ranking-then-filtering could not be proven to return what filtering-then-ranking returns.
    `${row}id ASC`
  ].join(",\n                      ");
}

/**
 * The ranking tail of the anchor-posting BM25 search: rank the narrow columns, then read the wide ones.
 *
 * `provenance_json` averages 58,509 bytes per span on this corpus, so a predicate over it detoasts once per
 * candidate. Measured live 2026-09-16 over one group's 4,186 candidates: 0.505s joining the narrow columns,
 * 4.69s with the force-class exclusion in the same WHERE, and past the 8s statement timeout with both
 * exclusions. The exclusions decide admission, not rank, so ranking is total first and the exclusions then run
 * down the ranked prefix until the LIMIT is filled -- the same rows, in the same order, for 0.340s.
 *
 * `OFFSET 0` is the fence that keeps the planner from pulling the lateral back under the sort. It is a plan
 * barrier, not a skip. Pure.
 */
export function evidenceAnchorRankingTail(input: {
  spansTable: string;
  statusCondition: string;
  accessCondition: string;
  titleMatch: string;
  titleExact: string;
  sourceKindExclusion: string;
  /**
   * The complement of `sourceKindExclusion`: true for exactly the rows that predicate removes.
   *
   * Supplying it turns the source-kind half from an exclusion into a frontier partition. The deprioritized rows
   * are no longer deleted; they fill the slots the first pass left empty. Omitting it emits the exclusion shape
   * unchanged, so a caller that does not partition pays nothing and reads the same SQL it always did.
   */
  sourceKindDeprioritized?: string;
  forceClassExclusion: string;
  limitParameter: string;
  openingBlockPrior: boolean;
}): string {
  const { openingBlockPrior } = input;
  const fencedRanking = `SELECT hits.id, hits.score, hits.overlap_count, hits.first_feature_ord, narrow.status, narrow.alpha, narrow.observed_at,
                      ${input.titleMatch} AS title_match,
                      ${input.titleExact} AS title_exact,
                      (evidence.char_start = 0) AS opening_block
               FROM candidate_hits hits
               JOIN ${input.spansTable} evidence ON evidence.id=hits.id
               CROSS JOIN LATERAL (SELECT evidence.status, evidence.alpha, evidence.observed_at) narrow
               WHERE ${input.statusCondition}
                 AND ${input.accessCondition}
               ORDER BY ${evidenceRankOrder({ rank: "", score: "hits.", row: "evidence.", openingBlockPrior })}
               OFFSET 0`;
  // One pass down the ranked prefix, admitting the source kinds this request is about. Identical to the
  // exclusion shape: same fence, same lateral, same LIMIT, same rows.
  const pass = (sourceKindPredicate: string, tier: string) => `SELECT ranked.*${tier}
             FROM (
               ${fencedRanking}
             ) ranked
             CROSS JOIN LATERAL (
               SELECT ${evidenceSourceKindExpression("wide")} AS source_kind,
                      ${evidenceForceClassExpression("wide")} AS force_class
               FROM ${input.spansTable} wide WHERE wide.id = ranked.id
             ) provenance
             WHERE ${sourceKindPredicate}
               AND ${input.forceClassExclusion}
             LIMIT ${input.limitParameter}`;
  const admitted = input.sourceKindDeprioritized
    ? `SELECT tier.* FROM (
             (${pass(input.sourceKindExclusion, ", 0 AS source_kind_rank")})
             UNION ALL
             (${pass(input.sourceKindDeprioritized, ", 1 AS source_kind_rank")})
           ) tier
           LIMIT ${input.limitParameter}`
    : pass(input.sourceKindExclusion, "");
  return `SELECT evidence.*
           FROM (
             ${admitted}
           ) top
           JOIN ${input.spansTable} evidence ON evidence.id=top.id
           ORDER BY ${evidenceRankOrder({
             rank: "top.",
             score: "top.",
             row: "top.",
             openingBlockPrior,
             ...(input.sourceKindDeprioritized ? { sourceKindRank: "top.source_kind_rank" } : {})
           })}`;
}

/** A source titled with the subject the request names, ranked ahead of one that only mentions it. An empty unit
 *  list is a no-op, so every caller that does not name a subject ranks exactly as before. Pure. */
function titleMatchExpression(alias: string, parameter: number): string {
  // Title or derived identity: a book, a PDF or a source file arrives with no title, and its identity
  // (source-identity.ts) is what names it. An empty concatenation matches nothing, as a NULL title did.
  return `(cardinality($${parameter}::text[]) > 0 AND ${alias}.source_name <> ''
    AND (SELECT bool_and(${alias}.source_name LIKE '%' || unit || '%')
         FROM unnest($${parameter}::text[]) AS unit))`;
}

/** The source *named* by the subject, not merely one whose title contains it. Substring title_match is true for every
 *  "Japanese submarine I-40" and "Japan Society ...", so it stops discriminating and BM25's length term then picks the
 *  shortest stub: measured, "What is the capital of Japan?" ranked 32 such spans and never the Japan article. */
function titleExactExpression(alias: string, parameter: number): string {
  return `(cardinality($${parameter}::text[]) > 0
    AND ${alias}.source_title = array_to_string($${parameter}::text[], ' '))`;
}

/** Measured on this corpus: 25,889 of 73,209 scored spans carry a class that can never certify, so BM25 pays for them and
 *  the turn drops them afterwards. Excluded before the LIMIT, so ranking still decides among admitted spans only; an
 *  empty list is a no-op through the cardinality guard. */
function forceClassExclusion(valueExpression: string, parameter: number): string {
  return `(cardinality($${parameter}::text[]) = 0 OR ${valueExpression} <> ALL($${parameter}::text[]))`;
}

/** A span's force class, read from the same two places `resolveEvidenceSourceIdentity` reads. Pure. */
function evidenceForceClassExpression(alias: string): string {
  return `COALESCE(${alias}.provenance_json->>'forceClass', ${alias}.provenance_json->'metadata'->>'forceClass', '')`;
}

/** A span's source kind, read from the same two places `resolveEvidenceSourceIdentity` reads. Pure. */
export function evidenceSourceKindExpression(alias: string): string {
  // The stored generated column carries this exact COALESCE; reading it here keeps the column and the code one contract.
  return `${alias}.source_kind`;
}

/** A pattern's source system, read from the stored generated column that carries `pattern_json->>'sourceSystem'`. Pure. */
export function languagePatternSourceSystemExpression(alias: string): string {
  return `${alias}.source_system`;
}

/** A model's source system, read from the stored generated column that carries `model_json->>'sourceSystem'`. Pure. */
export function ngramModelSourceSystemExpression(alias: string): string {
  return `${alias}.source_system`;
}

/** The indexed observation profile expression. */
export function ngramObservationProfileIdExpression(alias: string): string {
  return `${alias}.metadata_json->>'profileId'`;
}

/** The indexed observation source expression. */
export function ngramObservationSourceSystemExpression(alias: string): string {
  return `${alias}.metadata_json->>'sourceSystem'`;
}

/** A model's owning profile, read from the stored generated column that carries `model_json->>'profileId'`. Pure. */
export function ngramModelProfileIdExpression(alias: string): string {
  return `${alias}.profile_id`;
}

/** A model's trained mass, read from the stored generated column that carries the ranking ORDER BY's COALESCE. Pure. */
export function ngramModelTrainedMassExpression(alias: string): string {
  return `${alias}.trained_mass`;
}

/**
 * The complement of `sourceKindExclusion`: true for exactly the rows it removes, false for every row it keeps.
 *
 * The two together partition the ranked prefix instead of truncating it. An empty list makes this constantly
 * false, so the second pass contributes nothing and the query behaves as the exclusion alone always did. The
 * cardinality guard is the same one, for the same reason: the parameter must be referenced with its type. Pure.
 */
function sourceKindDeprioritized(valueExpression: string, parameter: number): string {
  return `(cardinality($${parameter}::text[]) > 0 AND ${valueExpression} = ANY($${parameter}::text[]))`;
}

/** A prose question must not draw its candidates from source code: 38,232 promoted spans are the owner's own
 *  repository, and for "When was Ada Lovelace born?" every top BM25 row was a test file mentioning her. The
 *  provenance sourceKind names the lane, so this decides which pass of the frontier partition a row belongs to,
 *  before the LIMIT and never on the returned rows. Pure. */
function sourceKindExclusion(valueExpression: string, query: EvidenceQuery, parameter: number): string {
  void query;
  // The parameter is always bound, so it must always be referenced with its type: returning a bare TRUE for an
  // empty list left the placeholder unreferenced, Postgres refused the statement, and every search by source
  // version failed silently -- which starved the construction lane of its graph. An empty list is a no-op
  // through the cardinality guard.
  //
  // This excludes the source kinds the caller named and nothing else. It used to also guess: an unlabelled span
  // not fetched over http was taken for the workspace and dropped from every non-code request. The private-docs
  // corpus is file:// and unlabelled throughout, so the guess hid all of it from questions about it. Asked what
  // license SlopBlocker uses, retrieval returned 151 spans of MediaWiki boilerplate while the span reading
  // "# License SlopBlocker is source-available under the PolyForm Noncommercial License" was excluded here,
  // before ranking ever saw it, though it was indexed under the request subject anchor.
  //
  // Whether a span is source code is isCodeEvidenceSpan's decision -- media type, then extension, then code
  // shape -- and it already runs over the merged pool. A second, cheaper predicate answering the same question
  // from provenance can only disagree with it, and did.
  // The same two places resolveEvidenceSourceIdentity reads, and the same COALESCE the source_title generated
  // column already uses: an ingestor that records its kind under metadata was read as unlabelled here.
  return `(cardinality($${parameter}::text[]) = 0 OR ${valueExpression} <> ALL($${parameter}::text[]))`;
}
function evidenceStatusCondition(
  alias: string,
  status: EvidenceQuery["status"]
): string {
  if (status === "any") return "TRUE";
  if (status === "quarantined") return `${alias}.status='quarantined'`;
  return `${alias}.status='promoted'`;
}

interface GraphNodeRow { id: string; type_id: string; representation_json: JsonValue; alpha: string; evidence_ids: string[]; features: string[]; created_at: Date; updated_at: Date; metadata_json: JsonValue; information_label: InformationLabel }
function rowToGraphNode(row: GraphNodeRow): GraphNode { return { id: row.id as never, typeId: row.type_id as never, representation: row.representation_json, alpha: Number(row.alpha), evidenceIds: row.evidence_ids as EvidenceId[], features: row.features, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(), metadata: row.metadata_json, informationLabel: normalizeInformationLabel(row.information_label) }; }

interface GraphEdgeRow { id: string; source_node_id: string; target_node_id: string; relation_id: string; alpha: string; weight: string; temporal_scope: JsonValue; evidence_ids: string[]; created_at: Date; updated_at: Date; metadata_json: JsonValue; information_label: InformationLabel }
function rowToGraphEdge(row: GraphEdgeRow): GraphEdge { return { id: row.id as never, source: row.source_node_id as never, target: row.target_node_id as never, relationId: row.relation_id as never, alpha: Number(row.alpha), weight: Number(row.weight), temporalScope: row.temporal_scope as never, evidenceIds: row.evidence_ids as EvidenceId[], createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(), metadata: row.metadata_json, informationLabel: normalizeInformationLabel(row.information_label) }; }

interface HyperedgeRow { id: string; schema_id: "scce.hyperedge.v2"; relation_id: string; participant_ports: Hyperedge["participantPorts"]; member_node_ids: string[]; qualifiers_json: JsonValue; modality_json: JsonValue; evidence_ids: string[]; weight_vector: JsonValue; temporal_scope: JsonValue; provenance_refs: string[]; created_at: Date; updated_at: Date; information_label: InformationLabel }
function rowToHyperedge(row: HyperedgeRow): Hyperedge { return { schema: row.schema_id, id: row.id as never, relationId: row.relation_id as never, participantPorts: row.participant_ports, memberNodeIds: row.member_node_ids as never[], qualifiers: row.qualifiers_json, modality: row.modality_json, evidenceIds: row.evidence_ids as EvidenceId[], weightVector: row.weight_vector, temporalScope: row.temporal_scope, provenanceRefs: row.provenance_refs, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

interface QuarantineRow { id: string; source_id: string; source_version_id: string; uri: string; content_hash: string; media_type: string; fetched_at: Date; trust_vector: JsonValue; permission_vector: JsonValue; license_hint: string | null; decision: "pending" | "promoted" | "rejected"; decision_json: JsonValue | null }
function rowToQuarantine(row: QuarantineRow): QuarantineSource { return { id: row.id, sourceId: row.source_id as SourceId, sourceVersionId: row.source_version_id as SourceVersionId, uri: row.uri, contentHash: row.content_hash as ContentHash, mediaType: row.media_type, fetchedAt: row.fetched_at.getTime(), trustVector: row.trust_vector, permissionVector: row.permission_vector, licenseHint: row.license_hint ?? undefined, decision: row.decision, decisionJson: row.decision_json ?? undefined }; }

interface ProofRow { id: string; claim_id: string; verdict: string; confidence_json: JsonValue; proof_graph_json: SemanticProof["proofGraph"]; evidence_ids: string[]; transform_ids: string[]; scores_json: JsonValue; validator_version: string; created_at: Date }
function rowToProof(row: ProofRow): SemanticProof { return { id: row.id as ProofId, claimId: row.claim_id as never, verdict: row.verdict as never, confidence: row.confidence_json, proofGraph: row.proof_graph_json, evidenceIds: row.evidence_ids as EvidenceId[], transformIds: row.transform_ids, scores: row.scores_json, validatorVersion: row.validator_version, createdAt: row.created_at.getTime() }; }

interface CapabilityRow { id: string; episode_id: string; capability_id: string; phase: CapabilityPlan["phase"]; status: CapabilityPlan["status"]; input_json: JsonValue; result_json: JsonValue | null; risk_vector: JsonValue; permission_json: JsonValue; created_at: Date; completed_at: Date | null }
function rowToCapability(row: CapabilityRow): CapabilityPlan { return { id: row.id as never, episodeId: row.episode_id as EpisodeId, capabilityId: row.capability_id, phase: row.phase, status: row.status, input: row.input_json, result: row.result_json ?? undefined, riskVector: row.risk_vector, permission: row.permission_json, createdAt: row.created_at.getTime(), completedAt: row.completed_at?.getTime() }; }

interface ForecastRow { id: string; episode_id: string | null; t: string; state_vector: number[]; alpha_surface_json: AlphaTrace["surfaces"]; spectrum_json: ForecastState["spectrum"] }
function rowToForecast(row: ForecastRow): ForecastState { return { id: row.id as never, episodeId: row.episode_id ? row.episode_id as EpisodeId : undefined, t: Number(row.t), stateVector: row.state_vector.map(Number), alphaSurface: row.alpha_surface_json, spectrum: row.spectrum_json }; }

interface NgramModelRow { id: string; stream_id: string; language_hint: string; max_order: number; discount: string; model_json: JsonValue; updated_at: Date; information_label: InformationLabel }
function rowToNgramModel(row: NgramModelRow): NgramModelRecord { return { id: row.id, streamId: row.stream_id, languageHint: row.language_hint, maxOrder: Number(row.max_order), discount: Number(row.discount), modelJson: row.model_json, updatedAt: row.updated_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

interface NgramCandidateRow { id: string; stream_id: string; language_hint: string; max_order: number; discount: string; updated_at: Date; information_label: InformationLabel; stored_bytes: string }
function candidateToNgramModel(row: NgramCandidateRow, modelJson: JsonValue): NgramModelRecord { return { id: row.id, streamId: row.stream_id, languageHint: row.language_hint, maxOrder: Number(row.max_order), discount: Number(row.discount), modelJson, updatedAt: row.updated_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

// A read-through cache of model_json, not a shadow store: PostgreSQL still decides which rows a listing returns, and
// the key carries the row version a write always bumps alongside the blob. Blobs are held weakly, so an entry only
// survives while a hydration already holds that blob anyway; the measured size is kept as a number, because the byte
// budget has to weigh candidates it will then reject and nothing would retain those.
const residentNgramModelJsonByVersion = new Map<string, WeakRef<object>>();
const ngramModelJsonBytesByVersion = new Map<string, number>();
const ngramModelCacheScopes = new WeakMap<PostgresStorageAdapter, number>();
let nextNgramModelCacheScope = 0;
const residentNgramModelJsonFinalizers = new FinalizationRegistry<string>(key => {
  if (residentNgramModelJsonByVersion.get(key)?.deref() === undefined) residentNgramModelJsonByVersion.delete(key);
});
function ngramModelVersionKey(storage: PostgresStorageAdapter, id: string, updatedAtMs: number): string {
  let scope = ngramModelCacheScopes.get(storage);
  if (scope === undefined) { scope = nextNgramModelCacheScope++; ngramModelCacheScopes.set(storage, scope); }
  return `${scope}${id}${updatedAtMs}`;
}
function ngramModelJsonBytes(storage: PostgresStorageAdapter, id: string, updatedAtMs: number): number | undefined {
  return ngramModelJsonBytesByVersion.get(ngramModelVersionKey(storage, id, updatedAtMs));
}
function residentNgramModelJson(storage: PostgresStorageAdapter, id: string, updatedAtMs: number): { json: JsonValue; jsonBytes: number } | undefined {
  const key = ngramModelVersionKey(storage, id, updatedAtMs);
  const json = residentNgramModelJsonByVersion.get(key)?.deref();
  const jsonBytes = ngramModelJsonBytesByVersion.get(key);
  return json && jsonBytes !== undefined ? { json: json as JsonValue, jsonBytes } : undefined;
}
function rememberNgramModelJson(storage: PostgresStorageAdapter, id: string, updatedAtMs: number, entry: { json: JsonValue; jsonBytes: number }): void {
  if (!entry.json || typeof entry.json !== "object" || !Number.isFinite(entry.jsonBytes)) return;
  const key = ngramModelVersionKey(storage, id, updatedAtMs);
  ngramModelJsonBytesByVersion.set(key, entry.jsonBytes);
  residentNgramModelJsonByVersion.set(key, new WeakRef(entry.json as object));
  residentNgramModelJsonFinalizers.register(entry.json as object, key);
}

/** Test seam: how many model_json blobs this process would not re-read, and a reset of the cache. */
export function residentNgramModelJsonCount(): number {
  let held = 0;
  for (const entry of residentNgramModelJsonByVersion.values()) if (entry.deref()) held += 1;
  return held;
}

export function clearResidentNgramModelJson(): void {
  residentNgramModelJsonByVersion.clear();
  ngramModelJsonBytesByVersion.clear();
}

interface NgramObservationRow { id: string; stream_id: string; language_hint: string; order_n: number; history: string[]; symbol: string; count: string; field_weight: string; source_version_id: string | null; evidence_id: string | null; observed_at: Date; metadata_json: JsonValue; information_label: InformationLabel }
function rowToNgramObservation(row: NgramObservationRow): NgramObservation { return { id: row.id, streamId: row.stream_id, languageHint: row.language_hint, order: Number(row.order_n), history: row.history, symbol: row.symbol, count: Number(row.count), fieldWeight: Number(row.field_weight), sourceVersionId: row.source_version_id ? row.source_version_id as SourceVersionId : undefined, evidenceId: row.evidence_id ? row.evidence_id as EvidenceId : undefined, observedAt: row.observed_at.getTime(), metadata: row.metadata_json, informationLabel: normalizeInformationLabel(row.information_label) }; }

interface LanguageUnitRow { id: string; profile_id: string; source_version_id: string; script: string; unit_kind: LanguageUnitRecord["unitKind"]; unit_text: string; features: string[]; competence_vector: number[]; alpha: string; evidence_ids: string[]; metadata_json: JsonValue; information_label: InformationLabel }
function rowToLanguageUnit(row: LanguageUnitRow): LanguageUnitRecord { return { id: row.id, profileId: row.profile_id, sourceVersionId: row.source_version_id as SourceVersionId, script: row.script, unitKind: row.unit_kind, text: row.unit_text, features: row.features, competenceVector: row.competence_vector.map(Number), alpha: Number(row.alpha), evidenceIds: row.evidence_ids as EvidenceId[], metadata: row.metadata_json, informationLabel: normalizeInformationLabel(row.information_label) }; }

interface LanguagePatternRow { id: string; profile_id: string; pattern_kind: LanguagePatternRecord["patternKind"]; support: string; entropy: string; pattern_json: JsonValue; evidence_ids: string[]; updated_at: Date; information_label: InformationLabel }
function rowToLanguagePattern(row: LanguagePatternRow): LanguagePatternRecord { return { id: row.id, profileId: row.profile_id, patternKind: row.pattern_kind, support: Number(row.support), entropy: Number(row.entropy), patternJson: row.pattern_json, evidenceIds: row.evidence_ids as EvidenceId[], updatedAt: row.updated_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

interface SemanticFrameRow { id: string; frame_json: JsonValue; embedding: string; evidence_ids: string[]; alpha: string; created_at: Date; information_label: InformationLabel }
function rowToSemanticFrame(row: SemanticFrameRow): SemanticFrameRecord { return { id: row.id, frameJson: row.frame_json, embedding: parseVectorText(row.embedding, 64), evidenceIds: row.evidence_ids as EvidenceId[], alpha: Number(row.alpha), createdAt: row.created_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

function parseVectorText(value: string, dimensions: number): number[] {
  const body = value.trim().replace(/^\[/u, "").replace(/\]$/u, "");
  const parsed = body ? body.split(",").map(item => Number(item.trim())) : [];
  if (parsed.length !== dimensions || parsed.some(item => !Number.isFinite(item))) return Array.from({ length: dimensions }, () => 0);
  return parsed;
}

interface TranslationAlignmentRow { id: string; source_frame_id: string; target_frame_id: string; source_language: string; target_language: string; force: TranslationAlignmentRecord["force"]; loss_vector: JsonValue; alignment_json: JsonValue; evidence_ids: string[]; updated_at: Date; information_label: InformationLabel }
function rowToTranslationAlignment(row: TranslationAlignmentRow): TranslationAlignmentRecord { return { id: row.id, sourceFrameId: row.source_frame_id, targetFrameId: row.target_frame_id, sourceLanguage: row.source_language, targetLanguage: row.target_language, force: row.force, lossVector: row.loss_vector, alignmentJson: row.alignment_json, evidenceIds: row.evidence_ids as EvidenceId[], updatedAt: row.updated_at.getTime(), informationLabel: normalizeInformationLabel(row.information_label) }; }

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
  // The column's CHECK constraint and this type agree today, and nothing keeps them agreeing: a state added to the
  // enum without a migration, or a row written by an older build, arrives here as a string the rest of the runtime
  // will treat as a lifecycle state and switch on. `isBrainLifecycleState` is the guard for exactly that and had no
  // caller, so the one place untrusted text becomes a typed lifecycle state was the one place not checking.
  if (!isBrainLifecycleState(row.state)) {
    throw new Error(`brain_import_lifecycle row ${row.import_run_id} carries unknown state ${JSON.stringify(row.state)}`);
  }
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

interface UserModelClaimRow { id: string; conversation_id: string; kind: UserModelClaimRecord["kind"]; subject: string; value: string; source: UserModelClaimRecord["source"]; scope: string; confidence: string; observed_at: Date; evidence_ids: string[]; supersedes_claim_id: string | null }
function rowToUserModelClaim(row: UserModelClaimRow): UserModelClaimRecord { return { id: row.id, conversationId: row.conversation_id, kind: row.kind, subject: row.subject, value: row.value, source: row.source, scope: row.scope, confidence: Number(row.confidence), observedAt: row.observed_at.getTime(), evidenceIds: row.evidence_ids as EvidenceId[], ...(row.supersedes_claim_id ? { supersedesClaimId: row.supersedes_claim_id } : {}) }; }

interface TaskResumptionSnapshotRow { id: string; goal_id: string; snapshot_json: JsonValue; captured_at: Date }
function rowToTaskResumptionSnapshot(row: TaskResumptionSnapshotRow): TaskResumptionSnapshotRecord { return { id: row.id, goalId: row.goal_id, snapshotJson: row.snapshot_json, capturedAt: row.captured_at.getTime() }; }

interface DocumentGenerationSessionRow { id: string; conversation_id: string; session_json: JsonValue; updated_at: Date }
function rowToDocumentGenerationSession(row: DocumentGenerationSessionRow): DocumentGenerationSessionRecord { return { id: row.id, conversationId: row.conversation_id, sessionJson: row.session_json, updatedAt: row.updated_at.getTime() }; }

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


interface RelationPotentialModelRow {
  model_id: string;
  lifecycle: RelationPotentialArtifactRecord["lifecycle"];
  model_json: JsonValue;
  validation_json: JsonValue | null;
  training_window_json: JsonValue;
  dataset_hash: string;
  created_at: Date;
}

function rowToRelationPotentialArtifact(row: RelationPotentialModelRow): RelationPotentialArtifactRecord {
  const model = row.model_json as unknown as RelationPotentialModel;
  assertValidRelationPotentialModel(model);
  return {
    modelId: row.model_id,
    model,
    lifecycle: row.lifecycle,
    validation: (row.validation_json ?? undefined) as unknown as RelationPotentialValidation | undefined,
    trainingWindow: (row.training_window_json ?? {}) as unknown as Readonly<Record<string, number | string>>,
    createdAt: row.created_at.getTime()
  };
}

/**
 * Durable relation-potential artifact lifecycle. `promote()` is the structural gate: it re-reads the stored row and
 * refuses anything that is not already `validated` with a held-out result that beat identity, so a fitted model
 * cannot reach production by being written into a config file.
 */
function createRelationPotentialModelStore(storage: PostgresStorageAdapter): RelationPotentialModelStore {
  const select = async (sql: string, params: unknown[]) => storage.query<RelationPotentialModelRow>(sql, params);
  return {
    async readPromoted() {
      const active = await storage.query<{ model_id: string }>(
        `SELECT model_id FROM ${storage.table("relation_potential_active_model")} WHERE slot=$1`,
        ["global"]
      );
      const modelId = active[0]?.model_id;
      if (!modelId) return undefined;
      const rows = await select(`SELECT * FROM ${storage.table("relation_potential_models")} WHERE model_id=$1 AND lifecycle=$2`, [modelId, "promoted"]);
      return rows[0] ? rowToRelationPotentialArtifact(rows[0]) : undefined;
    },
    async read(modelId) {
      const rows = await select(`SELECT * FROM ${storage.table("relation_potential_models")} WHERE model_id=$1`, [modelId]);
      return rows[0] ? rowToRelationPotentialArtifact(rows[0]) : undefined;
    },
    async put(record) {
      assertValidRelationPotentialModel(record.model);
      if (record.modelId !== record.model.modelId) throw new Error("relation-potential artifact modelId must match the frozen model");
      await storage.query(
        `INSERT INTO ${storage.table("relation_potential_models")}(model_id,lifecycle,model_json,validation_json,training_window_json,dataset_hash,created_at)
         VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
         ON CONFLICT (model_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle, validation_json=EXCLUDED.validation_json, training_window_json=EXCLUDED.training_window_json`,
        [record.modelId, record.lifecycle, JSON.stringify(record.model), record.validation ? JSON.stringify(record.validation) : null,
          JSON.stringify(record.trainingWindow), record.model.datasetHash, new Date(record.createdAt)]
      );
    },
    async promote(input) {
      await storage.transaction(async () => {
        const rows = await select(`SELECT * FROM ${storage.table("relation_potential_models")} WHERE model_id=$1 FOR UPDATE`, [input.modelId]);
        const row = rows[0];
        if (!row) throw new Error(`relation-potential artifact ${input.modelId} is not stored; promotion refused`);
        assertPromotableRelationPotentialArtifact(rowToRelationPotentialArtifact(row));
        const current = await storage.query<{ model_id: string }>(
          `SELECT model_id FROM ${storage.table("relation_potential_active_model")} WHERE slot=$1 FOR UPDATE`,
          ["global"]
        );
        const currentId = current[0]?.model_id;
        if (input.expectedCurrentModelId !== undefined && (currentId ?? null) !== (input.expectedCurrentModelId ?? null)) {
          throw new Error(`relation-potential active artifact is ${currentId ?? "none"}, expected ${input.expectedCurrentModelId}`);
        }
        if (currentId && currentId !== input.modelId) {
          await storage.query(`UPDATE ${storage.table("relation_potential_models")} SET lifecycle=$2 WHERE model_id=$1 AND lifecycle=$3`, [currentId, "validated", "promoted"]);
        }
        await storage.query(`UPDATE ${storage.table("relation_potential_models")} SET lifecycle=$2 WHERE model_id=$1`, [input.modelId, "promoted"]);
        await storage.query(
          `INSERT INTO ${storage.table("relation_potential_active_model")}(slot,model_id,activated_at) VALUES($1,$2,$3)
           ON CONFLICT (slot) DO UPDATE SET model_id=EXCLUDED.model_id, activated_at=EXCLUDED.activated_at`,
          ["global", input.modelId, new Date()]
        );
      });
    },
    async list(limit) {
      // Cost bound: listing is an operator aid, never a hot path.
      const rows = await select(`SELECT * FROM ${storage.table("relation_potential_models")} ORDER BY created_at DESC, model_id LIMIT $1`, [Math.max(1, Math.min(200, Math.floor(limit ?? 20)))]);
      return rows.map(rowToRelationPotentialArtifact);
    }
  };
}

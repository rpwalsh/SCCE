import path from "node:path";
import {
  createSourceCompletionContract,
  planHydration,
  toJsonValue,
  type BrainShardImportOptions,
  type BrainShardProvenanceClass,
  type JsonValue,
  type ScceStorage,
  type SourceCompletionFamilyId,
  type SourceCompletionHydrationPlan,
  type SourceCompletionHydrationRecord
} from "@scce/kernel";
import { buildScce2BrainShardIndex, type Scce2BrainShardIndex, type Scce2ShardIndexEntry } from "./scce2/brain-shard-index.js";
import { createScce2ToV3Importer } from "./scce2/scce2-to-v3-importer.js";
import { readScce2LanguageProfile, type Scce2ProfileFileEvidence } from "./scce2/scce2-ingest-manifest.js";

export interface HydrationPlanOptions {
  hashWorkExtentBytes?: number;
  maxHashBytesPerFile?: number;
  maxDepth?: number;
  maxFiles?: number;
}

export interface HydrationImportOptions extends HydrationPlanOptions, BrainShardImportOptions {
  planId: string;
}

export interface HydrationPlanReport {
  schema: "scce.hydration.plan.v1";
  planId: string;
  rootPath: string;
  filesFound: number;
  sectionsFound: number;
  importableSections: Scce2BrainShardIndex["importableSections"];
  unsupportedSections: Scce2BrainShardIndex["unsupportedSections"];
  unknownSections: Scce2BrainShardIndex["unknownSections"];
  recordCountsByFamily: Record<string, number>;
  destinationTables: Record<string, number>;
  destinationStores: Record<string, number>;
  idempotencyKeys: Array<{ familyId: string; key: string }>;
  missingRequiredFields: Array<{ familyId: string; recordId?: string; fields: string[]; reasons: string[] }>;
  directEvidenceSourceSpanCoverage: {
    directEvidenceSpans: number;
    directEvidenceWithExactSourceSpan: number;
    profileExcerptEvidenceSpans: number;
    directEvidenceRejectedForMissingSourceSpan: number;
  };
  learnedPriorCounts: {
    language: number;
    concept: number;
    program: number;
    unknown: number;
  };
  warnings: string[];
  safeToHydrate: boolean;
  sourceCompletionPlan: SourceCompletionHydrationPlan;
  index: Scce2BrainShardIndex;
}

export interface HydrationImportReport {
  schema: "scce.hydration.import.v1";
  ok: boolean;
  planId: string;
  importRunId?: string;
  activeBrainVersion?: string;
  insertedLedgerRows: number;
  skippedLedgerRows: number;
  rejectedRecords: SourceCompletionHydrationPlan["rejectedRecords"];
  warnings: string[];
  counters?: JsonValue;
  activeBrain?: JsonValue;
}

export async function createHydrationPlan(rootPath: string, options: HydrationPlanOptions = {}): Promise<HydrationPlanReport> {
  const root = path.resolve(rootPath);
  const index = await buildScce2BrainShardIndex(root, options);
  const evidenceCoverage = await inspectProfileEvidence(index);
  const records = hydrationRecordsFromIndex(index, evidenceCoverage);
  const sourceCompletionPlan = planHydration({ records, contract: createSourceCompletionContract() });
  const recordCountsByFamily = countBy(records.map(record => String(record.familyId)));
  const missingRequiredFields = sourceCompletionPlan.rejectedRecords.map(record => ({
    familyId: record.familyId,
    recordId: record.recordId,
    fields: record.missingFields,
    reasons: record.reasonIds
  }));
  const warnings = [
    ...index.warnings,
    ...index.unsupportedSections.map(section => `unsupported section ${section.id}: ${section.reason}`),
    ...index.unknownSections.map(section => `unknown section ${section.id}: ${section.reason}`),
    ...sourceCompletionPlan.warnings,
    ...sourceCompletionPlan.unsafeReasons
  ];
  const importableCount = index.importableSections.length;
  if (importableCount === 0) warnings.push("hydrate plan found zero importable SCCE2 sections");
  const directMissing = sourceCompletionPlan.rejectedRecords.filter(record => record.reasonIds.includes("source_completion.hydration.direct_evidence_requires_exact_source_span")).length;
  const safeToHydrate = sourceCompletionPlan.safeToHydrate && importableCount > 0 && directMissing === 0;
  return {
    schema: "scce.hydration.plan.v1",
    planId: sourceCompletionPlan.id,
    rootPath: root,
    filesFound: index.filesFound,
    sectionsFound: index.entries.length,
    importableSections: index.importableSections,
    unsupportedSections: index.unsupportedSections,
    unknownSections: index.unknownSections,
    recordCountsByFamily,
    destinationTables: sourceCompletionPlan.destinationTableCounts,
    destinationStores: sourceCompletionPlan.destinationStoreCounts,
    idempotencyKeys: sourceCompletionPlan.acceptedRecords.map(record => ({ familyId: record.familyId, key: record.idempotencyKey })),
    missingRequiredFields,
    directEvidenceSourceSpanCoverage: {
      directEvidenceSpans: evidenceCoverage.directEvidenceSpans,
      directEvidenceWithExactSourceSpan: evidenceCoverage.directEvidenceWithExactSourceSpan,
      profileExcerptEvidenceSpans: evidenceCoverage.profileExcerptEvidenceSpans,
      directEvidenceRejectedForMissingSourceSpan: directMissing
    },
    learnedPriorCounts: {
      language: index.languagePriorCounts.units + index.languagePriorCounts.patterns + index.languagePriorCounts.ngramStates,
      concept: index.graphConceptPriorCounts.concepts + index.graphConceptPriorCounts.relations + index.graphConceptPriorCounts.graphShards,
      program: index.entries.filter(entry => entry.forceClass === "learned_program_prior").length,
      unknown: index.entries.filter(entry => entry.forceClass === "unknown_prior").length
    },
    warnings,
    safeToHydrate,
    sourceCompletionPlan,
    index
  };
}

export async function importHydrationPlan(storage: ScceStorage, rootPath: string, options: HydrationImportOptions): Promise<HydrationImportReport> {
  const plan = await createHydrationPlan(rootPath, options);
  if (plan.planId !== options.planId) {
    return {
      schema: "scce.hydration.import.v1",
      ok: false,
      planId: options.planId,
      insertedLedgerRows: 0,
      skippedLedgerRows: 0,
      rejectedRecords: plan.sourceCompletionPlan.rejectedRecords,
      warnings: [`plan id mismatch: expected ${plan.planId}, received ${options.planId}`]
    };
  }
  if (!plan.safeToHydrate) {
    return {
      schema: "scce.hydration.import.v1",
      ok: false,
      planId: plan.planId,
      insertedLedgerRows: 0,
      skippedLedgerRows: 0,
      rejectedRecords: plan.sourceCompletionPlan.rejectedRecords,
      warnings: plan.warnings
    };
  }
  const readiness = await storage.verify();
  if (!readiness.ok) {
    return {
      schema: "scce.hydration.import.v1",
      ok: false,
      planId: plan.planId,
      insertedLedgerRows: 0,
      skippedLedgerRows: 0,
      rejectedRecords: plan.sourceCompletionPlan.rejectedRecords,
      warnings: readiness.errors
    };
  }
  const before = await storage.brainImports.listLedger({ limit: 100000 });
  const beforeIds = new Set(before.map(row => row.id));
  const importer = createScce2ToV3Importer({ storage });
  const imported = await importer.import(path.resolve(rootPath), options);
  const after = await storage.brainImports.listLedger({ importRunId: imported.importRunId, limit: 100000 });
  const insertedLedgerRows = after.filter(row => !beforeIds.has(row.id)).length;
  const skippedLedgerRows = insertedLedgerRows === 0 ? after.length : Math.max(0, before.filter(row => row.importRunId === imported.importRunId).length);
  return {
    schema: "scce.hydration.import.v1",
    ok: true,
    planId: plan.planId,
    importRunId: imported.importRunId,
    activeBrainVersion: imported.activeBrainVersion,
    insertedLedgerRows,
    skippedLedgerRows,
    rejectedRecords: plan.sourceCompletionPlan.rejectedRecords,
    warnings: [...plan.warnings, ...imported.warnings.map(warning => warning.message)],
    counters: toJsonValue(imported.counters),
    activeBrain: await storage.brainImports.active()
  };
}

export async function assertHydratedRuntimeReady(storage: ScceStorage): Promise<{ activeBrainVersion: string; activeImportRunIds: string[] }> {
  const readiness = await storage.verify();
  if (!readiness.ok) throw new Error(`hydrated runtime unavailable: ${readiness.errors.join("; ")}`);
  const active = await storage.brainImports.active();
  if (!active.activeBrainVersion || active.activeImportRunIds.length === 0) throw new Error("hydrated runtime unavailable: no active brain marker");
  return { activeBrainVersion: active.activeBrainVersion, activeImportRunIds: active.activeImportRunIds };
}

async function inspectProfileEvidence(index: Scce2BrainShardIndex): Promise<{
  directEvidenceSpans: number;
  directEvidenceWithExactSourceSpan: number;
  profileExcerptEvidenceSpans: number;
  explicitDirectEvidenceMissingSourceSpan: number;
}> {
  let directEvidenceSpans = 0;
  let directEvidenceWithExactSourceSpan = 0;
  let profileExcerptEvidenceSpans = 0;
  let explicitDirectEvidenceMissingSourceSpan = 0;
  for (const shard of index.manifest.language?.shards ?? []) {
    const profile = await readScce2LanguageProfile(shard.profilePath);
    for (const evidence of profile?.fileEvidence ?? []) {
      const exact = hasExactSourceSpan(evidence);
      if (exact) {
        directEvidenceSpans++;
        directEvidenceWithExactSourceSpan++;
      } else {
        profileExcerptEvidenceSpans++;
        if (explicitForceClass(evidence) === "direct_evidence") explicitDirectEvidenceMissingSourceSpan++;
      }
    }
  }
  return { directEvidenceSpans, directEvidenceWithExactSourceSpan, profileExcerptEvidenceSpans, explicitDirectEvidenceMissingSourceSpan };
}

function hydrationRecordsFromIndex(index: Scce2BrainShardIndex, coverage: Awaited<ReturnType<typeof inspectProfileEvidence>>): SourceCompletionHydrationRecord[] {
  const importRunId = `hydrate.import.${hashKey(index.rootPath, index.entries.map(entry => `${entry.id}:${entry.sha256 ?? entry.hashStatus ?? entry.byteLength}`).join("|"))}`;
  const brainVersion = `hydrate.brain.${hashKey(index.rootPath, index.sourceId ?? "", String(index.totals.bytes))}`;
  const records: SourceCompletionHydrationRecord[] = [
    record("scce2_import_runs", {
      id: `${importRunId}:run`,
      importRunId,
      brainVersion,
      rootPath: index.rootPath,
      forceClass: "unknown_prior",
      sourceVersionId: "hydrate.plan.source_version.manifest",
      evidenceSpanId: "hydrate.plan.evidence.manifest"
    }),
    record("model_state_markers", {
      id: `${importRunId}:active_marker`,
      kind: "active_brain",
      active: true,
      activeImportRunIds: [importRunId],
      forceClass: "unknown_prior"
    })
  ];
  for (const entry of index.entries) records.push(recordForEntry(entry, importRunId));
  for (let i = 0; i < coverage.directEvidenceSpans; i++) {
    records.push(record("evidence_spans", {
      id: `${importRunId}:direct_evidence:${i}`,
      sourceId: `${importRunId}:source:direct:${i}`,
      sourceVersionId: `${importRunId}:source_version:direct:${i}`,
      evidenceSpanId: `${importRunId}:evidence_span:direct:${i}`,
      chunkId: `${importRunId}:chunk:direct:${i}`,
      byteStart: 0,
      byteEnd: 1,
      forceClass: "direct_evidence"
    }));
  }
  for (let i = 0; i < coverage.profileExcerptEvidenceSpans; i++) {
    records.push(record("evidence_spans", {
      id: `${importRunId}:profile_excerpt:${i}`,
      sourceId: `${importRunId}:source:profile:${i}`,
      sourceVersionId: `${importRunId}:source_version:profile:${i}`,
      evidenceSpanId: `${importRunId}:evidence_span:profile:${i}`,
      chunkId: `${importRunId}:chunk:profile:${i}`,
      byteStart: 0,
      byteEnd: 1,
      forceClass: "profile_excerpt_evidence"
    }));
  }
  for (let i = 0; i < coverage.explicitDirectEvidenceMissingSourceSpan; i++) {
    records.push(record("evidence_spans", {
      id: `${importRunId}:invalid_direct_evidence:${i}`,
      sourceId: `${importRunId}:source:invalid:${i}`,
      chunkId: `${importRunId}:chunk:invalid:${i}`,
      byteStart: 0,
      byteEnd: 1,
      forceClass: "direct_evidence"
    }));
  }
  return records;
}

function recordForEntry(entry: Scce2ShardIndexEntry, importRunId: string): SourceCompletionHydrationRecord {
  const fileHash = entry.sha256 ?? `${entry.hashStatus ?? "unhashed"}:${entry.byteLength}`;
  const familyId = familyForEntry(entry);
  const base: Record<string, JsonValue> = {
    id: `${importRunId}:${entry.kind}:${entry.id}`,
    importRunId,
    sectionId: entry.id,
    fileHash,
    sourcePath: entry.path,
    forceClass: entry.forceClass,
    sourceVersionId: `${importRunId}:source_version:${entry.id}`,
    evidenceSpanId: `${importRunId}:evidence:${entry.id}`,
    evidenceIds: [],
    memberNodeIds: [`${importRunId}:node:${entry.id}`],
    traceKind: "hydration_plan",
    traceId: `${importRunId}:trace`
  };
  if (familyId === "graph_nodes") {
    base.typeId = "scce2.concept_prior";
    base.metadata = toJsonValue({ sourcePath: entry.path });
  }
  if (familyId === "graph_edges") {
    base.source = `${importRunId}:node:source:${entry.id}`;
    base.target = `${importRunId}:node:target:${entry.id}`;
    base.relationId = `${importRunId}:relation:${entry.id}`;
  }
  if (familyId === "language_units") {
    base.profileId = `${importRunId}:profile:${entry.id}`;
  }
  if (familyId === "ngram_models") {
    base.streamId = `${importRunId}:stream:${entry.id}`;
    base.maxOrder = 6;
    base.modelHash = fileHash;
  }
  return record(familyId, base);
}

function familyForEntry(entry: Scce2ShardIndexEntry): SourceCompletionFamilyId {
  if (entry.kind === "graph") return "graph_nodes";
  if (entry.kind === "language") return "language_units";
  if (entry.kind === "ngram_state") return "ngram_models";
  return "scce2_shard_sections";
}

function record(familyId: SourceCompletionFamilyId, value: Record<string, JsonValue>): SourceCompletionHydrationRecord {
  return { familyId, record: value, traceIds: typeof value.traceId === "string" ? [value.traceId] : [] };
}

function hasExactSourceSpan(evidence: Scce2ProfileFileEvidence): boolean {
  return Boolean(sourceUri(evidence) && sourceVersion(evidence) && (range(evidence.originalByteRange) || range(evidence.byteRange) || range(evidence.originalCharRange) || range(evidence.charRange) || startEnd(evidence.byteStart, evidence.byteEnd) || startEnd(evidence.charStart, evidence.charEnd)));
}

function explicitForceClass(evidence: Scce2ProfileFileEvidence): BrainShardProvenanceClass | undefined {
  const record = evidence as Record<string, unknown>;
  const raw = record.forceClass ?? record.provenanceClass;
  return typeof raw === "string" ? raw as BrainShardProvenanceClass : undefined;
}

function sourceUri(evidence: Scce2ProfileFileEvidence): string | undefined {
  return firstString(evidence.originalSourceUri, evidence.sourceUri, evidence.canonicalUri, evidence.uri, evidence.url);
}

function sourceVersion(evidence: Scce2ProfileFileEvidence): string | undefined {
  return firstString(evidence.originalSourceVersionId, evidence.sourceVersionId, evidence.revisionId, evidence.contentHash);
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

function range(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) return false;
  return startEnd(value[0], value[1]);
}

function startEnd(start: unknown, end: unknown): boolean {
  return typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function hashKey(...parts: readonly string[]): string {
  let hash = 2166136261;
  const text = parts.join("\u001f");
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  canonicalStringify,
  CORPUS_SOURCE_SYSTEM_IDS,
  compileBrainReplayManifest,
  createHasher,
  createLanguageIdentityRuntime,
  toJsonValue,
  validateBrainManifestContract,
  validationDisposition,
  type BrainLifecycleRecord,
  type BrainManifestContract,
  type BrainValidationReport,
  type EvidenceId,
  type InformationLabel,
  type SourceVersionId,
  type SourceVersion,
  type LanguageProfileHeader,
  type NgramModelHeader,
  type ScceStorage
} from "@scce/kernel";
import type { LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";
import type { OssCorpusTrainReport } from "./oss-corpus.js";
import type { GutenbergCorpusTrainReport } from "./gutenberg-corpus.js";
import type { StoredCorpusConstructionTrainingReport } from "./stored-corpus-construction-training.js";
import type { DialogueCorpusTrainReport } from "./dialogue-corpus.js";

export type DialogueSourceBrainReport = Pick<DialogueCorpusTrainReport, "rootPath" | "sourceSystem" | "authorship" | "startFileIndex"
  | "filesTrained" | "filesSkipped" | "reports" | "stoppedByHeapSafetyBound" | "selection">;

export interface SourceBrainSelectedItem {
  /** Stable raw source-version identity; one raw source may produce several trained projections. */
  sourceVersionId: string;
  /** SHA-256 of the exact source bytes bound by the trainer. */
  contentHash: string;
  byteLength: number;
}

export interface SourceBrainBuildInput {
  storage: ScceStorage;
  informationLabel: InformationLabel;
  sourceId: string;
  sourceSchema: string;
  rootPath: string;
  sourceManifestHash: string;
  /** Complete, explicitly bounded owner selection, in deterministic order or any order (canonicalized internally). */
  selectedItems: readonly SourceBrainSelectedItem[];
  /** All successful trainer reports for the selected inputs. */
  reports: readonly LanguageCorpusTrainingReport[];
  /** Exact completion envelope from the same trainer run, including required-item coverage and stop state. */
  completion: {
    explicitSelection: boolean;
    selectedItemIds: readonly string[];
    completedItemIds: readonly string[];
    stoppedByHeapSafetyBound: boolean;
    interrupted: boolean;
    skippedRequiredItemIds: readonly string[];
  };
  configuration?: unknown;
  now?: number;
  activate?: boolean;
}

export interface SourceBrainBuildResult {
  lifecycle: BrainLifecycleRecord;
  report: BrainValidationReport;
  replayManifestHash: string;
  active: boolean;
  activeBrainVersion?: string;
  idempotent: boolean;
}

export interface SourceBrainBuildReceipt {
  status: "activated" | "ready" | "validation_failed" | "existing_active";
  importRunId?: string;
  brainVersion?: string;
  lifecycleState?: BrainLifecycleRecord["state"];
  activeBrainVersion?: string;
  active: boolean;
  idempotent: boolean;
  replayManifestHash?: string;
  validationDisposition?: BrainValidationReport["disposition"];
  checks: Array<{ id: string; passed: boolean }>;
}

export function sourceBrainBuildReceipt(result: SourceBrainBuildResult): SourceBrainBuildReceipt {
  return {
    status: result.active ? "activated" : result.activeBrainVersion ? "existing_active" : result.lifecycle.state === "READY" ? "ready" : "validation_failed",
    importRunId: result.lifecycle.importRunId,
    brainVersion: result.lifecycle.brainVersion,
    lifecycleState: result.lifecycle.state,
    ...(result.active ? { activeBrainVersion: result.lifecycle.brainVersion } : {}),
    ...(!result.active && result.activeBrainVersion ? { activeBrainVersion: result.activeBrainVersion } : {}),
    active: result.active,
    idempotent: result.idempotent,
    replayManifestHash: result.replayManifestHash,
    validationDisposition: result.report.disposition,
    checks: result.report.checks.map(check => ({ id: check.id, passed: check.passed }))
  };
}

export function sourceBrainBuildExistingActiveReceipt(active: { activeBrainVersion?: string; activeImportRunIds: string[] }): SourceBrainBuildReceipt {
  return {
    status: "existing_active",
    ...(active.activeBrainVersion ? { activeBrainVersion: active.activeBrainVersion } : {}),
    active: Boolean(active.activeBrainVersion && active.activeImportRunIds.length),
    idempotent: false,
    checks: []
  };
}

export async function completeInitialSourceBrainFromDialogueReport(input: {
  storage: ScceStorage;
  informationLabel: InformationLabel;
  report: DialogueSourceBrainReport;
  configuration?: unknown;
  now?: number;
}): Promise<SourceBrainBuildResult | SourceBrainBuildReceipt> {
  const selection = input.report.selection;
  if (input.report.authorship !== "human_authored" || !selection?.languageTrainingComplete
    || !selection.selectedSourceUris.length || input.report.stoppedByHeapSafetyBound || input.report.filesSkipped.length
    || new Set(selection.selectedSourceUris).size !== selection.selectedSourceUris.length
    || new Set(selection.completedSourceUris).size !== selection.completedSourceUris.length
    || !sameStrings([...selection.selectedSourceUris].sort(compare), [...selection.completedSourceUris].sort(compare))
    || selection.completedSourceUris.length !== input.report.reports.length || input.report.filesTrained !== input.report.reports.length
    || input.report.reports.some(report => report.sourceSystemId !== input.report.sourceSystem)) {
    throw new Error("initial dialogue brain requires a complete explicit human-authored language-training selection");
  }
  const selectedItems = sourceBrainSelectedItemsFromReports(input.report.reports);
  const selectedIds = selectedItems.map(item => item.sourceVersionId);
  const sourceId = `dialogue:${input.report.rootPath}`;
  const configuration = input.configuration ?? { startFileIndex: input.report.startFileIndex, selectedSourceUris: selection.selectedSourceUris };
  try {
    return await completeInitialSourceBrainBuild({ storage: input.storage, informationLabel: input.informationLabel,
      sourceId, sourceSchema: "scce.dialogue.corpus.v1", rootPath: input.report.rootPath,
      sourceManifestHash: sourceBrainInputManifestHash({ sourceId, sourceSchema: "scce.dialogue.corpus.v1", selectedItems, configuration }),
      selectedItems, reports: input.report.reports, configuration, now: input.now,
      completion: { explicitSelection: true, selectedItemIds: selectedIds, completedItemIds: selectedIds,
        stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] } });
  } catch (error) {
    if (error instanceof Error && error.message.includes("refuses to replace an existing active brain")) {
      return sourceBrainBuildExistingActiveReceipt(await input.storage.brainImports.active());
    }
    throw error;
  }
}

/** Activate the exact successful raw inputs in one local OSS trainer report. */
export async function completeInitialSourceBrainFromOssReport(input: {
  storage: ScceStorage;
  informationLabel: InformationLabel;
  report: OssCorpusTrainReport;
  sourceId?: string;
  sourceSchema?: string;
  rootPath?: string;
  configuration?: unknown;
  sourceManifestHash?: string;
  now?: number;
}): Promise<SourceBrainBuildResult | SourceBrainBuildReceipt> {
  const selectedItems = sourceBrainSelectedItemsFromReports(input.report.reports);
  const failedItems = input.report.filesSkipped.filter(item => item.reason.startsWith("training_failed:"));
  const selectedIds = selectedItems.map(item => item.sourceVersionId);
  try { return await completeInitialSourceBrainBuild({
    storage: input.storage,
    informationLabel: input.informationLabel,
    sourceId: input.sourceId ?? `oss-local:${input.report.rootPath}`,
    sourceSchema: input.sourceSchema ?? "scce.oss.corpus.v1",
    rootPath: input.rootPath ?? input.report.rootPath,
    sourceManifestHash: input.sourceManifestHash ?? input.report.snapshotHash,
    selectedItems,
    reports: input.report.reports,
    completion: {
      explicitSelection: selectedItems.length > 0,
      selectedItemIds: selectedIds,
      completedItemIds: selectedIds,
      stoppedByHeapSafetyBound: input.report.stoppedByHeapSafetyBound,
      interrupted: !input.report.snapshotComplete || input.report.inspectionTruncated || failedItems.length > 0
        || input.report.nextFileIndex < input.report.startFileIndex + input.report.filesConsidered,
      skippedRequiredItemIds: failedItems.map(item => item.path)
    },
    configuration: input.configuration ?? {
      snapshotKind: input.report.snapshotKind,
      startFileIndex: input.report.startFileIndex,
      nextFileIndex: input.report.nextFileIndex,
      filesConsidered: input.report.filesConsidered
    },
    now: input.now
  }); } catch (error) {
    if (error instanceof Error && error.message.includes("refuses to replace an existing active brain")) {
      return sourceBrainBuildExistingActiveReceipt(await input.storage.brainImports.active());
    }
    throw error;
  }
}

/** Activate Gutenberg only when all discovered entries in this bounded run were trained. */
export async function completeInitialSourceBrainFromGutenbergReport(input: {
  storage: ScceStorage;
  informationLabel: InformationLabel;
  report: GutenbergCorpusTrainReport;
  configuration?: unknown;
  now?: number;
}): Promise<SourceBrainBuildResult | SourceBrainBuildReceipt> {
  const selectedItems = sourceBrainSelectedItemsFromReports(input.report.reports);
  const selectedIds = selectedItems.map(item => item.sourceVersionId);
  const configuration = input.configuration ?? {
    startFileIndex: input.report.startFileIndex,
    maxFilesTrained: input.report.filesTrained,
    sourceSystem: input.report.sourceSystem
  };
  try { return await completeInitialSourceBrainBuild({
    storage: input.storage,
    informationLabel: input.informationLabel,
    sourceId: `gutenberg:${input.report.rootPath}`,
    sourceSchema: "scce.gutenberg.corpus.v1",
    rootPath: input.report.rootPath,
    sourceManifestHash: sourceBrainInputManifestHash({ sourceId: `gutenberg:${input.report.rootPath}`, sourceSchema: "scce.gutenberg.corpus.v1", selectedItems, configuration }),
    selectedItems,
    reports: input.report.reports,
    completion: {
      explicitSelection: selectedItems.length > 0,
      selectedItemIds: selectedIds,
      completedItemIds: selectedIds,
      stoppedByHeapSafetyBound: input.report.stoppedByHeapSafetyBound,
      interrupted: input.report.filesSkipped.length > 0,
      skippedRequiredItemIds: input.report.filesSkipped.map(item => item.path)
    },
    configuration,
    now: input.now
  }); } catch (error) {
    if (error instanceof Error && error.message.includes("refuses to replace an existing active brain")) {
      return sourceBrainBuildExistingActiveReceipt(await input.storage.brainImports.active());
    }
    throw error;
  }
}

/** Collapse code/prose projections back to the exact raw files they came from. */
export function sourceBrainSelectedItemsFromReports(reports: readonly LanguageCorpusTrainingReport[]): SourceBrainSelectedItem[] {
  const bySource = new Map<string, SourceBrainSelectedItem>();
  for (const report of reports) {
    const sourceVersionId = report.originalSourceVersionId || report.sourceVersionId;
    const item: SourceBrainSelectedItem = { sourceVersionId, contentHash: report.sourceContentHash, byteLength: report.sourceByteLength };
    const existing = bySource.get(sourceVersionId);
    if (existing && (normalizeContentHash(existing.contentHash) !== normalizeContentHash(item.contentHash) || existing.byteLength !== item.byteLength)) {
      throw new Error(`trainer projections disagree on raw source bytes: ${sourceVersionId}`);
    }
    bySource.set(sourceVersionId, item);
  }
  return [...bySource.values()].sort((a, b) => compare(a.sourceVersionId, b.sourceVersionId));
}

/** Deterministic manifest digest for bounded sources without a publisher-supplied manifest hash. */
export function sourceBrainInputManifestHash(input: {
  sourceId: string;
  sourceSchema: string;
  selectedItems: readonly SourceBrainSelectedItem[];
  configuration?: unknown;
}): string {
  return createHasher().digestHex(canonicalStringify(toJsonValue({
    schema: "scce.sourceBrainInputManifest.v1",
    sourceId: input.sourceId,
    sourceSchema: input.sourceSchema,
    selectedItems: [...input.selectedItems].sort((a, b) => compare(a.sourceVersionId, b.sourceVersionId)),
    configuration: input.configuration ?? {}
  })));
}

export async function completeInitialSourceBrainFromStoredReport(input: {
  storage: ScceStorage; informationLabel: InformationLabel; report: StoredCorpusConstructionTrainingReport; configuration?: unknown;
}): Promise<SourceBrainBuildResult> {
  const selection = input.report.selection;
  if (!selection?.languageTrainingComplete || !input.report.exhausted || input.report.stoppedByHeapSafetyBound
    || input.report.stoppedByStorageFailure || input.report.stoppedByInterruption || input.report.sourcesSkipped.length || input.report.batchesFailed.length
    || input.report.startBatchIndex !== 0 || input.report.startSourceVersionId !== null
    || !sameStrings([...selection.selectedSourceVersionIds].sort(compare), input.report.reports.map(report => report.sourceVersionId).sort(compare)))
    throw new Error("initial stored source brain requires a complete explicit language-training selection");
  const selectedItems = sourceBrainSelectedItemsFromReports(input.report.reports), sourceId = `stored:${input.report.sourceSystem}`;
  const ids = selectedItems.map(item => item.sourceVersionId);
  return completeInitialSourceBrainBuild({ storage: input.storage, informationLabel: input.informationLabel, sourceId,
    sourceSchema: input.report.schema, rootPath: sourceId,
    sourceManifestHash: sourceBrainInputManifestHash({ sourceId, sourceSchema: input.report.schema, selectedItems, configuration: input.configuration }),
    selectedItems, reports: input.report.reports, configuration: input.configuration,
    completion: { explicitSelection: true, selectedItemIds: ids, completedItemIds: ids, stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] } });
}

export interface SourceBrainPlannedProjection {
  sourceSystemId: string;
  projection?: string;
  transformId?: string;
  originalSourceVersionId?: string;
  sourceVersionId?: string;
}

export interface StoredSourceBrainPlan {
  schema: "scce.storedSourceBrainPlan.v1";
  sourceId: string;
  rootPath: string;
  selectedItems: Array<Omit<SourceBrainSelectedItem, "sourceVersionId"> & { sourceVersionId?: string; canonicalUri: string; sourceFileHash?: string; projections?: SourceBrainPlannedProjection[] }>;
  reportFiles: Array<{ path: string; sha256?: string }>;
}

/** Validate the explicit cohort independently of any completed report subset. */
export function validateStoredSourceBrainPlan(value: unknown, complete = false): StoredSourceBrainPlan {
  const plan = objectRecord(value);
  if (plan.schema !== "scce.storedSourceBrainPlan.v1" || typeof plan.sourceId !== "string" || !plan.sourceId.trim()
    || typeof plan.rootPath !== "string" || !plan.rootPath.trim() || !Array.isArray(plan.selectedItems) || !plan.selectedItems.length
    || !Array.isArray(plan.reportFiles) || !plan.reportFiles.length) throw new Error("invalid explicit stored source brain manifest");
  const selectedItems = plan.selectedItems.map(value => {
    const row = objectRecord(value);
    if ((row.sourceVersionId !== undefined && (typeof row.sourceVersionId !== "string" || !row.sourceVersionId)) || (row.sourceVersionId === undefined && typeof row.sourceFileHash !== "string") || typeof row.canonicalUri !== "string" || !row.canonicalUri
      || typeof row.contentHash !== "string" || !/^(?:sha256_)?[a-f0-9]{64}$/iu.test(row.contentHash)
      || typeof row.byteLength !== "number" || !Number.isSafeInteger(row.byteLength) || row.byteLength <= 0
      || (row.sourceFileHash !== undefined && (typeof row.sourceFileHash !== "string" || !/^[a-f0-9]{64}$/iu.test(row.sourceFileHash))))
      throw new Error("invalid planned source file/owner binding");
    const projections = row.projections === undefined ? undefined : parsePlannedProjections(row.projections);
    return { ...(typeof row.sourceVersionId === "string" ? { sourceVersionId: row.sourceVersionId } : {}), canonicalUri: row.canonicalUri, contentHash: row.contentHash, byteLength: row.byteLength,
      ...(typeof row.sourceFileHash === "string" ? { sourceFileHash: row.sourceFileHash.toLowerCase() } : {}), ...(projections ? { projections } : {}) };
  });
  const reportFiles = plan.reportFiles.map(value => {
    const row = objectRecord(value);
    if (typeof row.path !== "string" || !row.path || ((complete || row.sha256 !== undefined)
      && (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(row.sha256)))) throw new Error("invalid planned report file/hash binding");
    return { path: row.path, ...(typeof row.sha256 === "string" ? { sha256: row.sha256.toLowerCase() } : {}) };
  });
  if (new Set(selectedItems.flatMap(item => item.sourceVersionId ? [item.sourceVersionId] : [])).size !== selectedItems.filter(item => item.sourceVersionId).length
    || new Set(selectedItems.map(item => item.canonicalUri)).size !== selectedItems.length
    || new Set(reportFiles.map(item => item.path)).size !== reportFiles.length) throw new Error("duplicate source owner/file or report in brain manifest");
  return { schema: "scce.storedSourceBrainPlan.v1", sourceId: plan.sourceId, rootPath: plan.rootPath, selectedItems, reportFiles };
}

export async function completeInitialSourceBrainFromStoredReports(input: {
  storage: ScceStorage; informationLabel: InformationLabel; plan: StoredSourceBrainPlan;
  reports: readonly unknown[]; sourceManifestHash: string; now?: number; configuration?: unknown;
}): Promise<SourceBrainBuildResult> {
  const plan = validateStoredSourceBrainPlan(input.plan, true);
  if (input.reports.length !== plan.reportFiles.length) throw new Error("brain manifest requires every planned report file");
  const reports: LanguageCorpusTrainingReport[] = [];
  const canonicalInputs = new Map<string, SourceVersion>();
  const declaredAcquisitions = new Map<string, unknown>();
  for (const value of input.reports) {
    const report = await sourceBrainNormalTrainingReport(value), selection = objectRecord(report.selection);
    if (!Array.isArray(report.reports) || !report.reports.every(isLanguageTrainingReport)) throw new Error("invalid completed source training report");
    if (report.schema === "scce.dialogueCorpusTrainReport.v1") {
      const selected = stringArray(selection.selectedSourceUris), completed = stringArray(selection.completedSourceUris);
      if (report.authorship !== "human_authored" || selection.languageTrainingComplete !== true || !selected.length
        || new Set(selected).size !== selected.length || new Set(completed).size !== completed.length
        || !sameStrings([...selected].sort(compare), [...completed].sort(compare))
        || report.stoppedByHeapSafetyBound !== false || !Array.isArray(report.filesSkipped) || report.filesSkipped.length
        || report.filesTrained !== report.reports.length || completed.length !== report.reports.length
        || report.reports.some(row => row.sourceSystemId !== report.sourceSystem))
        throw new Error("brain manifest requires a complete human dialogue report");
      if (!input.storage.evidence.sourceVersionById) throw new Error("brain finalization requires canonical source identity reads");
      const actualUris: string[] = [];
      for (const row of report.reports) {
        const id = row.originalSourceVersionId || row.sourceVersionId;
        const source = await input.storage.evidence.sourceVersionById(id as SourceVersionId);
        if (!source) throw new Error("completed dialogue report has no accessible canonical source");
        canonicalInputs.set(id, source); actualUris.push(source.canonicalUri);
      }
      if (!sameStrings(actualUris.sort(compare), [...completed].sort(compare))) throw new Error("completed dialogue file selection differs from canonical source owners");
    } else if (report.schema === "scce.storedCorpusConstructionTrainReport.v1") {
      const selected = stringArray(selection.selectedSourceVersionIds), completed = stringArray(selection.completedSourceVersionIds);
      if (selection.schema !== "scce.storedCorpusSourceSelection.v1" || selection.languageTrainingComplete !== true || !selected.length
        || new Set(selected).size !== selected.length || new Set(completed).size !== completed.length
        || !sameStrings([...selected].sort(compare), [...completed].sort(compare))
        || !sameStrings([...completed].sort(compare), report.reports.map(row => row.sourceVersionId).sort(compare))
        || report.exhausted !== true || report.startBatchIndex !== 0 || report.startSourceVersionId !== null
        || report.stoppedByHeapSafetyBound !== false || report.stoppedByStorageFailure !== false || report.stoppedByInterruption !== false
        || !Array.isArray(report.sourcesSkipped) || report.sourcesSkipped.length || !Array.isArray(report.batchesFailed) || report.batchesFailed.length)
        throw new Error("brain manifest requires a complete stored-source report");
    } else if (report.schema === "scce.ossCorpusTrainReport.v1") {
      const skipped = Array.isArray(report.filesSkipped) ? report.filesSkipped.map(objectRecord) : undefined;
      const closure = objectRecord(report.sourceContractClosure);
      if (!skipped || report.snapshotComplete !== true || report.inspectionTruncated !== false || report.stoppedByHeapSafetyBound !== false
        || typeof report.snapshotHash !== "string" || !/^[a-f0-9]{64}$/iu.test(report.snapshotHash)
        || !Number.isSafeInteger(report.startFileIndex) || !Number.isSafeInteger(report.filesConsidered) || !Number.isSafeInteger(report.nextFileIndex)
        || Number(report.startFileIndex) < 0 || Number(report.filesConsidered) < 0
        || report.nextFileIndex !== Number(report.startFileIndex) + Number(report.filesConsidered)
        || skipped.some(row => typeof row.reason !== "string" || row.reason.startsWith("training_failed:"))
        || report.reports.some(row => row.sourceSystemId !== CORPUS_SOURCE_SYSTEM_IDS.ossCode && row.sourceSystemId !== CORPUS_SOURCE_SYSTEM_IDS.ossDocs)
        || report.docsTrained !== report.reports.filter(row => row.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs).length
        || report.codeTrained !== report.reports.filter(row => row.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode).length
        || (report.sourceContractClosure !== undefined && (closure.complete !== true || closure.incompleteInRound !== 0)))
        throw new Error("brain manifest requires complete normal OSS training reports");
      if (report.acquisitionProvenance !== undefined) for (const row of report.reports) declaredAcquisitions.set(row.sourceVersionId, report.acquisitionProvenance);
    } else if (report.schema === "scce.gutenbergCorpusTrainReport.v1") {
      if (report.stoppedByHeapSafetyBound !== false || !Array.isArray(report.filesSkipped) || report.filesSkipped.length
        || report.filesTrained !== report.reports.length || !Number.isSafeInteger(report.startFileIndex) || Number(report.startFileIndex) < 0
        || report.sourceSystem !== CORPUS_SOURCE_SYSTEM_IDS.gutenberg || report.reports.some(row => row.sourceSystemId !== report.sourceSystem))
        throw new Error("brain manifest requires complete normal Gutenberg training reports");
    } else throw new Error("unsupported source brain report schema");
    reports.push(...report.reports);
  }
  const selected = sourceBrainSelectedItemsFromReports(reports);
  if (!input.storage.evidence.sourceVersionById) throw new Error("brain finalization requires canonical source identity reads");
  const byUri = new Map<string, Array<{ report: LanguageCorpusTrainingReport; original: SourceVersion; source: SourceVersion }>>();
  for (const report of reports) {
    const originalId = report.originalSourceVersionId || report.sourceVersionId;
    const original = canonicalInputs.get(originalId) ?? await input.storage.evidence.sourceVersionById(originalId as SourceVersionId);
    const source = await input.storage.evidence.sourceVersionById(report.sourceVersionId as SourceVersionId);
    if (!original || !source || !sourceProjectionParentMatches(source, originalId, report.sourceVersionId))
      throw new Error("completed training projection lacks its exact canonical source/parent");
    if (declaredAcquisitions.has(report.sourceVersionId)) {
      const acquisition = canonicalStringify(toJsonValue(declaredAcquisitions.get(report.sourceVersionId)));
      if (canonicalStringify(toJsonValue(objectRecord(original.metadata).acquisitionProvenance)) !== acquisition
        || canonicalStringify(toJsonValue(objectRecord(source.metadata).acquisitionProvenance)) !== acquisition)
        throw new Error("completed OSS acquisition provenance differs from canonical source owners");
    }
    canonicalInputs.set(originalId, original);
    const group = byUri.get(original.canonicalUri) ?? []; group.push({ report, original, source }); byUri.set(original.canonicalUri, group);
  }
  if (byUri.size !== plan.selectedItems.length) throw new Error("completed reports do not cover the entire planned brain cohort exactly");
  for (const item of plan.selectedItems) {
    const group = byUri.get(item.canonicalUri);
    if (!group?.length) throw new Error("completed reports omit planned brain source files");
    const originalIds = new Set(group.map(row => String(row.original.sourceVersionId)));
    if ((item.sourceVersionId !== undefined && (originalIds.size !== 1 || !originalIds.has(item.sourceVersionId)))
      || group.some(({ report, original }) => normalizeContentHash(String(original.contentHash)) !== normalizeContentHash(item.contentHash)
        || original.byteLength !== item.byteLength || normalizeContentHash(report.sourceContentHash) !== normalizeContentHash(item.contentHash)
        || report.sourceByteLength !== item.byteLength || (item.sourceFileHash !== undefined
          && normalizeContentHash(String(objectRecord(original.metadata).sourceHash)) !== item.sourceFileHash)))
      throw new Error(`planned source owner/file binding does not match canonical source: ${item.canonicalUri}`);
    const human = group.some(row => row.report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue);
    if (human && (!item.sourceFileHash || group.some(row => objectRecord(row.original.metadata).authorship !== "human_authored")))
      throw new Error("human dialogue plan requires the exact original file hash and authorship");
    const projectedCorpus = group.some(row => new Set<string>([CORPUS_SOURCE_SYSTEM_IDS.ossCode, CORPUS_SOURCE_SYSTEM_IDS.ossDocs, CORPUS_SOURCE_SYSTEM_IDS.gutenberg]).has(row.report.sourceSystemId));
    if (projectedCorpus && !item.sourceFileHash) throw new Error("projected source file requires its exact original file hash");
    if (!item.projections) {
      if (group.length !== 1 || originalIds.size !== 1 || projectedCorpus) throw new Error("planned physical file requires its complete explicit projection declarations");
    } else {
      if (item.projections.length !== group.length) throw new Error("completed reports omit or duplicate a planned file projection");
      const matched = new Set<number>();
      for (const expected of item.projections) {
        const matches = group.flatMap((row, index) => {
          const metadata = objectRecord(row.source.metadata);
          return row.report.sourceSystemId === expected.sourceSystemId && metadata.sourceSystemId === expected.sourceSystemId
            && (expected.projection === undefined || metadata.projection === expected.projection)
            && (expected.transformId === undefined || row.source.derivation?.transformId === expected.transformId)
            && (expected.originalSourceVersionId === undefined || String(row.original.sourceVersionId) === expected.originalSourceVersionId)
            && (expected.sourceVersionId === undefined || String(row.source.sourceVersionId) === expected.sourceVersionId) ? [index] : [];
        });
        if (matches.length !== 1 || matched.has(matches[0]!)) throw new Error("planned projection is ambiguous, foreign, changed, or missing");
        matched.add(matches[0]!);
      }
    }
  }
  const ids = selected.map(item => item.sourceVersionId);
  return completeInitialSourceBrainBuild({ storage: input.storage, informationLabel: input.informationLabel, sourceId: plan.sourceId,
    sourceSchema: plan.schema, rootPath: plan.rootPath, sourceManifestHash: input.sourceManifestHash, selectedItems: selected,
    reports, configuration: input.configuration, now: input.now, completion: { explicitSelection: true, selectedItemIds: ids,
      completedItemIds: ids, stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] } });
}

function parsePlannedProjections(value: unknown): SourceBrainPlannedProjection[] {
  if (!Array.isArray(value) || !value.length) throw new Error("planned file projections must be nonempty");
  const rows = value.map(value => {
    const row = objectRecord(value);
    if (Object.keys(row).some(key => !["sourceSystemId", "projection", "transformId", "originalSourceVersionId", "sourceVersionId"].includes(key))
      || typeof row.sourceSystemId !== "string" || !row.sourceSystemId || (row.projection === undefined && row.transformId === undefined)
      || ["projection", "transformId", "originalSourceVersionId", "sourceVersionId"].some(key => row[key] !== undefined && (typeof row[key] !== "string" || !row[key])))
      throw new Error("invalid planned source projection");
    return { sourceSystemId: row.sourceSystemId,
      ...(typeof row.projection === "string" ? { projection: row.projection } : {}), ...(typeof row.transformId === "string" ? { transformId: row.transformId } : {}),
      ...(typeof row.originalSourceVersionId === "string" ? { originalSourceVersionId: row.originalSourceVersionId } : {}),
      ...(typeof row.sourceVersionId === "string" ? { sourceVersionId: row.sourceVersionId } : {}) };
  });
  if (new Set(rows.map(row => canonicalStringify(toJsonValue(row)))).size !== rows.length) throw new Error("duplicate planned file projection");
  return rows;
}

async function sourceBrainNormalTrainingReport(value: unknown): Promise<Record<string, unknown>> {
  const report = objectRecord(value);
  if (report.schema !== "scce.githubOssAcquisition.v1") return report;
  const provenance = objectRecord(report.provenance), training = objectRecord(report.training), acquisition = objectRecord(training.acquisitionProvenance);
  if (typeof report.commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(report.commitSha) || typeof report.remoteUrl !== "string"
    || provenance.commitSha !== report.commitSha || provenance.remoteUrl !== report.remoteUrl || !Array.isArray(report.files)
    || training.schema !== "scce.ossCorpusTrainReport.v1" || training.snapshotKind !== "git_snapshot"
    || training.snapshotHash !== provenance.snapshotHash || acquisition.commitSha !== report.commitSha || acquisition.remoteUrl !== report.remoteUrl
    || acquisition.snapshotHash !== provenance.snapshotHash) throw new Error("brain manifest requires an exact pinned GitHub acquisition/training report");
  const files = report.files.map(value => { const row = objectRecord(value);
    if (typeof row.path !== "string" || !row.path || typeof row.contentHash !== "string" || !/^[a-f0-9]{64}$/iu.test(row.contentHash)
      || typeof row.byteLength !== "number" || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0) throw new Error("invalid GitHub snapshot file binding");
    return { path: row.path, contentHash: row.contentHash, byteLength: row.byteLength }; });
  const { ingestMaterialSnapshot } = await import("./oss-corpus.js");
  const snapshot = ingestMaterialSnapshot(files);
  if (new Set(files.map(file => file.path)).size !== files.length || snapshot.snapshotHash !== provenance.snapshotHash
    || canonicalStringify(toJsonValue(snapshot.fileHashes)) !== canonicalStringify(toJsonValue(provenance.fileHashes))
    || files.reduce((sum, file) => sum + file.byteLength, 0) !== report.totalBytes) throw new Error("GitHub snapshot inventory differs from completed training provenance");
  return training;
}

function sourceProjectionParentMatches(source: SourceVersion, originalId: string, sourceVersionId: string): boolean {
  return String(source.sourceVersionId) === sourceVersionId && (originalId === sourceVersionId
    || (source.role === "evidence-derivative" && source.derivation !== undefined && String(source.derivation.derivedFromSourceVersionId) === originalId));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringArray(value: unknown): string[] { return Array.isArray(value) && value.every(item => typeof item === "string") ? value : []; }
function isLanguageTrainingReport(value: unknown): value is LanguageCorpusTrainingReport {
  const row = objectRecord(value), artifacts = objectRecord(row.artifacts);
  return row.schema === "scce.languageCorpusTrainingReport.v1" && typeof row.sourceVersionId === "string" && typeof row.originalSourceVersionId === "string"
    && typeof row.sourceContentHash === "string" && typeof row.sourceByteLength === "number" && typeof row.sourceSystemId === "string"
    && typeof row.sourceSystem === "string" && typeof row.streamUri === "string" && typeof artifacts.languageProfileId === "string"
    && Array.isArray(artifacts.evidenceIds) && artifacts.evidenceIds.every(item => typeof item === "string")
    && Array.isArray(artifacts.ngramModelIds) && artifacts.ngramModelIds.every(item => typeof item === "string")
    && [row.languageProfiles, row.ngramModels, row.evidence].every(value => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/**
 * Finalize one explicit, completed source selection as the owner's first active brain.
 * The trainer remains responsible for its durable per-document checkpoints; this function
 * verifies those committed outputs and refuses incomplete or replaced-source material.
 */
export async function completeInitialSourceBrainBuild(input: SourceBrainBuildInput): Promise<SourceBrainBuildResult> {
  const now = input.now ?? Date.now();
  const hasher = createHasher();
  const configuration = sanitizeSourceBrainBuildConfiguration(input.configuration ?? {});
  const selected = [...input.selectedItems].sort((a, b) => compare(a.sourceVersionId, b.sourceVersionId));
  if (!selected.length) throw new Error("source brain build requires an explicit nonempty source selection");
  if (new Set(selected.map(item => item.sourceVersionId)).size !== selected.length) throw new Error("source brain selection contains duplicate source-version identities");
  for (const item of selected) {
    if (!item.sourceVersionId || !/^(?:sha256_)?[a-f0-9]{64}$/iu.test(item.contentHash) || !Number.isSafeInteger(item.byteLength) || item.byteLength <= 0) {
      throw new Error(`source brain selection has invalid source identity or byte binding: ${item.sourceVersionId || "(empty)"}`);
    }
  }
  const reports = [...input.reports].sort((a, b) => compare(a.originalSourceVersionId, b.originalSourceVersionId) || compare(a.sourceVersionId, b.sourceVersionId));
  if (new Set(reports.map(report => report.sourceVersionId)).size !== reports.length) throw new Error("source brain reports contain duplicate trained source-version identities");
  const selectedById = new Map(selected.map(item => [item.sourceVersionId, item]));
  const reportsByInput = new Map<string, LanguageCorpusTrainingReport[]>();
  for (const report of reports) {
    const inputSourceVersionId = report.originalSourceVersionId || report.sourceVersionId;
    if (!selectedById.has(inputSourceVersionId)) throw new Error(`source brain report references an unselected raw source: ${inputSourceVersionId}`);
    const group = reportsByInput.get(inputSourceVersionId) ?? [];
    group.push(report);
    reportsByInput.set(inputSourceVersionId, group);
  }
  if (!reports.length || selected.some(item => !reportsByInput.has(item.sourceVersionId))) {
    throw new Error("source brain reports do not cover every selected raw source version");
  }
  const expectedItemIds = selected.map(item => item.sourceVersionId);
  const selectedItemIds = [...input.completion.selectedItemIds].sort(compare);
  const completedItemIds = [...input.completion.completedItemIds].sort(compare);
  const completionMatchesSelection = input.completion.explicitSelection
    && sameStrings(expectedItemIds, selectedItemIds)
    && sameStrings(expectedItemIds, completedItemIds)
    && !input.completion.stoppedByHeapSafetyBound
    && !input.completion.interrupted
    && input.completion.skippedRequiredItemIds.length === 0;
  if (!completionMatchesSelection) throw new Error("source brain build cannot activate an incomplete, skipped, stopped, or implicit selection");
  for (const report of reports) {
    const item = selectedById.get(report.originalSourceVersionId || report.sourceVersionId)!;
    if (normalizeContentHash(item.contentHash) !== normalizeContentHash(report.sourceContentHash) || item.byteLength !== report.sourceByteLength) {
      throw new Error(`source brain report does not match selected source bytes: ${item.sourceVersionId}`);
    }
    if (report.languageProfiles !== 1 || report.ngramModels < 1 || report.ngramModels !== report.artifacts.ngramModelIds.length
      || new Set(report.artifacts.ngramModelIds).size !== report.artifacts.ngramModelIds.length || !report.artifacts.languageProfileId) {
      throw new Error(`source brain input has no persisted language profile/model output: ${item.sourceVersionId}`);
    }
    if (report.evidence < 1 || report.evidence !== report.artifacts.evidenceIds.length
      || new Set(report.artifacts.evidenceIds).size !== report.artifacts.evidenceIds.length) throw new Error(`source brain input has no evidence output: ${item.sourceVersionId}`);
  }

  const activeBefore = await input.storage.brainImports.active();
  const selectedDigest = hasher.digestHex(canonicalStringify(toJsonValue({
    sourceId: input.sourceId,
    sourceSchema: input.sourceSchema,
    sourceManifestHash: input.sourceManifestHash,
    selected,
    configuration
  })));
  const importRunId = `source_brain.${selectedDigest.slice(0, 40)}`;
  const brainVersion = `source_brain_v1_${selectedDigest.slice(0, 32)}`;
  const rootPath = input.rootPath.trim();
  if (!rootPath || !input.sourceId.trim() || !input.sourceSchema.trim() || !/^[a-f0-9]{64}$/iu.test(input.sourceManifestHash)) {
    throw new Error("source brain identity requires root, source, schema, and SHA-256 source manifest hash");
  }

  let existingActive: BrainLifecycleRecord | undefined;
  if (activeBefore.activeImportRunIds.length || activeBefore.activeBrainVersion) {
    if (activeBefore.activeImportRunIds.includes(importRunId) && activeBefore.activeBrainVersion === brainVersion) {
      const existing = await input.storage.brainImports.getLifecycle(importRunId);
      if (!existing || existing.state !== "ACTIVE" || existing.validation?.disposition !== "PASSED" || !existing.manifest.replayManifest) {
        throw new Error("active source brain marker does not match a validated lifecycle record");
      }
      existingActive = existing;
    } else throw new Error("initial source brain build refuses to replace an existing active brain");
  }

  const sourceVersionIds = selected.map(item => item.sourceVersionId);
  const trainedSourceVersionIds = [...new Set(reports.map(report => report.sourceVersionId))].sort(compare);
  const profileIds = [...new Set(reports.map(report => report.artifacts.languageProfileId))].sort(compare);
  const evidenceIds = [...new Set(reports.flatMap(report => report.artifacts.evidenceIds))].sort(compare);
  const ngramModelIds = [...new Set(reports.flatMap(report => report.artifacts.ngramModelIds))].sort(compare);
  let sourceBytesVerified = true;
  for (const item of selected) {
    const blobHash = normalizeContentHash(item.contentHash);
    const stored = await input.storage.blobs.exists((`sha256_${blobHash}`) as never);
    if (!stored) { sourceBytesVerified = false; break; }
    const bytes = await input.storage.blobs.get((`sha256_${blobHash}`) as never);
    if (bytes.byteLength !== item.byteLength || hasher.digestHex(bytes) !== blobHash) { sourceBytesVerified = false; break; }
  }
  const evidenceOwners = new Map<string, string>();
  const evidenceSourceIds = new Map<string, string>();
  let evidencePromoted = true;
  const versions = new Map<string, SourceVersion>();
  for (const page of workPages(evidenceIds)) {
    const rows = await input.storage.evidence.getEvidenceBatch(page as EvidenceId[]);
    for (const row of rows) if (page.includes(String(row.id))) {
      evidenceOwners.set(String(row.id), String(row.sourceVersionId)); evidenceSourceIds.set(String(row.id), String(row.sourceId));
      if (row.status !== "promoted") evidencePromoted = false;
    }
    for (const version of await input.storage.evidence.sourceVersionsForEvidence(page as EvidenceId[])) versions.set(String(version.sourceVersionId), version);
  }
  let rawSourceVersionsPersisted = Boolean(input.storage.evidence.sourceVersionsByContentHashes);
  for (const page of workPages(selected)) {
    const rows = await input.storage.evidence.sourceVersionsByContentHashes?.(page.map(item => (`sha256_${normalizeContentHash(item.contentHash)}`) as never)) ?? [];
    for (const version of rows) versions.set(String(version.sourceVersionId), version);
    rawSourceVersionsPersisted &&= page.every(item => rows.some(version => String(version.sourceVersionId) === item.sourceVersionId
      && normalizeContentHash(String(version.contentHash)) === normalizeContentHash(item.contentHash) && version.byteLength === item.byteLength));
  }
  const parentSourceVersionIds = new Set<string>();
  let sourceLineageVerified = true;
  for (const report of reports) {
    let version = versions.get(report.sourceVersionId);
    if (version) {
      const hash = normalizeContentHash(String(version.contentHash));
      if (!await input.storage.blobs.exists((`sha256_${hash}`) as never)) sourceLineageVerified = false;
      else {
        const bytes = await input.storage.blobs.get((`sha256_${hash}`) as never);
        if (bytes.byteLength !== version.byteLength || hasher.digestHex(bytes) !== hash) sourceLineageVerified = false;
      }
    }
    const seen = new Set<string>();
    while (version?.derivation) {
      const id = String(version.sourceVersionId), parentId = String(version.derivation.derivedFromSourceVersionId);
      if (seen.has(id) || !parentId || !input.storage.evidence.sourceVersionById) { sourceLineageVerified = false; break; }
      seen.add(id);
      const parent = await input.storage.evidence.sourceVersionById(parentId as SourceVersionId);
      if (!parent || version.role !== "evidence-derivative") { sourceLineageVerified = false; break; }
      const hash = normalizeContentHash(String(parent.contentHash));
      if (!await input.storage.blobs.exists((`sha256_${hash}`) as never)) { sourceLineageVerified = false; break; }
      const bytes = await input.storage.blobs.get((`sha256_${hash}`) as never);
      if (bytes.byteLength !== parent.byteLength || hasher.digestHex(bytes) !== hash) { sourceLineageVerified = false; break; }
      parentSourceVersionIds.add(parentId);
      versions.set(parentId, parent);
      version = parent;
    }
  }
  const profileHeaders = input.storage.model.listLanguageProfileHeaders;
  const modelHeaders = input.storage.languageMemory.listNgramModelHeaders;
  if (!profileHeaders || !modelHeaders) throw new Error("source brain completion requires exact owned artifact metadata reads");
  const profiles: LanguageProfileHeader[] = [];
  const persistedModels: NgramModelHeader[] = [];
  for (const page of workPages(profileIds)) profiles.push(...await profileHeaders({ profileIds: page, limit: page.length }));
  const modelOwner = new Map(reports.flatMap(report => report.artifacts.ngramModelIds.map(id => [id, report.artifacts.languageProfileId] as const)));
  for (const page of workPages(ngramModelIds)) persistedModels.push(...await modelHeaders({ modelIds: page,
    profileIds: [...new Set(page.map(id => modelOwner.get(id)!))], limit: page.length }));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const modelById = new Map(persistedModels.map(model => [model.id, model]));
  const persistedProfileIds = new Set(profileById.keys());
  const modelIds = new Set(modelById.keys());
  const expectedEvidenceVersions = new Set(trainedSourceVersionIds);
  const sourceVersionsPresent = evidencePromoted && evidenceOwners.size === evidenceIds.length
    && [...evidenceOwners.values()].every(id => expectedEvidenceVersions.has(id));
  const evidenceOwnedByReportSource = sourceLineageVerified && reports.every(report => {
    const version = versions.get(report.sourceVersionId);
    return report.artifacts.evidenceIds.length > 0
      && report.artifacts.evidenceIds.every(id => evidenceOwners.get(id) === report.sourceVersionId && evidenceSourceIds.get(id) === String(version?.sourceId))
      && version !== undefined && String(version.sourceVersionId) === report.sourceVersionId
      && sourceProjectionParentMatches(version, report.originalSourceVersionId || report.sourceVersionId, report.sourceVersionId);
  });
  const profilesMatchSourceVersions = reports.every(report => {
    const profile = profileById.get(report.artifacts.languageProfileId);
    return profile && (String(profile.sourceVersionId) === report.sourceVersionId || profile.parentSourceVersionIds?.includes(report.sourceVersionId as SourceVersionId));
  });
  const artifactsPersisted = profileIds.every(id => persistedProfileIds.has(id)) && profilesMatchSourceVersions
    && reports.every(report => report.artifacts.ngramModelIds.every(id => modelById.get(id)?.profileId === report.artifacts.languageProfileId));

  const identityRuntime = createLanguageIdentityRuntime({
    store: input.storage.languageIdentities,
    hasher,
    now: () => now,
    informationLabel: input.informationLabel
  });
  let identityResult = await identityRuntime.ensure({ initializeIfMissing: true, requiredProfileIds: profileIds });
  const readAssignments = async () => {
    const rows: { profileId: string; languageId: string }[] = [];
    if (input.storage.languageIdentities) for (const page of workPages(profileIds)) rows.push(...await input.storage.languageIdentities.listProfileLanguages({ profileIds: page }));
    return rows;
  };
  let assignments = await readAssignments();
  const firstAssigned = new Set(assignments.map(row => row.profileId));
  if (input.storage.languageIdentities && profileIds.some(id => !firstAssigned.has(id))) {
    identityResult = await identityRuntime.ensure({ rebuild: true, requiredProfileIds: profileIds });
    assignments = await readAssignments();
  }
  const assignedProfiles = new Set(assignments.map(item => item.profileId));
  const persistedIdentities = input.storage.languageIdentities ? await input.storage.languageIdentities.listIdentities() : [];
  const persistedIdentityIds = new Set(persistedIdentities.map(identity => String(identity.id)));
  const selectedProfileIds = new Set(profileIds);
  const selectedAssignments = assignments.filter(item => selectedProfileIds.has(item.profileId));
  const identityReady = Boolean(input.storage.languageIdentities)
    && persistedIdentities.length > 0
    && profileIds.every(id => assignedProfiles.has(id))
    && selectedAssignments.length === profileIds.length
    && selectedAssignments.every(item => persistedIdentityIds.has(item.languageId))
    && identityResult.readiness === "ready";

  const parentBindings = [...parentSourceVersionIds].sort(compare).map(id => {
    const parent = versions.get(id)!;
    return { sourceId: parent.sourceId, sourceVersionId: id, contentHash: parent.contentHash, byteLength: parent.byteLength,
      ...(parent.role ? { role: parent.role } : {}), ...(parent.derivation ? { derivation: parent.derivation } : {}) };
  });
  const content = {
    graphShardCount: 0,
    languageShardCount: profileIds.length,
    ngramStateCount: ngramModelIds.length,
    priorSectionCount: 2
  } as const;
  const replayManifest = compileBrainReplayManifest({
    sourceSchema: input.sourceSchema,
    sourceManifestHash: input.sourceManifestHash,
    componentIds: [...sourceVersionIds, ...parentSourceVersionIds, ...parentBindings.map(parent => `${parent.sourceVersionId}:${parent.contentHash}:${parent.byteLength}`), ...trainedSourceVersionIds, ...profileIds, ...evidenceIds, ...ngramModelIds, ...persistedIdentityIds, ...selectedAssignments.map(item => `${item.profileId}->${item.languageId}`)].sort(compare),
    content,
    configuration: toJsonValue(configuration),
    hasher
  });
  const manifestHash = hasher.digestHex(canonicalStringify(toJsonValue({
    sourceId: input.sourceId,
    sourceSchema: input.sourceSchema,
    sourceManifestHash: input.sourceManifestHash,
    selected,
    replayManifestHash: replayManifest.byteHash,
    configuration
  })));
  const manifest: BrainManifestContract = {
    schema: "scce.brainManifestContract.v1",
    importRunId,
    brainVersion,
    rootPath,
    manifestHash,
    sourceId: input.sourceId,
    sourceSchema: input.sourceSchema,
    runtimeContractVersion: 1,
    content,
    replayManifest,
    metadata: toJsonValue({
      sourceBuild: true,
      selectedItems: selected,
      parentSourceVersionIds: [...parentSourceVersionIds].sort(compare),
      parentBindings,
      sourceManifestHash: input.sourceManifestHash,
      sourceManifestDigest: selectedDigest,
      configuration,
      persistedArtifacts: { profileIds, evidenceIds, ngramModelIds, languageIdentityIds: [...persistedIdentityIds].sort(compare), profileLanguageAssignments: selectedAssignments }
    }),
    createdAt: now
  };

  const checks = [
    ...validateBrainManifestContract(manifest),
    { id: "source.selection_complete", passed: completionMatchesSelection, severity: "error" as const, message: "explicit bounded source selection completed exactly, without heap stop, skip, or interruption", details: toJsonValue(input.completion) },
    { id: "source.inputs_match_reports", passed: selected.every(item => reportsByInput.has(item.sourceVersionId)) && reports.every(report => {
      const item = selectedById.get(report.originalSourceVersionId || report.sourceVersionId)!;
      return normalizeContentHash(report.sourceContentHash) === normalizeContentHash(item.contentHash) && report.sourceByteLength === item.byteLength;
    }), severity: "error" as const, message: "every selected raw source version has one or more matching completed trainer projections" },
    { id: "source.raw_bytes_persisted", passed: sourceBytesVerified, severity: "error" as const, message: "the exact selected source bytes are present under their content-addressed blob identities" },
    { id: "source.raw_version_persisted", passed: rawSourceVersionsPersisted, severity: "error" as const, message: "every selected raw source version is durably bound to its exact byte hash and length" },
    { id: "source.evidence_persisted", passed: sourceVersionsPresent && evidenceOwnedByReportSource, severity: "error" as const, message: "source evidence rows are durable and each trainer report's evidence belongs to that source version", details: toJsonValue({ expected: evidenceIds.length, observed: evidenceOwners.size, evidenceOwnedByReportSource }) },
    { id: "source.language_artifacts_persisted", passed: artifactsPersisted, severity: "error" as const, message: "all reported language profiles belong to their selected source versions and all n-gram models are durable", details: toJsonValue({ expectedProfiles: profileIds.length, observedProfiles: persistedProfileIds.size, profilesMatchSourceVersions, expectedModels: ngramModelIds.length, observedModels: modelIds.size }) },
    { id: "source.language_identity_ready", passed: identityReady, severity: "error" as const, message: "every selected language profile has a persisted assignment to a durable learned identity", details: toJsonValue({ identityCount: persistedIdentities.length, assignedProfileCount: selectedAssignments.length }) },
    { id: "source.no_existing_active_brain", passed: Boolean(existingActive) || (activeBefore.activeImportRunIds.length === 0 && !activeBefore.activeBrainVersion), severity: "error" as const, message: "initial source build did not replace an existing active brain" }
  ];
  const validation: BrainValidationReport = {
    schema: "scce.brainValidationReport.v1",
    importRunId,
    brainVersion,
    manifestHash,
    validatorVersion: "source-brain-build.v1",
    disposition: validationDisposition(checks),
    checks,
    validatedAt: now
  };

  if (existingActive) {
    if (validation.disposition !== "PASSED") throw new Error("active source brain no longer satisfies canonical source/artifact validation");
    if (existingActive.manifest.replayManifest?.byteHash !== replayManifest.byteHash) throw new Error("active source brain replay artifact identity changed");
    return { lifecycle: existingActive, report: validation, replayManifestHash: replayManifest.byteHash, active: true, idempotent: true };
  }
  let lifecycle = await input.storage.brainImports.getLifecycle(importRunId);
  if (!lifecycle) {
    await input.storage.brainImports.putLifecycle({ importRunId, brainVersion, rootPath, state: "CREATED", manifest, revision: 0, createdAt: now, updatedAt: now });
    lifecycle = await input.storage.brainImports.getLifecycle(importRunId);
  }
  if (!lifecycle || lifecycle.brainVersion !== brainVersion || lifecycle.manifest.manifestHash !== manifestHash) throw new Error("source brain lifecycle identity conflict");
  if (lifecycle.state === "CREATED" || lifecycle.state === "STOPPED" || lifecycle.state === "FAILED") {
    lifecycle = await input.storage.brainImports.transitionLifecycle({ importRunId, expectedState: lifecycle.state, toState: "IMPORTING", updatedAt: now, reason: "completed source selection registered" });
  }
  if (lifecycle.state === "IMPORTING") {
    for (const report of reports) {
      await input.storage.brainImports.putLedger({
        id: `source-build.${hasher.digestHex(`${importRunId}\n${report.sourceVersionId}`).slice(0, 40)}`,
        importRunId,
        brainVersion,
        rootPath,
        sectionId: report.sourceVersionId,
        sectionKind: "direct_evidence",
        forceClass: "direct_evidence",
        sourceVersionId: report.sourceVersionId as never,
        evidenceIds: report.artifacts.evidenceIds as never[],
        nodeIds: [],
        rowCounts: { evidence_spans: report.evidence, language_profiles: report.languageProfiles, ngram_models: report.ngramModels, ngram_observations: report.ngramObservations, language_units: report.languageUnits, language_patterns: report.languagePatterns, semantic_frames: report.semanticFrames },
        warnings: [],
        metadata: toJsonValue({ sourceContentHash: report.sourceContentHash, sourceSystem: report.sourceSystem, streamUri: report.streamUri, profileId: report.artifacts.languageProfileId, ngramModelIds: report.artifacts.ngramModelIds }),
        importedAt: now
      });
    }
    await input.storage.brainImports.putLedger({
      id: `source-build.${hasher.digestHex(`${importRunId}\ncomplete`).slice(0, 40)}`,
      importRunId, brainVersion, rootPath, sectionId: "__import_complete__", sectionKind: "manifest", forceClass: "learned_language_prior",
      fileHash: manifestHash, evidenceIds: [], nodeIds: [], rowCounts: {}, warnings: [],
      metadata: toJsonValue({ complete: true, selectedSourceVersionIds: sourceVersionIds, replayManifestHash: replayManifest.byteHash }), importedAt: now
    });
    lifecycle = await input.storage.brainImports.transitionLifecycle({ importRunId, expectedState: "IMPORTING", toState: "VALIDATING", updatedAt: now, reason: "selected source artifacts validated" });
  }
  if (lifecycle.state === "VALIDATING") {
    lifecycle = await input.storage.brainImports.transitionLifecycle({ importRunId, expectedState: "VALIDATING", toState: validation.disposition === "PASSED" ? "READY" : "FAILED", updatedAt: now, reason: validation.disposition === "PASSED" ? "source brain checks passed" : "source brain checks failed", validation });
  }
  if (lifecycle.state === "ACTIVE") return { lifecycle, report: lifecycle.validation ?? validation, replayManifestHash: replayManifest.byteHash, active: true, idempotent: true };
  if (lifecycle.state === "READY" && validation.disposition !== "PASSED") throw new Error("ready source brain no longer satisfies canonical source/artifact validation");
  if (lifecycle.state !== "READY") return { lifecycle, report: lifecycle.validation ?? validation, replayManifestHash: replayManifest.byteHash, active: false, idempotent: false };
  if (input.activate === false) return { lifecycle, report: validation, replayManifestHash: replayManifest.byteHash, active: false, idempotent: false };

  try {
    await input.storage.brainImports.activateReady({ brainVersion, importRunId, updatedAt: now, requireNoActive: true });
  } catch (error) {
    if (error instanceof Error && error.message.includes("no existing active brain")) {
      const ready = await input.storage.brainImports.getLifecycle(importRunId);
      if (ready) {
        const active = await input.storage.brainImports.active();
        return { lifecycle: ready, report: validation, replayManifestHash: replayManifest.byteHash, active: false, activeBrainVersion: active.activeBrainVersion, idempotent: false };
      }
    }
    throw error;
  }
  lifecycle = await input.storage.brainImports.getLifecycle(importRunId);
  if (!lifecycle || lifecycle.state !== "ACTIVE") throw new Error("source brain activation did not persist an ACTIVE lifecycle");
  return { lifecycle, report: validation, replayManifestHash: replayManifest.byteHash, active: true, idempotent: false };
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function normalizeContentHash(value: string): string { return value.replace(/^sha256_/iu, "").toLowerCase(); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

const SOURCE_BUILD_CONFIGURATION_KEYS = new Set([
  "bounds", "commitSha", "filesConsidered", "heapCheckpointMb", "includeDocs", "includeSource", "languageAliases",
  "maxDepth", "maxFileBytes", "maxFiles", "maxFilesPerRepo", "maxFilesPerRun", "maxTotalBytes", "ngramMaxCountersPerOrder",
  "ngramMaxOrder", "ngramVocabularyLimit", "nextFileIndex", "snapshotKind", "startFileIndex"
]);

/** Keep only source/training bounds in the durable manifest; runtime settings and credentials never belong here. */
export function sanitizeSourceBrainBuildConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSourceBrainBuildConfiguration);
  if (!value || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!SOURCE_BUILD_CONFIGURATION_KEYS.has(key)) continue;
    safe[key] = sanitizeSourceBrainBuildConfiguration(child);
  }
  return safe;
}

function* workPages<T>(items: readonly T[], pageSize = 512): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += pageSize) yield items.slice(offset, offset + pageSize);
}

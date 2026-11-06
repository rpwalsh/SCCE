// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  canonicalStringify,
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
  type ScceStorage
} from "@scce/kernel";
import type { LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";
import type { OssCorpusTrainReport } from "./oss-corpus.js";
import type { GutenbergCorpusTrainReport } from "./gutenberg-corpus.js";

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
  if (selected.length > 512) throw new Error("source brain build selection exceeds the bounded 512-item completion limit");
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
    if (report.languageProfiles < 1 || report.ngramModels < 1 || !report.artifacts.languageProfileId || !report.artifacts.ngramModelIds.length) {
      throw new Error(`source brain input has no persisted language profile/model output: ${item.sourceVersionId}`);
    }
    if (report.evidence < 1 || !report.artifacts.evidenceIds.length) throw new Error(`source brain input has no evidence output: ${item.sourceVersionId}`);
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

  if (activeBefore.activeImportRunIds.length || activeBefore.activeBrainVersion) {
    if (activeBefore.activeImportRunIds.includes(importRunId) && activeBefore.activeBrainVersion === brainVersion) {
      const existing = await input.storage.brainImports.getLifecycle(importRunId);
      if (!existing || existing.state !== "ACTIVE" || existing.validation?.disposition !== "PASSED" || !existing.manifest.replayManifest) {
        throw new Error("active source brain marker does not match a validated lifecycle record");
      }
      return { lifecycle: existing, report: existing.validation, replayManifestHash: existing.manifest.replayManifest.byteHash, active: true, idempotent: true };
    }
    throw new Error("initial source brain build refuses to replace an existing active brain");
  }

  const sourceVersionIds = selected.map(item => item.sourceVersionId);
  const trainedSourceVersionIds = [...new Set(reports.map(report => report.sourceVersionId))].sort(compare);
  const profileIds = reports.map(report => report.artifacts.languageProfileId);
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
  const versionsForEvidence = await input.storage.evidence.sourceVersionsForEvidence(evidenceIds as EvidenceId[]);
  const evidenceRows = await input.storage.evidence.getEvidenceBatch(evidenceIds as EvidenceId[]);
  const sourceVersionsByHash = input.storage.evidence.sourceVersionsByContentHashes
    ? await input.storage.evidence.sourceVersionsByContentHashes(selected.map(item => (`sha256_${normalizeContentHash(item.contentHash)}`) as never))
    : [];
  const rawSourceVersionsPersisted = Boolean(input.storage.evidence.sourceVersionsByContentHashes)
    && selected.every(item => sourceVersionsByHash.some(version => String(version.sourceVersionId) === item.sourceVersionId
      && normalizeContentHash(String(version.contentHash)) === normalizeContentHash(item.contentHash)
      && version.byteLength === item.byteLength));
  const profiles = await input.storage.model.listLanguageProfiles({ limit: Math.min(10_000, Math.max(100, profileIds.length * 2)), sourceVersionIds: trainedSourceVersionIds as SourceVersionId[] });
  const persistedModels = await input.storage.languageMemory.listNgramModels({ profileIds, limit: 10_000 });
  const modelIds = new Set(persistedModels.map(model => String(model.id)));
  const persistedProfileIds = new Set(profiles.map(profile => String(profile.id)));
  const expectedEvidenceVersions = new Set(trainedSourceVersionIds);
  const observedEvidenceVersions = new Set(versionsForEvidence.map(version => String(version.sourceVersionId)));
  const sourceVersionsPresent = evidenceRows.length === evidenceIds.length
    && evidenceRows.every(row => expectedEvidenceVersions.has(String(row.sourceVersionId)))
    && [...observedEvidenceVersions].every(id => expectedEvidenceVersions.has(id));
  const evidenceOwnedByReportSource = reports.every(report => {
    const reportEvidence = evidenceRows.filter(row => report.artifacts.evidenceIds.includes(String(row.id)));
    const reportVersions = versionsForEvidence.filter(version => report.artifacts.evidenceIds.some(id => {
      const row = evidenceRows.find(candidate => String(candidate.id) === id);
      return row && String(row.sourceVersionId) === String(version.sourceVersionId);
    }));
    return reportEvidence.length === report.artifacts.evidenceIds.length
      && reportEvidence.length > 0
      && reportEvidence.every(row => String(row.sourceVersionId) === report.sourceVersionId)
      && reportVersions.length > 0
      && reportVersions.every(version => String(version.sourceVersionId) === report.sourceVersionId
        && (!version.derivation || String(version.derivation.derivedFromSourceVersionId) === report.originalSourceVersionId));
  });
  const profilesMatchSourceVersions = reports.every(report => profiles.some(profile => String(profile.id) === report.artifacts.languageProfileId && String(profile.sourceVersionId) === report.sourceVersionId));
  const artifactsPersisted = profileIds.every(id => persistedProfileIds.has(id)) && profilesMatchSourceVersions && ngramModelIds.every(id => modelIds.has(id));

  const identityRuntime = createLanguageIdentityRuntime({
    store: input.storage.languageIdentities,
    hasher,
    now: () => now,
    informationLabel: input.informationLabel
  });
  let identityResult = await identityRuntime.ensure();
  let assignments = input.storage.languageIdentities ? await input.storage.languageIdentities.listProfileLanguages() : [];
  if (input.storage.languageIdentities && profileIds.some(id => !assignments.some(item => item.profileId === id))) {
    identityResult = await identityRuntime.ensure({ rebuild: true });
    assignments = await input.storage.languageIdentities.listProfileLanguages();
  }
  const assignedProfiles = new Set(assignments.map(item => item.profileId));
  const persistedIdentities = input.storage.languageIdentities ? await input.storage.languageIdentities.listIdentities() : [];
  const persistedIdentityIds = new Set(persistedIdentities.map(identity => String(identity.id)));
  const selectedAssignments = assignments.filter(item => profileIds.includes(item.profileId));
  const identityReady = Boolean(input.storage.languageIdentities)
    && persistedIdentities.length > 0
    && profileIds.every(id => assignedProfiles.has(id))
    && selectedAssignments.length === profileIds.length
    && selectedAssignments.every(item => persistedIdentityIds.has(item.languageId))
    && identityResult.assigned > 0;

  const content = {
    graphShardCount: 0,
    languageShardCount: profileIds.length,
    ngramStateCount: ngramModelIds.length,
    priorSectionCount: 2
  } as const;
  const replayManifest = compileBrainReplayManifest({
    sourceSchema: input.sourceSchema,
    sourceManifestHash: input.sourceManifestHash,
    componentIds: [...sourceVersionIds, ...trainedSourceVersionIds, ...profileIds, ...evidenceIds, ...ngramModelIds, ...persistedIdentityIds, ...selectedAssignments.map(item => `${item.profileId}->${item.languageId}`)].sort(compare),
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
    { id: "source.evidence_persisted", passed: sourceVersionsPresent && evidenceOwnedByReportSource, severity: "error" as const, message: "source evidence rows are durable and each trainer report's evidence belongs to that source version", details: toJsonValue({ expected: evidenceIds.length, observed: evidenceRows.length, evidenceOwnedByReportSource }) },
    { id: "source.language_artifacts_persisted", passed: artifactsPersisted, severity: "error" as const, message: "all reported language profiles belong to their selected source versions and all n-gram models are durable", details: toJsonValue({ expectedProfiles: profileIds.length, observedProfiles: persistedProfileIds.size, profilesMatchSourceVersions, expectedModels: ngramModelIds.length, observedModels: modelIds.size }) },
    { id: "source.language_identity_ready", passed: identityReady, severity: "error" as const, message: "every selected language profile has a persisted assignment to a durable learned identity", details: toJsonValue({ identityCount: persistedIdentities.length, assignedProfileCount: selectedAssignments.length }) },
    { id: "source.no_existing_active_brain", passed: activeBefore.activeImportRunIds.length === 0 && !activeBefore.activeBrainVersion, severity: "error" as const, message: "initial source build did not replace an existing active brain" }
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

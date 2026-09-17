// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  codeCommentProse,
  codeLanguageForPath,
  codeTrainingSurface,
  createHasher,
  openingIdentityUnits,
  sourceTitleFromUri,
  toJsonValue,
  type InformationLabel,
  type JsonValue,
  type ScceStorage
} from "@scce/kernel";
import { extractNodeSourceCodeFacts, measureExhibitedContent } from "./code-graph.js";
import { inspectEngineeringCorpusFolder, type EngineeringCorpusFolderOptions } from "./engineering-corpus-folder.js";
import { trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";
import { createProjectDeclarationIndex, createProjectLicenseIndex, readDeclaredLicense } from "./project-artifact-declarations.js";

export const DEFAULT_OSS_FILES_PER_RUN = 2000;
export const DEFAULT_OSS_FILES_PER_REPOSITORY = 100000;

export interface OssCorpusTrainOptions extends EngineeringCorpusFolderOptions {
  storage: ScceStorage;
  rootPath: string;
  /** Provenance of a fetched repository snapshot, retained on every trained projection. */
  repositoryProvenance?: OssRepositoryProvenance;
  /** Stable source URI prefix for a fetched snapshot. Local training derives one from the ingest-material snapshot. */
  sourceUriBase?: string;
  /** Resume point over the deterministic importable-file ordering. */
  startFileIndex?: number;
  /**
   * Fence a local-folder resume to the same ingest-material snapshot. Required when startFileIndex > 0 unless
   * immutable repository provenance is supplied. A changed checkout must fail rather than skip/duplicate files.
   */
  expectedSnapshotHash?: string;
  /** Number of importable files considered by this training run. */
  maxFilesPerRun?: number;
  /** Hard repository inventory ceiling. `maxFiles` remains the compatibility alias for this bound. */
  maxFilesPerRepo?: number;
  includeDocs?: boolean;
  includeSource?: boolean;
  languageAliases?: readonly string[];
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  /**
   * Heap-safety checkpoint in MiB. Omission is still bounded: the default is derived from the actual V8 heap
   * ceiling and may be lowered by SCCE_TRAINING_HEAP_BOUND_MB. A configured value above the real V8 limit is
   * clamped below that limit so the checkpoint can fire before V8 aborts.
   */
  heapCheckpointMb?: number;
}

export interface OssRepositoryProvenance {
  remoteUrl: string;
  commitSha: string;
  snapshotHash: string;
  /** Full repository manifest belongs on the acquisition report, not on every evidence span. */
  fileHashes: Record<string, string>;
}

export type OssSnapshotKind = "git_snapshot" | "ingest_material";

export interface OssCorpusTrainReport {
  schema: "scce.ossCorpusTrainReport.v1";
  rootPath: string;
  snapshotHash: string;
  snapshotKind: OssSnapshotKind;
  /** False when the caller's repository inventory ceiling was reached. */
  snapshotComplete: boolean;
  sourceUriBase: string;
  startFileIndex: number;
  nextFileIndex: number;
  filesConsidered: number;
  heapCheckpointMb: number;
  docsTrained: number;
  codeTrained: number;
  filesSkipped: Array<{ path: string; reason: string; byteLength?: number }>;
  totals: {
    oss_docs: OssCorpusTrainingTotals;
    oss_code: OssCorpusTrainingTotals;
  };
  reports: LanguageCorpusTrainingReport[];
  stoppedByHeapSafetyBound: boolean;
  /** Whether folder inspection hit its repository ceiling. */
  inspectionTruncated: boolean;
  heapMiBAtExit: number;
}

export interface OssCorpusTrainingTotals {
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  constructionCandidates: number;
  languageConstructions: number;
  rejectedLanguageConstructions: number;
}

type OssCorpusSourceSystem = typeof CORPUS_SOURCE_SYSTEM_IDS.ossDocs | typeof CORPUS_SOURCE_SYSTEM_IDS.ossCode;

export async function trainOssCorpus(input: OssCorpusTrainOptions): Promise<OssCorpusTrainReport> {
  const root = path.resolve(input.rootPath);
  const startFileIndex = nonNegativeInteger(input.startFileIndex, 0);

  // Compatibility contract: maxFiles has always bounded folder inspection. Keep that meaning. The expensive
  // trainer gets a separate window, defaulting to no more than the caller's repository ceiling.
  const maxFilesPerRepo = positiveInteger(input.maxFilesPerRepo ?? input.maxFiles, DEFAULT_OSS_FILES_PER_REPOSITORY);
  const maxFilesPerRun = positiveInteger(input.maxFilesPerRun, Math.min(DEFAULT_OSS_FILES_PER_RUN, maxFilesPerRepo));
  const inspection = await inspectEngineeringCorpusFolder(root, {
    maxFiles: maxFilesPerRepo,
    maxFileBytes: input.maxFileBytes ?? 1_000_000,
    maxDepth: input.maxDepth ?? 12,
    includeUnsupported: false
  });
  const importable = inspection.files.filter(file => file.importable);
  const inspectionTruncated = inspection.skipped.some(item => item.reason === "max_files");
  const ingestMaterial = ingestMaterialSnapshot(importable);
  const snapshotHash = input.repositoryProvenance?.snapshotHash ?? ingestMaterial.snapshotHash;
  const snapshotKind: OssSnapshotKind = input.repositoryProvenance ? "git_snapshot" : "ingest_material";

  if (input.expectedSnapshotHash && input.expectedSnapshotHash !== snapshotHash) {
    throw new Error(`OSS resume snapshot changed: expected ${input.expectedSnapshotHash}, found ${snapshotHash}`);
  }
  if (startFileIndex > 0 && !input.repositoryProvenance && !input.expectedSnapshotHash) {
    throw new Error("local OSS resume requires expectedSnapshotHash from the previous run");
  }
  if (startFileIndex > importable.length) {
    throw new Error(`OSS resume index ${startFileIndex} exceeds importable file count ${importable.length}`);
  }

  const window = importable.slice(startFileIndex, startFileIndex + maxFilesPerRun);
  const reports: LanguageCorpusTrainingReport[] = [];
  const skipped: OssCorpusTrainReport["filesSkipped"] = [...inspection.skipped];
  const includeDocs = input.includeDocs !== false;
  const includeSource = input.includeSource !== false;
  const heapCheckpointMb = boundedOssHeapCheckpointMb(input.heapCheckpointMb);
  const sourceUriBase = input.sourceUriBase?.replace(/#.*$/u, "")
    || (input.repositoryProvenance
      ? `${input.repositoryProvenance.remoteUrl.replace(/\.git$/u, "")}/tree/${input.repositoryProvenance.commitSha}`
      : `scce://oss-ingest/${snapshotHash}`);

  // Keep repository provenance compact on every source/span. The full fileHashes manifest remains on the
  // acquisition report; stamping it onto every projection would multiply tens of thousands of hashes by every
  // evidence span. The current file's own hash is already stored separately as sourceHash.
  // The repository's own declared licence, read once at the snapshot root. Recorded at the producer because an
  // ingested span can be cited verbatim, so which licence it is under is a property of the answer.
  const repositoryLicense = await readDeclaredLicense(root);
  const repositoryIdentity: JsonValue = input.repositoryProvenance
    ? toJsonValue({
      identityKind: "git_commit",
      remoteUrl: input.repositoryProvenance.remoteUrl,
      commitSha: input.repositoryProvenance.commitSha,
      snapshotHash: input.repositoryProvenance.snapshotHash,
      license: repositoryLicense
    })
    : toJsonValue({ identityKind: "ingest_material", snapshotHash, license: repositoryLicense });

  let stoppedByHeapSafetyBound = false;
  let filesConsidered = 0;
  const roles = createProjectDeclarationIndex({ stopAt: root });
  const licenses = createProjectLicenseIndex({ stopAt: root });
  const hasher = createHasher();

  for (const file of window) {
    if (heapMiB() >= heapCheckpointMb) {
      stoppedByHeapSafetyBound = true;
      break;
    }
    // Advance the cursor only after this file becomes this run's responsibility. If the heap stop trips before
    // the file, nextFileIndex points back to it. A training failure is an explicit skip and therefore advances.
    filesConsidered += 1;

    const sourceSystem = sourceSystemForPath(file.path);
    if (!sourceSystem) {
      skipped.push({ path: file.path, reason: "not_language_training_material", byteLength: file.byteLength });
      continue;
    }
    if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs && !includeDocs) continue;
    if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode && !includeSource) continue;

    const raw = await readFile(file.absolutePath, "utf8");
    const artifactRole = await roles.roleFor(file.absolutePath);
    const license = await licenses.licenseFor(file.absolutePath);
    const relativePath = normalizeRelative(file.path);
    const sourceHash = file.contentHash ?? sha256(raw);
    // Same producers document.ts uses, over the file rather than a projection: a projection is a different text,
    // but every projection of a file is reachable by the one name and identity the file itself declares.
    const sourceCodeFacts = extractNodeSourceCodeFacts({
      absolutePath: file.absolutePath,
      uri: relativePath,
      mediaType: file.mediaType,
      text: raw,
      sha256: sourceHash,
      hasher
    });
    const title = sourceTitleFromUri(relativePath);
    const identity = [...new Set([
      ...openingIdentityUnits(raw),
      ...(sourceCodeFacts?.declarations ?? []).map(declaration => declaration.name).filter(Boolean).slice(0, 96)
    ])].join(" ");
    // A source file carries two languages at once, and one projection cannot hold both. The code lane learns the
    // token stream itself, because that is the only thing a generator can compose an expression out of; the
    // documentation lane learns the file's comments and the words its identifiers are built from, because that
    // is what a question about the code is asked in. Splitting them keeps each corpus a model of one thing.
    const projections: Array<{ sourceSystem: OssCorpusSourceSystem; text: string; projection: string }> =
      sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs
        ? [{ sourceSystem, text: raw, projection: "verbatim" }]
        : [
          { sourceSystem, text: codeTrainingSurface(raw), projection: "code_surface_tokens" },
          ...(includeDocs
            ? [{
              sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.ossDocs,
              text: codeAdjacentTrainingText(file.path, raw),
              projection: "code_adjacent_prose"
            }]
            : [])
        ];

    let trainedAnyProjection = false;
    for (const projected of projections) {
      if (!projected.text.trim()) continue;
      trainedAnyProjection = true;
      try {
        const relativePath = normalizeRelative(file.path);
        reports.push(await trainLanguageCorpusText({
          storage: input.storage,
          sourceSystem: projected.sourceSystem,
          streamUri: `${projected.sourceSystem}:${relativePath}`,
          sourceUri: `${sourceUriBase}#path=${encodeURIComponent(relativePath)}`,
          text: projected.text,
          mediaType: file.mediaType,
          namespace: `corpus:${projected.sourceSystem}`,
          maxEvidenceChunkBytes: 64 * 1024,
          ngramMaxOrder: input.ngramMaxOrder,
          ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
          ngramVocabularyLimit: input.ngramVocabularyLimit,
          languageAliases: input.languageAliases,
          informationLabel: OSS_CORPUS_INFORMATION_LABEL,
          corpusMetadata: toJsonValue({
            // Retrieval anchors a named subject to a source's title and identity; without them at the producer
            // every OSS span was unreachable by name until a backfill ran. Same contract as document.ts.
            title,
            identity,
            relativePath,
            sourceHash,
            extractor: file.extractor,
            supportedSections: file.supportedSections,
            projection: projected.projection,
            formalLanguage: codeLanguageForPath(file.path) ?? null,
            artifactRole,
            license,
            repository: repositoryIdentity,
            exhibitedContent: projected.projection === "verbatim"
              ? measureExhibitedContent({ uri: relativePath, mediaType: file.mediaType, text: projected.text })
              : {
                schema: "scce.exhibited-content.v1",
                measured: false,
                unmeasuredReason: `projection-changed-coordinate-space:${projected.projection}`,
                coordinateSpace: "extracted-text-code-points",
                textLength: 0,
                ranges: []
              }
          })
        }));
      } catch (error) {
        skipped.push({
          path: file.path,
          reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
          byteLength: file.byteLength
        });
      }
    }
    if (!trainedAnyProjection) {
      skipped.push({ path: file.path, reason: "empty_language_training_projection", byteLength: file.byteLength });
    }
  }

  const nextFileIndex = startFileIndex + filesConsidered;
  return {
    schema: "scce.ossCorpusTrainReport.v1",
    rootPath: root,
    snapshotHash,
    snapshotKind,
    snapshotComplete: !inspectionTruncated,
    sourceUriBase,
    startFileIndex,
    nextFileIndex,
    filesConsidered,
    heapCheckpointMb,
    docsTrained: reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs).length,
    codeTrained: reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode).length,
    filesSkipped: skipped,
    totals: {
      oss_docs: sumReports(reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs)),
      oss_code: sumReports(reports.filter(report => report.sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode))
    },
    reports,
    stoppedByHeapSafetyBound,
    inspectionTruncated,
    heapMiBAtExit: heapMiB()
  };
}

export function sourceSystemForPath(relativePath: string): OssCorpusSourceSystem | undefined {
  const normalized = normalizeRelative(relativePath).toLowerCase();
  const base = path.posix.basename(normalized);
  if (normalized.includes("/docs/") || normalized.startsWith("docs/")) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/^(readme|changelog|contributing|license|security|code_of_conduct)(\.[a-z0-9]+)?$/u.test(base)) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/\.(md|mdx|rst|adoc|txt)$/u.test(normalized)) return CORPUS_SOURCE_SYSTEM_IDS.ossDocs;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|css|scss|html|json|yaml|yml)$/u.test(normalized)) return CORPUS_SOURCE_SYSTEM_IDS.ossCode;
  return undefined;
}

/**
 * A source file's prose: its comments, and the words its identifiers are spelled out of.
 *
 * This is the documentation projection of code, not the code itself -- what a question about a library is asked
 * in. Comment recognition is delegated so that `#` is never read as a comment marker: it opens a preprocessor
 * directive in C and an attribute in Rust, and treating it as one silently swallowed every `#include` line.
 */
export function codeAdjacentTrainingText(relativePath: string, text: string): string {
  const comments = codeCommentProse(text, 512);
  const identifiers = [...new Set(text.match(/[$_\p{Letter}][$_\p{Letter}\p{Number}]{2,}/gu) ?? [])]
    .slice(0, 1200)
    .map(splitIdentifierSurface)
    .filter(Boolean);
  return [
    normalizeRelative(relativePath),
    ...comments,
    identifiers.join(" ")
  ].filter(Boolean).join("\n").slice(0, 1_000_000);
}

/** Stable hash of exactly the importable material SCCE is about to train, not of an entire repository checkout. */
export function ingestMaterialSnapshot(files: readonly { path: string; contentHash?: string }[]): { snapshotHash: string; fileHashes: Record<string, string> } {
  const rows = files
    .map(file => [normalizeRelative(file.path), file.contentHash ?? ""] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return {
    snapshotHash: createHash("sha256").update(rows.map(([file, hash]) => `${file}\u0000${hash}`).join("\n"), "utf8").digest("hex"),
    fileHashes: Object.fromEntries(rows)
  };
}

/**
 * A finite default that is meaningful for the process actually running this trainer. The operational clean-build
 * setting may request 5600 MiB, but that request is clamped below V8's real heap ceiling instead of pretending
 * every invocation was launched with --max-old-space-size=7168.
 */
export function boundedOssHeapCheckpointMb(explicit?: number): number {
  const heapLimitMb = Math.max(256, Math.floor(getHeapStatistics().heap_size_limit / (1024 * 1024)));
  const reserveMb = Math.max(128, Math.floor(heapLimitMb * 0.1));
  const maxSafeMb = Math.max(128, heapLimitMb - reserveMb);
  const environment = Number(process.env.SCCE_TRAINING_HEAP_BOUND_MB);
  const requested = typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0
    ? Math.floor(explicit)
    : Number.isFinite(environment) && environment > 0
      ? Math.floor(environment)
      : Math.floor(heapLimitMb * 0.8);
  return Math.max(128, Math.min(requested, maxSafeMb));
}

function splitIdentifierSurface(value: string): string {
  return value
    .replace(/[_$]+/gu, " ")
    .replace(/([\p{Ll}\p{Number}])([\p{Lu}])/gu, "$1 $2")
    .trim();
}

function sumReports(reports: readonly LanguageCorpusTrainingReport[]): OssCorpusTrainingTotals {
  return reports.reduce((sum, report) => ({
    languageProfiles: sum.languageProfiles + report.languageProfiles,
    evidence: sum.evidence + report.evidence,
    ngramObservations: sum.ngramObservations + report.ngramObservations,
    ngramModels: sum.ngramModels + report.ngramModels,
    languageUnits: sum.languageUnits + report.languageUnits,
    languagePatterns: sum.languagePatterns + report.languagePatterns,
    semanticFrames: sum.semanticFrames + report.semanticFrames,
    constructionCandidates: sum.constructionCandidates + report.constructionCandidates,
    languageConstructions: sum.languageConstructions + report.languageConstructions,
    rejectedLanguageConstructions: sum.rejectedLanguageConstructions + report.rejectedLanguageConstructions
  }), {
    languageProfiles: 0,
    evidence: 0,
    ngramObservations: 0,
    ngramModels: 0,
    languageUnits: 0,
    languagePatterns: 0,
    semanticFrames: 0,
    constructionCandidates: 0,
    languageConstructions: 0,
    rejectedLanguageConstructions: 0
  });
}

const OSS_CORPUS_INFORMATION_LABEL: InformationLabel = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public",
  mergePolicy: "same_owner"
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

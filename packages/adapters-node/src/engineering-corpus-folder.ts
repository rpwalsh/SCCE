import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createClock,
  createEngineeringCorpusProjection,
  createEngineeringCorpusRuntime,
  createHasher,
  createIdFactory,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  createTypedIngestProjector,
  observationContract,
  toJsonValue,
  type EvidenceSpan,
  type JsonValue,
  type ObservationContract,
  type SourceCodeCall,
  type SourceCodeDeclaration,
  type SourceCodeExport,
  type SourceCodeFileFacts,
  type SourceCodeImport,
  type SourceCodePattern,
  type SourceCodeRoute,
  type SourceCodeTest,
  type SourcePackageFacts,
  type TypedIngestProjection
} from "@scce/kernel";
import { extractWorkbookBytes } from "./spreadsheet.js";

export interface EngineeringCorpusFolderOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  includeUnsupported?: boolean;
}

export interface EngineeringCorpusFileInspection {
  path: string;
  absolutePath: string;
  byteLength: number;
  mediaType: string;
  contentHash?: string;
  extractor: string;
  sourceKind: "developer_intelligence" | "local_engineering_corpus" | "unsupported";
  importable: boolean;
  supportedSections: string[];
  unsupportedSections: string[];
  warnings: string[];
}

export interface EngineeringCorpusFolderInspection {
  schema: "scce.engineeringCorpusFolderInspection.v1";
  rootPath: string;
  limits: Required<EngineeringCorpusFolderOptions>;
  readPlan: EngineeringCorpusReadPlan;
  files: EngineeringCorpusFileInspection[];
  skipped: Array<{ path: string; reason: string; byteLength?: number }>;
  totals: {
    filesFound: number;
    filesImportable: number;
    filesUnsupported: number;
    bytesImportable: number;
    bytesSkipped: number;
  };
  extractors: Record<string, number>;
  mediaTypes: Record<string, number>;
  warnings: string[];
}

export interface EngineeringCorpusReadPlan {
  maxResidentFileBytes: number;
  hashChunkBytes: number;
  textChunkBytes: number;
  importableFileCount: number;
  hashOnlyFileCount: number;
  skippedBySizeCount: number;
  generatedDirectorySkipCount: number;
  estimatedResidentCeilingBytes: number;
  notes: string[];
}

export interface EngineeringCorpusFileProjectionSummary {
  path: string;
  sourceKind: EngineeringCorpusFileInspection["sourceKind"];
  extractor: string;
  mediaType: string;
  observationCounts: Record<string, number>;
  forceClasses: Record<string, number>;
  durableStores: Record<string, number>;
  forbiddenStores: Record<string, number>;
  graphNodeKinds: Record<string, number>;
  graphEdgeKinds: Record<string, number>;
  languageEligible: number;
  proofEligible: number;
  graphNodes: number;
  graphEdges: number;
  languageTextChars: number;
  contractSample: JsonValue[];
  warnings: string[];
}

export interface EngineeringCorpusRouteAudit {
  passed: boolean;
  invariants: Array<{ code: string; passed: boolean; count: number; message: string }>;
  issues: Array<{ code: string; path?: string; message: string }>;
}

export interface EngineeringCorpusFolderRuntimeReport {
  schema: "scce.engineeringCorpusFolderRuntime.v1";
  rootPath: string;
  dryRun: true;
  mutation: {
    postgres: false;
    filesystemWrites: false;
    serverStarted: false;
  };
  inspection: EngineeringCorpusFolderInspection;
  observations: {
    total: number;
    byKind: Record<string, number>;
    languageEligible: number;
    proofEligible: number;
    forbiddenLanguageMemory: number;
  };
  routes: {
    durableStores: Record<string, number>;
    forbiddenStores: Record<string, number>;
    graphNodeKinds: Record<string, number>;
    graphEdgeKinds: Record<string, number>;
  };
  fileProjections: EngineeringCorpusFileProjectionSummary[];
  routeAudit: EngineeringCorpusRouteAudit;
  projections: Array<{
    sourceUri: string;
    mediaType: string;
    lane: string;
    observationCounts: Record<string, number>;
    graphNodes: number;
    graphEdges: number;
    languageTextChars: number;
  }>;
  engineering: {
    repositoryFacts: JsonValue;
    projectionSummary: JsonValue;
    packageManagers: string[];
    commandCandidates: JsonValue[];
    entrypointCandidates: JsonValue[];
    capabilitySupport: JsonValue[];
  };
  warnings: string[];
}

interface LoadedCorpusFile extends EngineeringCorpusFileInspection {
  text: string;
  metadata: Record<string, JsonValue>;
  packageFacts?: SourcePackageFacts;
  codeFacts?: SourceCodeFileFacts;
}

const HASH_CHUNK_BYTES = 1024 * 1024;
const TEXT_CHUNK_BYTES = 256 * 1024;

const DEFAULT_LIMITS: Required<EngineeringCorpusFolderOptions> = {
  maxFiles: 2000,
  maxFileBytes: 2 * 1024 * 1024,
  maxDepth: 12,
  includeUnsupported: true
};

const SKIPPED_DIRS = new Set([".git", ".scce", ".tmp", "node_modules", ".pnpm-store", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);
const SKIPPED_ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar"]);
const SKIPPED_BINARY_EXTENSIONS = new Set([
  ".bin",
  ".dll",
  ".docx",
  ".exe",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".sqlite",
  ".ttf",
  ".wasm",
  ".wav",
  ".webp",
  ".woff",
  ".woff2"
]);

export async function inspectEngineeringCorpusFolder(rootPath: string, options: EngineeringCorpusFolderOptions = {}): Promise<EngineeringCorpusFolderInspection> {
  const limits = normalizeOptions(options);
  const root = path.resolve(rootPath);
  const warnings: string[] = [];
  const discovered = await walkFiles(root, limits, warnings);
  const files: EngineeringCorpusFileInspection[] = [];
  let bytesImportable = 0;
  let bytesSkipped = discovered.skipped.reduce((sum, item) => sum + (item.byteLength ?? 0), 0);
  for (const item of discovered.files) {
    const classified = classifyCorpusFile(item.relativePath, item.byteLength);
    const tooLarge = item.byteLength > limits.maxFileBytes;
    const importable = classified.importable && !tooLarge;
    const fileWarnings = [...classified.warnings];
    if (tooLarge) fileWarnings.push(`file exceeds maxFileBytes ${limits.maxFileBytes}`);
    let contentHash: string | undefined;
    if (importable) {
      contentHash = await hashFileSha256(item.absolutePath);
      bytesImportable += item.byteLength;
    } else {
      bytesSkipped += item.byteLength;
    }
    if (importable || limits.includeUnsupported) {
      files.push({
        path: item.relativePath,
        absolutePath: item.absolutePath,
        byteLength: item.byteLength,
        mediaType: classified.mediaType,
        contentHash,
        extractor: classified.extractor,
        sourceKind: classified.sourceKind,
        importable,
        supportedSections: importable ? classified.supportedSections : [],
        unsupportedSections: importable ? classified.unsupportedSections : [...classified.unsupportedSections, "source_bytes"],
        warnings: fileWarnings
      });
    }
  }
  const extractors = countBy(files.map(file => file.extractor));
  const mediaTypes = countBy(files.map(file => file.mediaType));
  const readPlan = createReadPlan({ limits, files, skipped: discovered.skipped });
  return {
    schema: "scce.engineeringCorpusFolderInspection.v1",
    rootPath: root,
    limits,
    readPlan,
    files,
    skipped: discovered.skipped,
    totals: {
      filesFound: discovered.files.length,
      filesImportable: files.filter(file => file.importable).length,
      filesUnsupported: files.filter(file => !file.importable).length,
      bytesImportable,
      bytesSkipped
    },
    extractors,
    mediaTypes,
    warnings
  };
}

export async function dryRunEngineeringCorpusIngest(rootPath: string, options: EngineeringCorpusFolderOptions = {}): Promise<EngineeringCorpusFolderRuntimeReport> {
  return projectEngineeringCorpusFolder(rootPath, options);
}

export async function routeEngineeringCorpusFixture(rootPath: string, options: EngineeringCorpusFolderOptions = {}): Promise<EngineeringCorpusFolderRuntimeReport> {
  return projectEngineeringCorpusFolder(rootPath, options);
}

async function projectEngineeringCorpusFolder(rootPath: string, options: EngineeringCorpusFolderOptions): Promise<EngineeringCorpusFolderRuntimeReport> {
  const limits = normalizeOptions(options);
  const root = path.resolve(rootPath);
  const inspection = await inspectEngineeringCorpusFolder(root, limits);
  const warnings = [...inspection.warnings];
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1_800_000_000_000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "engineering-corpus-folder" });
  const projector = createTypedIngestProjector({ idFactory: ids, hasher });
  const loaded = await loadImportableFiles(inspection, hasher);
  const codeFiles = loaded.filter(file => file.sourceKind === "developer_intelligence");
  const fileFacts = codeFiles.flatMap(file => file.codeFacts ? [file.codeFacts] : []);
  const repositoryFacts = createSourceRepositoryFacts({
    rootUri: folderUri(root),
    files: codeFiles.map(file => ({
      path: file.path,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      contentHash: file.contentHash,
      facts: file.codeFacts
    })),
    hasher
  });
  const rootEvidence = evidenceForText({
    ids,
    namespace: "local-engineering-corpus",
    uri: folderUri(root),
    mediaType: "application/vnd.scce.source-repository",
    text: `engineering corpus folder ${root}`,
    byteLength: 0,
    observedAt: clock.now()
  });
  const projections: TypedIngestProjection[] = [];
  const projectedFiles: Array<{ path: string; file?: LoadedCorpusFile; projection: TypedIngestProjection }> = [];
  if (fileFacts.length || repositoryFacts.files.length) {
    const projection = projector.project({
      sourceId: rootEvidence.sourceId,
      sourceVersionId: rootEvidence.sourceVersionId,
      uri: folderUri(root),
      mediaType: "application/vnd.scce.source-repository",
      text: "",
      metadata: toJsonValue({
        sourceKind: "developer_intelligence",
        repositoryFacts,
        codebase: { rootUri: folderUri(root), fileCount: repositoryFacts.files.length }
      }),
      evidence: [rootEvidence],
      observedAt: clock.now()
    });
    projections.push(projection);
    projectedFiles.push({ path: ".", projection });
  }
  for (const file of loaded) {
    const evidence = evidenceForText({
      ids,
      namespace: file.sourceKind,
      uri: fileUri(file.absolutePath),
      mediaType: file.mediaType,
      text: file.text,
      byteLength: file.byteLength,
      observedAt: clock.now()
    });
    const projection = projector.project({
      sourceId: evidence.sourceId,
      sourceVersionId: evidence.sourceVersionId,
      uri: file.path,
      mediaType: file.mediaType,
      text: file.text,
      metadata: toJsonValue({
        ...file.metadata,
        sourceKind: file.sourceKind,
        codebase: { rootUri: folderUri(root), relativePath: file.path },
        sourceCode: file.codeFacts,
        repositoryFacts: file.sourceKind === "developer_intelligence" ? repositoryFacts : undefined
      }),
      evidence: [evidence],
      observedAt: clock.now()
    });
    projections.push(projection);
    projectedFiles.push({ path: file.path, file, projection });
  }
  const allObservations = projections.flatMap(projection => projection.observations);
  const allRoutes = projections.flatMap(projection => projection.routes);
  const contracts = allObservations.map(observationContract);
  const fileProjections = projectedFiles.map(projected => summarizeFileProjection(projected));
  const routeAudit = auditEngineeringRoutes(fileProjections);
  const engineeringProjection = createEngineeringCorpusProjection({
    repositoryFacts,
    fileFacts,
    evidenceIds: [rootEvidence.id],
    sourceVersionId: String(rootEvidence.sourceVersionId),
    hasher
  });
  const runtime = createEngineeringCorpusRuntime([engineeringProjection]);
  return {
    schema: "scce.engineeringCorpusFolderRuntime.v1",
    rootPath: root,
    dryRun: true,
    mutation: { postgres: false, filesystemWrites: false, serverStarted: false },
    inspection,
    observations: {
      total: allObservations.length,
      byKind: countBy(allObservations.map(item => item.kind)),
      languageEligible: contracts.filter(contract => contract.languageTraining.eligible).length,
      proofEligible: contracts.filter(contract => contract.proofEligibility.eligible).length,
      forbiddenLanguageMemory: contracts.filter(contract => contract.forbiddenStores.includes("language_memory")).length
    },
    routes: {
      durableStores: countBy(allRoutes.flatMap(route => route.durableStores)),
      forbiddenStores: countBy(allRoutes.flatMap(route => route.forbiddenStores)),
      graphNodeKinds: countBy(allRoutes.flatMap(route => route.graphNodeKinds)),
      graphEdgeKinds: countBy(allRoutes.flatMap(route => route.graphEdgeKinds))
    },
    fileProjections,
    routeAudit,
    projections: projections.map(projection => ({
      sourceUri: projection.observations[0]?.provenance && typeof projection.observations[0].provenance === "object" && !Array.isArray(projection.observations[0].provenance)
        ? String((projection.observations[0].provenance as Record<string, JsonValue>).uri ?? "")
        : "",
      mediaType: String(projection.observations[0]?.metadata && typeof projection.observations[0].metadata === "object" && !Array.isArray(projection.observations[0].metadata) ? (projection.observations[0].metadata as Record<string, JsonValue>).mediaType ?? "" : ""),
      lane: projection.lane,
      observationCounts: projection.observationCounts,
      graphNodes: projection.graphNodes.length,
      graphEdges: projection.graphEdges.length,
      languageTextChars: projection.languageText.length
    })),
    engineering: {
      repositoryFacts: toJsonValue({
        workspace: repositoryFacts.workspace,
        distributions: repositoryFacts.distributions,
        files: repositoryFacts.files.slice(0, 128)
      }),
      projectionSummary: toJsonValue(engineeringProjection.summary),
      packageManagers: runtime.packageManagers(),
      commandCandidates: runtime.rankCommands({ limit: 24 }).map(candidate => toJsonValue(candidate)),
      entrypointCandidates: runtime.rankEntrypoints({ limit: 24 }).map(candidate => toJsonValue(candidate)),
      capabilitySupport: runtime.capabilitySupport({ capabilities: [] }).map(item => toJsonValue(item))
    },
    warnings
  };
}

function summarizeFileProjection(input: { path: string; file?: LoadedCorpusFile; projection: TypedIngestProjection }): EngineeringCorpusFileProjectionSummary {
  const contracts = input.projection.observations.map(observationContract);
  const routes = input.projection.routes;
  return {
    path: input.path,
    sourceKind: input.file?.sourceKind ?? "developer_intelligence",
    extractor: input.file?.extractor ?? "repository_projection",
    mediaType: input.file?.mediaType ?? "application/vnd.scce.source-repository",
    observationCounts: input.projection.observationCounts,
    forceClasses: countBy(contracts.map(contract => contract.forceClass)),
    durableStores: countBy(routes.flatMap(route => route.durableStores)),
    forbiddenStores: countBy(routes.flatMap(route => route.forbiddenStores)),
    graphNodeKinds: countBy(routes.flatMap(route => route.graphNodeKinds)),
    graphEdgeKinds: countBy(routes.flatMap(route => route.graphEdgeKinds)),
    languageEligible: contracts.filter(contract => contract.languageTraining.eligible).length,
    proofEligible: contracts.filter(contract => contract.proofEligibility.eligible).length,
    graphNodes: input.projection.graphNodes.length,
    graphEdges: input.projection.graphEdges.length,
    languageTextChars: input.projection.languageText.length,
    contractSample: contracts.slice(0, 24).map(contract => toJsonValue(compactContract(contract))),
    warnings: input.file?.warnings ?? []
  };
}

function compactContract(contract: ObservationContract): JsonValue {
  return toJsonValue({
    id: contract.observationId,
    kind: contract.observationKind,
    forceClass: contract.forceClass,
    confidence: contract.confidence,
    languageEligible: contract.languageTraining.eligible,
    proofEligible: contract.proofEligibility.eligible,
    durableStores: contract.durableStores,
    forbiddenStores: contract.forbiddenStores,
    graphNodeKinds: contract.graphIntent.nodeKinds.slice(0, 24),
    graphEdgeKinds: contract.graphIntent.edgeKinds.slice(0, 24)
  });
}

function auditEngineeringRoutes(files: EngineeringCorpusFileProjectionSummary[]): EngineeringCorpusRouteAudit {
  const issues: EngineeringCorpusRouteAudit["issues"] = [];
  const invariants: EngineeringCorpusRouteAudit["invariants"] = [];
  const add = (code: string, passed: boolean, count: number, message: string) => {
    invariants.push({ code, passed, count, message });
  };
  const codeFiles = files.filter(file => countOf(file.observationCounts, "code") > 0);
  const logFiles = files.filter(file => countOf(file.observationCounts, "log_event") > 0);
  const tableFiles = files.filter(file => countOf(file.observationCounts, "table") > 0 || countOf(file.observationCounts, "measurement") > 0);
  const proseFiles = files.filter(file => countOf(file.observationCounts, "language") > 0);
  for (const file of codeFiles) {
    if (!file.durableStores.program_graph) issues.push({ code: "code_missing_program_graph", path: file.path, message: "code observation did not route to program_graph" });
    if (!file.forbiddenStores.data_graph) issues.push({ code: "code_missing_data_graph_block", path: file.path, message: "code observation did not block data_graph" });
  }
  for (const file of logFiles) {
    if (!file.durableStores.event_graph) issues.push({ code: "log_missing_event_graph", path: file.path, message: "log events did not route to event_graph" });
    if (!file.forbiddenStores.language_memory) issues.push({ code: "log_missing_language_memory_block", path: file.path, message: "log events did not block raw language memory training" });
  }
  for (const file of tableFiles) {
    if (!file.durableStores.data_graph) issues.push({ code: "table_missing_data_graph", path: file.path, message: "table/measurement observations did not route to data_graph" });
  }
  for (const file of files) {
    if (countOf(file.observationCounts, "formula") > 0 && !file.durableStores.computation_graph) issues.push({ code: "formula_missing_computation_graph", path: file.path, message: "formula observations did not route to computation_graph" });
    if (countOf(file.observationCounts, "time_series") > 0 && !file.durableStores.forecast_layer) issues.push({ code: "time_series_missing_forecast_layer", path: file.path, message: "time series observations did not route to forecast_layer" });
  }
  add("code_routes_to_program_graph", codeFiles.every(file => Boolean(file.durableStores.program_graph)), codeFiles.length, "code observations must become program graph material");
  add("logs_block_raw_language_memory", logFiles.every(file => Boolean(file.forbiddenStores.language_memory)), logFiles.length, "log events must not become raw language training");
  add("tables_route_to_data_graph", tableFiles.every(file => Boolean(file.durableStores.data_graph)), tableFiles.length, "tables and measurements must route into the data graph");
  add("prose_can_train_language", proseFiles.some(file => file.durableStores.language_memory), proseFiles.length, "eligible prose/captions should still feed language memory");
  add("formulas_route_to_computation_graph", files.filter(file => countOf(file.observationCounts, "formula") > 0).every(file => Boolean(file.durableStores.computation_graph)), files.filter(file => countOf(file.observationCounts, "formula") > 0).length, "spreadsheet formulas must route into computation graph");
  return { passed: issues.length === 0 && invariants.every(item => item.passed || item.count === 0), invariants, issues };
}

async function walkFiles(root: string, limits: Required<EngineeringCorpusFolderOptions>, warnings: string[]): Promise<{ files: Array<{ absolutePath: string; relativePath: string; byteLength: number }>; skipped: Array<{ path: string; reason: string; byteLength?: number }> }> {
  const files: Array<{ absolutePath: string; relativePath: string; byteLength: number }> = [];
  const skipped: Array<{ path: string; reason: string; byteLength?: number }> = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (files.length >= limits.maxFiles) return;
    if (depth > limits.maxDepth) {
      skipped.push({ path: relative(root, dir), reason: "max_depth" });
      return;
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read ${dir}: ${messageOf(error)}`);
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= limits.maxFiles) {
        skipped.push({ path: relative(root, dir), reason: "max_files" });
        return;
      }
      const absolute = path.join(dir, entry.name);
      const rel = relative(root, absolute);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) {
          skipped.push({ path: rel, reason: "generated_or_dependency_directory" });
          continue;
        }
        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        const skipReason = skippedSourceFileReason(rel);
        if (skipReason) {
          skipped.push({ path: rel, reason: skipReason, byteLength: info.size });
          continue;
        }
        files.push({ absolutePath: absolute, relativePath: rel, byteLength: info.size });
      }
    }
  }
  await visit(root, 0);
  return { files, skipped };
}

function createReadPlan(input: { limits: Required<EngineeringCorpusFolderOptions>; files: EngineeringCorpusFileInspection[]; skipped: Array<{ path: string; reason: string; byteLength?: number }> }): EngineeringCorpusReadPlan {
  const importable = input.files.filter(file => file.importable);
  const skippedBySize = input.files.filter(file => file.warnings.some(warning => warning.includes("maxFileBytes")));
  const generatedSkips = input.skipped.filter(item => item.reason === "generated_or_dependency_directory");
  const largestResidentFile = importable.reduce((max, file) => Math.max(max, Math.min(file.byteLength, input.limits.maxFileBytes)), 0);
  return {
    maxResidentFileBytes: input.limits.maxFileBytes,
    hashChunkBytes: HASH_CHUNK_BYTES,
    textChunkBytes: TEXT_CHUNK_BYTES,
    importableFileCount: importable.length,
    hashOnlyFileCount: input.files.filter(file => !file.importable && Boolean(file.contentHash)).length,
    skippedBySizeCount: skippedBySize.length,
    generatedDirectorySkipCount: generatedSkips.length,
    estimatedResidentCeilingBytes: largestResidentFile + TEXT_CHUNK_BYTES * 2 + HASH_CHUNK_BYTES,
    notes: [
      "hashing uses bounded chunks",
      "text loading refuses files larger than maxFileBytes",
      "folder runtime performs no database writes and starts no server",
      "generated/dependency directories are skipped during source-only corpus inspection"
    ]
  };
}

async function loadImportableFiles(inspection: EngineeringCorpusFolderInspection, hasher: ReturnType<typeof createHasher>): Promise<LoadedCorpusFile[]> {
  const loaded: LoadedCorpusFile[] = [];
  for (const file of inspection.files.filter(item => item.importable)) {
    if (file.extractor === "sheetjs_workbook") {
      const bytes = await readFileBytesBounded(file);
      const extraction = await extractWorkbookBytes(bytes, file.absolutePath);
      loaded.push({
        ...file,
        text: extraction.text,
        metadata: {
          mediaType: file.mediaType,
          structure: toJsonValue(extraction.structural),
          typedExtraction: toJsonValue(extraction.typedExtraction),
          extractionWarnings: toJsonValue(extraction.warnings)
        }
      });
      continue;
    }
    const text = await readTextFileBounded(file);
    const fixture = fixtureMetadata(file, text);
    const packageFacts = file.extractor === "package_manifest" ? packageFactsFromJson(text) : undefined;
    const codeFacts = file.sourceKind === "developer_intelligence" && sourceFactsEligible(file.extractor)
      ? createStructuralSourceFacts(file, text, hasher, packageFacts)
      : undefined;
    loaded.push({
      ...file,
      text: fixture.text,
      metadata: fixture.metadata,
      packageFacts,
      codeFacts
    });
  }
  return loaded;
}

async function hashFileSha256(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead <= 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    return `sha256_${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function readTextFileBounded(file: EngineeringCorpusFileInspection): Promise<string> {
  return textForFile(file, await readFileBytesBounded(file));
}

async function readFileBytesBounded(file: EngineeringCorpusFileInspection): Promise<Buffer> {
  const handle = await open(file.absolutePath, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(TEXT_CHUNK_BYTES);
  let total = 0;
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead <= 0) break;
      total += result.bytesRead;
      if (total > file.byteLength) throw new Error(`read exceeded inspected byte length for ${file.path}`);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total);
}

function sourceFactsEligible(extractor: string): boolean {
  return extractor === "structural_source_code" || extractor === "package_manifest";
}

function classifyCorpusFile(relativePath: string, byteLength: number): Omit<EngineeringCorpusFileInspection, "path" | "absolutePath" | "byteLength" | "contentHash"> {
  const lower = relativePath.split("\\").join("/").toLocaleLowerCase();
  const ext = extensionOf(lower);
  const warnings: string[] = [];
  if (lower.endsWith(".fixture.json")) {
    const workbook = lower.includes("workbook") || lower.includes("sheet");
    return {
      mediaType: workbook ? "application/vnd.scce.workbook+json" : "application/vnd.scce.document-structure+json",
      extractor: workbook ? "workbook_metadata_fixture" : "document_metadata_fixture",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: workbook ? ["workbook.sheets", "workbook.formulas"] : ["structure.headings", "structure.sections", "structure.figures", "structure.pages"],
      unsupportedSections: [],
      warnings
    };
  }
  if (lower.endsWith("package.json")) {
    return {
      mediaType: "application/json",
      extractor: "package_manifest",
      sourceKind: "developer_intelligence",
      importable: true,
      supportedSections: ["scripts", "dependencies", "devDependencies", "peerDependencies"],
      unsupportedSections: [],
      warnings
    };
  }
  if (packageLockLike(lower)) {
    return {
      mediaType: "application/vnd.scce.package-lock",
      extractor: "package_lock",
      sourceKind: "developer_intelligence",
      importable: true,
      supportedSections: ["package_manager_evidence", "dependency_resolution_surface"],
      unsupportedSections: ["lockfile_full_resolution_graph"],
      warnings
    };
  }
  if (ext === ".json" || ext === ".jsonl" || ext === ".ndjson") {
    return {
      mediaType: ext === ".json" ? "application/vnd.scce.structured-json" : "application/vnd.scce.structured-json-lines",
      extractor: ext === ".json" ? "structured_json" : "structured_json_lines",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["object_records", "array_records", "schema_profile", "typed_tables"],
      unsupportedSections: ["json_graph_semantics"],
      warnings
    };
  }
  if (ext === ".csv" || ext === ".tsv") {
    return {
      mediaType: ext === ".csv" ? "text/csv" : "text/tab-separated-values",
      extractor: ext === ".csv" ? "csv_table" : "tsv_table",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["table.rows", "table.schema", "measurements", "time_series"],
      unsupportedSections: [],
      warnings
    };
  }
  if (ext === ".yaml" || ext === ".yml") {
    return {
      mediaType: "application/yaml",
      extractor: "structured_yaml_text",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["key_value_text", "configuration_claims"],
      unsupportedSections: ["yaml_full_schema_graph"],
      warnings
    };
  }
  if (ext === ".md" || ext === ".txt") {
    return {
      mediaType: ext === ".md" ? "text/markdown" : "text/plain",
      extractor: "document_text",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["paragraphs", "headings", "sections", "markdown_tables", "markdown_figures", "code_fences"],
      unsupportedSections: [],
      warnings
    };
  }
  if (ext === ".log") {
    return {
      mediaType: "application/vnd.scce.engineering-log",
      extractor: "engineering_log",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["log.events", "event.attributes"],
      unsupportedSections: ["raw_log_language_training"],
      warnings
    };
  }
  if (isCodeExtension(ext)) {
    return {
      mediaType: mediaTypeForCodeExtension(ext),
      extractor: "structural_source_code",
      sourceKind: "developer_intelligence",
      importable: true,
      supportedSections: ["imports", "exports", "declarations", "calls", "routes", "tests", "patterns"],
      unsupportedSections: [],
      warnings
    };
  }
  if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
    if (ext === ".xlsm") warnings.push("macro-enabled workbook is parsed as data only; VBA may be inflated by bounded validation/parser internals but is not exposed to cognition or executed");
    return {
      mediaType: ext === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : ext === ".xlsm"
          ? "application/vnd.ms-excel.sheet.macroEnabled.12"
          : "application/vnd.ms-excel",
      extractor: "sheetjs_workbook",
      sourceKind: "local_engineering_corpus",
      importable: true,
      supportedSections: ["workbook.sheets", "workbook.cells", "workbook.formulas", "workbook.merged_ranges"],
      unsupportedSections: ["formula_recalculation", "macro_execution", "external_link_resolution", "embedded_object_execution"],
      warnings
    };
  }
  if (ext === ".pdf" || ext === ".docx") {
    warnings.push("binary file requires a metadata fixture in this source-only pass");
    return {
      mediaType: ext === ".pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractor: "binary_metadata_required",
      sourceKind: "unsupported",
      importable: false,
      supportedSections: [],
      unsupportedSections: ["binary_content"],
      warnings
    };
  }
  return {
    mediaType: "application/octet-stream",
    extractor: "unsupported",
    sourceKind: "unsupported",
    importable: false,
    supportedSections: [],
    unsupportedSections: [byteLength > 0 ? "unknown_content" : "empty_file"],
    warnings
  };
}

function createStructuralSourceFacts(file: EngineeringCorpusFileInspection, text: string, hasher: ReturnType<typeof createHasher>, packageFacts?: SourcePackageFacts): SourceCodeFileFacts {
  const parser = { id: file.extractor, ok: true, diagnostics: file.warnings };
  const declarations = sourceDeclarations(text, file.path, hasher);
  const imports = sourceImports(text, file.path, hasher);
  const exports = sourceExports(text, file.path, hasher);
  const calls = sourceCalls(text, file.path, hasher);
  const routes = sourceRoutes(text, file.path, hasher);
  const tests = sourceTests(text, file.path, hasher);
  const patterns = sourcePatterns({ declarations, imports, routes, tests }, file.path, hasher);
  return createSourceCodeFileFacts({
    path: file.path,
    mediaType: file.mediaType,
    text,
    contentHash: file.contentHash,
    parser,
    declarations,
    imports,
    exports,
    calls,
    routes,
    tests,
    patterns,
    packageFacts,
    hasher
  });
}

function sourceDeclarations(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeDeclaration[] {
  const out: SourceCodeDeclaration[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 2048; index++) {
    const line = lines[index] ?? "";
    const lexemes = codeLexemes(line);
    for (let t = 0; t < lexemes.length; t++) {
      const lexeme = lexemes[t] ?? "";
      const next = lexemes[t + 1] ?? "";
      if (declarationMarker(lexeme) && identifierLike(next)) {
        out.push({
          id: stableId(hasher, "decl", filePath, index, lexeme, next),
          name: next,
          kind: lexeme,
          exported: lexemes.includes("export") || lexemes.includes("public"),
          defaultExport: lexemes.includes("default"),
          signature: line.trim(),
          metadata: toJsonValue({ line: index + 1 })
        });
      }
    }
  }
  return uniqueById(out);
}

function sourceImports(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeImport[] {
  const out: SourceCodeImport[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 2048; index++) {
    const line = lines[index] ?? "";
    const lower = line.toLocaleLowerCase();
    const quoted = quotedStrings(line);
    const specifier = quoted.find(item => importLineHasSpecifier(lower, item));
    if (specifier) {
      out.push({
        id: stableId(hasher, "import", filePath, index, specifier),
        moduleSpecifier: specifier,
        importedNames: importedNamesFromLine(line),
        typeOnly: lower.includes("type "),
        metadata: toJsonValue({ line: index + 1 })
      });
    }
  }
  return uniqueById(out);
}

function sourceExports(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeExport[] {
  const out: SourceCodeExport[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 1024; index++) {
    const line = lines[index] ?? "";
    const lexemes = codeLexemes(line);
    if (!lexemes.includes("export")) continue;
    const names = lexemes.filter((lexeme, t) => identifierLike(lexeme) && t > 0 && !["export", "default", "from", "as", "function", "class", "type", "interface", "const", "let", "var"].includes(lexeme)).slice(0, 32);
    out.push({
      id: stableId(hasher, "export", filePath, index, names),
      exportedNames: names.length ? names : ["default"],
      moduleSpecifier: quotedStrings(line).find(item => line.includes("from")),
      defaultExport: lexemes.includes("default"),
      metadata: toJsonValue({ line: index + 1 })
    });
  }
  return uniqueById(out);
}

function sourceCalls(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeCall[] {
  const out: SourceCodeCall[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 4096; index++) {
    for (const call of callNames(lines[index] ?? "").slice(0, 32)) {
      out.push({
        id: stableId(hasher, "call", filePath, index, call),
        callee: call,
        argumentKinds: argumentKindsForCall(lines[index] ?? "", call),
        metadata: toJsonValue({ line: index + 1 })
      });
    }
  }
  return uniqueById(out);
}

function sourceRoutes(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeRoute[] {
  const out: SourceCodeRoute[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 1024; index++) {
    const line = lines[index] ?? "";
    for (const quoted of quotedStrings(line)) {
      if (!quoted.startsWith("/")) continue;
      const call = nearestCallNameBefore(line, quoted);
      out.push({
        id: stableId(hasher, "route", filePath, index, quoted, call),
        protocol: "local-interface",
        method: routeMethodFromCall(call),
        path: quoted,
        handlerHint: lastIdentifier(line),
        metadata: toJsonValue({ line: index + 1, call })
      });
    }
  }
  return uniqueById(out);
}

function sourceTests(text: string, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodeTest[] {
  const out: SourceCodeTest[] = [];
  const lines = splitTextLines(text);
  for (let index = 0; index < lines.length && out.length < 1024; index++) {
    const line = lines[index] ?? "";
    const call = callNames(line).find(name => ["test", "it", "describe", "spec"].includes(name.toLocaleLowerCase()));
    if (!call) continue;
    out.push({
      id: stableId(hasher, "test", filePath, index, line.trim()),
      name: quotedStrings(line)[0],
      runnerHint: call,
      metadata: toJsonValue({ line: index + 1 })
    });
  }
  return uniqueById(out);
}

function sourcePatterns(input: { declarations: SourceCodeDeclaration[]; imports: SourceCodeImport[]; routes: SourceCodeRoute[]; tests: SourceCodeTest[] }, filePath: string, hasher: ReturnType<typeof createHasher>): SourceCodePattern[] {
  const out: SourceCodePattern[] = [];
  if (input.declarations.length) out.push({ id: stableId(hasher, "pattern", filePath, "declarations"), kind: "declaration_cluster", label: "declaration cluster", codeSymbols: input.declarations.map(item => item.name).slice(0, 128), support: 0.66, metadata: {} });
  if (input.imports.length) out.push({ id: stableId(hasher, "pattern", filePath, "imports"), kind: "dependency_cluster", label: "dependency cluster", codeSymbols: input.imports.map(item => item.moduleSpecifier).slice(0, 128), support: 0.62, metadata: {} });
  if (input.routes.length) out.push({ id: stableId(hasher, "pattern", filePath, "routes"), kind: "interface_routes", label: "interface routes", codeSymbols: input.routes.map(item => item.path).slice(0, 128), support: 0.7, metadata: {} });
  if (input.tests.length) out.push({ id: stableId(hasher, "pattern", filePath, "tests"), kind: "validation_surface", label: "validation surface", codeSymbols: input.tests.flatMap(item => item.name ? [item.name] : []).slice(0, 128), support: 0.68, metadata: {} });
  return out;
}

function packageFactsFromJson(text: string): SourcePackageFacts | undefined {
  const parsed = parseJson(text);
  if (!parsed) return undefined;
  const scriptsRecord = recordValue(parsed.scripts);
  const scripts = Object.entries(scriptsRecord).flatMap(([name, value]) => typeof value === "string" ? [{
    name,
    command: value,
    roleEvidence: scriptRoleEvidence(name, value)
  }] : []);
  const dependencies: SourcePackageFacts["dependencies"] = [];
  for (const [scope, key] of [["runtime", "dependencies"], ["development", "devDependencies"], ["peer", "peerDependencies"], ["optional", "optionalDependencies"]] as const) {
    for (const [name, value] of Object.entries(recordValue(parsed[key]))) {
      dependencies.push({ name, scope, version: typeof value === "string" ? value : undefined });
    }
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    version: typeof parsed.version === "string" ? parsed.version : undefined,
    scripts,
    dependencies
  };
}

function scriptRoleEvidence(name: string, command: string): SourcePackageFacts["scripts"][number]["roleEvidence"] {
  const text = `${name} ${command}`.toLocaleLowerCase();
  const evidence = [name, command];
  if (text.includes("build") || text.includes("compile") || text.includes("bundle")) return [{ roleId: "source.role.build", source: "package-manifest", confidence: 0.86, evidence }];
  if (text.includes("test") || text.includes("check") || text.includes("lint") || text.includes("verify")) return [{ roleId: "source.role.validation", source: "package-manifest", confidence: 0.86, evidence }];
  if (text.includes("start") || text.includes("serve") || text.includes("dev")) return [{ roleId: "source.role.runtime", source: "package-manifest", confidence: 0.78, evidence }];
  return [{ roleId: "source.role.script", source: "package-manifest", confidence: 0.5, evidence }];
}

function fixtureMetadata(file: EngineeringCorpusFileInspection, text: string): { text: string; metadata: Record<string, JsonValue> } {
  if (file.extractor === "document_text" && file.mediaType === "text/markdown") {
    return { text, metadata: { mediaType: file.mediaType, structure: toJsonValue(markdownStructure(text)), fixture: toJsonValue({ path: file.path, source: "markdown" }) } };
  }
  if (file.extractor === "document_text") {
    return { text, metadata: { mediaType: file.mediaType, structure: toJsonValue(plainTextStructure(text)), fixture: toJsonValue({ path: file.path, source: "plain_text" }) } };
  }
  if (file.extractor === "structured_json" || file.extractor === "structured_json_lines") {
    return structuredJsonMetadata(file, text);
  }
  if (!file.path.toLocaleLowerCase().endsWith(".fixture.json")) return { text, metadata: { mediaType: file.mediaType } };
  const parsed = parseJson(text);
  if (!parsed) return { text: "", metadata: { mediaType: file.mediaType, fixtureParseError: true } };
  const mediaType = typeof parsed.mediaType === "string" ? parsed.mediaType : file.mediaType;
  const structure = recordValue(parsed.structure);
  const workbook = recordValue(parsed.workbook);
  const document = recordValue(parsed.document);
  const fixtureText = typeof parsed.text === "string" ? parsed.text : documentTextFromStructure(structure);
  if (Object.keys(workbook).length) {
    return {
      text: "",
      metadata: {
        mediaType,
        typedExtraction: toJsonValue({ workbook }),
        fixture: toJsonValue({ path: file.path, schema: parsed.schema ?? null })
      }
    };
  }
  return {
    text: fixtureText,
    metadata: {
      mediaType,
      structure: toJsonValue({ ...recordValue(document.structure), ...structure }),
      typedExtraction: toJsonValue({ document }),
      fixture: toJsonValue({ path: file.path, schema: parsed.schema ?? null })
    }
  };
}

function documentTextFromStructure(structure: Record<string, JsonValue>): string {
  const parts: string[] = [];
  for (const key of ["headings", "paragraphs", "sections", "pages", "figures"]) {
    const rows = Array.isArray(structure[key]) ? structure[key] as JsonValue[] : [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const record = row as Record<string, JsonValue>;
      for (const field of ["text", "title", "heading", "preview", "caption"]) {
        if (typeof record[field] === "string") parts.push(record[field] as string);
      }
    }
  }
  return parts.join("\n\n");
}

function markdownStructure(text: string): Record<string, JsonValue> {
  const lines = splitTextLines(text);
  const headings: JsonValue[] = [];
  const sections: JsonValue[] = [];
  const paragraphs: JsonValue[] = [];
  const figures: JsonValue[] = [];
  const codeFences: JsonValue[] = [];
  let currentTitle = "";
  let sectionLines: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  let fenceStart = 0;
  let fenceInfo = "";
  let fenceLines: string[] = [];
  const flushParagraph = (lineNumber: number) => {
    if (!paragraph.length) return;
    const textValue = collapseSpaces(paragraph.join(" "));
    if (textValue) paragraphs.push(toJsonValue({ text: textValue, lineEnd: lineNumber }));
    paragraph = [];
  };
  const flushSection = (lineNumber: number) => {
    const body = collapseSpaces(sectionLines.join(" "));
    if (currentTitle || body) sections.push(toJsonValue({ title: currentTitle, text: body, lineEnd: lineNumber }));
    sectionLines = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (fenceBoundary(trimmed)) {
      if (inFence) {
        codeFences.push(toJsonValue({ info: fenceInfo, lineStart: fenceStart, lineEnd: index + 1, preview: fenceLines.slice(0, 12).join("\n") }));
        fenceLines = [];
        fenceInfo = "";
        inFence = false;
      } else {
        flushParagraph(index + 1);
        inFence = true;
        fenceStart = index + 1;
        fenceInfo = fenceInfoString(trimmed);
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    const heading = markdownHeading(line);
    if (heading) {
      flushParagraph(index + 1);
      flushSection(index + 1);
      currentTitle = heading.text;
      headings.push(toJsonValue({ text: heading.text, level: heading.level, line: index + 1 }));
      continue;
    }
    const figure = markdownFigure(line, index + 1);
    if (figure) figures.push(toJsonValue(figure));
    if (!trimmed) {
      flushParagraph(index + 1);
      if (sectionLines.length) sectionLines.push("");
      continue;
    }
    if (!markdownTableLine(trimmed)) paragraph.push(trimmed);
    sectionLines.push(trimmed);
  }
  flushParagraph(lines.length);
  flushSection(lines.length);
  return {
    headings,
    paragraphs,
    sections,
    figures,
    codeFences
  };
}

function plainTextStructure(text: string): Record<string, JsonValue> {
  const lines = splitTextLines(text);
  const paragraphs: JsonValue[] = [];
  let block: string[] = [];
  const flush = (lineEnd: number) => {
    const value = collapseSpaces(block.join(" "));
    if (value) paragraphs.push(toJsonValue({ text: value, lineEnd }));
    block = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed) flush(index + 1);
    else block.push(trimmed);
  }
  flush(lines.length);
  return { paragraphs, sections: paragraphs.map((paragraph, index) => toJsonValue({ title: `section:${index + 1}`, text: recordValue(paragraph).text ?? "" })) };
}

function structuredJsonMetadata(file: EngineeringCorpusFileInspection, text: string): { text: string; metadata: Record<string, JsonValue> } {
  const parsed = file.extractor === "structured_json_lines" ? parseJsonLines(text) : parseJsonValue(text);
  if (!parsed) {
    return {
      text: "",
      metadata: {
        mediaType: file.mediaType,
        fixture: toJsonValue({ path: file.path, source: file.extractor, parseError: true })
      }
    };
  }
  const tables = jsonTables(parsed, file.path);
  const structure = jsonDocumentStructure(parsed, file.path);
  if (tables.length) {
    return {
      text: "",
      metadata: {
        mediaType: file.mediaType,
        typedExtraction: toJsonValue({ workbook: { sheets: tables } }),
        structure: toJsonValue(structure),
        fixture: toJsonValue({ path: file.path, source: file.extractor, tableCount: tables.length })
      }
    };
  }
  return {
    text: documentTextFromStructure(structure),
    metadata: {
      mediaType: file.mediaType,
      structure: toJsonValue(structure),
      fixture: toJsonValue({ path: file.path, source: file.extractor, tableCount: 0 })
    }
  };
}

function parseJsonLines(text: string): JsonValue | undefined {
  const rows: JsonValue[] = [];
  for (const line of splitTextLines(text).slice(0, 10000)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonValue(trimmed);
    if (parsed === undefined) return undefined;
    rows.push(parsed);
  }
  return rows;
}

function jsonTables(value: JsonValue, sourcePath: string): Array<{ name: string; rows: JsonValue[][]; formulas: JsonValue[] }> {
  const tables: Array<{ name: string; rows: JsonValue[][]; formulas: JsonValue[] }> = [];
  const visit = (node: JsonValue, pathParts: string[], depth: number) => {
    if (tables.length >= 64 || depth > 8) return;
    if (Array.isArray(node)) {
      const rows = rowsFromJsonArray(node);
      if (rows.length >= 2) {
        tables.push({ name: pathParts.join(".") || "records", rows, formulas: [] });
        return;
      }
      for (let i = 0; i < Math.min(node.length, 128); i++) visit(node[i] ?? null, [...pathParts, String(i)], depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) visit(child, [...pathParts, key], depth + 1);
  };
  visit(value, [sourcePath.split("/").pop() ?? "json"], 0);
  return tables;
}

function rowsFromJsonArray(rows: JsonValue[]): JsonValue[][] {
  const records = rows.filter(row => row && typeof row === "object" && !Array.isArray(row)) as Array<Record<string, JsonValue>>;
  if (records.length < 1 || records.length < Math.max(1, Math.floor(rows.length * 0.55))) return [];
  const headers = jsonHeaders(records).slice(0, 256);
  if (!headers.length) return [];
  const tableRows: JsonValue[][] = [headers];
  for (const record of records.slice(0, 10000)) tableRows.push(headers.map(header => jsonCellValue(record[header])));
  return tableRows;
}

function jsonHeaders(records: Array<Record<string, JsonValue>>): string[] {
  const seen = new Map<string, number>();
  for (const record of records.slice(0, 1000)) {
    for (const key of Object.keys(record)) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}

function jsonCellValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(item => primitivePreview(item)).join(", ");
  return objectPreview(value);
}

function primitivePreview(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return Array.isArray(value) ? `array:${value.length}` : `object:${Object.keys(value).length}`;
}

function objectPreview(value: JsonValue): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return primitivePreview(value);
  return Object.entries(value).slice(0, 8).map(([key, child]) => `${key}=${primitivePreview(child)}`).join("; ");
}

function jsonDocumentStructure(value: JsonValue, sourcePath: string): Record<string, JsonValue> {
  const sections: JsonValue[] = [];
  const paragraphs: JsonValue[] = [];
  const visit = (node: JsonValue, pathParts: string[], depth: number) => {
    if (sections.length >= 512 || depth > 8) return;
    if (typeof node === "string") {
      const text = collapseSpaces(node);
      if (text.length >= 12) paragraphs.push(toJsonValue({ text, path: pathParts.join(".") }));
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      sections.push(toJsonValue({ title: pathParts.join("."), text: `array length ${node.length}` }));
      for (let i = 0; i < Math.min(node.length, 64); i++) visit(node[i] ?? null, [...pathParts, String(i)], depth + 1);
      return;
    }
    const scalarPieces: string[] = [];
    for (const [key, child] of Object.entries(node)) {
      if (child === null || typeof child === "string" || typeof child === "number" || typeof child === "boolean") scalarPieces.push(`${key}: ${String(child ?? "")}`);
    }
    if (scalarPieces.length) sections.push(toJsonValue({ title: pathParts.join(".") || sourcePath, text: scalarPieces.join("; ") }));
    for (const [key, child] of Object.entries(node)) if (child && typeof child === "object") visit(child, [...pathParts, key], depth + 1);
  };
  visit(value, [sourcePath.split("/").pop() ?? "json"], 0);
  return { sections, paragraphs };
}

function markdownHeading(line: string): { level: number; text: string } | undefined {
  const trimmed = line.trimStart();
  let level = 0;
  while (level < trimmed.length && trimmed[level] === "#") level++;
  if (level < 1 || level > 6 || trimmed[level] !== " ") return undefined;
  return { level, text: trimmed.slice(level + 1).trim() };
}

function markdownFigure(line: string, lineNumber: number): { id: string; caption: string; page?: number; extractedLabels: string[]; line: number } | undefined {
  const imageStart = line.indexOf("![");
  if (imageStart < 0) return undefined;
  const close = line.indexOf("]", imageStart + 2);
  const openParen = close >= 0 ? line.indexOf("(", close + 1) : -1;
  const closeParen = openParen >= 0 ? line.indexOf(")", openParen + 1) : -1;
  if (close <= imageStart || openParen <= close || closeParen <= openParen) return undefined;
  const caption = line.slice(imageStart + 2, close).trim();
  const target = line.slice(openParen + 1, closeParen).trim();
  return { id: `markdown-image-${lineNumber}`, caption, extractedLabels: [...new Set([...codeLexemes(caption), ...codeLexemes(target)].filter(lexeme => lexeme.length > 2))].slice(0, 32), line: lineNumber };
}

function markdownTableLine(trimmed: string): boolean {
  return trimmed.includes("|") && trimmed.split("|").length >= 3;
}

function fenceBoundary(trimmed: string): boolean {
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function fenceInfoString(trimmed: string): string {
  let ticks = 0;
  while (ticks < trimmed.length && (trimmed[ticks] === "`" || trimmed[ticks] === "~")) ticks++;
  return trimmed.slice(ticks).trim();
}

function collapseSpaces(text: string): string {
  let out = "";
  let spacing = false;
  for (const ch of text.trim()) {
    if (ch.trim() === "") {
      if (!spacing) out += " ";
      spacing = true;
    } else {
      out += ch;
      spacing = false;
    }
  }
  return out;
}

function evidenceForText(input: {
  ids: ReturnType<typeof createIdFactory>;
  namespace: string;
  uri: string;
  mediaType: string;
  text: string;
  byteLength: number;
  observedAt: number;
}): EvidenceSpan {
  const sourceId = input.ids.sourceId(input.namespace, input.uri);
  const bytes = Buffer.from(input.text, "utf8");
  const sourceVersionId = input.ids.sourceVersionId(bytes.length ? bytes : input.uri);
  const contentHash = input.ids.contentHash(bytes.length ? bytes : input.uri);
  const chunkId = input.ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: Math.max(input.byteLength, bytes.byteLength), chunkHash: contentHash });
  const id = input.ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: Math.max(input.byteLength, bytes.byteLength), spanHash: contentHash });
  return {
    id,
    sourceId,
    sourceVersionId,
    chunkId,
    contentHash,
    mediaType: input.mediaType,
    byteStart: 0,
    byteEnd: Math.max(input.byteLength, bytes.byteLength),
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text.slice(0, 500),
    languageHints: {},
    scriptHints: {},
    trustVector: {
      sourceTrust: {
        identity: 1,
        integrity: 1,
        parserReliability: 0.9,
        directness: 0.9,
        authority: 1,
        freshness: 0.95,
        independenceGroup: `engineering:${input.namespace}`,
        accessScope: "owner_private",
        licenseStatus: "owner_authorized"
      }
    },
    provenance: toJsonValue({ uri: input.uri, namespace: input.namespace }),
    features: [],
    status: "promoted",
    alpha: 0.82,
    observedAt: input.observedAt
  };
}

function textForFile(file: EngineeringCorpusFileInspection, bytes: Uint8Array): string {
  if (file.mediaType === "application/octet-stream") return "";
  return Buffer.from(bytes).toString("utf8");
}

function mediaTypeForCodeExtension(ext: string): string {
  return ext ? `text/x-source${ext}` : "text/x-source";
}

function packageLockLike(lowerPath: string): boolean {
  const file = lowerPath.split("/").pop() ?? lowerPath;
  return file === "pnpm-lock.yaml"
    || file === "yarn.lock"
    || file === "package-lock.json"
    || file === "bun.lockb"
    || file === "bun.lock"
    || file === "npm-shrinkwrap.json"
    || file === "poetry.lock"
    || file === "cargo.lock"
    || file === "gemfile.lock"
    || file === "composer.lock"
    || file === "go.sum"
    || file === "packages.lock.json";
}

function isCodeExtension(ext: string): boolean {
  if (!ext || ext.length > 12) return false;
  const excluded = new Set([
    ".csv",
    ".tsv",
    ".log",
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".lock",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".docx",
    ".xlsx",
    ".xlsm",
    ".xls",
    ".zip",
    ".gz",
    ".bz2",
    ".7z",
    ".exe",
    ".dll",
    ".bin"
  ]);
  return !excluded.has(ext);
}

function skippedSourceFileReason(relativePath: string): "archive_file" | "binary_file" | undefined {
  const ext = extensionOf(relativePath);
  if (SKIPPED_ARCHIVE_EXTENSIONS.has(ext)) return "archive_file";
  if (SKIPPED_BINARY_EXTENSIONS.has(ext)) return "binary_file";
  return undefined;
}

function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLocaleLowerCase() : "";
}

function normalizeOptions(options: EngineeringCorpusFolderOptions): Required<EngineeringCorpusFolderOptions> {
  return {
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_LIMITS.maxFiles),
    maxFileBytes: Math.max(1024, options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes),
    maxDepth: Math.max(0, options.maxDepth ?? DEFAULT_LIMITS.maxDepth),
    includeUnsupported: options.includeUnsupported ?? DEFAULT_LIMITS.includeUnsupported
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function countOf(record: Record<string, number>, key: string): number {
  return record[key] ?? 0;
}

function splitTextLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
      out.push(text.slice(start, end));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function codeLexemes(line: string): string[] {
  const out: string[] = [];
  let lexeme = "";
  for (const ch of line) {
    if (identifierChar(ch)) lexeme += ch;
    else if (lexeme) {
      out.push(lexeme);
      lexeme = "";
    }
  }
  if (lexeme) out.push(lexeme);
  return out;
}

function identifierChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 48 && cp <= 57) || ch === "_" || ch === "$" || ch.toLocaleLowerCase() !== ch.toLocaleUpperCase();
}

function identifierLike(lexeme: string): boolean {
  if (!lexeme) return false;
  const first = lexeme[0] ?? "";
  const cp = lexeme.codePointAt(0) ?? 0;
  return first === "_" || first === "$" || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || first.toLocaleLowerCase() !== first.toLocaleUpperCase();
}

function declarationMarker(lexeme: string): boolean {
  return ["function", "class", "interface", "type", "struct", "enum", "def", "fn", "const", "let", "var"].includes(lexeme);
}

function quotedStrings(text: string): string[] {
  const out: string[] = [];
  let quote: string | undefined;
  let current = "";
  let escaped = false;
  for (const ch of text) {
    if (quote) {
      if (escaped) {
        current += ch;
        escaped = false;
      } else if (ch === "\\") escaped = true;
      else if (ch === quote) {
        out.push(current);
        quote = undefined;
        current = "";
      } else current += ch;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
  }
  return out;
}

function importedNamesFromLine(line: string): string[] {
  const braceStart = line.indexOf("{");
  const braceEnd = line.indexOf("}", braceStart + 1);
  if (braceStart >= 0 && braceEnd > braceStart) return codeLexemes(line.slice(braceStart + 1, braceEnd)).filter(identifierLike).slice(0, 64);
  const lexemes = codeLexemes(line);
  const blocked = new Set(["import", "from", "require", "type", "as"]);
  return lexemes.filter(lexeme => !blocked.has(lexeme) && identifierLike(lexeme)).slice(0, 16);
}

function importLineHasSpecifier(lowerLine: string, specifier: string): boolean {
  return lowerLine.includes("import") || lowerLine.includes("require") || lowerLine.includes("include") || lowerLine.includes("using") || lowerLine.includes("from");
}

function callNames(line: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "(") continue;
    let end = i - 1;
    while (end >= 0 && line[end]?.trim() === "") end--;
    let start = end;
    while (start >= 0 && (identifierChar(line[start] ?? "") || line[start] === "." || line[start] === ":")) start--;
    const name = line.slice(start + 1, end + 1);
    if (name && identifierLike(name[0] ?? "")) out.push(name);
  }
  return out;
}

function argumentKindsForCall(line: string, call: string): string[] {
  const start = line.indexOf(call);
  const open = start >= 0 ? line.indexOf("(", start + call.length) : -1;
  const close = open >= 0 ? line.indexOf(")", open + 1) : -1;
  if (open < 0 || close < 0) return [];
  return splitTopLevel(line.slice(open + 1, close), ",").map(argumentKind).slice(0, 16);
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === delimiter && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function argumentKind(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("\"") || trimmed.startsWith("'") || trimmed.startsWith("`")) return "literal:string";
  if (trimmed === "true" || trimmed === "false") return "literal:boolean";
  if (Number.isFinite(Number(trimmed))) return "literal:number";
  if (trimmed.startsWith("{")) return "object";
  if (trimmed.startsWith("[")) return "array";
  if (trimmed.includes("=>")) return "function";
  return "symbol";
}

function nearestCallNameBefore(line: string, quoted: string): string | undefined {
  const index = line.indexOf(quoted);
  if (index < 0) return undefined;
  const prefix = line.slice(0, index);
  return callNames(prefix).pop() ?? codeLexemes(prefix).pop();
}

function routeMethodFromCall(call: string | undefined): string {
  if (!call) return "UNKNOWN";
  const lower = call.toLocaleLowerCase();
  for (const method of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    if (lower.endsWith(method) || lower.includes(`.${method}`)) return method.toUpperCase();
  }
  return call;
}

function lastIdentifier(line: string): string | undefined {
  return codeLexemes(line).filter(identifierLike).pop();
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function stableId(hasher: ReturnType<typeof createHasher>, ...parts: unknown[]): string {
  return `folder_${hasher.digestHex(JSON.stringify(parts)).slice(0, 40)}`;
}

function parseJson(text: string): Record<string, JsonValue> | undefined {
  const parsed = parseJsonValue(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, JsonValue> : undefined;
}

function parseJsonValue(text: string): JsonValue | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function recordValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function folderUri(root: string): string {
  return `file://${root.split(path.sep).join("/")}`;
}

function fileUri(filePath: string): string {
  return `file://${filePath.split(path.sep).join("/")}`;
}

function relative(root: string, target: string): string {
  const rel = path.relative(root, target).split(path.sep).join("/");
  return rel || ".";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

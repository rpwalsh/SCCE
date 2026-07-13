import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createDiagnosticRecord,
  createHasher,
  createRepoSnapshot,
  createSourceCodeFileFacts,
  createSourceRepositoryFacts,
  developerSnapshotSummary,
  diagnosticsToProgramValidationInput,
  roleEvidenceFromPath,
  toJsonValue,
  type DiagnosticRecord,
  type JsonValue,
  type RepoSnapshot,
  type SourceCodeFileFacts
} from "@scce/kernel";
import { extractNodeSourceCodeFacts } from "./code-graph.js";

export interface RepoIntelligenceFolderOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  includeUnsupported?: boolean;
}

export interface RepoIntelligenceAnalysis {
  schema: "scce.repoIntelligenceAnalysis.v1";
  rootPath: string;
  dryRun: true;
  mutation: {
    postgres: false;
    filesystemWrites: false;
    serverStarted: false;
    network: false;
  };
  limits: Required<RepoIntelligenceFolderOptions>;
  snapshot: RepoSnapshot;
  unsupportedFiles: Array<{ path: string; reason: string; byteLength?: number }>;
  warnings: string[];
}

export interface RepoDiagnosticFixtureResult {
  schema: "scce.repoDiagnosticFixture.v1";
  fixturePath: string;
  dryRun: true;
  diagnostics: DiagnosticRecord[];
  validationInput: ReturnType<typeof diagnosticsToProgramValidationInput>;
  warnings: string[];
}

export interface RepoPlanDryRun {
  schema: "scce.repoPlanDryRun.v1";
  rootPath: string;
  dryRun: true;
  snapshotSummary: JsonValue;
  engineeringContext: JsonValue;
  validationInput: ReturnType<typeof diagnosticsToProgramValidationInput>;
  observedBuildCommands: Array<{ id: string; scriptName: string; command: string; sourcePath: string; evidenceSpanId?: string }>;
  observedTestCommands: Array<{ id: string; scriptName: string; command: string; sourcePath: string; evidenceSpanId?: string }>;
  observedDependencies: Array<{ id: string; name: string; scope: string; version?: string }>;
  observedSourceLayout: string[];
  diagnostics: DiagnosticRecord[];
  warnings: string[];
  mutation: RepoIntelligenceAnalysis["mutation"];
}

interface FoundFile {
  absolutePath: string;
  relativePath: string;
  byteLength: number;
}

interface LoadedFile extends FoundFile {
  mediaType: string;
  sourceHash: string;
  text?: string;
  fileFacts?: SourceCodeFileFacts;
  unsupportedReason?: string;
}

const HASH_CHUNK_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;

const DEFAULT_LIMITS: Required<RepoIntelligenceFolderOptions> = {
  maxFiles: 3000,
  maxFileBytes: 2 * 1024 * 1024,
  maxDepth: 12,
  includeUnsupported: true
};

const SKIPPED_DIRECTORIES = new Set([".git", ".scce", ".tmp", "node_modules", ".pnpm-store", "dist", "build", "coverage", ".next", ".turbo", ".cache"]);
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
  ".woff2",
  ".xls",
  ".xlsm",
  ".xlsx"
]);

export async function analyzeDeveloperRepo(rootPath: string, options: RepoIntelligenceFolderOptions = {}, diagnostics: readonly DiagnosticRecord[] = []): Promise<RepoIntelligenceAnalysis> {
  const limits = normalizeOptions(options);
  const root = path.resolve(rootPath);
  const warnings: string[] = [];
  const discovered = await walkRepo(root, limits, warnings);
  const hasher = createHasher();
  const loaded: LoadedFile[] = [];
  const unsupportedFiles: RepoIntelligenceAnalysis["unsupportedFiles"] = [...discovered.skipped];
  for (const file of discovered.files) {
    const classified = classifyRepoFile(file.relativePath);
    if (!classified.supported) {
      if (limits.includeUnsupported) unsupportedFiles.push({ path: file.relativePath, reason: classified.reason, byteLength: file.byteLength });
      continue;
    }
    const sourceHash = await hashFileSha256(file.absolutePath);
    if (file.byteLength > limits.maxFileBytes) {
      unsupportedFiles.push({ path: file.relativePath, reason: "file_exceeds_maxFileBytes", byteLength: file.byteLength });
      loaded.push({ ...file, mediaType: classified.mediaType, sourceHash, unsupportedReason: "file_exceeds_maxFileBytes" });
      continue;
    }
    const text = await readTextFileBounded(file.absolutePath, file.byteLength);
    const fileFacts = factsForFile({ root, file, mediaType: classified.mediaType, text, sourceHash, hasher });
    loaded.push({ ...file, mediaType: classified.mediaType, sourceHash, text, fileFacts });
  }
  const fileFacts = loaded.flatMap(file => file.fileFacts ? [file.fileFacts] : []);
  const repositoryFacts = createSourceRepositoryFacts({
    rootUri: folderUri(root),
    files: loaded.map(file => ({
      path: normalizeRelative(file.relativePath),
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      contentHash: file.sourceHash,
      facts: file.fileFacts
    })),
    hasher
  });
  const snapshot = createRepoSnapshot({
    rootUri: folderUri(root),
    repositoryFacts,
    fileFacts,
    diagnostics,
    unsupportedFiles: unsupportedFiles.map(file => file.path),
    warnings,
    hasher
  });
  return {
    schema: "scce.repoIntelligenceAnalysis.v1",
    rootPath: root,
    dryRun: true,
    mutation: { postgres: false, filesystemWrites: false, serverStarted: false, network: false },
    limits,
    snapshot,
    unsupportedFiles,
    warnings
  };
}

export async function inspectDeveloperRepo(rootPath: string, options: RepoIntelligenceFolderOptions = {}): Promise<JsonValue> {
  const analysis = await analyzeDeveloperRepo(rootPath, options);
  return toJsonValue({
    schema: analysis.schema,
    rootPath: analysis.rootPath,
    dryRun: analysis.dryRun,
    mutation: analysis.mutation,
    limits: analysis.limits,
    summary: analysis.snapshot.summary,
    languages: analysis.snapshot.engineeringContext.languages.map(language => ({ id: language.id, language: language.language, fileCount: language.fileCount, confidence: language.confidence })),
    packageManagers: analysis.snapshot.engineeringContext.plannerHints.packageManagers,
    packageScripts: analysis.snapshot.buildGraph.scripts.map(script => ({ id: script.id, name: script.scriptName, command: script.command, sourcePath: script.sourcePath, evidenceSpanId: script.evidenceSpan?.id })),
    buildCommands: analysis.snapshot.buildGraph.buildCommands.map(command => ({ id: command.id, name: command.scriptName, command: command.command, sourcePath: command.sourcePath, evidenceSpanId: command.evidenceSpan?.id })),
    testCommands: analysis.snapshot.testGraph.testCommands.map(command => ({ id: command.id, name: command.scriptName, command: command.command, sourcePath: command.sourcePath, evidenceSpanId: command.evidenceSpan?.id })),
    dependencies: analysis.snapshot.dependencyGraph.dependencies.map(dep => ({ id: dep.id, name: dep.name, scope: dep.scope, version: dep.version, declaredBy: dep.declaredBy, importedBy: dep.importedBy })),
    unsupportedFiles: analysis.unsupportedFiles,
    warnings: analysis.warnings,
    hydration: { valid: analysis.snapshot.hydration.valid, diagnostics: analysis.snapshot.hydration.diagnosticsText }
  });
}

export async function graphDeveloperRepo(rootPath: string, options: RepoIntelligenceFolderOptions = {}): Promise<JsonValue> {
  const analysis = await analyzeDeveloperRepo(rootPath, options);
  const snapshot = analysis.snapshot;
  return toJsonValue({
    schema: "scce.repoIntelligenceGraph.v1",
    rootPath: analysis.rootPath,
    dryRun: true,
    mutation: analysis.mutation,
    nodes: {
      files: snapshot.files.map(file => ({ id: file.id, kind: file.kind, path: file.sourcePath, languageId: file.languageId, sourceHash: file.sourceHash })),
      directories: snapshot.directories.map(directory => ({ id: directory.id, path: directory.sourcePath, childFileCount: directory.childFileCount })),
      symbols: snapshot.symbolGraph.nodes.map(symbol => ({ id: symbol.id, name: symbol.name, kind: symbol.symbolKind, path: symbol.sourcePath, exported: symbol.exported, evidenceSpanId: symbol.evidenceSpan?.id })),
      dependencies: snapshot.dependencyGraph.dependencies.map(dep => ({ id: dep.id, name: dep.name, scope: dep.scope, declaredBy: dep.declaredBy, importedBy: dep.importedBy })),
      buildCommands: snapshot.buildGraph.buildCommands.map(command => ({ id: command.id, name: command.scriptName, command: command.command, evidenceSpanId: command.evidenceSpan?.id })),
      testCommands: snapshot.testGraph.testCommands.map(command => ({ id: command.id, name: command.scriptName, command: command.command, evidenceSpanId: command.evidenceSpan?.id })),
      diagnostics: snapshot.diagnosticsGraph.diagnostics.map(record => ({ id: record.id, kind: record.diagnosticKindId, sourcePath: record.sourcePath, line: record.line, column: record.column, severityId: record.severityId, code: record.diagnosticCode }))
    },
    edges: {
      symbol: snapshot.symbolGraph.edges,
      dependency: snapshot.dependencyGraph.edges,
      build: snapshot.buildGraph.edges,
      test: snapshot.testGraph.edges,
      diagnostics: snapshot.diagnosticsGraph.edges
    },
    summary: snapshot.summary,
    warnings: analysis.warnings
  });
}

export async function parseRepoDiagnosticsFixture(fixturePath: string): Promise<RepoDiagnosticFixtureResult> {
  const absolute = path.resolve(fixturePath);
  const hasher = createHasher();
  const sourceHash = await hashFileSha256(absolute);
  const text = await readTextFileBounded(absolute, (await stat(absolute)).size);
  const diagnostics = parseDiagnosticsText({ rootUri: fileUri(absolute), fixturePath: absolute, sourceHash, text, hasher });
  return {
    schema: "scce.repoDiagnosticFixture.v1",
    fixturePath: absolute,
    dryRun: true,
    diagnostics,
    validationInput: diagnosticsToProgramValidationInput(diagnostics),
    warnings: []
  };
}

export async function dryRunDeveloperRepoPlan(rootPath: string, options: RepoIntelligenceFolderOptions = {}, diagnostics: readonly DiagnosticRecord[] = []): Promise<RepoPlanDryRun> {
  const analysis = await analyzeDeveloperRepo(rootPath, options, diagnostics);
  const snapshot = analysis.snapshot;
  return {
    schema: "scce.repoPlanDryRun.v1",
    rootPath: analysis.rootPath,
    dryRun: true,
    snapshotSummary: developerSnapshotSummary(snapshot),
    engineeringContext: toJsonValue({
      id: snapshot.engineeringContext.id,
      summary: snapshot.engineeringContext.summary,
      plannerHints: snapshot.engineeringContext.plannerHints,
      capabilities: snapshot.engineeringContext.capabilities.map(capability => ({ kind: capability.kind, support: capability.support, confidence: capability.confidence }))
    }),
    validationInput: diagnosticsToProgramValidationInput(snapshot.diagnosticsGraph.diagnostics),
    observedBuildCommands: snapshot.buildGraph.buildCommands.map(command => ({ id: command.id, scriptName: command.scriptName, command: command.command, sourcePath: command.sourcePath, evidenceSpanId: command.evidenceSpan?.id })),
    observedTestCommands: snapshot.testGraph.testCommands.map(command => ({ id: command.id, scriptName: command.scriptName, command: command.command, sourcePath: command.sourcePath, evidenceSpanId: command.evidenceSpan?.id })),
    observedDependencies: snapshot.dependencyGraph.dependencies.map(dep => ({ id: dep.id, name: dep.name, scope: dep.scope, version: dep.version })),
    observedSourceLayout: snapshot.files.map(file => file.sourcePath).sort(),
    diagnostics: snapshot.diagnosticsGraph.diagnostics,
    warnings: analysis.warnings,
    mutation: analysis.mutation
  };
}

export function parseDiagnosticsText(input: { rootUri: string; fixturePath: string; sourceHash?: string; text: string; hasher: ReturnType<typeof createHasher> }): DiagnosticRecord[] {
  const records: DiagnosticRecord[] = [];
  const lines = splitLines(input.text);
  let currentTestName: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const compiler = parseTypeScriptDiagnosticLine(trimmed);
    if (compiler) {
      records.push(createDiagnosticRecord({
        rootUri: input.rootUri,
        sourcePath: normalizeRelative(compiler.filePath),
        sourceHash: input.sourceHash,
        diagnosticKindId: "diagnostic.kind.compiler",
        severityId: severityId(compiler.observedSeverity),
        observedSeverity: compiler.observedSeverity,
        diagnosticCode: compiler.diagnosticCode,
        message: compiler.message,
        line: compiler.line,
        column: compiler.column,
        hasher: input.hasher
      }));
      continue;
    }
    const stack = parseStackTraceLine(trimmed);
    if (stack) {
      records.push(createDiagnosticRecord({
        rootUri: input.rootUri,
        sourcePath: normalizeRelative(stack.filePath),
        sourceHash: input.sourceHash,
        diagnosticKindId: "diagnostic.kind.compiler",
        severityId: "diagnostic.severity.observed.stack",
        observedSeverity: "stack",
        message: trimmed,
        line: stack.line,
        column: stack.column,
        relatedSymbol: stack.symbol,
        hasher: input.hasher
      }));
      continue;
    }
    const testHeader = parseTestHeader(trimmed);
    if (testHeader) {
      currentTestName = testHeader.name;
      records.push(createDiagnosticRecord({
        rootUri: input.rootUri,
        sourcePath: normalizeRelative(testHeader.filePath),
        sourceHash: input.sourceHash,
        diagnosticKindId: "diagnostic.kind.test",
        severityId: severityId(testHeader.observedSeverity),
        observedSeverity: testHeader.observedSeverity,
        message: trimmed,
        testName: currentTestName,
        hasher: input.hasher
      }));
      continue;
    }
    if (currentTestName && looksLikeFailureMessage(trimmed)) {
      records.push(createDiagnosticRecord({
        rootUri: input.rootUri,
        sourcePath: normalizeRelative(input.fixturePath),
        sourceHash: input.sourceHash,
        diagnosticKindId: "diagnostic.kind.test",
        severityId: "diagnostic.severity.observed.failure-message",
        observedSeverity: "failure-message",
        message: trimmed,
        testName: currentTestName,
        hasher: input.hasher
      }));
    }
  }
  return records;
}

function factsForFile(input: { root: string; file: FoundFile; mediaType: string; text: string; sourceHash: string; hasher: ReturnType<typeof createHasher> }): SourceCodeFileFacts | undefined {
  const normalized = normalizeRelative(input.file.relativePath);
  if (input.mediaType === "text/markdown" || input.mediaType === "text/plain") {
    return createSourceCodeFileFacts({
      path: normalized,
      mediaType: input.mediaType,
      text: input.text,
      contentHash: input.sourceHash,
      parser: { id: "documentation-evidence", ok: true, diagnostics: [] },
      roleEvidence: roleEvidenceFromPath(normalized),
      hasher: input.hasher
    });
  }
  return extractNodeSourceCodeFacts({
    absolutePath: input.file.absolutePath,
    uri: normalized,
    mediaType: input.mediaType,
    text: input.text,
    sha256: input.sourceHash.startsWith("sha256_") ? input.sourceHash.slice("sha256_".length) : input.sourceHash,
    hasher: input.hasher
  });
}

async function walkRepo(root: string, limits: Required<RepoIntelligenceFolderOptions>, warnings: string[]): Promise<{ files: FoundFile[]; skipped: Array<{ path: string; reason: string; byteLength?: number }> }> {
  const files: FoundFile[] = [];
  const skipped: Array<{ path: string; reason: string; byteLength?: number }> = [];
  const pending: Array<{ absolutePath: string; depth: number }> = [{ absolutePath: root, depth: 0 }];
  while (pending.length) {
    const current = pending.shift();
    if (!current) continue;
    if (current.depth > limits.maxDepth) {
      skipped.push({ path: normalizeRelative(path.relative(root, current.absolutePath)), reason: "max_depth" });
      continue;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      warnings.push(`repo.walk.read_error:${messageOf(error)}`);
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(current.absolutePath, entry.name);
      const relativePath = normalizeRelative(path.relative(root, absolutePath));
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          skipped.push({ path: relativePath, reason: "generated_or_dependency_directory" });
          continue;
        }
        pending.push({ absolutePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: relativePath, reason: "not_regular_file" });
        continue;
      }
      const info = await stat(absolutePath);
      const skipReason = skippedSourceFileReason(relativePath);
      if (skipReason) {
        skipped.push({ path: relativePath, reason: skipReason, byteLength: info.size });
        continue;
      }
      files.push({ absolutePath, relativePath, byteLength: info.size });
      if (files.length >= limits.maxFiles) {
        warnings.push("repo.walk.max_files_reached");
        return { files, skipped };
      }
    }
  }
  return { files, skipped };
}

function classifyRepoFile(relativePath: string): { supported: boolean; mediaType: string; reason: string } {
  const normalized = normalizeRelative(relativePath);
  const lower = normalized.toLocaleLowerCase();
  const file = basename(lower);
  const ext = extensionOf(lower);
  if (file === "package.json") return { supported: true, mediaType: "application/json", reason: "package_manifest" };
  if (file === "tsconfig.json") return { supported: true, mediaType: "application/json", reason: "typescript_config" };
  if (packageLockLike(file)) return { supported: true, mediaType: "application/vnd.scce.package-lock", reason: "package_lock" };
  if (ext === ".ts" || ext === ".tsx") return { supported: true, mediaType: "text/typescript", reason: "typescript_source" };
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return { supported: true, mediaType: "text/javascript", reason: "javascript_source" };
  if (ext === ".yaml" || ext === ".yml") return { supported: true, mediaType: "application/yaml", reason: "configuration" };
  if (ext === ".md") return { supported: true, mediaType: "text/markdown", reason: "documentation" };
  if (ext === ".txt") return { supported: true, mediaType: "text/plain", reason: "text_document" };
  if (sourceLikeExtension(ext)) return { supported: true, mediaType: ext ? `text/x-source${ext}` : "text/x-source", reason: "source_extension" };
  return { supported: false, mediaType: "application/octet-stream", reason: "unsupported_extension" };
}

function parseTypeScriptDiagnosticLine(line: string): { filePath: string; line?: number; column?: number; observedSeverity: string; diagnosticCode?: string; message: string } | undefined {
  const close = line.indexOf("):");
  const open = close > 0 ? line.lastIndexOf("(", close) : -1;
  if (open <= 0 || close <= open) return undefined;
  const location = line.slice(open + 1, close);
  const locationParts = location.split(",");
  const lineNumber = numberOrUndefined(locationParts[0]);
  const column = numberOrUndefined(locationParts[1]);
  const rest = line.slice(close + 2).trim();
  const colon = rest.indexOf(":");
  const head = colon >= 0 ? rest.slice(0, colon).trim() : rest;
  const message = colon >= 0 ? rest.slice(colon + 1).trim() : rest;
  const headParts = head.split(" ").filter(Boolean);
  const observedSeverity = headParts[0] ?? "observed";
  const diagnosticCode = headParts.find(part => startsWithLettersAndDigits(part, "TS"));
  return { filePath: line.slice(0, open), line: lineNumber, column, observedSeverity, diagnosticCode, message };
}

function parseStackTraceLine(line: string): { symbol?: string; filePath: string; line?: number; column?: number } | undefined {
  const marker = line.indexOf("at ");
  if (marker < 0) return undefined;
  const body = line.slice(marker + 3).trim();
  const open = body.lastIndexOf("(");
  const close = body.endsWith(")") ? body.length - 1 : -1;
  const locationText = open >= 0 && close > open ? body.slice(open + 1, close) : body;
  const symbol = open > 0 ? body.slice(0, open).trim() : undefined;
  const location = parseColonLocation(locationText);
  return location ? { symbol, ...location } : undefined;
}

function parseTestHeader(line: string): { filePath: string; observedSeverity: string; name?: string } | undefined {
  const trimmed = line.trim();
  const heads = ["FAIL", "Failed", "failed", "not ok", "✖", "×"];
  const matched = heads.find(head => trimmed.startsWith(head));
  if (!matched) return undefined;
  const rest = trimmed.slice(matched.length).trim();
  const pieces = rest.split(" ").filter(Boolean);
  const filePath = pieces.find(piece => hasSourceExtension(piece)) ?? pieces[0] ?? "diagnostic.fixture";
  const name = pieces.filter(piece => piece !== filePath).join(" ") || undefined;
  return { filePath, observedSeverity: matched, name };
}

function parseColonLocation(value: string): { filePath: string; line?: number; column?: number } | undefined {
  const parts = value.split(":");
  if (parts.length < 2) return undefined;
  const column = numberOrUndefined(parts[parts.length - 1]);
  const line = numberOrUndefined(parts[parts.length - 2]);
  const filePath = parts.slice(0, parts.length - (column !== undefined ? 2 : 1)).join(":");
  if (!filePath) return undefined;
  return { filePath, line, column };
}

function severityId(value: string | undefined): string {
  const safe = safeIdentifier(value ?? "observed");
  return `diagnostic.severity.observed.${safe}`;
}

function looksLikeFailureMessage(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  return lower.includes("expected") || lower.includes("received") || lower.includes("assert") || lower.includes("fail");
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

async function readTextFileBounded(filePath: string, byteLength: number): Promise<string> {
  const handle = await open(filePath, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let total = 0;
  try {
    while (true) {
      const result = await handle.read(buffer, 0, buffer.byteLength, null);
      if (result.bytesRead <= 0) break;
      total += result.bytesRead;
      if (total > byteLength) throw new Error(`read exceeded inspected byte length for ${filePath}`);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
  } finally {
    await handle.close();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function normalizeOptions(options: RepoIntelligenceFolderOptions): Required<RepoIntelligenceFolderOptions> {
  return {
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_LIMITS.maxFiles),
    maxFileBytes: Math.max(1024, options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes),
    maxDepth: Math.max(0, options.maxDepth ?? DEFAULT_LIMITS.maxDepth),
    includeUnsupported: options.includeUnsupported ?? DEFAULT_LIMITS.includeUnsupported
  };
}

function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    out.push(text.slice(start, end));
    start = index + 1;
  }
  out.push(text.slice(start));
  return out;
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function startsWithLettersAndDigits(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false;
  return value.slice(prefix.length).length > 0 && [...value.slice(prefix.length)].every(ch => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 48 && cp <= 57;
  });
}

function safeIdentifier(value: string): string {
  const out: string[] = [];
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 48 && cp <= 57 || cp >= 97 && cp <= 122) out.push(char);
    else if ((char === "-" || char === "_" || char === ".") && out.length) out.push(".");
  }
  return out.join("") || "observed";
}

function packageLockLike(file: string): boolean {
  return file === "pnpm-lock.yaml"
    || file === "yarn.lock"
    || file === "package-lock.json"
    || file === "bun.lockb"
    || file === "bun.lock"
    || file === "npm-shrinkwrap.json";
}

function sourceLikeExtension(ext: string): boolean {
  if (!ext || ext.length > 12) return false;
  const excluded = new Set([".csv", ".tsv", ".log", ".json", ".yaml", ".yml", ".toml", ".lock", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".docx", ".xls", ".xlsm", ".xlsx", ".zip", ".gz", ".bz2", ".7z", ".exe", ".dll", ".bin"]);
  return !excluded.has(ext);
}

function skippedSourceFileReason(relativePath: string): "archive_file" | "binary_file" | undefined {
  const ext = extensionOf(relativePath);
  if (SKIPPED_ARCHIVE_EXTENSIONS.has(ext)) return "archive_file";
  if (SKIPPED_BINARY_EXTENSIONS.has(ext)) return "binary_file";
  return undefined;
}

function hasSourceExtension(value: string): boolean {
  return Boolean(extensionOf(value));
}

function extensionOf(filePath: string): string {
  const file = basename(filePath);
  const dot = file.lastIndexOf(".");
  return dot > 0 && dot < file.length - 1 ? file.slice(dot).toLocaleLowerCase() : "";
}

function basename(filePath: string): string {
  const normalized = normalizeRelative(filePath);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").split("\\").join("/");
}

function folderUri(root: string): string {
  return `file://${root.split(path.sep).join("/")}`;
}

function fileUri(filePath: string): string {
  return `file://${filePath.split(path.sep).join("/")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

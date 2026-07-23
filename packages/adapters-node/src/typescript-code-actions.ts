import { createHash } from "node:crypto";
import path from "node:path";
import {
  canonicalTypeScriptCodeActionPostconditionBindingId,
  canonicalTypeScriptCodeActionPostconditionIds,
  canonicalTypeScriptCodeFixIdentity,
  canonicalTypeScriptCompilerOptionsHash,
  canonicalTypeScriptDiagnosticIdentity,
  canonicalWorkspaceCompilerCandidateSetId,
  canonicalWorkspaceCompilerCommandIdentity,
  type WorkspaceCompilerAnalyzerBinding
} from "@scce/kernel";
import ts from "typescript";
import { resolveTypeScriptCommandLane } from "./typescript-command-lane.js";

const FAMILY_ID = "repair.family.typescript.code_action.v1" as const;
const DEFAULT_MAX_EDITS = 32;
const MAX_EDITS = 128;
const MAX_ACTION_FILES = 32;
const MAX_ACTION_TEXT_CHANGES = 128;
const REQUESTED_TYPESCRIPT_EXTENSIONS = /\.(?:[cm]?ts|tsx)$/iu;
const PROJECT_SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/iu;

export interface TypeScriptCodeActionSnapshotFile {
  path: string;
  content: string;
  contentHash: string;
}

export interface TypeScriptCodeActionSnapshotManifestFile {
  path: string;
  contentHash: string;
}

export interface TypeScriptCodeActionInput {
  rootPath: string;
  requestedPaths: readonly string[];
  requestText: string;
  files: readonly TypeScriptCodeActionSnapshotFile[];
  /** Complete byte-level workspace manifest; source text may be a strict subset. */
  workspaceManifest?: readonly TypeScriptCodeActionSnapshotManifestFile[];
  compilerCommand: TypeScriptObservedCompilerCommand;
  maxEdits?: number;
}

export interface TypeScriptCodeActionCandidateInput extends Omit<TypeScriptCodeActionInput, "requestText" | "workspaceManifest"> {
  workspaceManifest: readonly TypeScriptCodeActionSnapshotManifestFile[];
  diagnosticCodes?: readonly number[];
  semanticAnalyzer: {
    analyzerId: string;
    semanticRevisionHash: string;
  };
}

export interface TypeScriptObservedCompilerCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  sourcePath: string;
}

export interface TypeScriptCodeActionDiagnostic {
  code: number;
  category: string;
  start: number;
  length: number;
  message: string;
}

export interface TypeScriptCodeActionTextChange {
  start: number;
  length: number;
  newText: string;
}

export interface TypeScriptCodeActionFix {
  fixName: string;
  description: string;
  fixId?: string;
  /** Single-target compatibility view; empty for atomic multi-target actions. */
  textChanges: TypeScriptCodeActionTextChange[];
  fileChanges: TypeScriptCodeActionFileChange[];
}

export interface TypeScriptCodeActionFileChange {
  path: string;
  isNewFile: boolean;
  baseContentHash: string | null;
  textChanges: TypeScriptCodeActionTextChange[];
  afterContent: string;
  afterContentHash: `sha256:${string}`;
}

export interface TypeScriptCodeActionCompilerProvenance {
  version: string;
  tsconfigPath: string;
  tsconfigContentHash: string;
  compilerOptionsHash: `sha256:${string}`;
  compilerOptionsSource: "source_observed_tsc_project";
  configDiagnosticCodes: number[];
  sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library";
  compilerCommand: {
    executable: string;
    args: string[];
    cwd: string;
    sourcePath: string;
    sourceContentHash: string;
    sourceSelector: string;
    rawCommandHash: `sha256:${string}`;
    identity: `typescript.compiler_command:${string}`;
  };
}

export interface TypeScriptCodeActionTransformation {
  path: string;
  baseContentHash: string;
  diagnostic: TypeScriptCodeActionDiagnostic;
  codeFix: TypeScriptCodeActionFix;
  diagnosticIdentity: `typescript.diagnostic:${string}`;
  codeFixIdentity: `typescript.code_fix:${string}`;
  afterContent: string;
  afterContentHash: `sha256:${string}`;
  compiler: TypeScriptCodeActionCompilerProvenance;
  postconditionIds: string[];
  postconditionBindingId: `typescript.code_fix_postconditions:${string}`;
}

export interface TypeScriptCodeActionRepairResult {
  familyId: typeof FAMILY_ID;
  snapshotHash: `sha256:${string}`;
  requestTextHash: `sha256:${string}`;
  selection: {
    mode: "selected" | "unselected_candidates" | "ambiguous_candidates" | "selector_not_found";
    diagnosticCodes: number[];
    fixNames: string[];
    codeFixIdentities: string[];
    admissibleCandidateCount: number;
    availableCandidateCount: number;
    truncated: boolean;
    candidates: TypeScriptCodeActionCandidateSummary[];
  };
  transformations: TypeScriptCodeActionTransformation[];
}

export interface TypeScriptCodeActionCandidateSet {
  familyId: typeof FAMILY_ID;
  candidateSetId: `typescript.candidate_set:${string}`;
  snapshotHash: `sha256:${string}`;
  analyzedSnapshotHash: `sha256:${string}`;
  availableCandidateCount: number;
  truncated: boolean;
  complete: boolean;
  analyzer: WorkspaceCompilerAnalyzerBinding;
  transformations: TypeScriptCodeActionTransformation[];
}

export interface TypeScriptCodeActionCandidateSummary {
  path: string;
  diagnosticCode: number;
  diagnosticStart: number;
  fixName: string;
  codeFixIdentity: `typescript.code_fix:${string}`;
  affectedPaths: string[];
  createPaths: string[];
}

export function typescriptCompilerOptionsHash(compilerOptions: unknown): `sha256:${string}` {
  return canonicalTypeScriptCompilerOptionsHash(compilerOptions) as `sha256:${string}`;
}

export function typescriptDiagnosticIdentity(input: {
  path: string;
  diagnostic: TypeScriptCodeActionDiagnostic;
  compilerVersion: string;
  compilerOptionsHash: string;
}): `typescript.diagnostic:${string}` {
  return canonicalTypeScriptDiagnosticIdentity(input) as `typescript.diagnostic:${string}`;
}

export function typescriptCodeFixIdentity(input: {
  diagnosticIdentity: string;
  codeFix: TypeScriptCodeActionFix;
}): `typescript.code_fix:${string}` {
  return canonicalTypeScriptCodeFixIdentity(input) as `typescript.code_fix:${string}`;
}

interface SnapshotFile extends TypeScriptCodeActionSnapshotFile {
  absolutePath: string;
  canonicalAbsolutePath: string;
}

interface ExactSnapshot {
  rootPath: string;
  files: SnapshotFile[];
  byWorkspacePath: Map<string, SnapshotFile>;
  byAbsolutePath: Map<string, SnapshotFile>;
  directoryPaths: Set<string>;
  hash: `sha256:${string}`;
  workspaceHash: `sha256:${string}`;
}

interface ProjectContext {
  service: ts.LanguageService;
  provenance: TypeScriptCodeActionCompilerProvenance;
}

interface ObservedCompilerProject {
  config: SnapshotFile;
  commandLineOptions: ts.CompilerOptions;
  command: TypeScriptCodeActionCompilerProvenance["compilerCommand"];
  commandBinding: WorkspaceCompilerAnalyzerBinding["compilerCommand"];
}

interface DerivedTypeScriptCodeActions {
  snapshotHash: `sha256:${string}`;
  analyzedSnapshotHash: `sha256:${string}`;
  transformations: TypeScriptCodeActionTransformation[];
}

/**
 * Enumerates compiler-owned exact transformations without interpreting request prose.
 * The returned candidates remain unexecuted and are bound to the complete input snapshot.
 */
export function deriveTypeScriptCodeActionCandidates(
  input: TypeScriptCodeActionCandidateInput
): TypeScriptCodeActionCandidateSet | undefined {
  const derived = deriveCompilerCodeActions(input, true);
  if (!derived || derived.transformations.length === 0) return undefined;
  if (!input.semanticAnalyzer.analyzerId || input.semanticAnalyzer.analyzerId.includes("\0")
    || !input.semanticAnalyzer.semanticRevisionHash || input.semanticAnalyzer.semanticRevisionHash.includes("\0")) {
    throw new Error("semantic analyzer binding is invalid");
  }
  const limit = boundedLimit(input.maxEdits);
  const diagnosticCodes = [...new Set(input.diagnosticCodes ?? [])].sort((left, right) => left - right);
  if (diagnosticCodes.some(code => !Number.isSafeInteger(code) || code <= 0)) throw new Error("diagnostic code selector is invalid");
  const scopedTransformations = diagnosticCodes.length
    ? derived.transformations.filter(transformation => diagnosticCodes.includes(transformation.diagnostic.code))
    : derived.transformations;
  if (scopedTransformations.length === 0) return undefined;
  const transformations = scopedTransformations.slice(0, limit);
  const compiler = transformations[0]!.compiler;
  const analyzer: WorkspaceCompilerAnalyzerBinding = {
    analyzerId: input.semanticAnalyzer.analyzerId,
    analyzerVersion: compiler.version,
    semanticRevisionHash: input.semanticAnalyzer.semanticRevisionHash,
    configPath: compiler.tsconfigPath,
    configContentHash: compiler.tsconfigContentHash,
    compilerOptionsHash: compiler.compilerOptionsHash,
    compilerCommand: compiler.compilerCommand
  };
  const contract = {
    familyId: FAMILY_ID,
    snapshotHash: derived.snapshotHash,
    analyzedSnapshotHash: derived.analyzedSnapshotHash,
    availableCandidateCount: scopedTransformations.length,
    truncated: scopedTransformations.length > limit,
    complete: scopedTransformations.length <= limit,
    analyzer,
    transformations
  };
  return {
    ...contract,
    candidateSetId: canonicalWorkspaceCompilerCandidateSetId(contract) as `typescript.candidate_set:${string}`
  };
}

/**
 * Derives compiler-owned fixes from an exact in-memory workspace snapshot.
 * The function does not execute commands or read workspace source from disk.
 */
export function deriveTypeScriptCodeActionRepair(input: TypeScriptCodeActionInput): TypeScriptCodeActionRepairResult | undefined {
  const derived = deriveCompilerCodeActions(input, false);
  if (!derived || derived.transformations.length === 0) return undefined;
  const { transformations } = derived;
  const limit = boundedLimit(input.maxEdits);
  const selectors = codeActionSelectors(input);
  const admissible = transformations.filter(transformation => {
    if (selectors.diagnosticCodes.length > 0 && !selectors.diagnosticCodes.includes(transformation.diagnostic.code)) return false;
    if (selectors.fixNames.length > 0 && !selectors.fixNames.includes(transformation.codeFix.fixName)) return false;
    if (selectors.codeFixIdentities.length > 0 && !selectors.codeFixIdentities.includes(transformation.codeFixIdentity)) return false;
    return true;
  });
  const hasSelector = selectors.diagnosticCodes.length > 0
    || selectors.fixNames.length > 0
    || selectors.codeFixIdentities.length > 0;
  const selectionPool = hasSelector && admissible.length > 0 ? admissible : transformations;
  const candidates = selectionPool.slice(0, limit).map(candidateSummary);
  const mode = !hasSelector
    ? "unselected_candidates"
    : admissible.length === 0
      ? "selector_not_found"
      : admissible.length === 1
        ? "selected"
        : "ambiguous_candidates";
  return {
    familyId: FAMILY_ID,
    snapshotHash: derived.snapshotHash,
    requestTextHash: sha256(input.requestText),
    selection: {
      mode,
      diagnosticCodes: selectors.diagnosticCodes,
      fixNames: selectors.fixNames,
      codeFixIdentities: selectors.codeFixIdentities,
      admissibleCandidateCount: admissible.length,
      availableCandidateCount: transformations.length,
      truncated: selectionPool.length > candidates.length,
      candidates
    },
    transformations: mode === "selected" ? [admissible[0]!] : []
  };
}

function deriveCompilerCodeActions(
  input: Omit<TypeScriptCodeActionInput, "requestText">,
  requireExactCommandBinding: boolean
): DerivedTypeScriptCodeActions | undefined {
  const snapshot = exactSnapshot(input.rootPath, input.files, input.workspaceManifest ?? input.files);
  const requestedFiles = requestedSourceFiles(snapshot, input.requestedPaths);
  if (requestedFiles.length === 0) return undefined;
  const transformations: TypeScriptCodeActionTransformation[] = [];
  const seenFixes = new Set<string>();

  const observedProject = observedCompilerProject(snapshot, input.compilerCommand, requireExactCommandBinding);
  const project = createProjectContext(snapshot, observedProject, requestedFiles);
  try {
    for (const file of requestedFiles) {
      const diagnostics = compilerDiagnostics(project.service, file);
      for (const diagnostic of diagnostics) {
        const fixes = project.service.getCodeFixesAtPosition(
          file.absolutePath,
          diagnostic.start,
          diagnostic.start + diagnostic.length,
          [diagnostic.code],
          formatOptions(file.content),
          {}
        );
        for (const fix of fixes) {
          const transformation = materializeAtomicCodeFix({ file, diagnostic, fix, snapshot, compiler: project.provenance });
          if (!transformation || seenFixes.has(transformation.codeFixIdentity)) continue;
          seenFixes.add(transformation.codeFixIdentity);
          transformations.push(transformation);
        }
      }
    }
  } finally {
    project.service.dispose();
  }

  transformations.sort((left, right) => compareCanonical(left.path, right.path)
    || left.diagnostic.start - right.diagnostic.start
    || left.diagnostic.code - right.diagnostic.code
    || compareCanonical(left.codeFix.fixName, right.codeFix.fixName)
    || compareCanonical(left.codeFixIdentity, right.codeFixIdentity));
  if (transformations.length === 0) return undefined;
  return {
    snapshotHash: snapshot.workspaceHash,
    analyzedSnapshotHash: snapshot.hash,
    transformations
  };
}

function candidateSummary(transformation: TypeScriptCodeActionTransformation): TypeScriptCodeActionCandidateSummary {
  return {
    path: transformation.path,
    diagnosticCode: transformation.diagnostic.code,
    diagnosticStart: transformation.diagnostic.start,
    fixName: transformation.codeFix.fixName,
    codeFixIdentity: transformation.codeFixIdentity,
    affectedPaths: transformation.codeFix.fileChanges.map(change => change.path),
    createPaths: transformation.codeFix.fileChanges.filter(change => change.isNewFile).map(change => change.path)
  };
}

function exactSnapshot(
  rootPath: string,
  inputFiles: readonly TypeScriptCodeActionSnapshotFile[],
  manifestFiles: readonly TypeScriptCodeActionSnapshotManifestFile[]
): ExactSnapshot {
  const root = path.resolve(rootPath);
  const manifestByPath = new Map<string, `sha256:${string}`>();
  const manifestByAbsolutePath = new Map<string, string>();
  for (const input of manifestFiles) {
    const workspacePath = normalizeWorkspacePath(input.path);
    if (manifestByPath.has(workspacePath)) throw new Error(`duplicate workspace manifest path: ${workspacePath}`);
    const canonicalContentHash = `sha256:${canonicalHash(input.contentHash)}` as const;
    const canonical = canonicalAbsolute(workspaceAbsolutePath(root, workspacePath));
    if (manifestByAbsolutePath.has(canonical)) throw new Error(`case-colliding workspace manifest path: ${workspacePath}`);
    manifestByPath.set(workspacePath, canonicalContentHash);
    manifestByAbsolutePath.set(canonical, workspacePath);
  }
  if (manifestByPath.size === 0) throw new Error("workspace manifest is empty");
  const files: SnapshotFile[] = [];
  const byWorkspacePath = new Map<string, SnapshotFile>();
  const byAbsolutePath = new Map<string, SnapshotFile>();
  const directoryPaths = new Set<string>([canonicalAbsolute(root)]);
  for (const input of inputFiles) {
    const workspacePath = normalizeWorkspacePath(input.path);
    if (byWorkspacePath.has(workspacePath)) throw new Error(`duplicate workspace snapshot path: ${workspacePath}`);
    assertContentHash(workspacePath, input.content, input.contentHash);
    const contentHash = `sha256:${canonicalHash(input.contentHash)}` as const;
    if (manifestByPath.get(workspacePath) !== contentHash) {
      throw new Error(`analyzed source is absent or stale in the complete workspace manifest: ${workspacePath}`);
    }
    const absolutePath = workspaceAbsolutePath(root, workspacePath);
    const canonical = canonicalAbsolute(absolutePath);
    if (byAbsolutePath.has(canonical)) throw new Error(`case-colliding workspace snapshot path: ${workspacePath}`);
    const file: SnapshotFile = { ...input, path: workspacePath, contentHash, absolutePath, canonicalAbsolutePath: canonical };
    files.push(file);
    byWorkspacePath.set(workspacePath, file);
    byAbsolutePath.set(canonical, file);
    addParentDirectories(directoryPaths, root, absolutePath);
  }
  files.sort((left, right) => compareCanonical(left.path, right.path));
  return {
    rootPath: root,
    files,
    byWorkspacePath,
    byAbsolutePath,
    directoryPaths,
    hash: sha256(files.map(file => `${file.path}\0${canonicalHash(file.contentHash)}`).join("\0")),
    workspaceHash: sha256([...manifestByPath.entries()]
      .sort((left, right) => compareCanonical(left[0], right[0]))
      .map(([workspacePath, contentHash]) => `${workspacePath}\0${canonicalHash(contentHash)}`)
      .join("\0"))
  };
}

function requestedSourceFiles(snapshot: ExactSnapshot, requestedPaths: readonly string[]): SnapshotFile[] {
  const out = new Map<string, SnapshotFile>();
  for (const requestedPath of requestedPaths) {
    const workspacePath = normalizeWorkspacePath(requestedPath);
    const file = snapshot.byWorkspacePath.get(workspacePath);
    if (!file) throw new Error(`requested path is absent from the exact workspace snapshot: ${workspacePath}`);
    if (!REQUESTED_TYPESCRIPT_EXTENSIONS.test(file.path)) throw new Error(`requested path is not a TypeScript source file: ${workspacePath}`);
    out.set(file.path, file);
  }
  return [...out.values()].sort((left, right) => compareCanonical(left.path, right.path));
}

function observedCompilerProject(
  snapshot: ExactSnapshot,
  input: TypeScriptObservedCompilerCommand,
  requireExactCommandBinding: boolean
): ObservedCompilerProject {
  const sourcePath = normalizeWorkspacePath(input.sourcePath);
  const source = snapshot.byWorkspacePath.get(sourcePath);
  if (!source) throw new Error(`source-observed tsc command artifact is absent from the exact snapshot: ${sourcePath}`);
  if (executableName(input.executable) !== "tsc") {
    throw new Error(`source-observed compiler command is not direct tsc: ${input.executable}`);
  }
  const cwd = normalizeWorkspaceDirectory(input.cwd);
  const expectedCwd = path.posix.dirname(sourcePath) === "." ? "." : path.posix.dirname(sourcePath);
  if (cwd !== expectedCwd) {
    throw new Error(`source-observed tsc cwd does not match its command source context: expected ${expectedCwd}, found ${cwd}`);
  }
  if (input.args.some(arg => typeof arg !== "string" || !arg || arg.includes("\0"))) {
    throw new Error("source-observed tsc command contains an invalid argument");
  }
  const commandLine = ts.parseCommandLine([...input.args]);
  if (commandLine.errors.length > 0) {
    throw new Error(`source-observed tsc command is not parseable: ${diagnosticCodes(commandLine.errors).join(",")}`);
  }
  if (commandLine.fileNames.length > 0) {
    throw new Error("source-observed tsc command uses explicit input files instead of a bindable project config");
  }
  const cwdAbsolute = cwd === "." ? snapshot.rootPath : workspaceAbsolutePath(snapshot.rootPath, cwd);
  const config = commandLine.options.project
    ? exactProjectConfig(snapshot, cwdAbsolute, commandLine.options.project)
    : upwardDefaultProjectConfig(snapshot, cwdAbsolute);
  if (!config) {
    throw new Error("source-observed tsc project config cannot be identified and bound to the exact workspace snapshot");
  }
  const exactCommandBinding = exactObservedCommandBinding(source, input, cwd);
  if (requireExactCommandBinding && !exactCommandBinding) {
    throw new Error("source-observed tsc command does not have one exact source binding");
  }
  const unboundBase = {
    executable: input.executable,
    args: [...input.args],
    cwd,
    sourcePath,
    sourceContentHash: source.contentHash,
    sourceSelector: "scce.command_source.unbound.v1",
    rawCommandHash: sha256("")
  };
  const commandBinding = exactCommandBinding ?? {
    ...unboundBase,
    identity: canonicalWorkspaceCompilerCommandIdentity(unboundBase) as `typescript.compiler_command:${string}`
  };
  const { project: _project, ...commandLineOptions } = commandLine.options;
  return {
    config,
    commandLineOptions,
    command: commandBinding,
    commandBinding
  };
}

function exactObservedCommandBinding(
  source: SnapshotFile,
  input: TypeScriptObservedCompilerCommand,
  cwd: string
): TypeScriptCodeActionCompilerProvenance["compilerCommand"] | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(source.content);
  } catch {
    return undefined;
  }
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    return undefined;
  }
  const scripts = (manifest as Record<string, unknown>).scripts;
  if (!scripts || Array.isArray(scripts) || typeof scripts !== "object") {
    return undefined;
  }
  const matches: Array<{ sourceSelector: string; rawCommandHash: `sha256:${string}` }> = [];
  for (const [name, rawCommand] of Object.entries(scripts as Record<string, unknown>).sort((left, right) => compareCanonical(left[0], right[0]))) {
    if (typeof rawCommand !== "string") continue;
    const sourceSelector = `scripts.${name}`;
    const resolved = resolveTypeScriptCommandLane({ rawCommand, sourceSelector, sourcePath: source.path, cwd });
    if (!resolved.ok || resolved.lane.wrapper !== "direct" || !resolved.lane.languageServiceCompatible) continue;
    if (executableName(resolved.lane.compilerExecutable) !== executableName(input.executable)
      || stableSerialize(resolved.lane.normalizedTscArgs) !== stableSerialize(input.args)) continue;
    matches.push({ sourceSelector, rawCommandHash: sha256(rawCommand) });
  }
  if (matches.length !== 1) return undefined;
  const base = {
    executable: input.executable,
    args: [...input.args],
    cwd,
    sourcePath: source.path,
    sourceContentHash: source.contentHash,
    sourceSelector: matches[0]!.sourceSelector,
    rawCommandHash: matches[0]!.rawCommandHash
  };
  return { ...base, identity: canonicalWorkspaceCompilerCommandIdentity(base) as `typescript.compiler_command:${string}` };
}

function exactProjectConfig(snapshot: ExactSnapshot, cwdAbsolute: string, projectValue: string): SnapshotFile | undefined {
  if (!projectValue.trim()) return undefined;
  const resolved = path.resolve(cwdAbsolute, projectValue);
  if (!isWithinDirectory(resolved, snapshot.rootPath)) return undefined;
  const exact = snapshot.byAbsolutePath.get(canonicalAbsolute(resolved));
  if (exact) return exact;
  return snapshot.byAbsolutePath.get(canonicalAbsolute(path.join(resolved, "tsconfig.json")));
}

function upwardDefaultProjectConfig(snapshot: ExactSnapshot, cwdAbsolute: string): SnapshotFile | undefined {
  let directory = path.resolve(cwdAbsolute);
  while (isWithinDirectory(directory, snapshot.rootPath)) {
    const config = snapshot.byAbsolutePath.get(canonicalAbsolute(path.join(directory, "tsconfig.json")));
    if (config) return config;
    if (canonicalAbsolute(directory) === canonicalAbsolute(snapshot.rootPath)) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

function createProjectContext(snapshot: ExactSnapshot, observed: ObservedCompilerProject, requestedFiles: readonly SnapshotFile[]): ProjectContext {
  const parsed = parsedConfig(snapshot, observed.config, observed.commandLineOptions);
  const configDiagnosticCodes = diagnosticCodes(parsed.errors);
  if (configDiagnosticCodes.length > 0) {
    throw new Error(`source-observed tsc project config is invalid: ${configDiagnosticCodes.join(",")}`);
  }
  const configuredFileNames = new Set(parsed.fileNames.map(canonicalAbsolute));
  for (const requestedFile of requestedFiles) {
    if (!configuredFileNames.has(requestedFile.canonicalAbsolutePath)) {
      throw new Error(`requested TypeScript source is outside the source-observed tsc project: ${requestedFile.path}`);
    }
  }
  const scriptFileNames = [...new Set(parsed.fileNames.filter(fileName => {
    const file = snapshot.byAbsolutePath.get(canonicalAbsolute(fileName));
    return Boolean(file && PROJECT_SOURCE_EXTENSIONS.test(file.path));
  }))].sort((left, right) => left.localeCompare(right));
  const compilerOptions: ts.CompilerOptions = { ...parsed.options };
  const compilerLibDirectory = path.dirname(ts.getDefaultLibFilePath(compilerOptions));
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getProjectReferences: () => parsed.projectReferences,
    getScriptFileNames: () => [...scriptFileNames],
    getScriptVersion: fileName => snapshot.byAbsolutePath.get(canonicalAbsolute(fileName))?.contentHash ?? `typescript-${ts.version}`,
    getScriptSnapshot: fileName => {
      const file = snapshot.byAbsolutePath.get(canonicalAbsolute(fileName));
      if (file) return ts.ScriptSnapshot.fromString(file.content);
      const library = readCompilerLibrary(fileName, compilerLibDirectory);
      return library === undefined ? undefined : ts.ScriptSnapshot.fromString(library);
    },
    getScriptKind: scriptKind,
    getCurrentDirectory: () => snapshot.rootPath,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    getNewLine: () => projectNewLine(requestedFiles, compilerOptions),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    fileExists: fileName => snapshot.byAbsolutePath.has(canonicalAbsolute(fileName)) || compilerLibraryExists(fileName, compilerLibDirectory),
    readFile: fileName => snapshot.byAbsolutePath.get(canonicalAbsolute(fileName))?.content ?? readCompilerLibrary(fileName, compilerLibDirectory),
    readDirectory: (rootDir, extensions, excludes, includes, depth) => snapshotReadDirectory(snapshot, rootDir, extensions, excludes, includes, depth),
    directoryExists: directoryName => snapshot.directoryPaths.has(canonicalAbsolute(directoryName)) || compilerLibraryDirectory(directoryName, compilerLibDirectory),
    getDirectories: directoryName => snapshotDirectories(snapshot, directoryName),
    realpath: fileName => path.resolve(fileName),
    getProjectVersion: () => snapshot.hash
  };
  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames, snapshot.rootPath)),
    provenance: {
      version: ts.version,
      tsconfigPath: observed.config.path,
      tsconfigContentHash: observed.config.contentHash,
      compilerOptionsHash: typescriptCompilerOptionsHash(portableCompilerValue(compilerOptions, snapshot.rootPath)),
      compilerOptionsSource: "source_observed_tsc_project",
      configDiagnosticCodes,
      sourceFileBoundary: "workspace_snapshot_and_typescript_standard_library",
      compilerCommand: observed.command
    }
  };
}

function parsedConfig(snapshot: ExactSnapshot, config: SnapshotFile, commandLineOptions: ts.CompilerOptions): ts.ParsedCommandLine {
  const json = ts.parseConfigFileTextToJson(config.absolutePath, config.content);
  if (json.error) {
    return { options: { noEmit: true }, fileNames: [], errors: [json.error] };
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: fileName => snapshot.byAbsolutePath.has(canonicalAbsolute(fileName)),
    readFile: fileName => snapshot.byAbsolutePath.get(canonicalAbsolute(fileName))?.content,
    readDirectory: (rootDir, extensions, excludes, includes, depth) => snapshotReadDirectory(snapshot, rootDir, extensions, excludes, includes, depth)
  };
  return ts.parseJsonConfigFileContent(json.config, host, path.dirname(config.absolutePath), commandLineOptions, config.absolutePath);
}

function compilerDiagnostics(service: ts.LanguageService, file: SnapshotFile): Array<TypeScriptCodeActionDiagnostic & { source: ts.Diagnostic }> {
  const diagnostics = [
    ...service.getSyntacticDiagnostics(file.absolutePath),
    ...service.getSemanticDiagnostics(file.absolutePath),
    ...service.getSuggestionDiagnostics(file.absolutePath)
  ];
  const out = new Map<string, TypeScriptCodeActionDiagnostic & { source: ts.Diagnostic }>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.file || canonicalAbsolute(diagnostic.file.fileName) !== file.canonicalAbsolutePath) continue;
    if (typeof diagnostic.start !== "number" || diagnostic.start < 0 || diagnostic.start > file.content.length) continue;
    const length = Math.max(0, Math.min(diagnostic.length ?? 0, file.content.length - diagnostic.start));
    const value = {
      code: diagnostic.code,
      category: diagnosticCategory(diagnostic.category),
      start: diagnostic.start,
      length,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      source: diagnostic
    };
    out.set(`${value.code}:${value.start}:${value.length}:${value.message}`, value);
  }
  return [...out.values()].sort((left, right) => left.start - right.start || left.code - right.code || compareCanonical(left.message, right.message));
}

function materializeAtomicCodeFix(input: {
  file: SnapshotFile;
  diagnostic: TypeScriptCodeActionDiagnostic & { source: ts.Diagnostic };
  fix: ts.CodeFixAction;
  snapshot: ExactSnapshot;
  compiler: TypeScriptCodeActionCompilerProvenance;
}): TypeScriptCodeActionTransformation | undefined {
  if ((input.fix.commands?.length ?? 0) > 0
    || input.fix.changes.length === 0
    || input.fix.changes.length > MAX_ACTION_FILES) return undefined;
  const materializedChanges: TypeScriptCodeActionFileChange[] = [];
  const seenPaths = new Set<string>();
  let totalTextChanges = 0;
  for (const fileChange of input.fix.changes) {
    const candidatePath = workspacePathForCompilerChange(input.snapshot, fileChange.fileName);
    if (!candidatePath) return undefined;
    const candidateAbsolute = workspaceAbsolutePath(input.snapshot.rootPath, candidatePath);
    const target = input.snapshot.byAbsolutePath.get(canonicalAbsolute(candidateAbsolute));
    const workspacePath = target?.path ?? candidatePath;
    if (seenPaths.has(workspacePath)) return undefined;
    seenPaths.add(workspacePath);
    const isNewFile = fileChange.isNewFile === true;
    if (isNewFile === Boolean(target)) return undefined;
    if (isNewFile) {
      if (!PROJECT_SOURCE_EXTENSIONS.test(workspacePath)) return undefined;
      const parent = path.dirname(workspaceAbsolutePath(input.snapshot.rootPath, workspacePath));
      if (!input.snapshot.directoryPaths.has(canonicalAbsolute(parent))) return undefined;
    }
    const baseContent = target?.content ?? "";
    const changes = orderedNonOverlappingChanges(baseContent, fileChange.textChanges);
    if (!changes || changes.length === 0) return undefined;
    totalTextChanges += changes.length;
    if (totalTextChanges > MAX_ACTION_TEXT_CHANGES) return undefined;
    const afterContent = applyTextChanges(baseContent, changes);
    if (afterContent === baseContent) return undefined;
    materializedChanges.push({
      path: workspacePath,
      isNewFile,
      baseContentHash: target?.contentHash ?? null,
      textChanges: changes,
      afterContent,
      afterContentHash: sha256(afterContent)
    });
  }
  materializedChanges.sort((left, right) => compareCanonical(left.path, right.path));
  const diagnostic: TypeScriptCodeActionDiagnostic = {
    code: input.diagnostic.code,
    category: input.diagnostic.category,
    start: input.diagnostic.start,
    length: input.diagnostic.length,
    message: input.diagnostic.message
  };
  const fixId = codeFixId(input.fix.fixId);
  const diagnosticIdentity = typescriptDiagnosticIdentity({
    path: input.file.path,
    diagnostic,
    compilerVersion: input.compiler.version,
    compilerOptionsHash: input.compiler.compilerOptionsHash
  });
  const codeFix: TypeScriptCodeActionFix = {
    fixName: input.fix.fixName,
    description: input.fix.description,
    ...(fixId ? { fixId } : {}),
    textChanges: materializedChanges.length === 1 && materializedChanges[0]!.path === input.file.path
      ? [...materializedChanges[0]!.textChanges]
      : [],
    fileChanges: materializedChanges
  };
  const codeFixIdentity = typescriptCodeFixIdentity({
    diagnosticIdentity,
    codeFix
  });
  const postconditionIds = canonicalTypeScriptCodeActionPostconditionIds(diagnostic.code);
  const postconditionBindingId = canonicalTypeScriptCodeActionPostconditionBindingId(codeFixIdentity, diagnostic.code) as `typescript.code_fix_postconditions:${string}`;
  return {
    path: input.file.path,
    baseContentHash: input.file.contentHash,
    diagnostic,
    codeFix,
    diagnosticIdentity,
    codeFixIdentity,
    afterContent: materializedChanges.find(change => change.path === input.file.path)?.afterContent ?? input.file.content,
    afterContentHash: materializedChanges.find(change => change.path === input.file.path)?.afterContentHash ?? sha256(input.file.content),
    compiler: input.compiler,
    postconditionIds,
    postconditionBindingId
  };
}

function workspacePathForCompilerChange(snapshot: ExactSnapshot, fileName: string): string | undefined {
  if (!fileName || fileName.includes("\0")) return undefined;
  const absolute = path.resolve(fileName);
  if (!isWithinDirectory(absolute, snapshot.rootPath)) return undefined;
  const relative = path.relative(snapshot.rootPath, absolute).replace(/\\/gu, "/");
  try {
    return normalizeWorkspacePath(relative);
  } catch {
    return undefined;
  }
}

function orderedNonOverlappingChanges(content: string, input: readonly ts.TextChange[]): TypeScriptCodeActionTextChange[] | undefined {
  const changes = input.map(change => ({ start: change.span.start, length: change.span.length, newText: change.newText }))
    .sort((left, right) => left.start - right.start || left.length - right.length || compareCanonical(left.newText, right.newText));
  let previousStart = -1;
  let previousEnd = -1;
  for (const change of changes) {
    if (!Number.isSafeInteger(change.start) || !Number.isSafeInteger(change.length) || change.start < 0 || change.length < 0 || change.start + change.length > content.length) return undefined;
    if (previousEnd >= 0 && (change.start < previousEnd || (change.start === previousStart && (change.length === 0 || previousEnd === previousStart)))) return undefined;
    previousStart = change.start;
    previousEnd = change.start + change.length;
  }
  return changes;
}

function applyTextChanges(content: string, changes: readonly TypeScriptCodeActionTextChange[]): string {
  let output = content;
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, change.start)}${change.newText}${output.slice(change.start + change.length)}`;
  }
  return output;
}

function snapshotReadDirectory(
  snapshot: ExactSnapshot,
  rootDir: string,
  extensions: readonly string[] = [],
  excludes: readonly string[] | undefined = [],
  includes: readonly string[] = [],
  depth?: number
): string[] {
  const root = path.resolve(rootDir);
  return snapshot.files.filter(file => {
    const relative = path.relative(root, file.absolutePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return false;
    const workspaceRelative = relative.replace(/\\/gu, "/");
    if (typeof depth === "number" && workspaceRelative.split("/").length - 1 > depth) return false;
    if (extensions.length > 0 && !extensions.some(extension => workspaceRelative.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()))) return false;
    if (includes.length > 0 && !includes.some(pattern => globMatches(workspaceRelative, pattern))) return false;
    if ((excludes ?? []).some(pattern => globMatches(workspaceRelative, pattern))) return false;
    return true;
  }).map(file => file.absolutePath);
}

function snapshotDirectories(snapshot: ExactSnapshot, directoryName: string): string[] {
  const root = path.resolve(directoryName);
  const directories = new Set<string>();
  for (const file of snapshot.files) {
    const relative = path.relative(root, file.absolutePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
    const first = relative.split(path.sep)[0];
    if (first && first !== path.basename(file.absolutePath)) directories.add(path.join(root, first));
  }
  return [...directories].sort(compareCanonical);
}

function globMatches(relativePath: string, rawPattern: string): boolean {
  let pattern = rawPattern.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!pattern) return false;
  if (!/[?*]/u.test(pattern)) {
    pattern = path.posix.extname(pattern) ? pattern : `${pattern}/**/*`;
  }
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  expression += "$";
  return new RegExp(expression, ts.sys.useCaseSensitiveFileNames ? "u" : "iu").test(relativePath);
}

function formatOptions(source: string): ts.FormatCodeSettings {
  const formatting = sourceFormatting(source);
  return {
    indentSize: formatting.indentSize,
    tabSize: formatting.tabSize,
    newLineCharacter: formatting.newLine,
    convertTabsToSpaces: formatting.convertTabsToSpaces,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
    insertSpaceBeforeFunctionParenthesis: false,
    placeOpenBraceOnNewLineForFunctions: false,
    placeOpenBraceOnNewLineForControlBlocks: false
  };
}

function sourceFormatting(source: string): { indentSize: number; tabSize: number; newLine: "\n" | "\r\n"; convertTabsToSpaces: boolean } {
  const crlf = (source.match(/\r\n/gu) ?? []).length;
  const lf = (source.match(/(?<!\r)\n/gu) ?? []).length;
  const indents = source.split(/\r?\n/gu).map(line => /^([\t ]+)/u.exec(line)?.[1]).filter((value): value is string => Boolean(value));
  const tabIndented = indents.filter(indent => indent.startsWith("\t")).length;
  const spaceWidths = indents.filter(indent => /^ +$/u.test(indent)).map(indent => indent.length).filter(width => width > 0 && width <= 8);
  const indentSize = spaceWidths.length > 0 ? Math.max(1, Math.min(...spaceWidths)) : 2;
  return {
    indentSize,
    tabSize: indentSize,
    newLine: crlf > lf ? "\r\n" : "\n",
    convertTabsToSpaces: tabIndented <= indents.length / 2
  };
}

function projectNewLine(files: readonly SnapshotFile[], compilerOptions: ts.CompilerOptions): "\n" | "\r\n" {
  if (compilerOptions.newLine === ts.NewLineKind.CarriageReturnLineFeed) return "\r\n";
  if (compilerOptions.newLine === ts.NewLineKind.LineFeed) return "\n";
  const crlf = files.reduce((sum, file) => sum + (file.content.match(/\r\n/gu) ?? []).length, 0);
  const lf = files.reduce((sum, file) => sum + (file.content.match(/(?<!\r)\n/gu) ?? []).length, 0);
  return crlf > lf ? "\r\n" : "\n";
}

function codeActionSelectors(input: TypeScriptCodeActionInput): { diagnosticCodes: number[]; fixNames: string[]; codeFixIdentities: string[] } {
  const diagnosticCodes = new Set<number>();
  for (const match of input.requestText.matchAll(/\bTS(\d{3,6})\b/giu)) {
    const code = Number(match[1]);
    if (Number.isSafeInteger(code) && code > 0) diagnosticCodes.add(code);
  }
  const fixNames = new Set<string>();
  for (const match of input.requestText.matchAll(/\bfixName\s*[:=]\s*["']?([\w.-]+)/gu)) {
    if (match[1]) fixNames.add(match[1]);
  }
  const codeFixIdentities = new Set<string>();
  for (const match of input.requestText.matchAll(/\bcodeFixIdentity\s*[:=]\s*["']?(typescript\.code_fix:[0-9a-f]{64})\b/gu)) {
    if (match[1]) codeFixIdentities.add(match[1]);
  }
  return {
    diagnosticCodes: [...diagnosticCodes].sort((left, right) => left - right),
    fixNames: [...fixNames].sort(compareCanonical),
    codeFixIdentities: [...codeFixIdentities].sort(compareCanonical)
  };
}

function diagnosticCodes(diagnostics: readonly ts.Diagnostic[]): number[] {
  return [...new Set(diagnostics.map(diagnostic => diagnostic.code))].sort((left, right) => left - right);
}

function scriptKind(fileName: string): ts.ScriptKind {
  const lower = fileName.toLocaleLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/u.test(lower)) return ts.ScriptKind.TS;
  if (/\.[cm]?js$/u.test(lower)) return ts.ScriptKind.JS;
  if (lower.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.Unknown;
}

function compilerLibraryExists(fileName: string, compilerLibDirectory: string): boolean {
  return isWithinDirectory(fileName, compilerLibDirectory) && ts.sys.fileExists(fileName);
}

function readCompilerLibrary(fileName: string, compilerLibDirectory: string): string | undefined {
  return isWithinDirectory(fileName, compilerLibDirectory) ? ts.sys.readFile(fileName) : undefined;
}

function compilerLibraryDirectory(directoryName: string, compilerLibDirectory: string): boolean {
  return isWithinDirectory(directoryName, compilerLibDirectory) && (ts.sys.directoryExists?.(directoryName) ?? false);
}

function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizeWorkspacePath(value: string): string {
  const portable = value.replace(/\\/gu, "/");
  if (!value || value !== value.trim() || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)
    || value.normalize("NFC") !== value || portable.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`invalid workspace-relative path: ${value}`);
  }
  return portable;
}

function normalizeWorkspaceDirectory(value: string): string {
  if (value === "." || value === "") return ".";
  return normalizeWorkspacePath(value).replace(/\/$/u, "");
}

function executableName(command: string): string {
  return path.basename(command).replace(/\.(?:cmd|exe)$/iu, "").toLocaleLowerCase();
}

function workspaceAbsolutePath(root: string, workspacePath: string): string {
  const absolute = path.resolve(root, ...workspacePath.split("/"));
  if (!isWithinDirectory(absolute, root)) throw new Error(`workspace path escapes root: ${workspacePath}`);
  return absolute;
}

function addParentDirectories(directories: Set<string>, root: string, absoluteFile: string): void {
  let current = path.dirname(absoluteFile);
  while (isWithinDirectory(current, root)) {
    directories.add(canonicalAbsolute(current));
    if (canonicalAbsolute(current) === canonicalAbsolute(root)) break;
    current = path.dirname(current);
  }
}

function canonicalAbsolute(value: string): string {
  const absolute = path.resolve(value);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLocaleLowerCase();
}

function assertContentHash(workspacePath: string, content: string, contentHash: string): void {
  const expected = canonicalHash(contentHash);
  const actual = sha256Hex(content);
  if (expected !== actual) throw new Error(`workspace snapshot content hash mismatch: ${workspacePath}`);
}

function canonicalHash(value: string): string {
  const match = /^(?:sha256[:_])?([0-9a-f]{64})$/iu.exec(value.trim());
  if (!match?.[1]) throw new Error(`workspace snapshot content hash is not sha256: ${value}`);
  return match[1].toLocaleLowerCase();
}

function codeFixId(value: {} | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : stableSerialize(value);
}

function diagnosticCategory(category: ts.DiagnosticCategory): string {
  return (ts.DiagnosticCategory[category] ?? String(category)).toLocaleLowerCase();
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_EDITS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("maxEdits must be a positive safe integer");
  return Math.min(value, MAX_EDITS);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function portableCompilerValue(value: unknown, workspaceRoot: string): unknown {
  if (typeof value === "string") {
    if (path.isAbsolute(value) && isWithinDirectory(value, workspaceRoot)) {
      const relative = path.relative(workspaceRoot, value).replace(/\\/gu, "/");
      return `<workspace>/${relative}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => portableCompilerValue(item, workspaceRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, portableCompilerValue(item, workspaceRoot)]));
  }
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

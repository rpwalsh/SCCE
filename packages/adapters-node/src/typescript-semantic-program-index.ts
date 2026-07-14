import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA = "scce.typescript.semantic_program_index.v1" as const;

export type TypeScriptSemanticHash = `sha256:${string}`;

export interface TypeScriptSemanticProgramBounds {
  /** Exact workspace-relative files that may be read. No implicit workspace traversal occurs. */
  readonly workspacePaths: readonly string[];
  /** Test membership is supplied as a source observation, not inferred from English names. */
  readonly observedTestPaths?: readonly string[];
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface TypeScriptSemanticProgramIndexInput {
  readonly workspaceRoot: string;
  readonly tsconfigPath: string;
  readonly bounds: TypeScriptSemanticProgramBounds;
}

export interface TypeScriptExactSourceSpan {
  readonly path: string;
  readonly contentHash: TypeScriptSemanticHash;
  /** TypeScript/JavaScript UTF-16 offsets. */
  readonly start: number;
  readonly length: number;
  readonly end: number;
  /** One-based line and column positions. */
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly textHash: TypeScriptSemanticHash;
}

export interface TypeScriptSemanticFile {
  readonly id: string;
  readonly kindId: "scce.program.file.v1";
  readonly path: string;
  readonly contentHash: TypeScriptSemanticHash;
  readonly byteLength: number;
  readonly charLength: number;
  readonly syntaxKind: ts.ScriptKind;
  readonly compilerOwned: boolean;
  readonly observedTest: boolean;
  readonly span: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticSymbol {
  readonly id: string;
  readonly kindId: "scce.program.symbol.v1";
  readonly nameEvidence: string;
  readonly flags: number;
  readonly declarationIds: readonly string[];
}

export interface TypeScriptSemanticDeclaration {
  readonly id: string;
  readonly kindId: "scce.program.declaration.v1";
  readonly fileId: string;
  readonly symbolId: string;
  readonly nameEvidence: string;
  readonly syntaxKind: ts.SyntaxKind;
  readonly exported: boolean;
  readonly span: TypeScriptExactSourceSpan;
  readonly nameSpan: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticReference {
  readonly id: string;
  readonly kindId: "scce.program.reference.v1";
  readonly fileId: string;
  readonly targetSymbolId: string;
  readonly bindingSymbolId?: string;
  readonly sourceDeclarationId?: string;
  readonly declarationOccurrence: boolean;
  readonly span: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticImportBinding {
  readonly kindId:
    | "scce.program.import.binding.default.v1"
    | "scce.program.import.binding.namespace.v1"
    | "scce.program.import.binding.named.v1";
  readonly localNameEvidence: string;
  readonly sourceNameEvidence?: string;
  readonly bindingSymbolId?: string;
  readonly targetSymbolId?: string;
  readonly span: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticImport {
  readonly id: string;
  readonly kindId: "scce.program.import.v1";
  readonly fileId: string;
  readonly moduleSpecifierEvidence: string;
  readonly moduleSpecifierSpan: TypeScriptExactSourceSpan;
  readonly span: TypeScriptExactSourceSpan;
  readonly targetFileId?: string;
  readonly typeOnly: boolean;
  readonly bindings: readonly TypeScriptSemanticImportBinding[];
}

export interface TypeScriptSemanticCall {
  readonly id: string;
  readonly kindId: "scce.program.call.v1";
  readonly fileId: string;
  readonly targetSymbolId: string;
  readonly sourceDeclarationId?: string;
  readonly signatureDeclarationId?: string;
  readonly argumentCount: number;
  readonly calleeSpan: TypeScriptExactSourceSpan;
  readonly span: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticDiagnosticRelatedEvidence {
  readonly rawMessageEvidence: string;
  readonly messageHash: TypeScriptSemanticHash;
  readonly span?: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticDiagnostic {
  readonly id: string;
  readonly kindId: "scce.program.diagnostic.v1";
  readonly compilerCode: number;
  readonly compilerCategory: number;
  readonly categoryId: string;
  readonly originIds: readonly string[];
  /** Compiler wording is retained only as source evidence; it does not drive intent selection. */
  readonly rawMessageEvidence: string;
  readonly messageHash: TypeScriptSemanticHash;
  readonly span?: TypeScriptExactSourceSpan;
  readonly relatedEvidence: readonly TypeScriptSemanticDiagnosticRelatedEvidence[];
}

export interface TypeScriptSemanticConfig {
  readonly id: string;
  readonly kindId: "scce.program.config.typescript.v1";
  readonly path: string;
  readonly contentHash: TypeScriptSemanticHash;
  readonly compilerVersion: string;
  readonly compilerOptionsHash: TypeScriptSemanticHash;
  readonly span: TypeScriptExactSourceSpan;
}

export interface TypeScriptConfigOwnership {
  readonly id: string;
  readonly kindId: "scce.rel.program.config_ownership.v1";
  readonly configId: string;
  readonly fileId: string;
  readonly configSpan: TypeScriptExactSourceSpan;
  readonly fileSpan: TypeScriptExactSourceSpan;
}

export interface TypeScriptObservedProgramCommand {
  readonly id: string;
  readonly kindId: "scce.program.command.package_script.v1";
  readonly sourceFileId: string;
  readonly sourceNameEvidence: string;
  readonly rawCommandEvidence: string;
  readonly nameSpan: TypeScriptExactSourceSpan;
  readonly commandSpan: TypeScriptExactSourceSpan;
}

export interface TypeScriptTestRelation {
  readonly id: string;
  readonly kindId:
    | "scce.rel.program.test_import.v1"
    | "scce.rel.program.test_call.v1"
    | "scce.rel.program.test_reference.v1";
  readonly testFileId: string;
  readonly targetFileId?: string;
  readonly targetSymbolId?: string;
  readonly importId?: string;
  readonly callId?: string;
  readonly referenceId?: string;
  readonly evidenceSpan: TypeScriptExactSourceSpan;
}

export interface TypeScriptSemanticProgramIndex {
  readonly schemaVersion: typeof TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA;
  readonly revisionHash: TypeScriptSemanticHash;
  readonly config: TypeScriptSemanticConfig;
  readonly files: readonly TypeScriptSemanticFile[];
  readonly symbols: readonly TypeScriptSemanticSymbol[];
  readonly declarations: readonly TypeScriptSemanticDeclaration[];
  readonly references: readonly TypeScriptSemanticReference[];
  readonly imports: readonly TypeScriptSemanticImport[];
  readonly calls: readonly TypeScriptSemanticCall[];
  readonly diagnostics: readonly TypeScriptSemanticDiagnostic[];
  readonly configOwnership: readonly TypeScriptConfigOwnership[];
  readonly commands: readonly TypeScriptObservedProgramCommand[];
  readonly testRelations: readonly TypeScriptTestRelation[];
}

interface SnapshotFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly canonicalAbsolutePath: string;
  readonly content: string;
  readonly bytes: Uint8Array;
  readonly contentHash: TypeScriptSemanticHash;
  readonly byteLength: number;
  readonly sourceFile: ts.SourceFile;
}

interface ExactSnapshot {
  readonly rootPath: string;
  readonly files: readonly SnapshotFile[];
  readonly byPath: ReadonlyMap<string, SnapshotFile>;
  readonly byAbsolutePath: ReadonlyMap<string, SnapshotFile>;
  readonly directoryPaths: ReadonlySet<string>;
  readonly observedTestPaths: ReadonlySet<string>;
  readonly revisionHash: TypeScriptSemanticHash;
}

interface SymbolState {
  readonly source: ts.Symbol;
  readonly id: string;
  readonly nameEvidence: string;
  readonly flags: number;
}

interface DiagnosticAccumulator {
  readonly diagnostic: ts.Diagnostic;
  readonly originIds: Set<string>;
}

/**
 * Builds one compiler-backed semantic index from an exact, explicitly bounded
 * workspace snapshot. It never executes a command and never reads an implicit
 * workspace file. TypeScript's installed standard-library files are the only
 * compiler reads permitted outside the snapshot.
 */
export async function buildTypeScriptSemanticProgramIndex(
  input: TypeScriptSemanticProgramIndexInput
): Promise<TypeScriptSemanticProgramIndex> {
  const snapshot = await readExactSnapshot(input);
  const configFile = snapshot.byPath.get(normalizeWorkspacePath(input.tsconfigPath));
  if (!configFile) throw new Error("typescript semantic index config is absent from the bounded snapshot");

  const parsed = parseProjectConfig(snapshot, configFile);
  assertParsedProjectIsBounded(snapshot, parsed);
  const host = createBoundedCompilerHost(snapshot, parsed.options);
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames],
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: parsed.errors,
    host
  });
  const checker = program.getTypeChecker();
  const compilerSourceFiles = program.getSourceFiles()
    .map(sourceFile => ({ sourceFile, snapshotFile: snapshot.byAbsolutePath.get(canonicalAbsolute(sourceFile.fileName)) }))
    .filter((entry): entry is { sourceFile: ts.SourceFile; snapshotFile: SnapshotFile } => Boolean(entry.snapshotFile))
    .sort((left, right) => compareCanonical(left.snapshotFile.path, right.snapshotFile.path));
  const compilerOwnedPaths = new Set(compilerSourceFiles.map(entry => entry.snapshotFile.path));

  const files = snapshot.files.map(file => semanticFile(snapshot, file, compilerOwnedPaths.has(file.path)));
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const fileByAbsolutePath = new Map(snapshot.files.map(file => [file.canonicalAbsolutePath, fileByPath.get(file.path)!]));
  const configSemanticFile = fileByPath.get(configFile.path)!;
  const config: TypeScriptSemanticConfig = {
    id: stableId("typescript_config", configFile.path, configFile.contentHash),
    kindId: "scce.program.config.typescript.v1",
    path: configFile.path,
    contentHash: configFile.contentHash,
    compilerVersion: ts.version,
    compilerOptionsHash: sha256Text(stableSerialize(portableValue(parsed.options, snapshot.rootPath))),
    span: configSemanticFile.span
  };

  const exportedSymbols = exportedWorkspaceSymbols(checker, compilerSourceFiles);
  const symbolStateBySymbol = new Map<ts.Symbol, SymbolState>();
  const declarationIdByNode = new Map<ts.Node, string>();
  const declarationNameNodes = new Set<ts.Node>();
  const declarations: TypeScriptSemanticDeclaration[] = [];

  const ensureSymbol = (source: ts.Symbol | undefined): SymbolState | undefined => {
    if (!source) return undefined;
    const existing = symbolStateBySymbol.get(source);
    if (existing) return existing;
    const workspaceDeclarations = (source.declarations ?? [])
      .map(declaration => ({
        declaration,
        file: snapshot.byAbsolutePath.get(canonicalAbsolute(declaration.getSourceFile().fileName))
      }))
      .filter((entry): entry is { declaration: ts.Declaration; file: SnapshotFile } => Boolean(entry.file))
      .sort((left, right) => compareCanonical(left.file.path, right.file.path) || left.declaration.pos - right.declaration.pos);
    if (workspaceDeclarations.length === 0) return undefined;
    const identity = workspaceDeclarations.map(entry => [
      entry.file.path,
      entry.declaration.getStart(entry.declaration.getSourceFile(), false),
      entry.declaration.getEnd(),
      entry.declaration.kind
    ]);
    const state: SymbolState = {
      source,
      id: stableId("typescript_symbol", configFile.path, source.getName(), stableSerialize(identity)),
      nameEvidence: source.getName(),
      flags: source.flags
    };
    symbolStateBySymbol.set(source, state);
    return state;
  };

  for (const { sourceFile, snapshotFile } of compilerSourceFiles) {
    visit(sourceFile, node => {
      const names = declarationNames(node);
      for (const nameNode of names) {
        if (declarationNameNodes.has(nameNode)) continue;
        const symbol = checker.getSymbolAtLocation(nameNode);
        const state = ensureSymbol(symbol);
        if (!state) continue;
        declarationNameNodes.add(nameNode);
        const id = stableId(
          "typescript_declaration",
          snapshotFile.path,
          String(node.getStart(sourceFile, false)),
          String(node.getEnd()),
          String(node.kind),
          state.id
        );
        declarationIdByNode.set(node, id);
        declarations.push({
          id,
          kindId: "scce.program.declaration.v1",
          fileId: fileByPath.get(snapshotFile.path)!.id,
          symbolId: state.id,
          nameEvidence: nameNode.getText(sourceFile),
          syntaxKind: node.kind,
          exported: Boolean(symbol && exportedSymbols.has(resolveAlias(checker, symbol) ?? symbol)),
          span: spanForNode(snapshotFile, sourceFile, node),
          nameSpan: spanForNode(snapshotFile, sourceFile, nameNode)
        });
      }
    });
  }

  const imports: TypeScriptSemanticImport[] = [];
  const calls: TypeScriptSemanticCall[] = [];
  const references: TypeScriptSemanticReference[] = [];
  const resolutionHost = moduleResolutionHost(host);

  for (const { sourceFile, snapshotFile } of compilerSourceFiles) {
    const sourceFileId = fileByPath.get(snapshotFile.path)!.id;
    visit(sourceFile, node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const bindings = importBindings(node, sourceFile, snapshotFile, checker, ensureSymbol);
        const resolved = ts.resolveModuleName(
          node.moduleSpecifier.text,
          sourceFile.fileName,
          parsed.options,
          resolutionHost
        ).resolvedModule;
        const targetFile = resolved
          ? fileByAbsolutePath.get(canonicalAbsolute(resolved.resolvedFileName))
          : undefined;
        const span = spanForNode(snapshotFile, sourceFile, node);
        imports.push({
          id: stableId("typescript_import", snapshotFile.path, String(span.start), String(span.length)),
          kindId: "scce.program.import.v1",
          fileId: sourceFileId,
          moduleSpecifierEvidence: node.moduleSpecifier.text,
          moduleSpecifierSpan: spanForNode(snapshotFile, sourceFile, node.moduleSpecifier),
          span,
          targetFileId: targetFile?.id,
          typeOnly: Boolean(node.importClause?.isTypeOnly),
          bindings
        });
      }

      if (ts.isCallExpression(node)) {
        const location = callSymbolLocation(node.expression);
        const local = checker.getSymbolAtLocation(location);
        const target = resolveAlias(checker, local);
        const targetState = ensureSymbol(target);
        if (targetState) {
          const signatureNode = checker.getResolvedSignature(node)?.declaration;
          const span = spanForNode(snapshotFile, sourceFile, node);
          calls.push({
            id: stableId("typescript_call", snapshotFile.path, String(span.start), String(span.length), targetState.id),
            kindId: "scce.program.call.v1",
            fileId: sourceFileId,
            targetSymbolId: targetState.id,
            sourceDeclarationId: nearestDeclarationId(node.parent, declarationIdByNode),
            signatureDeclarationId: signatureNode ? declarationIdByNode.get(signatureNode) : undefined,
            argumentCount: node.arguments.length,
            calleeSpan: spanForNode(snapshotFile, sourceFile, node.expression),
            span
          });
        }
      }

      if (ts.isIdentifier(node)) {
        const local = checker.getSymbolAtLocation(node);
        const bindingState = ensureSymbol(local);
        const target = resolveAlias(checker, local);
        const targetState = ensureSymbol(target);
        if (!targetState) return;
        const span = spanForNode(snapshotFile, sourceFile, node);
        references.push({
          id: stableId("typescript_reference", snapshotFile.path, String(span.start), String(span.length), targetState.id),
          kindId: "scce.program.reference.v1",
          fileId: sourceFileId,
          targetSymbolId: targetState.id,
          bindingSymbolId: bindingState && bindingState.id !== targetState.id ? bindingState.id : undefined,
          sourceDeclarationId: nearestDeclarationId(node.parent, declarationIdByNode),
          declarationOccurrence: declarationNameNodes.has(node),
          span
        });
      }
    });
  }

  const sortedDeclarations = [...declarations].sort(compareBySpanThenId);
  const declarationIdsBySymbol = new Map<string, string[]>();
  for (const declaration of sortedDeclarations) {
    const values = declarationIdsBySymbol.get(declaration.symbolId) ?? [];
    values.push(declaration.id);
    declarationIdsBySymbol.set(declaration.symbolId, values);
  }
  const symbols: TypeScriptSemanticSymbol[] = [...symbolStateBySymbol.values()]
    .map(state => ({
      id: state.id,
      kindId: "scce.program.symbol.v1" as const,
      nameEvidence: state.nameEvidence,
      flags: state.flags,
      declarationIds: [...(declarationIdsBySymbol.get(state.id) ?? [])].sort(compareCanonical)
    }))
    .sort((left, right) => compareCanonical(left.id, right.id));

  const diagnostics = collectDiagnostics(snapshot, parsed.errors, program);
  const configOwnership = compilerSourceFiles.map(({ snapshotFile }) => {
    const file = fileByPath.get(snapshotFile.path)!;
    return {
      id: stableId("typescript_config_ownership", config.id, file.id),
      kindId: "scce.rel.program.config_ownership.v1" as const,
      configId: config.id,
      fileId: file.id,
      configSpan: config.span,
      fileSpan: file.span
    };
  }).sort((left, right) => compareCanonical(left.fileId, right.fileId));
  const commands = snapshot.files
    .filter(file => path.posix.basename(file.path).toLocaleLowerCase() === "package.json")
    .flatMap(file => observedPackageCommands(file, fileByPath.get(file.path)!))
    .sort((left, right) => compareCanonical(left.sourceFileId, right.sourceFileId) || left.nameSpan.start - right.nameSpan.start);
  const sortedImports = [...imports].sort(compareBySpanThenId);
  const sortedCalls = [...calls].sort(compareBySpanThenId);
  const sortedReferences = [...references].sort(compareBySpanThenId);
  const testRelations = buildTestRelations(snapshot, fileByPath, sortedImports, sortedCalls, sortedReferences, symbols, sortedDeclarations);

  return {
    schemaVersion: TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA,
    revisionHash: snapshot.revisionHash,
    config,
    files,
    symbols,
    declarations: sortedDeclarations,
    references: sortedReferences,
    imports: sortedImports,
    calls: sortedCalls,
    diagnostics,
    configOwnership,
    commands,
    testRelations
  };
}

async function readExactSnapshot(input: TypeScriptSemanticProgramIndexInput): Promise<ExactSnapshot> {
  assertPositiveBound(input.bounds.maxFiles, "maxFiles");
  assertPositiveBound(input.bounds.maxFileBytes, "maxFileBytes");
  assertPositiveBound(input.bounds.maxTotalBytes, "maxTotalBytes");
  if (input.bounds.workspacePaths.length < 1 || input.bounds.workspacePaths.length > input.bounds.maxFiles) {
    throw new Error("typescript semantic index workspace path count exceeds its explicit bound");
  }
  const rootPath = await realpath(path.resolve(input.workspaceRoot));
  const rootStat = await lstat(rootPath);
  if (!rootStat.isDirectory()) throw new Error("typescript semantic index workspace root is not a directory");

  const normalizedPaths = input.bounds.workspacePaths.map(normalizeWorkspacePath);
  if (new Set(normalizedPaths.map(canonicalWorkspacePath)).size !== normalizedPaths.length) {
    throw new Error("typescript semantic index workspace paths contain duplicates");
  }
  const observedTestPaths = new Set((input.bounds.observedTestPaths ?? []).map(normalizeWorkspacePath));
  for (const testPath of observedTestPaths) {
    if (!normalizedPaths.includes(testPath)) throw new Error(`observed test path is outside the bounded snapshot: ${testPath}`);
  }

  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  for (const workspacePath of [...normalizedPaths].sort(compareCanonical)) {
    const absolutePath = workspaceAbsolutePath(rootPath, workspacePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`bounded workspace path is not a regular non-symbolic file: ${workspacePath}`);
    const canonicalPath = await realpath(absolutePath);
    if (!isWithinDirectory(canonicalPath, rootPath)) throw new Error(`bounded workspace path resolves outside the workspace: ${workspacePath}`);
    if (stat.size > input.bounds.maxFileBytes) throw new Error(`bounded workspace file exceeds maxFileBytes: ${workspacePath}`);
    totalBytes += stat.size;
    if (totalBytes > input.bounds.maxTotalBytes) throw new Error("typescript semantic index snapshot exceeds maxTotalBytes");
    const bytes = new Uint8Array(await readFile(canonicalPath));
    if (bytes.byteLength !== stat.size) throw new Error(`bounded workspace file changed while being read: ${workspacePath}`);
    const content = Buffer.from(bytes).toString("utf8");
    files.push({
      path: workspacePath,
      absolutePath: canonicalPath,
      canonicalAbsolutePath: canonicalAbsolute(canonicalPath),
      content,
      bytes,
      contentHash: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
      sourceFile: ts.createSourceFile(canonicalPath, content, ts.ScriptTarget.Latest, true, scriptKind(canonicalPath))
    });
  }
  const byPath = new Map(files.map(file => [file.path, file]));
  const byAbsolutePath = new Map<string, SnapshotFile>();
  const directoryPaths = new Set<string>([canonicalAbsolute(rootPath)]);
  for (const file of files) {
    if (byAbsolutePath.has(file.canonicalAbsolutePath)) throw new Error(`bounded workspace paths collide after resolution: ${file.path}`);
    byAbsolutePath.set(file.canonicalAbsolutePath, file);
    addParentDirectories(directoryPaths, rootPath, file.absolutePath);
  }
  const revisionHash = sha256Text([
    TYPESCRIPT_SEMANTIC_PROGRAM_INDEX_SCHEMA,
    ts.version,
    ...files.flatMap(file => [file.path, file.contentHash, String(file.byteLength)])
  ].join("\u0000"));
  return { rootPath, files, byPath, byAbsolutePath, directoryPaths, observedTestPaths, revisionHash };
}

function parseProjectConfig(snapshot: ExactSnapshot, config: SnapshotFile): ts.ParsedCommandLine {
  const json = ts.parseConfigFileTextToJson(config.absolutePath, config.content);
  if (json.error) return { options: {}, fileNames: [], errors: [json.error] };
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: fileName => snapshot.byAbsolutePath.has(canonicalAbsolute(fileName)),
    readFile: fileName => snapshot.byAbsolutePath.get(canonicalAbsolute(fileName))?.content,
    readDirectory: (rootDir, extensions, excludes, includes, depth) => snapshotReadDirectory(snapshot, rootDir, extensions, excludes, includes, depth)
  };
  return ts.parseJsonConfigFileContent(json.config, host, path.dirname(config.absolutePath), undefined, config.absolutePath);
}

function assertParsedProjectIsBounded(snapshot: ExactSnapshot, parsed: ts.ParsedCommandLine): void {
  for (const fileName of parsed.fileNames) {
    const absolute = path.resolve(fileName);
    if (!isWithinDirectory(absolute, snapshot.rootPath)) throw new Error(`tsconfig selects a source outside the bounded workspace: ${fileName}`);
    if (!snapshot.byAbsolutePath.has(canonicalAbsolute(absolute))) {
      throw new Error(`tsconfig selects a source outside the explicit bounded snapshot: ${workspaceDisplayPath(snapshot.rootPath, absolute)}`);
    }
  }
  for (const reference of parsed.projectReferences ?? []) {
    const referencePath = path.resolve(reference.path);
    const configPath = snapshot.byAbsolutePath.has(canonicalAbsolute(referencePath))
      ? referencePath
      : path.join(referencePath, "tsconfig.json");
    if (!isWithinDirectory(configPath, snapshot.rootPath) || !snapshot.byAbsolutePath.has(canonicalAbsolute(configPath))) {
      throw new Error(`tsconfig project reference is outside the explicit bounded snapshot: ${reference.path}`);
    }
  }
}

function createBoundedCompilerHost(snapshot: ExactSnapshot, options: ts.CompilerOptions): ts.CompilerHost {
  const compilerLibraryRoot = path.dirname(ts.getDefaultLibFilePath(options));
  const readAllowed = (fileName: string): string | undefined => {
    const bounded = snapshot.byAbsolutePath.get(canonicalAbsolute(fileName));
    if (bounded) return bounded.content;
    return isWithinDirectory(fileName, compilerLibraryRoot) ? ts.sys.readFile(fileName) : undefined;
  };
  const fileExists = (fileName: string): boolean => snapshot.byAbsolutePath.has(canonicalAbsolute(fileName))
    || isWithinDirectory(fileName, compilerLibraryRoot) && ts.sys.fileExists(fileName);
  return {
    getSourceFile(fileName, languageVersion) {
      const content = readAllowed(fileName);
      return content === undefined ? undefined : ts.createSourceFile(fileName, content, languageVersion, true, scriptKind(fileName));
    },
    getDefaultLibFileName: compilerOptions => ts.getDefaultLibFilePath(compilerOptions),
    writeFile: () => undefined,
    getCurrentDirectory: () => snapshot.rootPath,
    getDirectories: directoryName => snapshotDirectories(snapshot, directoryName),
    getCanonicalFileName: fileName => ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLocaleLowerCase(),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    fileExists,
    readFile: readAllowed,
    directoryExists: directoryName => snapshot.directoryPaths.has(canonicalAbsolute(directoryName))
      || isWithinDirectory(directoryName, compilerLibraryRoot) && Boolean(ts.sys.directoryExists?.(directoryName)),
    realpath: fileName => path.resolve(fileName)
  };
}

function moduleResolutionHost(host: ts.CompilerHost): ts.ModuleResolutionHost {
  return {
    fileExists: host.fileExists,
    readFile: host.readFile,
    directoryExists: host.directoryExists,
    getDirectories: host.getDirectories,
    realpath: host.realpath,
    getCurrentDirectory: host.getCurrentDirectory,
    useCaseSensitiveFileNames: host.useCaseSensitiveFileNames()
  };
}

function semanticFile(snapshot: ExactSnapshot, file: SnapshotFile, compilerOwned: boolean): TypeScriptSemanticFile {
  return {
    id: stableId("typescript_file", file.path, file.contentHash),
    kindId: "scce.program.file.v1",
    path: file.path,
    contentHash: file.contentHash,
    byteLength: file.byteLength,
    charLength: file.content.length,
    syntaxKind: scriptKind(file.path),
    compilerOwned,
    observedTest: snapshot.observedTestPaths.has(file.path),
    span: spanForRange(file, file.sourceFile, 0, file.content.length)
  };
}

function exportedWorkspaceSymbols(
  checker: ts.TypeChecker,
  sourceFiles: readonly { sourceFile: ts.SourceFile; snapshotFile: SnapshotFile }[]
): Set<ts.Symbol> {
  const out = new Set<ts.Symbol>();
  for (const { sourceFile } of sourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) out.add(resolveAlias(checker, exported) ?? exported);
  }
  return out;
}

function declarationNames(node: ts.Node): ts.Node[] {
  let name: ts.DeclarationName | ts.BindingName | undefined;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)
    || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node) || ts.isEnumMember(node) || ts.isVariableDeclaration(node)
    || ts.isParameter(node) || ts.isBindingElement(node) || ts.isMethodDeclaration(node)
    || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isModuleDeclaration(node)
    || ts.isTypeParameterDeclaration(node) || ts.isImportClause(node) || ts.isImportSpecifier(node)
    || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
    name = node.name;
  }
  return name ? bindingNameNodes(name) : [];
}

function bindingNameNodes(name: ts.DeclarationName | ts.BindingName): ts.Node[] {
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNameNodes(element.name));
  }
  return [name];
}

function importBindings(
  declaration: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  snapshotFile: SnapshotFile,
  checker: ts.TypeChecker,
  ensureSymbol: (source: ts.Symbol | undefined) => SymbolState | undefined
): TypeScriptSemanticImportBinding[] {
  const clause = declaration.importClause;
  if (!clause) return [];
  const out: TypeScriptSemanticImportBinding[] = [];
  const add = (
    name: ts.Identifier,
    kindId: TypeScriptSemanticImportBinding["kindId"],
    sourceNameEvidence?: string
  ): void => {
    const local = checker.getSymbolAtLocation(name);
    const target = resolveAlias(checker, local);
    out.push({
      kindId,
      localNameEvidence: name.text,
      sourceNameEvidence,
      bindingSymbolId: ensureSymbol(local)?.id,
      targetSymbolId: ensureSymbol(target)?.id,
      span: spanForNode(snapshotFile, sourceFile, name)
    });
  };
  if (clause.name) add(clause.name, "scce.program.import.binding.default.v1");
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    add(clause.namedBindings.name, "scce.program.import.binding.namespace.v1");
  } else if (clause.namedBindings) {
    for (const element of clause.namedBindings.elements) {
      add(element.name, "scce.program.import.binding.named.v1", (element.propertyName ?? element.name).text);
    }
  }
  return out.sort((left, right) => left.span.start - right.span.start);
}

function collectDiagnostics(
  snapshot: ExactSnapshot,
  configDiagnostics: readonly ts.Diagnostic[],
  program: ts.Program
): TypeScriptSemanticDiagnostic[] {
  const groups: Array<{ originId: string; diagnostics: readonly ts.Diagnostic[] }> = [
    { originId: "typescript.diagnostic.origin.config.v1", diagnostics: configDiagnostics },
    { originId: "typescript.diagnostic.origin.options.v1", diagnostics: program.getOptionsDiagnostics() },
    { originId: "typescript.diagnostic.origin.global.v1", diagnostics: program.getGlobalDiagnostics() },
    { originId: "typescript.diagnostic.origin.syntax.v1", diagnostics: program.getSyntacticDiagnostics() },
    { originId: "typescript.diagnostic.origin.semantic.v1", diagnostics: program.getSemanticDiagnostics() }
  ];
  const accumulated = new Map<string, DiagnosticAccumulator>();
  for (const group of groups) {
    for (const diagnostic of group.diagnostics) {
      const file = diagnostic.file ? snapshot.byAbsolutePath.get(canonicalAbsolute(diagnostic.file.fileName)) : undefined;
      const start = file && typeof diagnostic.start === "number" ? diagnostic.start : undefined;
      const length = file && start !== undefined ? Math.max(0, Math.min(diagnostic.length ?? 0, file.content.length - start)) : undefined;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const key = stableSerialize([diagnostic.code, diagnostic.category, file?.path, start, length, message]);
      const existing = accumulated.get(key);
      if (existing) existing.originIds.add(group.originId);
      else accumulated.set(key, { diagnostic, originIds: new Set([group.originId]) });
    }
  }
  return [...accumulated.values()].map(({ diagnostic, originIds }) => {
    const file = diagnostic.file ? snapshot.byAbsolutePath.get(canonicalAbsolute(diagnostic.file.fileName)) : undefined;
    const start = file && typeof diagnostic.start === "number" ? diagnostic.start : undefined;
    const length = file && start !== undefined ? Math.max(0, Math.min(diagnostic.length ?? 0, file.content.length - start)) : undefined;
    const rawMessageEvidence = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const span = file && start !== undefined && length !== undefined
      ? spanForRange(file, diagnostic.file!, start, length)
      : undefined;
    const relatedEvidence = (diagnostic.relatedInformation ?? []).map(related => {
      const relatedFile = related.file ? snapshot.byAbsolutePath.get(canonicalAbsolute(related.file.fileName)) : undefined;
      const relatedStart = relatedFile && typeof related.start === "number" ? related.start : undefined;
      const relatedLength = relatedFile && relatedStart !== undefined
        ? Math.max(0, Math.min(related.length ?? 0, relatedFile.content.length - relatedStart))
        : undefined;
      const relatedMessage = ts.flattenDiagnosticMessageText(related.messageText, "\n");
      return {
        rawMessageEvidence: relatedMessage,
        messageHash: sha256Text(relatedMessage),
        span: relatedFile && relatedStart !== undefined && relatedLength !== undefined
          ? spanForRange(relatedFile, related.file!, relatedStart, relatedLength)
          : undefined
      };
    }).sort((left, right) => compareCanonical(left.span?.path ?? "", right.span?.path ?? "") || (left.span?.start ?? -1) - (right.span?.start ?? -1));
    const sortedOrigins = [...originIds].sort(compareCanonical);
    return {
      id: stableId(
        "typescript_diagnostic",
        String(diagnostic.code),
        String(diagnostic.category),
        span?.path ?? "",
        String(span?.start ?? -1),
        String(span?.length ?? -1),
        rawMessageEvidence
      ),
      kindId: "scce.program.diagnostic.v1" as const,
      compilerCode: diagnostic.code,
      compilerCategory: diagnostic.category,
      categoryId: `typescript.diagnostic.category.${diagnostic.category}.v1`,
      originIds: sortedOrigins,
      rawMessageEvidence,
      messageHash: sha256Text(rawMessageEvidence),
      span,
      relatedEvidence
    };
  }).sort((left, right) => compareCanonical(left.span?.path ?? "", right.span?.path ?? "")
    || (left.span?.start ?? -1) - (right.span?.start ?? -1)
    || left.compilerCode - right.compilerCode
    || compareCanonical(left.id, right.id));
}

function observedPackageCommands(file: SnapshotFile, semanticFileRecord: TypeScriptSemanticFile): TypeScriptObservedProgramCommand[] {
  const jsonSource = ts.parseJsonText(file.absolutePath, file.content);
  const statement = jsonSource.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isObjectLiteralExpression(statement.expression)) return [];
  const scriptsProperty = statement.expression.properties.find(property => ts.isPropertyAssignment(property)
    && propertyNameEvidence(property.name) === "scripts");
  if (!scriptsProperty || !ts.isPropertyAssignment(scriptsProperty) || !ts.isObjectLiteralExpression(scriptsProperty.initializer)) return [];
  const commands: TypeScriptObservedProgramCommand[] = [];
  for (const property of scriptsProperty.initializer.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
    const sourceNameEvidence = propertyNameEvidence(property.name);
    if (sourceNameEvidence === undefined) continue;
    const nameSpan = spanForNode(file, jsonSource, property.name);
    const commandSpan = spanForNode(file, jsonSource, property.initializer);
    commands.push({
      id: stableId("typescript_package_command", file.path, String(nameSpan.start), String(commandSpan.start)),
      kindId: "scce.program.command.package_script.v1",
      sourceFileId: semanticFileRecord.id,
      sourceNameEvidence,
      rawCommandEvidence: property.initializer.text,
      nameSpan,
      commandSpan
    });
  }
  return commands;
}

function buildTestRelations(
  snapshot: ExactSnapshot,
  fileByPath: ReadonlyMap<string, TypeScriptSemanticFile>,
  imports: readonly TypeScriptSemanticImport[],
  calls: readonly TypeScriptSemanticCall[],
  references: readonly TypeScriptSemanticReference[],
  symbols: readonly TypeScriptSemanticSymbol[],
  declarations: readonly TypeScriptSemanticDeclaration[]
): TypeScriptTestRelation[] {
  const testFileIds = new Set([...snapshot.observedTestPaths].map(testPath => fileByPath.get(testPath)?.id).filter((id): id is string => Boolean(id)));
  const declarationById = new Map(declarations.map(declaration => [declaration.id, declaration]));
  const symbolById = new Map(symbols.map(symbol => [symbol.id, symbol]));
  const targetFileForSymbol = (symbolId: string): string | undefined => {
    const declarationId = symbolById.get(symbolId)?.declarationIds[0];
    return declarationId ? declarationById.get(declarationId)?.fileId : undefined;
  };
  const out: TypeScriptTestRelation[] = [];
  for (const item of imports) {
    if (!testFileIds.has(item.fileId) || !item.targetFileId) continue;
    out.push({
      id: stableId("typescript_test_import", item.fileId, item.id, item.targetFileId),
      kindId: "scce.rel.program.test_import.v1",
      testFileId: item.fileId,
      targetFileId: item.targetFileId,
      importId: item.id,
      evidenceSpan: item.span
    });
  }
  for (const item of calls) {
    if (!testFileIds.has(item.fileId)) continue;
    out.push({
      id: stableId("typescript_test_call", item.fileId, item.id, item.targetSymbolId),
      kindId: "scce.rel.program.test_call.v1",
      testFileId: item.fileId,
      targetFileId: targetFileForSymbol(item.targetSymbolId),
      targetSymbolId: item.targetSymbolId,
      callId: item.id,
      evidenceSpan: item.span
    });
  }
  for (const item of references) {
    if (!testFileIds.has(item.fileId) || item.declarationOccurrence) continue;
    const targetFileId = targetFileForSymbol(item.targetSymbolId);
    if (!targetFileId || targetFileId === item.fileId) continue;
    out.push({
      id: stableId("typescript_test_reference", item.fileId, item.id, item.targetSymbolId),
      kindId: "scce.rel.program.test_reference.v1",
      testFileId: item.fileId,
      targetFileId,
      targetSymbolId: item.targetSymbolId,
      referenceId: item.id,
      evidenceSpan: item.span
    });
  }
  return out.sort((left, right) => compareCanonical(left.testFileId, right.testFileId)
    || left.evidenceSpan.start - right.evidenceSpan.start
    || compareCanonical(left.id, right.id));
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  const target = checker.getAliasedSymbol(symbol);
  return target.flags === ts.SymbolFlags.None ? undefined : target;
}

function nearestDeclarationId(node: ts.Node | undefined, ids: ReadonlyMap<ts.Node, string>): string | undefined {
  let cursor = node;
  while (cursor) {
    const id = ids.get(cursor);
    if (id) return id;
    cursor = cursor.parent;
  }
  return undefined;
}

function callSymbolLocation(expression: ts.LeftHandSideExpression): ts.Node {
  if (ts.isPropertyAccessExpression(expression)) return expression.name;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) return expression.argumentExpression;
  return expression;
}

function propertyNameEvidence(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function visit(root: ts.Node, consumer: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    consumer(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function spanForNode(file: SnapshotFile, sourceFile: ts.SourceFile, node: ts.Node): TypeScriptExactSourceSpan {
  const start = node.getStart(sourceFile, false);
  return spanForRange(file, sourceFile, start, Math.max(0, node.getEnd() - start));
}

function spanForRange(file: SnapshotFile, sourceFile: ts.SourceFile, start: number, length: number): TypeScriptExactSourceSpan {
  const boundedStart = Math.max(0, Math.min(start, file.content.length));
  const boundedLength = Math.max(0, Math.min(length, file.content.length - boundedStart));
  const end = boundedStart + boundedLength;
  const beginLocation = sourceFile.getLineAndCharacterOfPosition(boundedStart);
  const endLocation = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    path: file.path,
    contentHash: file.contentHash,
    start: boundedStart,
    length: boundedLength,
    end,
    startLine: beginLocation.line + 1,
    startColumn: beginLocation.character + 1,
    endLine: endLocation.line + 1,
    endColumn: endLocation.character + 1,
    textHash: sha256Text(file.content.slice(boundedStart, end))
  };
}

function compareBySpanThenId<T extends { span: TypeScriptExactSourceSpan; id: string }>(left: T, right: T): number {
  return compareCanonical(left.span.path, right.span.path) || left.span.start - right.span.start || compareCanonical(left.id, right.id);
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
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const workspaceRelative = relative.replace(/\\/gu, "/");
    if (typeof depth === "number" && workspaceRelative.split("/").length - 1 > depth) return false;
    if (extensions.length > 0 && !extensions.some(extension => workspaceRelative.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase()))) return false;
    if (includes.length > 0 && !includes.some(pattern => globMatches(workspaceRelative, pattern))) return false;
    if ((excludes ?? []).some(pattern => globMatches(workspaceRelative, pattern))) return false;
    return true;
  }).map(file => file.absolutePath).sort(compareCanonical);
}

function snapshotDirectories(snapshot: ExactSnapshot, directoryName: string): string[] {
  const root = path.resolve(directoryName);
  const directories = new Set<string>();
  for (const file of snapshot.files) {
    const relative = path.relative(root, file.absolutePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const first = relative.split(path.sep)[0];
    if (first && first !== path.basename(file.absolutePath)) directories.add(path.join(root, first));
  }
  return [...directories].sort(compareCanonical);
}

function globMatches(relativePath: string, rawPattern: string): boolean {
  let pattern = rawPattern.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (!pattern) return false;
  if (!/[?*]/u.test(pattern)) pattern = path.posix.extname(pattern) ? pattern : `${pattern}/**/*`;
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      const followedBySlash = pattern[index + 2] === "/";
      expression += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  expression += "$";
  return new RegExp(expression, ts.sys.useCaseSensitiveFileNames ? "u" : "iu").test(relativePath);
}

function addParentDirectories(directories: Set<string>, root: string, absoluteFile: string): void {
  let current = path.dirname(absoluteFile);
  while (isWithinDirectory(current, root)) {
    directories.add(canonicalAbsolute(current));
    if (canonicalAbsolute(current) === canonicalAbsolute(root)) break;
    current = path.dirname(current);
  }
}

function workspaceAbsolutePath(root: string, workspacePath: string): string {
  const absolute = path.resolve(root, ...workspacePath.split("/"));
  if (!isWithinDirectory(absolute, root)) throw new Error(`bounded workspace path escapes the workspace: ${workspacePath}`);
  return absolute;
}

function workspaceDisplayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative.replace(/\\/gu, "/");
}

function normalizeWorkspacePath(value: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000") || path.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`invalid bounded workspace path: ${value}`);
  }
  if (value.normalize("NFC") !== value || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`invalid bounded workspace path: ${value}`);
  }
  return value;
}

function canonicalWorkspacePath(value: string): string {
  return ts.sys.useCaseSensitiveFileNames ? value : value.toLocaleLowerCase();
}

function canonicalAbsolute(value: string): string {
  const absolute = path.resolve(value);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLocaleLowerCase();
}

function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

function portableValue(value: unknown, workspaceRoot: string): unknown {
  if (typeof value === "string") {
    if (path.isAbsolute(value) && isWithinDirectory(value, workspaceRoot)) {
      return `<workspace>/${workspaceDisplayPath(workspaceRoot, value)}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => portableValue(item, workspaceRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, portableValue(item, workspaceRoot)]));
  }
  return value;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareCanonical).filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex")}`;
}

function sha256Text(value: string): TypeScriptSemanticHash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): TypeScriptSemanticHash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPositiveBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

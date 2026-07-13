import type { EvidenceId, Hasher, JsonValue } from "./types.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import { featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import {
  normalizePath,
  type SourceCodeDeclaration,
  type SourceCodeExport,
  type SourceCodeFileFacts,
  type SourceCodeImport,
  type SourceRepositoryFacts
} from "./source-code-graph.js";
import { createEngineeringCorpusProjection, type EngineeringCorpusProjection } from "./engineering-corpus.js";
import type { ProofClaim, ProofEvidenceRecord, ProofForceClass } from "./semantic-proof-engine.js";

export type CodeProofEligibility = "code.proof.direct_source_span" | "code.proof.source_bound_only" | "code.proof.learned_prior_only" | "code.proof.ineligible";
export type CodeGraphIntent = "graph.node" | "graph.edge" | "graph.evidence_span" | "graph.diagnostic" | "graph.trace";

export interface CodeHydrationDestination {
  recordType: string;
  dryRunDestination: string;
  inspectPath: string;
}

export interface CodeProvenance {
  source: string;
  rootUri: string;
  sourcePath: string;
  sourceHash?: string;
  parserId?: string;
  observedFrom: string[];
}

export interface CodeEvidenceSpan {
  id: string;
  sourcePath: string;
  sourceHash?: string;
  languageId: string;
  charStart: number;
  charEnd: number;
  lineStart: number;
  lineEnd: number;
  textPreview: string;
  provenance: CodeProvenance;
  confidence: number;
  graphIntent: CodeGraphIntent;
  proofEligibility: CodeProofEligibility;
  hydration: CodeHydrationDestination;
  scoreTrace?: ScoreTrace[];
}

export interface DeveloperRecordBase {
  id: string;
  sourcePath: string;
  sourceHash?: string;
  languageId: string;
  provenance: CodeProvenance;
  confidence: number;
  evidenceSpan?: CodeEvidenceSpan;
  graphIntent: CodeGraphIntent;
  proofEligibility: CodeProofEligibility;
  hydration: CodeHydrationDestination;
  scoreTrace?: ScoreTrace[];
}

export interface FileNodeBase extends DeveloperRecordBase {
  mediaType: string;
  byteLength: number;
  roles: string[];
}

export interface FileNode extends FileNodeBase {
  kind: "file";
}

export interface DirectoryNode extends DeveloperRecordBase {
  kind: "directory";
  childFileCount: number;
}

export interface SourceFileNode extends FileNodeBase {
  kind: "source_file";
  parserId?: string;
  declarationCount: number;
  importCount: number;
  exportCount: number;
  testCount: number;
}

export interface SymbolNode extends DeveloperRecordBase {
  kind: "symbol";
  name: string;
  symbolKind: string;
  exported: boolean;
  defaultExport: boolean;
}

export interface ImportEdge extends DeveloperRecordBase {
  kind: "import_edge";
  fromFileId: string;
  moduleSpecifier: string;
  importedNames: string[];
  typeOnly: boolean;
  local: boolean;
}

export interface ExportEdge extends DeveloperRecordBase {
  kind: "export_edge";
  fromFileId: string;
  exportedNames: string[];
  defaultExport: boolean;
  moduleSpecifier?: string;
}

export interface DependencyNode extends DeveloperRecordBase {
  kind: "dependency";
  name: string;
  scope: string;
  version?: string;
  declaredBy: string[];
  importedBy: string[];
}

export interface PackageScriptNodeBase extends DeveloperRecordBase {
  scriptName: string;
  command: string;
  packageName?: string;
  roleIds: string[];
}

export interface PackageScriptNode extends PackageScriptNodeBase {
  kind: "package_script";
}

export interface BuildCommandNode extends PackageScriptNodeBase {
  kind: "build_command";
}

export interface TestCommandNode extends PackageScriptNodeBase {
  kind: "test_command";
}

export interface DiagnosticRecord extends DeveloperRecordBase {
  kind: "diagnostic";
  diagnosticKindId: string;
  severityId: string;
  observedSeverity?: string;
  diagnosticCode?: string;
  message: string;
  line?: number;
  column?: number;
  relatedSymbol?: string;
  relatedFile?: string;
  testName?: string;
}

export interface CompilerDiagnosticRecord extends DiagnosticRecord {
  diagnosticKindId: "diagnostic.kind.compiler";
}

export interface TestDiagnosticRecord extends DiagnosticRecord {
  diagnosticKindId: "diagnostic.kind.test";
  testName?: string;
}

export interface CodeClaim {
  id: string;
  subjectId: string;
  relationId: string;
  objectId: string;
  sourcePath: string;
  sourceHash?: string;
  languageId: string;
  requiredSourceBinding: boolean;
}

export interface CodeFact extends DeveloperRecordBase {
  kind: "code_fact";
  subjectId: string;
  relationId: string;
  objectId: string;
  forceClass: ProofForceClass;
}

export interface CodeIntelligenceTrace extends DeveloperRecordBase {
  kind: "trace";
  nodeCount: number;
  edgeCount: number;
  unsupportedFiles: string[];
  warnings: string[];
}

export interface SymbolGraph {
  nodes: SymbolNode[];
  imports: ImportEdge[];
  exports: ExportEdge[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string }>;
}

export interface DependencyGraph {
  dependencies: DependencyNode[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string }>;
}

export interface BuildGraph {
  scripts: PackageScriptNode[];
  buildCommands: BuildCommandNode[];
  configFiles: string[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string }>;
}

export interface TestGraph {
  testCommands: TestCommandNode[];
  testFiles: SourceFileNode[];
  diagnostics: TestDiagnosticRecord[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string }>;
}

export interface DiagnosticsGraph {
  diagnostics: DiagnosticRecord[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string }>;
}

export interface RepoSnapshot {
  schema: "scce.developer-intelligence.snapshot.v1";
  id: string;
  rootUri: string;
  rootHash: string;
  files: Array<FileNode | SourceFileNode>;
  directories: DirectoryNode[];
  symbolGraph: SymbolGraph;
  dependencyGraph: DependencyGraph;
  buildGraph: BuildGraph;
  testGraph: TestGraph;
  diagnosticsGraph: DiagnosticsGraph;
  evidenceSpans: CodeEvidenceSpan[];
  codeFacts: CodeFact[];
  traces: CodeIntelligenceTrace[];
  engineeringContext: EngineeringCorpusProjection;
  summary: {
    fileCount: number;
    directoryCount: number;
    sourceFileCount: number;
    symbolCount: number;
    importCount: number;
    exportCount: number;
    dependencyCount: number;
    packageScriptCount: number;
    buildCommandCount: number;
    testCommandCount: number;
    diagnosticCount: number;
    evidenceSpanCount: number;
    unsupportedFileCount: number;
  };
  hydration: DeveloperIntelligenceHydrationContract;
  warnings: string[];
}

export interface RepoSnapshotInput {
  rootUri: string;
  repositoryFacts: SourceRepositoryFacts;
  fileFacts: SourceCodeFileFacts[];
  evidenceIds?: EvidenceId[];
  sourceVersionId?: string;
  diagnostics?: readonly DiagnosticRecord[];
  unsupportedFiles?: string[];
  warnings?: string[];
  hasher: Hasher;
}

export interface DiagnosticRecordInput {
  rootUri: string;
  sourcePath: string;
  sourceHash?: string;
  languageId?: string;
  diagnosticKindId: "diagnostic.kind.compiler" | "diagnostic.kind.test" | string;
  severityId: string;
  observedSeverity?: string;
  diagnosticCode?: string;
  message: string;
  line?: number;
  column?: number;
  relatedSymbol?: string;
  relatedFile?: string;
  evidenceSpan?: CodeEvidenceSpan;
  testName?: string;
  hasher: Hasher;
}

export interface RepoSnapshotRecord {
  snapshotId: string;
  rootUri: string;
  rootHash: string;
  fileCount: number;
  symbolCount: number;
  dependencyCount: number;
  diagnosticCount: number;
  dryRunDestination: string;
  inspectPath: string;
}

export interface FileNodeRecord {
  fileId: string;
  sourcePath: string;
  sourceHash?: string;
  languageId: string;
  mediaType: string;
  byteLength: number;
  proofEligibility: CodeProofEligibility;
  dryRunDestination: string;
  inspectPath: string;
}

export interface SymbolNodeRecord {
  symbolId: string;
  sourcePath: string;
  name: string;
  symbolKind: string;
  exported: boolean;
  evidenceSpanId?: string;
  dryRunDestination: string;
  inspectPath: string;
}

export interface DependencyRecord {
  dependencyId: string;
  name: string;
  scope: string;
  version?: string;
  declaredBy: string[];
  importedBy: string[];
  evidenceSpanId?: string;
  dryRunDestination: string;
  inspectPath: string;
}

export interface PackageScriptRecord {
  scriptId: string;
  scriptName: string;
  command: string;
  sourcePath: string;
  evidenceSpanId?: string;
  dryRunDestination: string;
  inspectPath: string;
}

export interface BuildGraphRecord {
  snapshotId: string;
  buildCommandIds: string[];
  configFiles: string[];
  edgeCount: number;
  dryRunDestination: string;
  inspectPath: string;
}

export interface TestGraphRecord {
  snapshotId: string;
  testCommandIds: string[];
  testFileIds: string[];
  diagnosticIds: string[];
  edgeCount: number;
  dryRunDestination: string;
  inspectPath: string;
}

export interface CodeEvidenceSpanRecord {
  spanId: string;
  sourcePath: string;
  sourceHash?: string;
  charStart: number;
  charEnd: number;
  lineStart: number;
  lineEnd: number;
  proofEligibility: CodeProofEligibility;
  dryRunDestination: string;
  inspectPath: string;
}

export interface CodeIntelligenceTraceRecord {
  traceId: string;
  snapshotId: string;
  nodeCount: number;
  edgeCount: number;
  warningCount: number;
  dryRunDestination: string;
  inspectPath: string;
}

export interface DeveloperIntelligenceHydrationContract {
  schema: "scce.developer-intelligence.hydration.v1";
  snapshot: RepoSnapshotRecord;
  files: FileNodeRecord[];
  symbols: SymbolNodeRecord[];
  dependencies: DependencyRecord[];
  packageScripts: PackageScriptRecord[];
  buildGraph: BuildGraphRecord;
  testGraph: TestGraphRecord;
  diagnostics: DiagnosticRecord[];
  evidenceSpans: CodeEvidenceSpanRecord[];
  traces: CodeIntelligenceTraceRecord[];
  diagnosticsText: string[];
  valid: boolean;
}

export function createRepoSnapshot(input: RepoSnapshotInput): RepoSnapshot {
  const fileFactsByPath = new Map(input.fileFacts.map(file => [normalizePath(file.normalizedPath || file.path), file]));
  const evidenceSpans: CodeEvidenceSpan[] = [];
  const spanByCarrierId = new Map<string, CodeEvidenceSpan>();
  const fileNodes: Array<FileNode | SourceFileNode> = input.repositoryFacts.files.map(file => {
    const facts = fileFactsByPath.get(file.normalizedPath);
    const base = baseRecord({
      rootUri: input.rootUri,
      sourcePath: file.normalizedPath,
      sourceHash: file.contentHash,
      languageId: languageIdForFile(file.languageEvidence, file.mediaType),
      parserId: file.parserId,
      hasher: input.hasher,
      recordType: facts ? "SourceFileNode" : "FileNode",
      inspectPath: `repo.files.${file.normalizedPath}`
    });
    const roles = file.roleEvidence.map(role => role.roleId);
    if (facts) {
      const node: SourceFileNode = {
        ...base,
        id: stableId(input.hasher, "source-file", input.rootUri, file.normalizedPath, file.contentHash),
        kind: "source_file",
        mediaType: file.mediaType,
        byteLength: file.byteLength,
        roles,
        parserId: file.parserId,
        declarationCount: facts.declarations.length,
        importCount: facts.imports.length,
        exportCount: facts.exports.length,
        testCount: facts.tests.length
      };
      return node;
    }
    return {
      ...base,
      id: stableId(input.hasher, "file", input.rootUri, file.normalizedPath, file.contentHash),
      kind: "file",
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      roles
    };
  });
  const fileNodeByPath = new Map(fileNodes.map(file => [file.sourcePath, file]));
  for (const facts of input.fileFacts) collectEvidenceSpans({ rootUri: input.rootUri, facts, hasher: input.hasher, evidenceSpans, spanByCarrierId });
  const directories = directoryNodes(input.rootUri, fileNodes, input.hasher);
  const symbolGraph = symbolGraphFromFacts(input.rootUri, input.fileFacts, fileNodeByPath, spanByCarrierId, input.hasher);
  const dependencyGraph = dependencyGraphFromFacts(input.rootUri, input.repositoryFacts, input.fileFacts, fileNodeByPath, spanByCarrierId, input.hasher);
  const buildGraph = buildGraphFromFacts(input.rootUri, input.repositoryFacts, fileNodeByPath, spanByCarrierId, input.hasher);
  const testGraph = testGraphFromFacts(input.rootUri, input.fileFacts, buildGraph, input.diagnostics ?? [], fileNodeByPath, spanByCarrierId, input.hasher);
  const diagnosticsGraph = diagnosticsGraphFromRecords(input.diagnostics ?? [], input.hasher);
  const codeFacts = [
    ...codeFactsFromSymbols(symbolGraph.nodes),
    ...codeFactsFromImports(symbolGraph.imports),
    ...codeFactsFromExports(symbolGraph.exports),
    ...codeFactsFromDependencies(dependencyGraph.dependencies),
    ...codeFactsFromScripts(buildGraph.scripts)
  ];
  const engineeringContext = createEngineeringCorpusProjection({
    repositoryFacts: input.repositoryFacts,
    fileFacts: input.fileFacts,
    evidenceIds: input.evidenceIds ?? [],
    sourceVersionId: input.sourceVersionId,
    hasher: input.hasher
  });
  const rootHash = input.hasher.digestHex(canonicalStringify({
    rootUri: input.rootUri,
    files: fileNodes.map(file => [file.sourcePath, file.sourceHash]),
    symbols: symbolGraph.nodes.map(symbol => [symbol.sourcePath, symbol.name, symbol.symbolKind]),
    deps: dependencyGraph.dependencies.map(dep => [dep.name, dep.scope, dep.version]),
    scripts: buildGraph.scripts.map(script => [script.sourcePath, script.scriptName, script.command])
  }));
  const summary = {
    fileCount: fileNodes.length,
    directoryCount: directories.length,
    sourceFileCount: fileNodes.filter(file => file.kind === "source_file").length,
    symbolCount: symbolGraph.nodes.length,
    importCount: symbolGraph.imports.length,
    exportCount: symbolGraph.exports.length,
    dependencyCount: dependencyGraph.dependencies.length,
    packageScriptCount: buildGraph.scripts.length,
    buildCommandCount: buildGraph.buildCommands.length,
    testCommandCount: testGraph.testCommands.length,
    diagnosticCount: diagnosticsGraph.diagnostics.length,
    evidenceSpanCount: evidenceSpans.length,
    unsupportedFileCount: input.unsupportedFiles?.length ?? 0
  };
  const trace = traceRecord(input.rootUri, rootHash, summary, input.unsupportedFiles ?? [], input.warnings ?? [], input.hasher);
  const snapshotWithoutHydration = {
    schema: "scce.developer-intelligence.snapshot.v1" as const,
    id: stableId(input.hasher, "repo-snapshot", input.rootUri, rootHash),
    rootUri: input.rootUri,
    rootHash,
    files: fileNodes,
    directories,
    symbolGraph,
    dependencyGraph,
    buildGraph,
    testGraph,
    diagnosticsGraph,
    evidenceSpans,
    codeFacts,
    traces: [trace],
    engineeringContext,
    summary,
    warnings: input.warnings ?? []
  };
  const hydration = createDeveloperIntelligenceHydrationContract(snapshotWithoutHydration);
  return { ...snapshotWithoutHydration, hydration };
}

export function repoSnapshotToEngineeringContext(snapshot: RepoSnapshot): EngineeringCorpusProjection {
  return snapshot.engineeringContext;
}

export function codeClaimToProofClaim(claim: CodeClaim): ProofClaim {
  return {
    id: claim.id,
    subject: { id: claim.subjectId, kindId: "code.claim.subject" },
    relationId: claim.relationId,
    object: { id: claim.objectId, kindId: "code.claim.object" },
    requiredSourceBinding: claim.requiredSourceBinding
  };
}

export function codeFactToProofEvidence(fact: CodeFact): ProofEvidenceRecord {
  return {
    id: fact.id,
    forceClass: fact.forceClass,
    sourceVersionId: fact.forceClass === "direct_evidence" ? fact.evidenceSpan?.provenance.sourceHash ?? fact.sourceHash : fact.sourceHash,
    evidenceSpanId: fact.forceClass === "direct_evidence" ? fact.evidenceSpan?.id : undefined,
    subject: { id: fact.subjectId, kindId: "code.fact.subject" },
    relationId: fact.relationId,
    object: { id: fact.objectId, kindId: "code.fact.object" }
  };
}

export function diagnosticsToProgramValidationInput(records: readonly DiagnosticRecord[]): {
  diagnostics: Array<{ id: string; sourcePath: string; line?: number; column?: number; severityId: string; diagnosticCode?: string; message: string }>;
  riskIds: string[];
  relatedFiles: string[];
} {
  return {
    diagnostics: records.map(record => ({
      id: record.id,
      sourcePath: record.sourcePath,
      line: record.line,
      column: record.column,
      severityId: record.severityId,
      diagnosticCode: record.diagnosticCode,
      message: record.message
    })),
    riskIds: [...new Set(records.map(record => record.diagnosticKindId))].sort(),
    relatedFiles: [...new Set(records.flatMap(record => [record.sourcePath, record.relatedFile].filter((item): item is string => Boolean(item))))].sort()
  };
}

export function createDiagnosticRecord(input: DiagnosticRecordInput): DiagnosticRecord {
  const base = baseRecord({
    rootUri: input.rootUri,
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    languageId: input.languageId ?? "diagnostic.observed",
    hasher: input.hasher,
    recordType: "DiagnosticRecord",
    inspectPath: `repo.diagnostics.${input.sourcePath}`
  });
  return {
    ...base,
    id: stableId(input.hasher, "diagnostic", input.rootUri, input.sourcePath, input.line, input.column, input.diagnosticCode, input.message),
    kind: "diagnostic",
    diagnosticKindId: input.diagnosticKindId,
    severityId: input.severityId,
    observedSeverity: input.observedSeverity,
    diagnosticCode: input.diagnosticCode,
    message: input.message,
    line: input.line,
    column: input.column,
    relatedSymbol: input.relatedSymbol,
    relatedFile: input.relatedFile,
    evidenceSpan: input.evidenceSpan,
    graphIntent: "graph.diagnostic",
    proofEligibility: "code.proof.source_bound_only",
    hydration: hydration("DiagnosticRecord", "postgres.diagnostics", `repo.diagnostics.${input.sourcePath}`),
    ...(input.diagnosticKindId === "diagnostic.kind.test" && input.testName ? { testName: input.testName } : {})
  };
}

export function createDeveloperIntelligenceHydrationContract(snapshot: Omit<RepoSnapshot, "hydration">): DeveloperIntelligenceHydrationContract {
  const files = snapshot.files.map(file => ({
    fileId: file.id,
    sourcePath: file.sourcePath,
    sourceHash: file.sourceHash,
    languageId: file.languageId,
    mediaType: file.mediaType,
    byteLength: file.byteLength,
    proofEligibility: file.proofEligibility,
    dryRunDestination: file.hydration.dryRunDestination,
    inspectPath: file.hydration.inspectPath
  }));
  const symbols = snapshot.symbolGraph.nodes.map(symbol => ({
    symbolId: symbol.id,
    sourcePath: symbol.sourcePath,
    name: symbol.name,
    symbolKind: symbol.symbolKind,
    exported: symbol.exported,
    evidenceSpanId: symbol.evidenceSpan?.id,
    dryRunDestination: symbol.hydration.dryRunDestination,
    inspectPath: symbol.hydration.inspectPath
  }));
  const dependencies = snapshot.dependencyGraph.dependencies.map(dep => ({
    dependencyId: dep.id,
    name: dep.name,
    scope: dep.scope,
    version: dep.version,
    declaredBy: dep.declaredBy,
    importedBy: dep.importedBy,
    evidenceSpanId: dep.evidenceSpan?.id,
    dryRunDestination: dep.hydration.dryRunDestination,
    inspectPath: dep.hydration.inspectPath
  }));
  const packageScripts = snapshot.buildGraph.scripts.map(script => ({
    scriptId: script.id,
    scriptName: script.scriptName,
    command: script.command,
    sourcePath: script.sourcePath,
    evidenceSpanId: script.evidenceSpan?.id,
    dryRunDestination: script.hydration.dryRunDestination,
    inspectPath: script.hydration.inspectPath
  }));
  const evidenceSpans = snapshot.evidenceSpans.map(span => ({
    spanId: span.id,
    sourcePath: span.sourcePath,
    sourceHash: span.sourceHash,
    charStart: span.charStart,
    charEnd: span.charEnd,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    proofEligibility: span.proofEligibility,
    dryRunDestination: span.hydration.dryRunDestination,
    inspectPath: span.hydration.inspectPath
  }));
  const traces = snapshot.traces.map(trace => ({
    traceId: trace.id,
    snapshotId: snapshot.id,
    nodeCount: trace.nodeCount,
    edgeCount: trace.edgeCount,
    warningCount: trace.warnings.length,
    dryRunDestination: trace.hydration.dryRunDestination,
    inspectPath: trace.hydration.inspectPath
  }));
  const contract: DeveloperIntelligenceHydrationContract = {
    schema: "scce.developer-intelligence.hydration.v1",
    snapshot: {
      snapshotId: snapshot.id,
      rootUri: snapshot.rootUri,
      rootHash: snapshot.rootHash,
      fileCount: snapshot.files.length,
      symbolCount: snapshot.symbolGraph.nodes.length,
      dependencyCount: snapshot.dependencyGraph.dependencies.length,
      diagnosticCount: snapshot.diagnosticsGraph.diagnostics.length,
      dryRunDestination: "postgres.repo_snapshots",
      inspectPath: "repo.snapshot"
    },
    files,
    symbols,
    dependencies,
    packageScripts,
    buildGraph: {
      snapshotId: snapshot.id,
      buildCommandIds: snapshot.buildGraph.buildCommands.map(command => command.id),
      configFiles: snapshot.buildGraph.configFiles,
      edgeCount: snapshot.buildGraph.edges.length,
      dryRunDestination: "postgres.build_graph",
      inspectPath: "repo.buildGraph"
    },
    testGraph: {
      snapshotId: snapshot.id,
      testCommandIds: snapshot.testGraph.testCommands.map(command => command.id),
      testFileIds: snapshot.testGraph.testFiles.map(file => file.id),
      diagnosticIds: snapshot.testGraph.diagnostics.map(item => item.id),
      edgeCount: snapshot.testGraph.edges.length,
      dryRunDestination: "postgres.test_graph",
      inspectPath: "repo.testGraph"
    },
    diagnostics: snapshot.diagnosticsGraph.diagnostics,
    evidenceSpans,
    traces,
    diagnosticsText: [],
    valid: true
  };
  const validation = validateDeveloperIntelligenceHydrationContract(contract);
  return { ...contract, diagnosticsText: validation.diagnostics, valid: validation.valid };
}

export function validateDeveloperIntelligenceHydrationContract(contract: DeveloperIntelligenceHydrationContract): { valid: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (contract.schema !== "scce.developer-intelligence.hydration.v1") diagnostics.push("developer.hydration.schema");
  if (!contract.snapshot.snapshotId) diagnostics.push("developer.hydration.snapshot_id");
  if (!contract.snapshot.rootUri) diagnostics.push("developer.hydration.root_uri");
  if (!contract.snapshot.rootHash) diagnostics.push("developer.hydration.root_hash");
  if (!contract.files.length) diagnostics.push("developer.hydration.files");
  for (const file of contract.files) {
    if (!file.fileId || !file.sourcePath || !file.languageId || !file.dryRunDestination) diagnostics.push(`developer.hydration.file:${file.sourcePath || file.fileId}`);
  }
  for (const symbol of contract.symbols) {
    if (!symbol.symbolId || !symbol.sourcePath || !symbol.name || !symbol.dryRunDestination) diagnostics.push(`developer.hydration.symbol:${symbol.symbolId || symbol.name}`);
  }
  for (const dep of contract.dependencies) {
    if (!dep.dependencyId || !dep.name || !dep.scope || !dep.dryRunDestination) diagnostics.push(`developer.hydration.dependency:${dep.dependencyId || dep.name}`);
  }
  for (const script of contract.packageScripts) {
    if (!script.scriptId || !script.scriptName || !script.command || !script.dryRunDestination) diagnostics.push(`developer.hydration.package_script:${script.scriptId || script.scriptName}`);
  }
  if (!contract.buildGraph.snapshotId) diagnostics.push("developer.hydration.build_graph");
  if (!contract.testGraph.snapshotId) diagnostics.push("developer.hydration.test_graph");
  for (const span of contract.evidenceSpans) {
    if (!span.spanId || !span.sourcePath || span.charEnd < span.charStart || !span.dryRunDestination) diagnostics.push(`developer.hydration.evidence_span:${span.spanId || span.sourcePath}`);
  }
  for (const trace of contract.traces) {
    if (!trace.traceId || !trace.snapshotId || !trace.dryRunDestination) diagnostics.push(`developer.hydration.trace:${trace.traceId}`);
  }
  return { valid: diagnostics.length === 0 && contract.valid, diagnostics };
}

function collectEvidenceSpans(input: {
  rootUri: string;
  facts: SourceCodeFileFacts;
  hasher: Hasher;
  evidenceSpans: CodeEvidenceSpan[];
  spanByCarrierId: Map<string, CodeEvidenceSpan>;
}): void {
  for (const declaration of input.facts.declarations) addSpanForCarrier(input, declaration.id, declaration.span, declaration.signature ?? declaration.name, "repo.symbols");
  for (const item of input.facts.imports) addSpanForCarrier(input, item.id, item.span, item.moduleSpecifier, "repo.imports");
  for (const item of input.facts.exports) addSpanForCarrier(input, item.id, item.span, item.exportedNames.join(","), "repo.exports");
  for (const test of input.facts.tests) addSpanForCarrier(input, test.id, test.span, test.name ?? test.id, "repo.tests");
  for (const script of input.facts.packageFacts?.scripts ?? []) {
    addSpanForCarrier(input, `script:${input.facts.normalizedPath}:${script.name}`, undefined, `${script.name}:${script.command}`, "repo.packageScripts");
  }
  for (const dep of input.facts.packageFacts?.dependencies ?? []) {
    addSpanForCarrier(input, `dependency:${input.facts.normalizedPath}:${dep.scope}:${dep.name}`, undefined, `${dep.scope}:${dep.name}`, "repo.dependencies");
  }
  if (documentationFile(input.facts)) {
    addSpanForCarrier(input, `doc:${input.facts.normalizedPath}`, { charStart: 0, charEnd: Math.min(input.facts.metrics.chars, 400), lineStart: 1, lineEnd: Math.min(input.facts.metrics.lines, 16) }, input.facts.path, "repo.docs");
  }
}

function addSpanForCarrier(input: {
  rootUri: string;
  facts: SourceCodeFileFacts;
  hasher: Hasher;
  evidenceSpans: CodeEvidenceSpan[];
  spanByCarrierId: Map<string, CodeEvidenceSpan>;
}, carrierId: string, span: { charStart: number; charEnd: number; lineStart: number; lineEnd: number } | undefined, preview: string, inspectPath: string): void {
  const normalizedPath = normalizePath(input.facts.normalizedPath || input.facts.path);
  const base = baseRecord({
    rootUri: input.rootUri,
    sourcePath: normalizedPath,
    sourceHash: input.facts.contentHash,
    languageId: languageIdForFile(input.facts.languageEvidence, input.facts.mediaType),
    parserId: input.facts.parser.id,
    hasher: input.hasher,
    recordType: "CodeEvidenceSpan",
    inspectPath
  });
  const evidenceSpan: CodeEvidenceSpan = {
    id: stableId(input.hasher, "code-evidence-span", input.rootUri, normalizedPath, carrierId, span?.charStart ?? 0, span?.charEnd ?? 0),
    sourcePath: normalizedPath,
    sourceHash: input.facts.contentHash,
    languageId: base.languageId,
    charStart: span?.charStart ?? 0,
    charEnd: span?.charEnd ?? 0,
    lineStart: span?.lineStart ?? 1,
    lineEnd: span?.lineEnd ?? 1,
    textPreview: preview.slice(0, 280),
    provenance: base.provenance,
    confidence: base.confidence,
    graphIntent: "graph.evidence_span",
    proofEligibility: "code.proof.direct_source_span",
    hydration: hydration("CodeEvidenceSpanRecord", "postgres.code_evidence_spans", inspectPath),
    scoreTrace: base.scoreTrace
  };
  input.evidenceSpans.push(evidenceSpan);
  input.spanByCarrierId.set(carrierId, evidenceSpan);
}

function symbolGraphFromFacts(rootUri: string, fileFacts: readonly SourceCodeFileFacts[], fileNodeByPath: ReadonlyMap<string, FileNode | SourceFileNode>, spanByCarrierId: ReadonlyMap<string, CodeEvidenceSpan>, hasher: Hasher): SymbolGraph {
  const nodes: SymbolNode[] = [];
  const imports: ImportEdge[] = [];
  const exports: ExportEdge[] = [];
  const edges: SymbolGraph["edges"] = [];
  for (const facts of fileFacts) {
    const path = normalizePath(facts.normalizedPath || facts.path);
    const file = fileNodeByPath.get(path);
    for (const declaration of facts.declarations) {
      const symbol = symbolNode(rootUri, facts, declaration, spanByCarrierId.get(declaration.id), hasher);
      nodes.push(symbol);
      if (file) edges.push(edgeRecord(hasher, file.id, symbol.id, "repo.file_declares_symbol", symbol.evidenceSpan?.id, path));
      if (declaration.exported) {
        const exported = declarationExportEdge(rootUri, facts, declaration, spanByCarrierId.get(declaration.id), file?.id ?? path, hasher);
        exports.push(exported);
        edges.push(edgeRecord(hasher, file?.id ?? path, exported.id, "repo.file_exports_symbol", exported.evidenceSpan?.id, path));
      }
    }
    for (const item of facts.imports) {
      const edge = importEdge(rootUri, facts, item, spanByCarrierId.get(item.id), file?.id ?? path, hasher);
      imports.push(edge);
      edges.push(edgeRecord(hasher, file?.id ?? path, edge.id, "repo.file_imports_module", edge.evidenceSpan?.id, path));
    }
    for (const item of facts.exports) {
      const edge = exportEdge(rootUri, facts, item, spanByCarrierId.get(item.id), file?.id ?? path, hasher);
      exports.push(edge);
      edges.push(edgeRecord(hasher, file?.id ?? path, edge.id, "repo.file_exports_symbol", edge.evidenceSpan?.id, path));
    }
  }
  return { nodes: dedupeById(nodes), imports: dedupeById(imports), exports: dedupeById(exports), edges };
}

function declarationExportEdge(rootUri: string, facts: SourceCodeFileFacts, declaration: SourceCodeDeclaration, evidenceSpan: CodeEvidenceSpan | undefined, fromFileId: string, hasher: Hasher): ExportEdge {
  const path = normalizePath(facts.normalizedPath || facts.path);
  return {
    ...baseRecord({ rootUri, sourcePath: path, sourceHash: facts.contentHash, languageId: languageIdForFile(facts.languageEvidence, facts.mediaType), parserId: facts.parser.id, hasher, recordType: "ExportEdge", inspectPath: `repo.exports.${declaration.name}` }),
    id: stableId(hasher, "declaration-export-edge", rootUri, path, declaration.kind, declaration.name),
    kind: "export_edge",
    fromFileId,
    exportedNames: [declaration.name],
    defaultExport: declaration.defaultExport,
    evidenceSpan
  };
}

function dependencyGraphFromFacts(rootUri: string, repositoryFacts: SourceRepositoryFacts, fileFacts: readonly SourceCodeFileFacts[], fileNodeByPath: ReadonlyMap<string, FileNode | SourceFileNode>, spanByCarrierId: ReadonlyMap<string, CodeEvidenceSpan>, hasher: Hasher): DependencyGraph {
  const byName = new Map<string, DependencyNode>();
  const edges: DependencyGraph["edges"] = [];
  const ensure = (input: { name: string; scope: string; version?: string; sourcePath: string; sourceHash?: string; declaredBy?: string; importedBy?: string; evidenceSpan?: CodeEvidenceSpan }) => {
    const key = `${input.scope}:${input.name}`;
    const existing = byName.get(key);
    if (existing) {
      if (input.declaredBy && !existing.declaredBy.includes(input.declaredBy)) existing.declaredBy.push(input.declaredBy);
      if (input.importedBy && !existing.importedBy.includes(input.importedBy)) existing.importedBy.push(input.importedBy);
      if (!existing.evidenceSpan && input.evidenceSpan) existing.evidenceSpan = input.evidenceSpan;
      return existing;
    }
    const base = baseRecord({ rootUri, sourcePath: input.sourcePath, sourceHash: input.sourceHash, languageId: "dependency.package", hasher, recordType: "DependencyNode", inspectPath: `repo.dependencies.${input.name}` });
    const node: DependencyNode = {
      ...base,
      id: stableId(hasher, "dependency", rootUri, input.scope, input.name),
      kind: "dependency",
      name: input.name,
      scope: input.scope,
      version: input.version,
      declaredBy: input.declaredBy ? [input.declaredBy] : [],
      importedBy: input.importedBy ? [input.importedBy] : [],
      evidenceSpan: input.evidenceSpan
    };
    byName.set(key, node);
    return node;
  };
  for (const pkg of repositoryFacts.packages) {
    const manifestHash = repositoryFacts.files.find(file => file.normalizedPath === pkg.manifestPath)?.contentHash;
    for (const dep of pkg.dependencies) {
      const evidenceSpan = spanByCarrierId.get(`dependency:${pkg.manifestPath}:${dep.scope}:${dep.name}`);
      const node = ensure({ name: dep.name, scope: dep.scope, version: dep.version, sourcePath: pkg.manifestPath, sourceHash: manifestHash, declaredBy: pkg.manifestPath, evidenceSpan });
      edges.push(edgeRecord(hasher, pkg.manifestPath, node.id, "repo.package_declares_dependency", node.evidenceSpan?.id, pkg.manifestPath));
    }
  }
  for (const facts of fileFacts) {
    const filePath = normalizePath(facts.normalizedPath || facts.path);
    const file = fileNodeByPath.get(filePath);
    for (const item of facts.imports) {
      const dependencyName = packageNameFromSpecifier(item.moduleSpecifier);
      if (!dependencyName || item.moduleSpecifier.startsWith(".")) continue;
      const node = ensure({ name: dependencyName, scope: "imported", sourcePath: filePath, sourceHash: facts.contentHash, importedBy: filePath, evidenceSpan: spanByCarrierId.get(item.id) });
      edges.push(edgeRecord(hasher, file?.id ?? filePath, node.id, "repo.file_references_dependency", node.evidenceSpan?.id, filePath));
    }
  }
  return { dependencies: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), edges };
}

function buildGraphFromFacts(rootUri: string, repositoryFacts: SourceRepositoryFacts, fileNodeByPath: ReadonlyMap<string, FileNode | SourceFileNode>, spanByCarrierId: ReadonlyMap<string, CodeEvidenceSpan>, hasher: Hasher): BuildGraph {
  const scripts: PackageScriptNode[] = [];
  const buildCommands: BuildCommandNode[] = [];
  const edges: BuildGraph["edges"] = [];
  const configFiles = repositoryFacts.files
    .filter(file => file.roleEvidence.some(role => role.roleId === "source.role.configuration"))
    .map(file => file.normalizedPath)
    .sort();
  for (const pkg of repositoryFacts.packages) {
    const manifest = fileNodeByPath.get(pkg.manifestPath);
    for (const script of pkg.scripts) {
      const evidenceSpan = spanByCarrierId.get(`script:${pkg.manifestPath}:${script.name}`);
      const roleIds = script.roleEvidence.map(role => role.roleId);
      const base = packageScriptNode(rootUri, pkg.manifestPath, repositoryFacts.files.find(file => file.normalizedPath === pkg.manifestPath)?.contentHash, pkg.name, script.name, script.command, roleIds, evidenceSpan, hasher);
      scripts.push(base);
      edges.push(edgeRecord(hasher, manifest?.id ?? pkg.manifestPath, base.id, "repo.manifest_defines_script", evidenceSpan?.id, pkg.manifestPath));
      if (roleIds.includes("source.role.build")) {
        const command = { ...base, id: stableId(hasher, "build-command", rootUri, pkg.manifestPath, script.name, script.command), kind: "build_command" as const };
        buildCommands.push(command);
        edges.push(edgeRecord(hasher, base.id, command.id, "repo.script_observed_as_build_command", evidenceSpan?.id, pkg.manifestPath));
      }
    }
  }
  return { scripts: dedupeById(scripts), buildCommands: dedupeById(buildCommands), configFiles, edges };
}

function testGraphFromFacts(rootUri: string, fileFacts: readonly SourceCodeFileFacts[], buildGraph: BuildGraph, diagnostics: readonly DiagnosticRecord[], fileNodeByPath: ReadonlyMap<string, FileNode | SourceFileNode>, spanByCarrierId: ReadonlyMap<string, CodeEvidenceSpan>, hasher: Hasher): TestGraph {
  const testFiles = [...fileNodeByPath.values()].filter((file): file is SourceFileNode => file.kind === "source_file" && file.roles.includes("source.role.test"));
  const testCommands = buildGraph.scripts
    .filter(script => script.roleIds.includes("source.role.validation"))
    .map(script => ({ ...script, id: stableId(hasher, "test-command", rootUri, script.sourcePath, script.scriptName, script.command), kind: "test_command" as const }));
  const testDiagnostics = diagnostics.filter((record): record is TestDiagnosticRecord => record.diagnosticKindId === "diagnostic.kind.test");
  const edges: TestGraph["edges"] = [];
  for (const file of testFiles) {
    edges.push(edgeRecord(hasher, file.sourcePath, file.id, "repo.test_file_detected", file.evidenceSpan?.id, file.sourcePath));
  }
  for (const command of testCommands) {
    edges.push(edgeRecord(hasher, command.sourcePath, command.id, "repo.script_observed_as_test_command", command.evidenceSpan?.id, command.sourcePath));
  }
  for (const facts of fileFacts) {
    const file = fileNodeByPath.get(normalizePath(facts.normalizedPath || facts.path));
    for (const test of facts.tests) edges.push(edgeRecord(hasher, file?.id ?? facts.path, test.id, "repo.file_contains_test", spanByCarrierId.get(test.id)?.id, facts.path));
  }
  for (const diagnostic of testDiagnostics) edges.push(edgeRecord(hasher, diagnostic.sourcePath, diagnostic.id, "repo.test_diagnostic_observed", diagnostic.evidenceSpan?.id, diagnostic.sourcePath));
  return { testCommands, testFiles, diagnostics: testDiagnostics, edges };
}

function diagnosticsGraphFromRecords(records: readonly DiagnosticRecord[], hasher: Hasher): DiagnosticsGraph {
  return {
    diagnostics: [...records],
    edges: records.map(record => edgeRecord(hasher, record.sourcePath, record.id, "repo.diagnostic_observed", record.evidenceSpan?.id, record.sourcePath))
  };
}

function symbolNode(rootUri: string, facts: SourceCodeFileFacts, declaration: SourceCodeDeclaration, evidenceSpan: CodeEvidenceSpan | undefined, hasher: Hasher): SymbolNode {
  const path = normalizePath(facts.normalizedPath || facts.path);
  return {
    ...baseRecord({ rootUri, sourcePath: path, sourceHash: facts.contentHash, languageId: languageIdForFile(facts.languageEvidence, facts.mediaType), parserId: facts.parser.id, hasher, recordType: "SymbolNode", inspectPath: `repo.symbols.${declaration.name}` }),
    id: stableId(hasher, "symbol", rootUri, path, declaration.kind, declaration.name),
    kind: "symbol",
    name: declaration.name,
    symbolKind: declaration.kind,
    exported: declaration.exported,
    defaultExport: declaration.defaultExport,
    evidenceSpan
  };
}

function importEdge(rootUri: string, facts: SourceCodeFileFacts, item: SourceCodeImport, evidenceSpan: CodeEvidenceSpan | undefined, fromFileId: string, hasher: Hasher): ImportEdge {
  const path = normalizePath(facts.normalizedPath || facts.path);
  return {
    ...baseRecord({ rootUri, sourcePath: path, sourceHash: facts.contentHash, languageId: languageIdForFile(facts.languageEvidence, facts.mediaType), parserId: facts.parser.id, hasher, recordType: "ImportEdge", inspectPath: `repo.imports.${item.moduleSpecifier}` }),
    id: stableId(hasher, "import-edge", rootUri, path, item.moduleSpecifier, item.importedNames),
    kind: "import_edge",
    fromFileId,
    moduleSpecifier: item.moduleSpecifier,
    importedNames: item.importedNames,
    typeOnly: item.typeOnly,
    local: item.moduleSpecifier.startsWith("."),
    evidenceSpan
  };
}

function exportEdge(rootUri: string, facts: SourceCodeFileFacts, item: SourceCodeExport, evidenceSpan: CodeEvidenceSpan | undefined, fromFileId: string, hasher: Hasher): ExportEdge {
  const path = normalizePath(facts.normalizedPath || facts.path);
  return {
    ...baseRecord({ rootUri, sourcePath: path, sourceHash: facts.contentHash, languageId: languageIdForFile(facts.languageEvidence, facts.mediaType), parserId: facts.parser.id, hasher, recordType: "ExportEdge", inspectPath: `repo.exports.${item.exportedNames.join(",")}` }),
    id: stableId(hasher, "export-edge", rootUri, path, item.exportedNames, item.moduleSpecifier),
    kind: "export_edge",
    fromFileId,
    exportedNames: item.exportedNames,
    defaultExport: item.defaultExport,
    moduleSpecifier: item.moduleSpecifier,
    evidenceSpan
  };
}

function packageScriptNode(rootUri: string, manifestPath: string, sourceHash: string | undefined, packageName: string | undefined, scriptName: string, command: string, roleIds: string[], evidenceSpan: CodeEvidenceSpan | undefined, hasher: Hasher): PackageScriptNode {
  return {
    ...baseRecord({ rootUri, sourcePath: manifestPath, sourceHash, languageId: "manifest.package", hasher, recordType: "PackageScriptNode", inspectPath: `repo.packageScripts.${scriptName}` }),
    id: stableId(hasher, "package-script", rootUri, manifestPath, scriptName, command),
    kind: "package_script",
    scriptName,
    command,
    packageName,
    roleIds,
    evidenceSpan
  };
}

function codeFactsFromSymbols(symbols: readonly SymbolNode[]): CodeFact[] {
  return symbols.map(symbol => codeFact(symbol, symbol.sourcePath, "repo.fact.file_exports_symbol", `${symbol.sourcePath}#${symbol.name}`, symbol.exported ? "direct_evidence" : "learned_program_prior"));
}

function codeFactsFromImports(imports: readonly ImportEdge[]): CodeFact[] {
  return imports.map(item => codeFact(item, item.sourcePath, "repo.fact.file_imports_module", item.moduleSpecifier, item.evidenceSpan ? "direct_evidence" : "learned_program_prior"));
}

function codeFactsFromExports(exports: readonly ExportEdge[]): CodeFact[] {
  return exports.flatMap(item => item.exportedNames.map(name => codeFact(item, item.sourcePath, "repo.fact.file_exports_symbol", `${item.sourcePath}#${name}`, item.evidenceSpan ? "direct_evidence" : "learned_program_prior")));
}

function codeFactsFromDependencies(dependencies: readonly DependencyNode[]): CodeFact[] {
  return dependencies.map(dep => codeFact(dep, dep.sourcePath, "repo.fact.package_has_dependency", dep.name, dep.evidenceSpan ? "direct_evidence" : "learned_program_prior"));
}

function codeFactsFromScripts(scripts: readonly PackageScriptNode[]): CodeFact[] {
  return scripts.map(script => codeFact(script, script.sourcePath, script.roleIds.includes("source.role.validation") ? "repo.fact.package_has_test_script" : "repo.fact.package_has_script", script.scriptName, script.evidenceSpan ? "direct_evidence" : "learned_program_prior"));
}

function codeFact(carrier: DeveloperRecordBase, subjectId: string, relationId: string, objectId: string, forceClass: ProofForceClass): CodeFact {
  return {
    ...carrier,
    id: `${carrier.id}.fact.${relationId}`,
    kind: "code_fact",
    subjectId,
    relationId,
    objectId,
    forceClass,
    proofEligibility: forceClass === "direct_evidence" ? "code.proof.direct_source_span" : "code.proof.learned_prior_only",
    graphIntent: "graph.edge",
    hydration: hydration("CodeFactRecord", "postgres.code_facts", `${carrier.hydration.inspectPath}.fact`)
  };
}

function directoryNodes(rootUri: string, files: readonly (FileNode | SourceFileNode)[], hasher: Hasher): DirectoryNode[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const pieces = file.sourcePath.split("/");
    let current = "";
    for (const piece of pieces.slice(0, -1)) {
      current = current ? `${current}/${piece}` : piece;
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([sourcePath, childFileCount]) => ({
    ...baseRecord({ rootUri, sourcePath, languageId: "directory", hasher, recordType: "DirectoryNode", inspectPath: `repo.directories.${sourcePath}` }),
    id: stableId(hasher, "directory", rootUri, sourcePath),
    kind: "directory",
    childFileCount
  }));
}

function traceRecord(rootUri: string, rootHash: string, summary: RepoSnapshot["summary"], unsupportedFiles: string[], warnings: string[], hasher: Hasher): CodeIntelligenceTrace {
  return {
    ...baseRecord({ rootUri, sourcePath: ".", sourceHash: rootHash, languageId: "repo.trace", hasher, recordType: "CodeIntelligenceTrace", inspectPath: "repo.trace" }),
    id: stableId(hasher, "developer-trace", rootUri, rootHash),
    kind: "trace",
    nodeCount: summary.fileCount + summary.directoryCount + summary.symbolCount + summary.dependencyCount + summary.packageScriptCount,
    edgeCount: summary.importCount + summary.exportCount + summary.buildCommandCount + summary.testCommandCount,
    unsupportedFiles,
    warnings,
    graphIntent: "graph.trace"
  };
}

function baseRecord(input: { rootUri: string; sourcePath: string; sourceHash?: string; languageId: string; parserId?: string; hasher: Hasher; recordType: string; inspectPath: string }): Omit<DeveloperRecordBase, "id"> {
  const confidence = confidenceFor(input);
  const scoreTrace: ScoreTrace[] = [
    featureScore({
      value: input.sourceHash ? 1 : 0,
      range: [0, 1],
      meaning: "source hash presence feature",
      inputs: ["sourceHash"],
      provenance: ["developer-intelligence.ts:baseRecord"]
    }),
    featureScore({
      value: input.parserId ? 1 : 0,
      range: [0, 1],
      meaning: "parser id presence feature",
      inputs: ["parserId"],
      provenance: ["developer-intelligence.ts:baseRecord"]
    }),
    provisionalHeuristicScore({
      value: confidence,
      range: [0, 1],
      meaning: "developer record confidence heuristic",
      inputs: ["sourceHash", "parserId"],
      provenance: ["developer-intelligence.ts:confidenceFor"],
      failureModes: ["parser_false_positive", "source_hash_missing_for_valid_span"]
    })
  ];
  return {
    sourcePath: normalizePath(input.sourcePath),
    sourceHash: input.sourceHash,
    languageId: input.languageId,
    provenance: {
      source: "developer-intelligence",
      rootUri: input.rootUri,
      sourcePath: normalizePath(input.sourcePath),
      sourceHash: input.sourceHash,
      parserId: input.parserId,
      observedFrom: [input.recordType]
    },
    confidence,
    graphIntent: "graph.node",
    proofEligibility: input.sourceHash ? "code.proof.direct_source_span" : "code.proof.ineligible",
    hydration: hydration(input.recordType, `postgres.${input.recordType}`, input.inspectPath),
    scoreTrace
  };
}

function hydration(recordType: string, dryRunDestination: string, inspectPath: string): CodeHydrationDestination {
  return { recordType, dryRunDestination, inspectPath };
}

function confidenceFor(input: { sourceHash?: string; parserId?: string }): number {
  return clamp01(0.42 + (input.sourceHash ? 0.24 : 0) + (input.parserId ? 0.18 : 0));
}

function edgeRecord(hasher: Hasher, source: string, target: string, relationId: string, evidenceSpanId: string | undefined, sourcePath: string): { id: string; source: string; target: string; relationId: string; evidenceSpanId?: string; sourcePath: string } {
  return { id: stableId(hasher, "edge", source, target, relationId, evidenceSpanId), source, target, relationId, evidenceSpanId, sourcePath };
}

function languageIdForFile(evidence: readonly { kind: string; value: string; confidence: number }[], mediaType: string): string {
  const strongest = [...evidence].sort((a, b) => b.confidence - a.confidence)[0];
  return strongest ? `${strongest.kind}:${strongest.value}` : mediaType ? `media-type:${mediaType}` : "language.und";
}

function packageNameFromSpecifier(value: string): string {
  if (!value || value.startsWith(".") || value.startsWith("/")) return value;
  if (value.startsWith("@")) {
    const parts = value.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : value;
  }
  return value.split("/")[0] ?? value;
}

function documentationFile(facts: SourceCodeFileFacts): boolean {
  return facts.roleEvidence.some(role => role.roleId === "source.role.documentation");
}

function stableId(hasher: Hasher, ...parts: unknown[]): string {
  return `developer_${hasher.digestHex(canonicalStringify(parts)).slice(0, 40)}`;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const out = new Map<string, T>();
  for (const item of items) if (!out.has(item.id)) out.set(item.id, item);
  return [...out.values()];
}

export function developerSnapshotSummary(snapshot: RepoSnapshot): JsonValue {
  return toJsonValue({
    schema: snapshot.schema,
    id: snapshot.id,
    rootUri: snapshot.rootUri,
    summary: snapshot.summary,
    graph: {
      symbolEdges: snapshot.symbolGraph.edges.length,
      dependencyEdges: snapshot.dependencyGraph.edges.length,
      buildEdges: snapshot.buildGraph.edges.length,
      testEdges: snapshot.testGraph.edges.length,
      diagnosticEdges: snapshot.diagnosticsGraph.edges.length
    },
    hydrationValid: snapshot.hydration.valid,
    hydrationDiagnostics: snapshot.hydration.diagnosticsText
  });
}

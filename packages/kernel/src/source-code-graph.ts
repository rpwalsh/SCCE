import type { Hasher, JsonValue } from "./types.js";
import { canonicalStringify, clamp01, entropy, toJsonValue } from "./primitives.js";

export interface SourceLanguageEvidence {
  kind: string;
  value: string;
  source: string;
  confidence: number;
  metadata?: JsonValue;
}

export interface SourceRoleEvidence {
  roleId: string;
  source: string;
  confidence: number;
  evidence: string[];
}

export interface SourceCodeSpan {
  charStart: number;
  charEnd: number;
  lineStart: number;
  lineEnd: number;
}

export interface SourceCodeDeclaration {
  id: string;
  name: string;
  kind: string;
  exported: boolean;
  defaultExport: boolean;
  span?: SourceCodeSpan;
  signature?: string;
  metadata?: JsonValue;
}

export interface SourceCodeImport {
  id: string;
  moduleSpecifier: string;
  importedNames: string[];
  typeOnly: boolean;
  span?: SourceCodeSpan;
  metadata?: JsonValue;
}

export interface SourceCodeExport {
  id: string;
  exportedNames: string[];
  moduleSpecifier?: string;
  defaultExport: boolean;
  span?: SourceCodeSpan;
  metadata?: JsonValue;
}

export interface SourceCodeCall {
  id: string;
  callee: string;
  argumentKinds: string[];
  span?: SourceCodeSpan;
  metadata?: JsonValue;
}

export interface SourceCodeRoute {
  id: string;
  protocol: string;
  method: string;
  path: string;
  handlerHint?: string;
  span?: SourceCodeSpan;
  metadata?: JsonValue;
}

export interface SourceCodeTest {
  id: string;
  name?: string;
  runnerHint?: string;
  span?: SourceCodeSpan;
  metadata?: JsonValue;
}

export interface SourceCodePattern {
  id: string;
  kind: string;
  label: string;
  codeSymbols: string[];
  span?: SourceCodeSpan;
  support: number;
  metadata?: JsonValue;
}

export interface SourcePackageFacts {
  name?: string;
  version?: string;
  scripts: Array<{ name: string; command: string; roleEvidence: SourceRoleEvidence[] }>;
  dependencies: Array<{ name: string; scope: string; version?: string }>;
}

export interface SourceRepositoryFileSummary {
  path: string;
  normalizedPath: string;
  mediaType: string;
  byteLength: number;
  contentHash?: string;
  parserId?: string;
  roleEvidence: SourceRoleEvidence[];
  languageEvidence: SourceLanguageEvidence[];
  declarations: number;
  imports: number;
  exports: number;
  calls: number;
  routes: number;
  tests: number;
  patterns: number;
  packageName?: string;
}

export interface SourceRepositoryFacts {
  schema: "scce.source-repository-facts.v1";
  rootUri: string;
  normalizedRootUri: string;
  files: SourceRepositoryFileSummary[];
  packages: Array<{
    manifestPath: string;
    name?: string;
    version?: string;
    scripts: SourcePackageFacts["scripts"];
    dependencies: SourcePackageFacts["dependencies"];
  }>;
  workspace: {
    packageManagers: string[];
    packageCount: number;
    fileCount: number;
    sourceFileCount: number;
    testFileCount: number;
    routeCount: number;
    declarationCount: number;
    importCount: number;
  };
  distributions: {
    parsers: Record<string, number>;
    roles: Record<string, number>;
    languages: Record<string, number>;
    dependencies: Record<string, number>;
    imports: Record<string, number>;
    patterns: Record<string, number>;
  };
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
    edges: Array<{ source: string; target: string; relation: string; weight: number; metadata: JsonValue }>;
  };
  audit: JsonValue;
}

export interface SourceCodeMetrics {
  bytes: number;
  chars: number;
  lines: number;
  nonEmptyLines: number;
  maxLineLength: number;
  meanLineLength: number;
  indentation: Array<{ unit: string; count: number }>;
  delimiterBalance: Array<{ open: string; close: string; balance: number; underflow: number }>;
  codeSymbolShapeEntropy: number;
}

export interface SourceCodeFileFacts {
  schema: "scce.source-code-file-facts.v1";
  path: string;
  normalizedPath: string;
  mediaType: string;
  contentHash?: string;
  parser: {
    id: string;
    version?: string;
    ok: boolean;
    diagnostics: string[];
  };
  languageEvidence: SourceLanguageEvidence[];
  roleEvidence: SourceRoleEvidence[];
  declarations: SourceCodeDeclaration[];
  imports: SourceCodeImport[];
  exports: SourceCodeExport[];
  calls: SourceCodeCall[];
  routes: SourceCodeRoute[];
  tests: SourceCodeTest[];
  patterns: SourceCodePattern[];
  packageFacts?: SourcePackageFacts;
  metrics: SourceCodeMetrics;
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
    edges: Array<{ source: string; target: string; relation: string; weight: number; metadata: JsonValue }>;
  };
  audit: JsonValue;
}

export interface SourceCodeFileFactsInput {
  path: string;
  mediaType: string;
  text: string;
  contentHash?: string;
  parser: SourceCodeFileFacts["parser"];
  languageEvidence?: SourceLanguageEvidence[];
  roleEvidence?: SourceRoleEvidence[];
  declarations?: SourceCodeDeclaration[];
  imports?: SourceCodeImport[];
  exports?: SourceCodeExport[];
  calls?: SourceCodeCall[];
  routes?: SourceCodeRoute[];
  tests?: SourceCodeTest[];
  patterns?: SourceCodePattern[];
  packageFacts?: SourcePackageFacts;
  hasher: Hasher;
}

export interface SourceRepositoryFactsInput {
  rootUri: string;
  files: Array<{
    path: string;
    mediaType: string;
    byteLength: number;
    contentHash?: string;
    facts?: SourceCodeFileFacts;
  }>;
  hasher: Hasher;
}

export function createSourceCodeFileFacts(input: SourceCodeFileFactsInput): SourceCodeFileFacts {
  const normalizedPath = normalizePath(input.path);
  const languageEvidence = dedupeLanguageEvidence([
    ...languageEvidenceFromPath(normalizedPath, input.mediaType),
    ...(input.languageEvidence ?? [])
  ]);
  const roleEvidence = dedupeRoleEvidence([
    ...roleEvidenceFromPath(normalizedPath),
    ...(input.roleEvidence ?? []),
    ...(input.packageFacts ? [{ roleId: "source.role.configuration", source: "package-facts", confidence: 0.84, evidence: ["package-manifest"] }] : [])
  ]);
  const metrics = sourceCodeMetrics(input.text);
  const declarations = uniqueById(input.declarations ?? []);
  const imports = uniqueById(input.imports ?? []);
  const exports = uniqueById(input.exports ?? []);
  const calls = uniqueById(input.calls ?? []);
  const routes = uniqueById(input.routes ?? []);
  const tests = uniqueById(input.tests ?? []);
  const patterns = uniqueById(input.patterns ?? []);
  const graph = buildFactsGraph({ normalizedPath, declarations, imports, exports, calls, routes, tests, patterns, packageFacts: input.packageFacts, hasher: input.hasher });
  const audit = toJsonValue({
    normalizedPath,
    parser: input.parser,
    languageEvidence,
    roleEvidence,
    counts: {
      declarations: declarations.length,
      imports: imports.length,
      exports: exports.length,
      calls: calls.length,
      routes: routes.length,
      tests: tests.length,
      patterns: patterns.length,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length
    },
    metrics
  });
  return {
    schema: "scce.source-code-file-facts.v1",
    path: input.path,
    normalizedPath,
    mediaType: input.mediaType,
    contentHash: input.contentHash,
    parser: input.parser,
    languageEvidence,
    roleEvidence,
    declarations,
    imports,
    exports,
    calls,
    routes,
    tests,
    patterns,
    packageFacts: input.packageFacts,
    metrics,
    graph,
    audit
  };
}

export function sourceCodeFileFactsFromJson(value: JsonValue | undefined): SourceCodeFileFacts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.source-code-file-facts.v1" || typeof record.normalizedPath !== "string") return undefined;
  return record as unknown as SourceCodeFileFacts;
}

export function createSourceRepositoryFacts(input: SourceRepositoryFactsInput): SourceRepositoryFacts {
  const normalizedRootUri = normalizePath(input.rootUri) || ".";
  const files = input.files.map(fileSummary).sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
  const packages = files
    .flatMap(file => {
      const original = input.files.find(item => normalizePath(item.path) === file.normalizedPath);
      const facts = original?.facts?.packageFacts;
      return facts ? [{
        manifestPath: file.normalizedPath,
        name: facts.name,
        version: facts.version,
        scripts: facts.scripts,
        dependencies: facts.dependencies
      }] : [];
    })
    .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
  const parsers = new Map<string, number>();
  const roles = new Map<string, number>();
  const languages = new Map<string, number>();
  const dependencies = new Map<string, number>();
  const imports = new Map<string, number>();
  const patterns = new Map<string, number>();
  let routeCount = 0;
  let declarationCount = 0;
  let importCount = 0;
  let testFileCount = 0;
  for (const file of files) {
    if (file.parserId) increment(parsers, file.parserId);
    for (const role of file.roleEvidence) increment(roles, role.roleId);
    for (const language of file.languageEvidence) increment(languages, `${language.kind}:${language.value}`);
    if (file.tests > 0 || file.roleEvidence.some(role => role.roleId === "source.role.test")) testFileCount++;
    routeCount += file.routes;
    declarationCount += file.declarations;
    importCount += file.imports;
    if (file.patterns > 0) increment(patterns, file.roleEvidence[0]?.roleId ?? "source.pattern.unclassified");
  }
  for (const file of input.files) {
    for (const item of file.facts?.imports ?? []) increment(imports, item.moduleSpecifier);
    for (const item of file.facts?.packageFacts?.dependencies ?? []) increment(dependencies, item.name);
  }
  const packageManagers = packageManagerEvidence(files);
  const graph = buildRepositoryGraph({ root: normalizedRootUri, files, packages, hasher: input.hasher });
  const facts: SourceRepositoryFacts = {
    schema: "scce.source-repository-facts.v1",
    rootUri: input.rootUri,
    normalizedRootUri,
    files,
    packages,
    workspace: {
      packageManagers,
      packageCount: packages.length,
      fileCount: files.length,
      sourceFileCount: files.filter(file => Boolean(file.parserId)).length,
      testFileCount,
      routeCount,
      declarationCount,
      importCount
    },
    distributions: {
      parsers: sortedCountRecord(parsers),
      roles: sortedCountRecord(roles),
      languages: sortedCountRecord(languages),
      dependencies: sortedCountRecord(dependencies),
      imports: sortedCountRecord(imports),
      patterns: sortedCountRecord(patterns)
    },
    graph,
    audit: toJsonValue({
      rootUri: normalizedRootUri,
      files: files.length,
      packages: packages.length,
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length,
      packageManagers
    })
  };
  return facts;
}

export function sourceRepositoryFactsFromJson(value: JsonValue | undefined): SourceRepositoryFacts | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.source-repository-facts.v1" || typeof record.normalizedRootUri !== "string") return undefined;
  return record as unknown as SourceRepositoryFacts;
}

export function normalizePath(path: string): string {
  const pieces = path.split("\\").join("/").split("/");
  const out: string[] = [];
  for (const piece of pieces) {
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      out.pop();
      continue;
    }
    out.push(piece);
  }
  return out.join("/");
}

export function extensionOf(path: string): string {
  const filename = basename(path);
  const index = filename.lastIndexOf(".");
  return index > 0 && index < filename.length - 1 ? filename.slice(index).toLocaleLowerCase() : "";
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function languageEvidenceFromPath(path: string, mediaType = ""): SourceLanguageEvidence[] {
  const out: SourceLanguageEvidence[] = [];
  const normalized = normalizePath(path);
  const ext = extensionOf(normalized);
  if (ext) out.push({ kind: "path-extension", value: ext, source: "path", confidence: 0.74 });
  const file = basename(normalized);
  if (file) out.push({ kind: "filename", value: file, source: "path", confidence: 0.42 });
  if (mediaType) out.push({ kind: "media-type", value: mediaType, source: "source-version", confidence: 0.62 });
  if (file.endsWith(".d.ts")) out.push({ kind: "compound-extension", value: ".d.ts", source: "path", confidence: 0.82 });
  return out;
}

export function roleEvidenceFromPath(path: string): SourceRoleEvidence[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").map(part => part.toLocaleLowerCase());
  const file = basename(normalized).toLocaleLowerCase();
  const out: SourceRoleEvidence[] = [];
  const hasPart = (value: string) => parts.includes(value);
  const hasAnyPart = (values: string[]) => values.some(value => hasPart(value));
  const fileHas = (value: string) => file.includes(value);
  if (hasAnyPart(["test", "tests", "__tests__", "spec", "specs", "e2e"]) || fileHas(".test.") || fileHas(".spec.")) {
    out.push({ roleId: "source.role.test", source: "path", confidence: 0.88, evidence: [normalized] });
  }
  if (hasAnyPart(["docs", "documentation"]) || file.endsWith(".md") || file.endsWith(".txt")) {
    out.push({ roleId: "source.role.documentation", source: "path", confidence: 0.78, evidence: [normalized] });
  }
  if (hasAnyPart(["migrations", "migration"]) || file.endsWith(".sql")) {
    out.push({ roleId: "source.role.schema", source: "path", confidence: 0.78, evidence: [normalized] });
  }
  if (hasAnyPart(["routes", "controllers", "handlers", "api"]) || fileHas("route") || fileHas("controller") || fileHas("handler")) {
    out.push({ roleId: "source.role.interface", source: "path", confidence: 0.68, evidence: [normalized] });
  }
  if (hasAnyPart(["components", "views", "pages", "ui"])) {
    out.push({ roleId: "source.role.presentation", source: "path", confidence: 0.64, evidence: [normalized] });
  }
  if (hasAnyPart(["dist", "build", ".cache", "generated"]) || file.endsWith(".d.ts")) {
    out.push({ roleId: "source.role.generated", source: "path", confidence: 0.9, evidence: [normalized] });
  }
  if (file === "package.json" || file === "tsconfig.json" || file.endsWith(".config.ts") || file.endsWith(".config.js") || file.endsWith(".json") || file.endsWith(".yaml") || file.endsWith(".yml")) {
    out.push({ roleId: "source.role.configuration", source: "path", confidence: 0.74, evidence: [normalized] });
  }
  if (!out.length) out.push({ roleId: "source.role.unresolved", source: "path", confidence: 0.22, evidence: [normalized] });
  return out;
}

export function sourceCodeMetrics(text: string): SourceCodeMetrics {
  const lines = splitLines(text);
  const lengths = lines.map(line => [...line].length);
  const nonEmpty = lines.filter(line => line.trim().length > 0);
  const indentation = indentationHistogram(lines);
  const delimiterBalance = delimiterBalances(text);
  const codeSymbolShapeEntropy = entropy(codeSymbolShapes(text).map(shape => shape.length));
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    chars: [...text].length,
    lines: lines.length,
    nonEmptyLines: nonEmpty.length,
    maxLineLength: lengths.length ? Math.max(...lengths) : 0,
    meanLineLength: lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0,
    indentation,
    delimiterBalance,
    codeSymbolShapeEntropy
  };
}

export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
      out.push(text.slice(start, end));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function lineForOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const start = starts[mid] ?? 0;
    const next = starts[mid + 1] ?? Number.POSITIVE_INFINITY;
    if (offset >= start && offset < next) return mid + 1;
    if (offset < start) hi = mid - 1;
    else lo = mid + 1;
  }
  return starts.length;
}

export function sourceSpan(text: string, start: number, end: number): SourceCodeSpan {
  const starts = lineStarts(text);
  return { charStart: start, charEnd: end, lineStart: lineForOffset(starts, start), lineEnd: lineForOffset(starts, Math.max(start, end - 1)) };
}

function fileSummary(input: SourceRepositoryFactsInput["files"][number]): SourceRepositoryFileSummary {
  const facts = input.facts;
  return {
    path: input.path,
    normalizedPath: normalizePath(input.path),
    mediaType: input.mediaType,
    byteLength: input.byteLength,
    contentHash: input.contentHash,
    parserId: facts?.parser.id,
    roleEvidence: facts?.roleEvidence ?? roleEvidenceFromPath(input.path),
    languageEvidence: facts?.languageEvidence ?? languageEvidenceFromPath(input.path, input.mediaType),
    declarations: facts?.declarations.length ?? 0,
    imports: facts?.imports.length ?? 0,
    exports: facts?.exports.length ?? 0,
    calls: facts?.calls.length ?? 0,
    routes: facts?.routes.length ?? 0,
    tests: facts?.tests.length ?? 0,
    patterns: facts?.patterns.length ?? 0,
    packageName: facts?.packageFacts?.name
  };
}

function buildRepositoryGraph(input: {
  root: string;
  files: SourceRepositoryFileSummary[];
  packages: SourceRepositoryFacts["packages"];
  hasher: Hasher;
}): SourceRepositoryFacts["graph"] {
  const nodes = new Map<string, { id: string; kind: string; label: string; metadata: JsonValue }>();
  const edges: SourceRepositoryFacts["graph"]["edges"] = [];
  const addNode = (kind: string, label: string, metadata: unknown): string => {
    const id = graphId(input.hasher, "repository", input.root, kind, label, metadata);
    nodes.set(id, { id, kind, label, metadata: toJsonValue(metadata) });
    return id;
  };
  const addEdge = (source: string, target: string, relation: string, weight: number, metadata: unknown = {}) => {
    edges.push({ source, target, relation, weight: clamp01(weight), metadata: toJsonValue(metadata) });
  };
  const repo = addNode("source.repository", input.root, { rootUri: input.root, files: input.files.length, packages: input.packages.length });
  const fileNodeByPath = new Map<string, string>();
  for (const file of input.files.slice(0, 10000)) {
    const node = addNode("source.repository_file", file.normalizedPath, file);
    fileNodeByPath.set(file.normalizedPath, node);
    addEdge(repo, node, "source.repository_contains_file", file.parserId ? 0.72 : 0.48, { mediaType: file.mediaType });
    for (const role of file.roleEvidence.slice(0, 16)) {
      const roleNode = addNode("source.repository_role", role.roleId, role);
      addEdge(node, roleNode, "source.file_has_role", role.confidence, { source: role.source });
    }
  }
  for (const pkg of input.packages.slice(0, 1000)) {
    const pkgNode = addNode("source.repository_package", pkg.name ?? pkg.manifestPath, pkg);
    addEdge(repo, pkgNode, "source.repository_declares_package", 0.82, { manifestPath: pkg.manifestPath });
    const manifest = fileNodeByPath.get(pkg.manifestPath);
    if (manifest) addEdge(manifest, pkgNode, "source.file_describes_package", 0.84);
    for (const script of pkg.scripts.slice(0, 256)) {
      const scriptNode = addNode("source.package_script", `${pkg.name ?? pkg.manifestPath}:${script.name}`, script);
      addEdge(pkgNode, scriptNode, "source.package_has_script", 0.62, { command: script.command });
    }
    for (const dep of pkg.dependencies.slice(0, 1000)) {
      const depNode = addNode("source.package_dependency", dep.name, dep);
      addEdge(pkgNode, depNode, "source.package_depends_on", dep.scope === "runtime" ? 0.78 : 0.56, { scope: dep.scope });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function packageManagerEvidence(files: readonly SourceRepositoryFileSummary[]): string[] {
  const out = new Set<string>();
  for (const file of files) {
    const name = basename(file.normalizedPath).toLocaleLowerCase();
    const lock = lockEvidenceName(name);
    if (lock) out.add(lock);
    const workspace = workspaceEvidenceName(name);
    if (workspace) out.add(workspace);
    if (file.packageName) out.add(`manifest:${name}`);
  }
  return [...out].sort();
}

function lockEvidenceName(filename: string): string | undefined {
  if (filename.endsWith(".lockb")) return compactEvidenceName(filename.slice(0, -".lockb".length), "lock");
  if (filename.endsWith(".lock")) return compactEvidenceName(filename.slice(0, -".lock".length), "lock");
  const lockMarker = "-lock.";
  const lockAt = filename.indexOf(lockMarker);
  if (lockAt > 0) return compactEvidenceName(filename.slice(0, lockAt), "lock");
  return undefined;
}

function workspaceEvidenceName(filename: string): string | undefined {
  const marker = "-workspace.";
  const at = filename.indexOf(marker);
  if (at > 0) return compactEvidenceName(filename.slice(0, at), "workspace");
  return undefined;
}

function compactEvidenceName(stem: string, kind: string): string | undefined {
  const out: string[] = [];
  for (const char of stem.normalize("NFKC")) {
    const cp = char.codePointAt(0) ?? 0;
    const valid = cp >= 48 && cp <= 57 || cp >= 97 && cp <= 122 || cp >= 65 && cp <= 90 || char === "_" || char === "-";
    if (valid) out.push(char.toLocaleLowerCase());
  }
  const value = out.join("");
  return value ? `${value}:${kind}` : undefined;
}

function increment(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCountRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildFactsGraph(input: {
  normalizedPath: string;
  declarations: SourceCodeDeclaration[];
  imports: SourceCodeImport[];
  exports: SourceCodeExport[];
  calls: SourceCodeCall[];
  routes: SourceCodeRoute[];
  tests: SourceCodeTest[];
  patterns: SourceCodePattern[];
  packageFacts?: SourcePackageFacts;
  hasher: Hasher;
}): SourceCodeFileFacts["graph"] {
  const nodes = new Map<string, { id: string; kind: string; label: string; metadata: JsonValue }>();
  const edges: SourceCodeFileFacts["graph"]["edges"] = [];
  const fileId = graphId(input.hasher, "file", input.normalizedPath);
  nodes.set(fileId, { id: fileId, kind: "source.file", label: input.normalizedPath, metadata: toJsonValue({ path: input.normalizedPath }) });
  const addNode = (kind: string, label: string, metadata: unknown): string => {
    const id = graphId(input.hasher, kind, input.normalizedPath, label, metadata);
    nodes.set(id, { id, kind, label, metadata: toJsonValue(metadata) });
    return id;
  };
  const addEdge = (source: string, target: string, relation: string, weight: number, metadata: unknown = {}) => {
    edges.push({ source, target, relation, weight: clamp01(weight), metadata: toJsonValue(metadata) });
  };
  for (const declaration of input.declarations.slice(0, 512)) {
    const id = addNode("source.declaration", declaration.name, declaration);
    addEdge(fileId, id, "source.file_declares", declaration.exported ? 0.82 : 0.68, { exported: declaration.exported });
  }
  for (const item of input.imports.slice(0, 512)) {
    const id = addNode("source.import", item.moduleSpecifier, item);
    addEdge(fileId, id, "source.file_imports", item.typeOnly ? 0.48 : 0.72, { names: item.importedNames });
  }
  for (const item of input.exports.slice(0, 512)) {
    const id = addNode("source.export", item.exportedNames.join(","), item);
    addEdge(fileId, id, "source.file_exports", item.defaultExport ? 0.72 : 0.76);
  }
  for (const call of input.calls.slice(0, 512)) {
    const id = addNode("source.call", call.callee, call);
    addEdge(fileId, id, "source.file_calls", 0.42);
  }
  for (const route of input.routes.slice(0, 256)) {
    const id = addNode("source.route", `${route.method} ${route.path}`, route);
    addEdge(fileId, id, "source.file_registers_route", 0.78);
  }
  for (const test of input.tests.slice(0, 256)) {
    const id = addNode("source.test", test.name ?? test.id, test);
    addEdge(fileId, id, "source.file_contains_test", 0.7);
  }
  for (const pattern of input.patterns.slice(0, 512)) {
    const id = addNode("source.pattern", pattern.label, pattern);
    addEdge(fileId, id, "source.file_exhibits_pattern", pattern.support);
  }
  if (input.packageFacts) {
    const pkg = addNode("source.package", input.packageFacts.name ?? input.normalizedPath, input.packageFacts);
    addEdge(fileId, pkg, "source.file_describes_package", 0.82);
    for (const dep of input.packageFacts.dependencies.slice(0, 512)) {
      const depId = addNode("source.package_dependency", dep.name, dep);
      addEdge(pkg, depId, "source.package_depends_on", dep.scope === "runtime" ? 0.78 : 0.58, { scope: dep.scope });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function indentationHistogram(lines: readonly string[]): Array<{ unit: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of lines.slice(0, 5000)) {
    if (!line.length) continue;
    let i = 0;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (i === 0) continue;
    const unit = line.slice(0, Math.min(i, 8));
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([unit, count]) => ({ unit, count }));
}

function delimiterBalances(text: string): Array<{ open: string; close: string; balance: number; underflow: number }> {
  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"]
  ] as const;
  return pairs.map(([open, close]) => {
    let balance = 0;
    let underflow = 0;
    for (const ch of text) {
      if (ch === open) balance++;
      else if (ch === close) {
        if (balance === 0) underflow++;
        else balance--;
      }
    }
    return { open, close, balance, underflow };
  });
}

function codeSymbolShapes(text: string): string[] {
  const shapes: string[] = [];
  let current = "";
  let currentKind = "";
  const flush = () => {
    if (current) shapes.push(`${currentKind}:${Math.min(32, current.length)}`);
    current = "";
    currentKind = "";
  };
  for (const ch of text) {
    const kind = charKind(ch);
    if (kind === "space") {
      flush();
      continue;
    }
    if (kind !== currentKind) flush();
    currentKind = kind;
    current += ch;
  }
  flush();
  return shapes.slice(0, 50000);
}

function charKind(ch: string): string {
  if (ch.trim() === "") return "space";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 48 && cp <= 57) return "number";
  if (cp >= 65 && cp <= 90) return "upper-latin";
  if (cp >= 97 && cp <= 122) return "lower-latin";
  if (cp === 95 || cp === 36) return "identifier-mark";
  if ("()[]{}<>".includes(ch)) return "delimiter";
  if ("'\"`".includes(ch)) return "quote";
  if ("+-*/%=!&|^~?:.;,".includes(ch)) return "operator";
  return "unicode";
}

function dedupeLanguageEvidence(items: readonly SourceLanguageEvidence[]): SourceLanguageEvidence[] {
  const seen = new Map<string, SourceLanguageEvidence>();
  for (const item of items) {
    const key = `${item.kind}\u001f${item.value}\u001f${item.source}`;
    const prev = seen.get(key);
    if (!prev || item.confidence > prev.confidence) seen.set(key, { ...item, confidence: clamp01(item.confidence) });
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 32);
}

function dedupeRoleEvidence(items: readonly SourceRoleEvidence[]): SourceRoleEvidence[] {
  const seen = new Map<string, SourceRoleEvidence>();
  for (const item of items) {
    const key = `${item.roleId}\u001f${item.source}`;
    const prev = seen.get(key);
    if (!prev || item.confidence > prev.confidence) seen.set(key, { ...item, confidence: clamp01(item.confidence), evidence: [...new Set(item.evidence)].slice(0, 16) });
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 32);
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

function graphId(hasher: Hasher, ...parts: unknown[]): string {
  return `source_graph_${hasher.digestHex(canonicalStringify(parts)).slice(0, 40)}`;
}

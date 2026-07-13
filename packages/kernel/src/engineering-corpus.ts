import type { EvidenceId, Hasher, JsonValue } from "./types.js";
import { canonicalStringify, clamp01, mean, toJsonValue } from "./primitives.js";
import {
  extensionOf,
  normalizePath,
  sourceCodeFileFactsFromJson,
  sourceRepositoryFactsFromJson,
  type SourceCodeFileFacts,
  type SourceCodeImport,
  type SourceRepositoryFacts,
  type SourceRepositoryFileSummary
} from "./source-code-graph.js";

export interface EngineeringCorpusProjectionInput {
  repositoryFacts?: SourceRepositoryFacts;
  fileFacts?: SourceCodeFileFacts[];
  evidenceIds?: EvidenceId[];
  sourceVersionId?: string;
  hasher: Hasher;
}

export interface EngineeringFileProjection {
  id: string;
  path: string;
  mediaType: string;
  byteLength: number;
  contentHash?: string;
  language: string;
  languageEvidence: Array<{ kind: string; value: string; source: string; confidence: number }>;
  roles: Array<{ roleId: string; source: string; confidence: number; evidence: string[] }>;
  parserId?: string;
  declarations: number;
  imports: number;
  exports: number;
  calls: number;
  routes: number;
  tests: number;
  patterns: number;
  packageName?: string;
  entrypointScore: number;
  moduleScore: number;
  validationScore: number;
  generatedScore: number;
  factsAvailable: boolean;
  evidenceIds: EvidenceId[];
}

export interface EngineeringLanguageProfile {
  id: string;
  language: string;
  weight: number;
  fileCount: number;
  sourceFileCount: number;
  declarationCount: number;
  importCount: number;
  routeCount: number;
  testCount: number;
  patternCount: number;
  roles: Array<{ roleId: string; count: number; confidence: number }>;
  entrypoints: Array<{ path: string; score: number }>;
  packageNames: string[];
  capabilityIds: string[];
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringRoleProfile {
  id: string;
  roleId: string;
  fileCount: number;
  confidence: number;
  paths: string[];
  languages: Array<{ language: string; count: number }>;
  evidenceIds: EvidenceId[];
}

export interface EngineeringPackageSurface {
  id: string;
  name?: string;
  version?: string;
  manifestPath: string;
  scripts: EngineeringCommandCandidate[];
  dependencies: EngineeringDependencyProfile[];
  managerEvidence: string[];
  languageHints: string[];
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringCommandCandidate {
  id: string;
  kind: string;
  scriptName: string;
  command: string;
  packageName?: string;
  manifestPath: string;
  roleEvidence: Array<{ roleId: string; source: string; confidence: number; evidence: string[] }>;
  managerEvidence: string[];
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringDependencyProfile {
  id: string;
  name: string;
  scope: string;
  version?: string;
  support: number;
  packageNames: string[];
  manifestPaths: string[];
  importEvidence: Array<{ path: string; count: number }>;
  capabilityIds: string[];
  evidenceIds: EvidenceId[];
}

export interface EngineeringSymbolProfile {
  id: string;
  name: string;
  kind: string;
  path: string;
  language: string;
  exported: boolean;
  defaultExport: boolean;
  signature?: string;
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringImportProfile {
  id: string;
  moduleSpecifier: string;
  path: string;
  language: string;
  importedNames: string[];
  typeOnly: boolean;
  packageName: string;
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringRouteProfile {
  id: string;
  protocol: string;
  method: string;
  path: string;
  handlerHint?: string;
  filePath: string;
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringTestProfile {
  id: string;
  name?: string;
  runnerHint?: string;
  filePath: string;
  language: string;
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface EngineeringCapability {
  id: string;
  kind: string;
  support: number;
  confidence: number;
  evidence: string[];
  evidenceIds: EvidenceId[];
}

export interface EngineeringGraphNode {
  id: string;
  kind: string;
  label: string;
  metadata: JsonValue;
}

export interface EngineeringGraphEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
  metadata: JsonValue;
}

export interface EngineeringCorpusProjection {
  schema: "scce.engineering-corpus.v1";
  id: string;
  rootUri: string;
  sourceVersionId?: string;
  summary: {
    fileCount: number;
    sourceFileCount: number;
    packageCount: number;
    languageCount: number;
    roleCount: number;
    commandCount: number;
    dependencyCount: number;
    symbolCount: number;
    importCount: number;
    routeCount: number;
    testCount: number;
    generatedFileCount: number;
    factCoverage: number;
    plannerReadiness: number;
  };
  files: EngineeringFileProjection[];
  languages: EngineeringLanguageProfile[];
  roles: EngineeringRoleProfile[];
  packages: EngineeringPackageSurface[];
  commands: EngineeringCommandCandidate[];
  dependencies: EngineeringDependencyProfile[];
  symbols: EngineeringSymbolProfile[];
  imports: EngineeringImportProfile[];
  routes: EngineeringRouteProfile[];
  tests: EngineeringTestProfile[];
  capabilities: EngineeringCapability[];
  plannerHints: {
    primaryLanguages: string[];
    packageManagers: string[];
    buildCommands: EngineeringCommandCandidate[];
    validationCommands: EngineeringCommandCandidate[];
    runtimeCommands: EngineeringCommandCandidate[];
    lintCommands: EngineeringCommandCandidate[];
    entrypoints: Array<{ path: string; language: string; score: number; evidenceIds: EvidenceId[] }>;
    packageManifests: string[];
    sourceRoots: string[];
    generatedRoots: string[];
  };
  graph: {
    nodes: EngineeringGraphNode[];
    edges: EngineeringGraphEdge[];
  };
  audit: JsonValue;
}

export function createEngineeringCorpusProjection(input: EngineeringCorpusProjectionInput): EngineeringCorpusProjection {
  const evidenceIds = [...new Set(input.evidenceIds ?? [])];
  const repositoryFacts = input.repositoryFacts;
  const directFacts = dedupeFileFacts(input.fileFacts ?? []);
  const rootUri = repositoryFacts?.normalizedRootUri ?? sharedRootForFacts(directFacts) ?? ".";
  const files = buildFileProjections({ repositoryFacts, fileFacts: directFacts, evidenceIds, hasher: input.hasher });
  const commands = commandCandidates({ repositoryFacts, files, evidenceIds, hasher: input.hasher });
  const imports = importProfiles({ fileFacts: directFacts, files, evidenceIds, hasher: input.hasher });
  const symbols = symbolProfiles({ fileFacts: directFacts, files, evidenceIds, hasher: input.hasher });
  const routes = routeProfiles({ fileFacts: directFacts, files, evidenceIds, hasher: input.hasher });
  const tests = testProfiles({ fileFacts: directFacts, files, evidenceIds, hasher: input.hasher });
  const dependencies = dependencyProfiles({ repositoryFacts, imports, commands, evidenceIds, hasher: input.hasher });
  const languages = languageProfiles({ files, dependencies, symbols, routes, tests, evidenceIds, hasher: input.hasher });
  const roles = roleProfiles({ files, evidenceIds, hasher: input.hasher });
  const packages = packageSurfaces({ repositoryFacts, commands, dependencies, files, evidenceIds, hasher: input.hasher });
  const capabilities = capabilityVector({ files, languages, commands, dependencies, symbols, routes, tests, evidenceIds, hasher: input.hasher });
  const plannerHints = plannerHintsFor({ repositoryFacts, files, languages, commands, evidenceIds });
  const graph = engineeringGraph({ rootUri, files, languages, roles, packages, commands, dependencies, symbols, imports, routes, tests, capabilities, hasher: input.hasher });
  const factCoverage = files.length ? files.filter(file => file.factsAvailable).length / files.length : 0;
  const plannerReadiness = clamp01(
    0.18 * scorePresence(languages.length) +
    0.16 * scorePresence(files.length) +
    0.14 * scorePresence(commands.length) +
    0.12 * scorePresence(dependencies.length) +
    0.12 * scorePresence(symbols.length) +
    0.12 * scorePresence(tests.length) +
    0.08 * scorePresence(routes.length) +
    0.08 * factCoverage
  );
  const summary = {
    fileCount: files.length,
    sourceFileCount: files.filter(file => file.parserId).length,
    packageCount: packages.length,
    languageCount: languages.length,
    roleCount: roles.length,
    commandCount: commands.length,
    dependencyCount: dependencies.length,
    symbolCount: symbols.length,
    importCount: imports.length,
    routeCount: routes.length,
    testCount: tests.length,
    generatedFileCount: files.filter(file => file.generatedScore >= 0.7).length,
    factCoverage,
    plannerReadiness
  };
  const id = `engineering_corpus_${input.hasher.digestHex(canonicalStringify({
    rootUri,
    sourceVersionId: input.sourceVersionId,
    summary,
    commands: commands.map(command => [command.kind, command.scriptName, command.command]),
    dependencies: dependencies.map(dep => [dep.name, dep.scope, dep.support]),
    languages: languages.map(language => [language.language, language.weight])
  })).slice(0, 40)}`;
  return {
    schema: "scce.engineering-corpus.v1",
    id,
    rootUri,
    sourceVersionId: input.sourceVersionId,
    summary,
    files,
    languages,
    roles,
    packages,
    commands,
    dependencies,
    symbols,
    imports,
    routes,
    tests,
    capabilities,
    plannerHints,
    graph,
    audit: toJsonValue({
      id,
      rootUri,
      sourceVersionId: input.sourceVersionId,
      repositoryFacts: repositoryFacts ? {
        schema: repositoryFacts.schema,
        normalizedRootUri: repositoryFacts.normalizedRootUri,
        workspace: repositoryFacts.workspace,
        distributions: {
          languages: Object.keys(repositoryFacts.distributions.languages).length,
          roles: Object.keys(repositoryFacts.distributions.roles).length,
          imports: Object.keys(repositoryFacts.distributions.imports).length,
          dependencies: Object.keys(repositoryFacts.distributions.dependencies).length
        }
      } : null,
      directFileFactCount: directFacts.length,
      summary,
      capabilityIds: capabilities.map(capability => capability.id),
      graphNodes: graph.nodes.length,
      graphEdges: graph.edges.length
    })
  };
}

export function engineeringCorpusProjectionFromJson(value: JsonValue | undefined): EngineeringCorpusProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.engineering-corpus.v1" || typeof record.id !== "string" || typeof record.rootUri !== "string") return undefined;
  return record as unknown as EngineeringCorpusProjection;
}

export function engineeringCorpusProjectionFromMetadata(metadata: JsonValue, hasher: Hasher, evidenceIds: EvidenceId[] = [], sourceVersionId?: string): EngineeringCorpusProjection | undefined {
  const record = jsonRecord(metadata);
  const existing = engineeringCorpusProjectionFromJson(record.engineeringCorpus);
  if (existing) return existing;
  const repositoryFacts = sourceRepositoryFactsFromJson(record.repositoryFacts);
  const fileFacts = sourceCodeFileFactsFromJson(record.sourceCode);
  if (!repositoryFacts && !fileFacts) return undefined;
  return createEngineeringCorpusProjection({
    repositoryFacts,
    fileFacts: fileFacts ? [fileFacts] : [],
    evidenceIds,
    sourceVersionId,
    hasher
  });
}

function buildFileProjections(input: {
  repositoryFacts?: SourceRepositoryFacts;
  fileFacts: SourceCodeFileFacts[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringFileProjection[] {
  const byPath = new Map<string, { summary?: SourceRepositoryFileSummary; facts?: SourceCodeFileFacts }>();
  for (const file of input.repositoryFacts?.files ?? []) {
    byPath.set(file.normalizedPath, { summary: file });
  }
  for (const facts of input.fileFacts) {
    const path = normalizePath(facts.normalizedPath || facts.path);
    const current = byPath.get(path) ?? {};
    byPath.set(path, { ...current, facts });
  }
  return [...byPath.entries()]
    .map(([path, value]) => fileProjection(path, value.summary, value.facts, input.evidenceIds, input.hasher))
    .sort((a, b) => b.moduleScore - a.moduleScore || b.entrypointScore - a.entrypointScore || a.path.localeCompare(b.path))
    .slice(0, 20000);
}

function fileProjection(
  normalizedPath: string,
  summary: SourceRepositoryFileSummary | undefined,
  facts: SourceCodeFileFacts | undefined,
  evidenceIds: EvidenceId[],
  hasher: Hasher
): EngineeringFileProjection {
  const languageEvidence = (facts?.languageEvidence ?? summary?.languageEvidence ?? []).map(item => ({
    kind: item.kind,
    value: item.value,
    source: item.source,
    confidence: clamp01(item.confidence)
  }));
  const roles = (facts?.roleEvidence ?? summary?.roleEvidence ?? []).map(role => ({
    roleId: role.roleId,
    source: role.source,
    confidence: clamp01(role.confidence),
    evidence: role.evidence.slice(0, 16)
  }));
  const declarations = facts?.declarations.length ?? summary?.declarations ?? 0;
  const imports = facts?.imports.length ?? summary?.imports ?? 0;
  const exports = facts?.exports.length ?? summary?.exports ?? 0;
  const calls = facts?.calls.length ?? summary?.calls ?? 0;
  const routes = facts?.routes.length ?? summary?.routes ?? 0;
  const tests = facts?.tests.length ?? summary?.tests ?? 0;
  const patterns = facts?.patterns.length ?? summary?.patterns ?? 0;
  const parserId = facts?.parser.id ?? summary?.parserId;
  const byteLength = facts?.metrics.bytes ?? summary?.byteLength ?? 0;
  const mediaType = facts?.mediaType ?? summary?.mediaType ?? mediaTypeFromPath(normalizedPath);
  const language = languageKey(languageEvidence, mediaType);
  const generatedScore = generatedScoreFor(normalizedPath, roles);
  const moduleScore = clamp01(
    0.2 * scorePresence(parserId) +
    0.2 * scorePresence(declarations + exports) +
    0.16 * scorePresence(imports) +
    0.12 * scorePresence(patterns) +
    0.12 * scorePresence(routes) +
    0.1 * scorePresence(calls) +
    0.1 * (1 - generatedScore)
  );
  const validationScore = clamp01(
    0.42 * scorePresence(tests) +
    0.22 * strongestRoleConfidence(roles, "source.role.test") +
    0.18 * strongestRoleConfidence(roles, "source.role.validation") +
    0.18 * scorePresence(patterns)
  );
  const entrypointScore = entrypointScoreFor({ path: normalizedPath, roles, declarations, exports, routes, tests, parserId, generatedScore });
  return {
    id: `eng_file_${hasher.digestHex(`${normalizedPath}:${summary?.contentHash ?? facts?.contentHash ?? ""}`).slice(0, 40)}`,
    path: normalizedPath,
    mediaType,
    byteLength,
    contentHash: facts?.contentHash ?? summary?.contentHash,
    language,
    languageEvidence,
    roles,
    parserId,
    declarations,
    imports,
    exports,
    calls,
    routes,
    tests,
    patterns,
    packageName: facts?.packageFacts?.name ?? summary?.packageName,
    entrypointScore,
    moduleScore,
    validationScore,
    generatedScore,
    factsAvailable: Boolean(facts),
    evidenceIds
  };
}

function languageProfiles(input: {
  files: EngineeringFileProjection[];
  dependencies: EngineeringDependencyProfile[];
  symbols: EngineeringSymbolProfile[];
  routes: EngineeringRouteProfile[];
  tests: EngineeringTestProfile[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringLanguageProfile[] {
  const groups = groupBy(input.files, file => file.language);
  const totalFiles = Math.max(1, input.files.length);
  return [...groups.entries()].map(([language, files]) => {
    const roles = roleCounts(files);
    const filePaths = new Set(files.map(file => file.path));
    const dependencyCount = input.dependencies.filter(dep => dep.importEvidence.some(item => filePaths.has(item.path))).length;
    const symbols = input.symbols.filter(symbol => filePaths.has(symbol.path));
    const routes = input.routes.filter(route => filePaths.has(route.filePath));
    const tests = input.tests.filter(test => filePaths.has(test.filePath));
    const capabilityIds = languageCapabilities({ files, dependencyCount, symbols: symbols.length, routes: routes.length, tests: tests.length });
    const entrypoints = files
      .filter(file => file.entrypointScore > 0.2)
      .sort((a, b) => b.entrypointScore - a.entrypointScore || a.path.localeCompare(b.path))
      .slice(0, 12)
      .map(file => ({ path: file.path, score: file.entrypointScore }));
    const confidence = clamp01(
      0.25 +
      0.25 * Math.min(1, files.length / 4) +
      0.2 * mean(files.map(file => file.moduleScore)) +
      0.14 * scorePresence(symbols.length) +
      0.08 * scorePresence(routes.length) +
      0.08 * scorePresence(tests.length)
    );
    return {
      id: `eng_lang_${input.hasher.digestHex(`${language}:${files.map(file => file.id).join("|")}`).slice(0, 40)}`,
      language,
      weight: clamp01(files.length / totalFiles),
      fileCount: files.length,
      sourceFileCount: files.filter(file => file.parserId).length,
      declarationCount: sum(files.map(file => file.declarations)),
      importCount: sum(files.map(file => file.imports)),
      routeCount: routes.length || sum(files.map(file => file.routes)),
      testCount: tests.length || sum(files.map(file => file.tests)),
      patternCount: sum(files.map(file => file.patterns)),
      roles,
      entrypoints,
      packageNames: [...new Set(files.flatMap(file => file.packageName ? [file.packageName] : []))].sort().slice(0, 32),
      capabilityIds,
      confidence,
      evidenceIds: input.evidenceIds
    };
  }).sort((a, b) => b.weight - a.weight || b.confidence - a.confidence || a.language.localeCompare(b.language));
}

function roleProfiles(input: { files: EngineeringFileProjection[]; evidenceIds: EvidenceId[]; hasher: Hasher }): EngineeringRoleProfile[] {
  const groups = new Map<string, EngineeringFileProjection[]>();
  for (const file of input.files) {
    for (const role of file.roles.length ? file.roles : [{ roleId: "source.role.unresolved", confidence: 0.2, source: "projection", evidence: [] }]) {
      groups.set(role.roleId, [...(groups.get(role.roleId) ?? []), file]);
    }
  }
  return [...groups.entries()].map(([roleId, files]) => ({
    id: `eng_role_${input.hasher.digestHex(`${roleId}:${files.map(file => file.path).join("|")}`).slice(0, 40)}`,
    roleId,
    fileCount: files.length,
    confidence: clamp01(mean(files.flatMap(file => file.roles.filter(role => role.roleId === roleId).map(role => role.confidence))) || 0.2),
    paths: files.map(file => file.path).sort().slice(0, 64),
    languages: sortedCounts(files.map(file => file.language)).slice(0, 16).map(([language, count]) => ({ language, count })),
    evidenceIds: input.evidenceIds
  })).sort((a, b) => b.fileCount - a.fileCount || a.roleId.localeCompare(b.roleId));
}

function packageSurfaces(input: {
  repositoryFacts?: SourceRepositoryFacts;
  commands: EngineeringCommandCandidate[];
  dependencies: EngineeringDependencyProfile[];
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringPackageSurface[] {
  const packageFacts = input.repositoryFacts?.packages ?? [];
  return packageFacts.map(pkg => {
    const commands = input.commands.filter(command => command.manifestPath === pkg.manifestPath);
    const dependencies = input.dependencies.filter(dep => dep.manifestPaths.includes(pkg.manifestPath));
    const manifestFile = input.files.find(file => file.path === pkg.manifestPath);
    const managerEvidence = managerEvidenceFor(input.repositoryFacts, pkg.manifestPath);
    const languageHints = manifestFile ? [manifestFile.language] : [];
    const confidence = clamp01(0.34 + 0.16 * scorePresence(commands.length) + 0.16 * scorePresence(dependencies.length) + 0.16 * scorePresence(managerEvidence.length) + 0.18 * scorePresence(manifestFile?.factsAvailable ? 1 : 0));
    return {
      id: `eng_package_${input.hasher.digestHex(`${pkg.manifestPath}:${pkg.name ?? ""}:${pkg.version ?? ""}`).slice(0, 40)}`,
      name: pkg.name,
      version: pkg.version,
      manifestPath: pkg.manifestPath,
      scripts: commands,
      dependencies,
      managerEvidence,
      languageHints,
      confidence,
      evidenceIds: input.evidenceIds
    };
  }).sort((a, b) => b.confidence - a.confidence || a.manifestPath.localeCompare(b.manifestPath));
}

function commandCandidates(input: {
  repositoryFacts?: SourceRepositoryFacts;
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringCommandCandidate[] {
  const commands: EngineeringCommandCandidate[] = [];
  for (const pkg of input.repositoryFacts?.packages ?? []) {
    const managerEvidence = managerEvidenceFor(input.repositoryFacts, pkg.manifestPath);
    for (const script of pkg.scripts) {
      const kind = commandKind(script.roleEvidence.map(role => role.roleId), script.name, script.command);
      const confidence = clamp01(0.36 + 0.24 * scorePresence(script.command) + 0.2 * mean(script.roleEvidence.map(role => role.confidence)) + 0.1 * scorePresence(managerEvidence.length) + 0.1 * scorePresence(pkg.name));
      commands.push({
        id: `eng_command_${input.hasher.digestHex(`${pkg.manifestPath}:${script.name}:${script.command}`).slice(0, 40)}`,
        kind,
        scriptName: script.name,
        command: script.command,
        packageName: pkg.name,
        manifestPath: pkg.manifestPath,
        roleEvidence: script.roleEvidence.map(role => ({ ...role, confidence: clamp01(role.confidence), evidence: role.evidence.slice(0, 16) })),
        managerEvidence,
        confidence,
        evidenceIds: input.evidenceIds
      });
    }
  }
  return commands.sort((a, b) => commandRank(a.kind) - commandRank(b.kind) || b.confidence - a.confidence || a.scriptName.localeCompare(b.scriptName)).slice(0, 512);
}

function dependencyProfiles(input: {
  repositoryFacts?: SourceRepositoryFacts;
  imports: EngineeringImportProfile[];
  commands: EngineeringCommandCandidate[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringDependencyProfile[] {
  const groups = new Map<string, {
    name: string;
    scopes: Map<string, number>;
    versions: Set<string>;
    packageNames: Set<string>;
    manifestPaths: Set<string>;
    importEvidence: Map<string, number>;
  }>();
  const ensure = (name: string) => {
    const key = canonicalPackageKey(name);
    const group = groups.get(key) ?? { name, scopes: new Map<string, number>(), versions: new Set<string>(), packageNames: new Set<string>(), manifestPaths: new Set<string>(), importEvidence: new Map<string, number>() };
    groups.set(key, group);
    return group;
  };
  for (const pkg of input.repositoryFacts?.packages ?? []) {
    for (const dep of pkg.dependencies) {
      const group = ensure(dep.name);
      group.scopes.set(dep.scope, (group.scopes.get(dep.scope) ?? 0) + 1);
      if (dep.version) group.versions.add(dep.version);
      if (pkg.name) group.packageNames.add(pkg.name);
      group.manifestPaths.add(pkg.manifestPath);
    }
  }
  for (const imp of input.imports) {
    const group = ensure(imp.packageName || imp.moduleSpecifier);
    group.importEvidence.set(imp.path, (group.importEvidence.get(imp.path) ?? 0) + 1);
  }
  return [...groups.values()].map(group => {
    const importEvidence = [...group.importEvidence.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32).map(([path, count]) => ({ path, count }));
    const manifestSupport = group.manifestPaths.size;
    const importSupport = sum(importEvidence.map(item => item.count));
    const support = clamp01(0.18 + 0.32 * Math.min(1, manifestSupport / 2) + 0.34 * Math.min(1, importSupport / 4) + 0.08 * Math.min(1, group.scopes.size / 3) + 0.08 * scriptMentionsDependency(input.commands, group.name));
    const scope = sortedCounts([...group.scopes.entries()].flatMap(([scope, count]) => Array.from({ length: count }, () => scope)))[0]?.[0] ?? "observed";
    return {
      id: `eng_dep_${input.hasher.digestHex(`${group.name}:${scope}:${[...group.manifestPaths].join("|")}`).slice(0, 40)}`,
      name: group.name,
      scope,
      version: [...group.versions].sort()[0],
      support,
      packageNames: [...group.packageNames].sort().slice(0, 32),
      manifestPaths: [...group.manifestPaths].sort().slice(0, 32),
      importEvidence,
      capabilityIds: dependencyCapabilities(group.name, scope, importSupport),
      evidenceIds: input.evidenceIds
    };
  }).sort((a, b) => b.support - a.support || a.name.localeCompare(b.name)).slice(0, 1024);
}

function importProfiles(input: {
  fileFacts: SourceCodeFileFacts[];
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringImportProfile[] {
  const fileByPath = new Map(input.files.map(file => [file.path, file]));
  const imports: EngineeringImportProfile[] = [];
  for (const facts of input.fileFacts) {
    const path = normalizePath(facts.normalizedPath || facts.path);
    const file = fileByPath.get(path);
    for (const item of facts.imports.slice(0, 4096)) {
      imports.push(importProfile(item, path, file?.language ?? languageKey(facts.languageEvidence, facts.mediaType), input.evidenceIds, input.hasher));
    }
  }
  return uniqueBy(imports, item => `${item.path}\u001f${item.moduleSpecifier}\u001f${item.importedNames.join(",")}`).slice(0, 8192);
}

function importProfile(item: SourceCodeImport, path: string, language: string, evidenceIds: EvidenceId[], hasher: Hasher): EngineeringImportProfile {
  return {
    id: `eng_import_${hasher.digestHex(`${path}:${item.moduleSpecifier}:${item.importedNames.join("|")}`).slice(0, 40)}`,
    moduleSpecifier: item.moduleSpecifier,
    path,
    language,
    importedNames: item.importedNames.slice(0, 64),
    typeOnly: item.typeOnly,
    packageName: packageNameFromSpecifier(item.moduleSpecifier),
    confidence: clamp01(item.typeOnly ? 0.52 : 0.7),
    evidenceIds
  };
}

function symbolProfiles(input: {
  fileFacts: SourceCodeFileFacts[];
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringSymbolProfile[] {
  const fileByPath = new Map(input.files.map(file => [file.path, file]));
  const symbols: EngineeringSymbolProfile[] = [];
  for (const facts of input.fileFacts) {
    const path = normalizePath(facts.normalizedPath || facts.path);
    const language = fileByPath.get(path)?.language ?? languageKey(facts.languageEvidence, facts.mediaType);
    for (const declaration of facts.declarations.slice(0, 4096)) {
      symbols.push({
        id: `eng_symbol_${input.hasher.digestHex(`${path}:${declaration.kind}:${declaration.name}:${declaration.exported}`).slice(0, 40)}`,
        name: declaration.name,
        kind: declaration.kind,
        path,
        language,
        exported: declaration.exported,
        defaultExport: declaration.defaultExport,
        signature: declaration.signature,
        confidence: clamp01(0.48 + (declaration.exported ? 0.18 : 0) + (declaration.signature ? 0.12 : 0) + (facts.parser.ok ? 0.14 : 0)),
        evidenceIds: input.evidenceIds
      });
    }
  }
  return uniqueBy(symbols, item => `${item.path}\u001f${item.kind}\u001f${item.name}`).slice(0, 8192);
}

function routeProfiles(input: {
  fileFacts: SourceCodeFileFacts[];
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringRouteProfile[] {
  const routes: EngineeringRouteProfile[] = [];
  for (const facts of input.fileFacts) {
    const filePath = normalizePath(facts.normalizedPath || facts.path);
    for (const route of facts.routes.slice(0, 1024)) {
      routes.push({
        id: `eng_route_${input.hasher.digestHex(`${filePath}:${route.protocol}:${route.method}:${route.path}`).slice(0, 40)}`,
        protocol: route.protocol,
        method: route.method,
        path: route.path,
        handlerHint: route.handlerHint,
        filePath,
        confidence: clamp01(0.62 + (route.handlerHint ? 0.12 : 0) + (facts.parser.ok ? 0.12 : 0)),
        evidenceIds: input.evidenceIds
      });
    }
  }
  return uniqueBy(routes, item => `${item.filePath}\u001f${item.method}\u001f${item.path}`).slice(0, 2048);
}

function testProfiles(input: {
  fileFacts: SourceCodeFileFacts[];
  files: EngineeringFileProjection[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringTestProfile[] {
  const fileByPath = new Map(input.files.map(file => [file.path, file]));
  const tests: EngineeringTestProfile[] = [];
  for (const facts of input.fileFacts) {
    const filePath = normalizePath(facts.normalizedPath || facts.path);
    const language = fileByPath.get(filePath)?.language ?? languageKey(facts.languageEvidence, facts.mediaType);
    for (const test of facts.tests.slice(0, 1024)) {
      tests.push({
        id: `eng_test_${input.hasher.digestHex(`${filePath}:${test.runnerHint ?? ""}:${test.name ?? test.id}`).slice(0, 40)}`,
        name: test.name,
        runnerHint: test.runnerHint,
        filePath,
        language,
        confidence: clamp01(0.54 + (test.name ? 0.12 : 0) + (test.runnerHint ? 0.12 : 0) + (facts.parser.ok ? 0.12 : 0)),
        evidenceIds: input.evidenceIds
      });
    }
  }
  return uniqueBy(tests, item => `${item.filePath}\u001f${item.runnerHint ?? ""}\u001f${item.name ?? item.id}`).slice(0, 2048);
}

function capabilityVector(input: {
  files: EngineeringFileProjection[];
  languages: EngineeringLanguageProfile[];
  commands: EngineeringCommandCandidate[];
  dependencies: EngineeringDependencyProfile[];
  symbols: EngineeringSymbolProfile[];
  routes: EngineeringRouteProfile[];
  tests: EngineeringTestProfile[];
  evidenceIds: EvidenceId[];
  hasher: Hasher;
}): EngineeringCapability[] {
  const caps: EngineeringCapability[] = [];
  const add = (kind: string, support: number, confidence: number, evidence: string[]) => {
    if (support <= 0) return;
    caps.push({
      id: `eng_cap_${input.hasher.digestHex(`${kind}:${evidence.join("|")}`).slice(0, 40)}`,
      kind,
      support: clamp01(support),
      confidence: clamp01(confidence),
      evidence: evidence.slice(0, 32),
      evidenceIds: input.evidenceIds
    });
  };
  add("eng.capability.module_authoring", scorePresence(input.symbols.length), mean(input.symbols.map(item => item.confidence)), input.symbols.slice(0, 24).map(item => item.name));
  add("eng.capability.dependency_binding", scorePresence(input.dependencies.length), mean(input.dependencies.map(item => item.support)), input.dependencies.slice(0, 24).map(item => item.name));
  add("eng.capability.command_execution", scorePresence(input.commands.length), mean(input.commands.map(item => item.confidence)), input.commands.slice(0, 24).map(item => item.scriptName));
  add("eng.capability.validation", scorePresence(input.tests.length) || scorePresence(input.commands.filter(item => item.kind === "eng.command.validation").length), mean([...input.tests.map(item => item.confidence), ...input.commands.filter(item => item.kind === "eng.command.validation").map(item => item.confidence)]), [...input.tests.slice(0, 16).map(item => item.name ?? item.id), ...input.commands.filter(item => item.kind === "eng.command.validation").slice(0, 16).map(item => item.scriptName)]);
  add("eng.capability.interface_surface", scorePresence(input.routes.length) || scorePresence(input.files.filter(file => strongestRoleConfidence(file.roles, "source.role.interface") > 0).length), mean([...input.routes.map(item => item.confidence), ...input.files.map(file => strongestRoleConfidence(file.roles, "source.role.interface"))]), [...input.routes.slice(0, 16).map(item => `${item.method} ${item.path}`), ...input.files.filter(file => strongestRoleConfidence(file.roles, "source.role.interface") > 0).slice(0, 16).map(item => item.path)]);
  add("eng.capability.presentation_surface", scorePresence(input.files.filter(file => strongestRoleConfidence(file.roles, "source.role.presentation") > 0).length), mean(input.files.map(file => strongestRoleConfidence(file.roles, "source.role.presentation"))), input.files.filter(file => strongestRoleConfidence(file.roles, "source.role.presentation") > 0).slice(0, 24).map(item => item.path));
  add("eng.capability.multi_language_project", input.languages.length > 1 ? clamp01(input.languages.length / 8) : 0, mean(input.languages.map(item => item.confidence)), input.languages.map(item => item.language));
  add("eng.capability.generated_boundary", scorePresence(input.files.filter(file => file.generatedScore >= 0.7).length), mean(input.files.map(item => item.generatedScore)), input.files.filter(file => file.generatedScore >= 0.7).slice(0, 24).map(item => item.path));
  return caps.sort((a, b) => b.support - a.support || b.confidence - a.confidence || a.kind.localeCompare(b.kind));
}

function plannerHintsFor(input: {
  repositoryFacts?: SourceRepositoryFacts;
  files: EngineeringFileProjection[];
  languages: EngineeringLanguageProfile[];
  commands: EngineeringCommandCandidate[];
  evidenceIds: EvidenceId[];
}): EngineeringCorpusProjection["plannerHints"] {
  const commandByKind = (kind: string) => input.commands.filter(command => command.kind === kind).sort((a, b) => b.confidence - a.confidence);
  const entrypoints = input.files
    .filter(file => file.entrypointScore > 0.2 && file.generatedScore < 0.85)
    .sort((a, b) => b.entrypointScore - a.entrypointScore || b.moduleScore - a.moduleScore || a.path.localeCompare(b.path))
    .slice(0, 32)
    .map(file => ({ path: file.path, language: file.language, score: file.entrypointScore, evidenceIds: file.evidenceIds.length ? file.evidenceIds : input.evidenceIds }));
  return {
    primaryLanguages: input.languages.slice(0, 12).map(language => language.language),
    packageManagers: input.repositoryFacts?.workspace.packageManagers.slice(0, 16) ?? [],
    buildCommands: commandByKind("eng.command.build").slice(0, 16),
    validationCommands: commandByKind("eng.command.validation").slice(0, 16),
    runtimeCommands: commandByKind("eng.command.runtime").slice(0, 16),
    lintCommands: commandByKind("eng.command.lint").slice(0, 16),
    entrypoints,
    packageManifests: input.repositoryFacts?.packages.map(pkg => pkg.manifestPath).slice(0, 64) ?? [],
    sourceRoots: sourceRoots(input.files.filter(file => file.generatedScore < 0.7).map(file => file.path)),
    generatedRoots: sourceRoots(input.files.filter(file => file.generatedScore >= 0.7).map(file => file.path))
  };
}

function engineeringGraph(input: {
  rootUri: string;
  files: EngineeringFileProjection[];
  languages: EngineeringLanguageProfile[];
  roles: EngineeringRoleProfile[];
  packages: EngineeringPackageSurface[];
  commands: EngineeringCommandCandidate[];
  dependencies: EngineeringDependencyProfile[];
  symbols: EngineeringSymbolProfile[];
  imports: EngineeringImportProfile[];
  routes: EngineeringRouteProfile[];
  tests: EngineeringTestProfile[];
  capabilities: EngineeringCapability[];
  hasher: Hasher;
}): EngineeringCorpusProjection["graph"] {
  const nodes = new Map<string, EngineeringGraphNode>();
  const edges: EngineeringGraphEdge[] = [];
  const addNode = (kind: string, label: string, metadata: unknown) => {
    const id = `eng_node_${input.hasher.digestHex(`${kind}:${label}:${canonicalStringify(metadata)}`).slice(0, 40)}`;
    nodes.set(id, { id, kind, label, metadata: toJsonValue(metadata) });
    return id;
  };
  const addEdge = (source: string, target: string, relation: string, weight: number, metadata: unknown = {}) => {
    edges.push({ source, target, relation, weight: clamp01(weight), metadata: toJsonValue(metadata) });
  };
  const repo = addNode("eng.repository", input.rootUri, { rootUri: input.rootUri });
  const fileNode = new Map<string, string>();
  for (const file of input.files.slice(0, 5000)) {
    const node = addNode("eng.file", file.path, file);
    fileNode.set(file.path, node);
    addEdge(repo, node, "eng.repository_contains_file", file.moduleScore, { language: file.language });
  }
  const languageNode = new Map<string, string>();
  for (const language of input.languages.slice(0, 256)) {
    const node = addNode("eng.language_profile", language.language, language);
    languageNode.set(language.language, node);
    addEdge(repo, node, "eng.repository_uses_language", language.weight, { fileCount: language.fileCount });
  }
  for (const role of input.roles.slice(0, 256)) {
    const node = addNode("eng.role_profile", role.roleId, role);
    addEdge(repo, node, "eng.repository_has_role", role.confidence, { fileCount: role.fileCount });
  }
  for (const pkg of input.packages.slice(0, 256)) {
    const node = addNode("eng.package_surface", pkg.name ?? pkg.manifestPath, pkg);
    addEdge(repo, node, "eng.repository_declares_package_surface", pkg.confidence, { manifestPath: pkg.manifestPath });
    const manifest = fileNode.get(pkg.manifestPath);
    if (manifest) addEdge(manifest, node, "eng.file_manifest_declares_package_surface", pkg.confidence);
  }
  for (const command of input.commands.slice(0, 512)) {
    const node = addNode("eng.command_candidate", `${command.scriptName}:${command.kind}`, command);
    const manifest = fileNode.get(command.manifestPath);
    addEdge(manifest ?? repo, node, "eng.manifest_exposes_command", command.confidence, { command: command.command });
  }
  for (const dep of input.dependencies.slice(0, 1024)) {
    const node = addNode("eng.dependency_profile", dep.name, dep);
    addEdge(repo, node, "eng.repository_observes_dependency", dep.support, { scope: dep.scope });
    for (const item of dep.importEvidence.slice(0, 16)) {
      const file = fileNode.get(item.path);
      if (file) addEdge(file, node, "eng.file_imports_dependency", clamp01(item.count / 8), { count: item.count });
    }
  }
  for (const symbol of input.symbols.slice(0, 2048)) {
    const node = addNode("eng.symbol", `${symbol.path}:${symbol.name}`, symbol);
    const file = fileNode.get(symbol.path);
    if (file) addEdge(file, node, "eng.file_declares_symbol", symbol.confidence, { exported: symbol.exported });
    const language = languageNode.get(symbol.language);
    if (language) addEdge(language, node, "eng.language_contains_symbol", symbol.confidence * 0.72);
  }
  for (const item of input.imports.slice(0, 2048)) {
    const node = addNode("eng.import", `${item.path}:${item.moduleSpecifier}`, item);
    const file = fileNode.get(item.path);
    if (file) addEdge(file, node, "eng.file_has_import", item.confidence, { typeOnly: item.typeOnly });
  }
  for (const route of input.routes.slice(0, 1024)) {
    const node = addNode("eng.route", `${route.method} ${route.path}`, route);
    const file = fileNode.get(route.filePath);
    if (file) addEdge(file, node, "eng.file_exposes_route", route.confidence, { protocol: route.protocol });
  }
  for (const test of input.tests.slice(0, 1024)) {
    const node = addNode("eng.test", test.name ?? test.id, test);
    const file = fileNode.get(test.filePath);
    if (file) addEdge(file, node, "eng.file_contains_test", test.confidence, { runnerHint: test.runnerHint });
  }
  for (const capability of input.capabilities) {
    const node = addNode("eng.capability", capability.kind, capability);
    addEdge(repo, node, "eng.repository_supports_capability", capability.support, { confidence: capability.confidence });
  }
  return { nodes: [...nodes.values()], edges: edges.slice(0, 12000) };
}

function languageCapabilities(input: { files: EngineeringFileProjection[]; dependencyCount: number; symbols: number; routes: number; tests: number }): string[] {
  const out = new Set<string>();
  if (input.symbols || input.files.some(file => file.declarations || file.exports)) out.add("eng.capability.module_authoring");
  if (input.dependencyCount || input.files.some(file => file.imports)) out.add("eng.capability.dependency_binding");
  if (input.routes || input.files.some(file => file.routes || strongestRoleConfidence(file.roles, "source.role.interface") > 0)) out.add("eng.capability.interface_surface");
  if (input.tests || input.files.some(file => file.tests || file.validationScore > 0.3)) out.add("eng.capability.validation");
  if (input.files.some(file => strongestRoleConfidence(file.roles, "source.role.presentation") > 0)) out.add("eng.capability.presentation_surface");
  return [...out].sort();
}

function dependencyCapabilities(name: string, scope: string, importSupport: number): string[] {
  const caps = new Set<string>(["eng.capability.dependency_binding"]);
  const lower = name.toLocaleLowerCase();
  if (scope.toLocaleLowerCase().includes("dev")) caps.add("eng.capability.development_dependency");
  if (importSupport > 0) caps.add("eng.capability.runtime_import");
  if (includesAny(lower, ["test", "vitest", "jest", "mocha", "ava", "tap"])) caps.add("eng.capability.validation");
  if (includesAny(lower, ["render", "component", "vite", "react", "vue", "svelte", "solid"])) caps.add("eng.capability.presentation_surface");
  if (includesAny(lower, ["http", "server", "express", "fastify", "hono", "koa"])) caps.add("eng.capability.interface_surface");
  return [...caps].sort();
}

function commandKind(roleIds: string[], name: string, command: string): string {
  const joined = [...roleIds, name, command].join(" ").toLocaleLowerCase();
  if (roleIds.includes("source.role.validation") || wordLike(joined, "test") || includesAny(joined, ["vitest", "jest", "mocha", "ava", "tap"])) return "eng.command.validation";
  if (roleIds.includes("source.role.build") || wordLike(joined, "build") || includesAny(joined, ["compile", "tsc"])) return "eng.command.build";
  if (roleIds.includes("source.role.lint") || wordLike(joined, "lint") || includesAny(joined, ["eslint", "biome"])) return "eng.command.lint";
  if (roleIds.includes("source.role.runtime") || wordLike(joined, "start") || wordLike(joined, "serve") || wordLike(joined, "dev")) return "eng.command.runtime";
  return "eng.command.other";
}

function commandRank(kind: string): number {
  if (kind === "eng.command.build") return 1;
  if (kind === "eng.command.validation") return 2;
  if (kind === "eng.command.runtime") return 3;
  if (kind === "eng.command.lint") return 4;
  return 9;
}

function managerEvidenceFor(repositoryFacts: SourceRepositoryFacts | undefined, manifestPath: string): string[] {
  const managers = repositoryFacts?.workspace.packageManagers ?? [];
  if (!managers.length) return [];
  const pathParts = pathPieces(manifestPath).map(part => part.toLocaleLowerCase());
  return managers.filter(manager => {
    const prefix = manager.split(":")[0]?.toLocaleLowerCase() ?? manager.toLocaleLowerCase();
    return pathParts.some(part => part.includes(prefix)) || manager.includes("lock") || manager.includes("workspace") || manager.includes("manifest");
  }).slice(0, 8);
}

function entrypointScoreFor(input: {
  path: string;
  roles: Array<{ roleId: string; confidence: number }>;
  declarations: number;
  exports: number;
  routes: number;
  tests: number;
  parserId?: string;
  generatedScore: number;
}): number {
  const file = basenameLike(input.path).toLocaleLowerCase();
  const pieces = pathPieces(input.path).map(part => part.toLocaleLowerCase());
  let score = 0.08;
  if (input.parserId) score += 0.12;
  if (input.exports) score += 0.16;
  if (input.declarations) score += 0.12;
  if (input.routes) score += 0.14;
  if (strongestRoleConfidence(input.roles, "source.role.interface") > 0) score += 0.12;
  if (strongestRoleConfidence(input.roles, "source.role.presentation") > 0) score += 0.12;
  if (fileStemMatches(file, ["main", "index", "app", "cli", "server", "program", "command"])) score += 0.28;
  if (pieces.some(part => part === "src" || part === "source" || part === "app")) score += 0.08;
  if (input.tests || strongestRoleConfidence(input.roles, "source.role.test") > 0) score -= 0.22;
  score -= input.generatedScore * 0.32;
  return clamp01(score);
}

function generatedScoreFor(path: string, roles: Array<{ roleId: string; confidence: number }>): number {
  const explicit = strongestRoleConfidence(roles, "source.role.generated");
  if (explicit > 0) return explicit;
  const pieces = pathPieces(path).map(part => part.toLocaleLowerCase());
  const generatedParts = ["dist", "build", "generated", ".cache", "coverage", "target", "out"];
  return pieces.some(part => generatedParts.includes(part)) ? 0.82 : 0;
}

function languageKey(languageEvidence: readonly { kind: string; value: string; confidence?: number }[], mediaType: string): string {
  const strongest = [...languageEvidence].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (strongest?.kind && strongest.value) return `${strongest.kind}:${strongest.value}`;
  if (mediaType) return `media-type:${mediaType}`;
  return "source.language.unresolved";
}

function roleCounts(files: readonly EngineeringFileProjection[]): Array<{ roleId: string; count: number; confidence: number }> {
  const groups = new Map<string, { count: number; confidence: number[] }>();
  for (const file of files) {
    for (const role of file.roles) {
      const current = groups.get(role.roleId) ?? { count: 0, confidence: [] };
      current.count++;
      current.confidence.push(role.confidence);
      groups.set(role.roleId, current);
    }
  }
  return [...groups.entries()]
    .map(([roleId, value]) => ({ roleId, count: value.count, confidence: mean(value.confidence) }))
    .sort((a, b) => b.count - a.count || b.confidence - a.confidence || a.roleId.localeCompare(b.roleId))
    .slice(0, 32);
}

function sourceRoots(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const pieces = pathPieces(path);
    const root = pieces.length > 1 ? pieces[0] ?? "." : ".";
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16).map(([root]) => root);
}

function sharedRootForFacts(fileFacts: readonly SourceCodeFileFacts[]): string | undefined {
  const paths = fileFacts.map(file => normalizePath(file.path || file.normalizedPath)).filter(Boolean);
  if (!paths.length) return undefined;
  const first = pathPieces(paths[0] ?? "");
  let length = first.length;
  for (const path of paths.slice(1)) {
    const pieces = pathPieces(path);
    let i = 0;
    while (i < length && i < pieces.length && first[i] === pieces[i]) i++;
    length = i;
  }
  return first.slice(0, Math.max(1, length)).join("/") || ".";
}

function dedupeFileFacts(facts: readonly SourceCodeFileFacts[]): SourceCodeFileFacts[] {
  const byPath = new Map<string, SourceCodeFileFacts>();
  for (const fact of facts) {
    const path = normalizePath(fact.normalizedPath || fact.path);
    const existing = byPath.get(path);
    if (!existing || fact.metrics.bytes >= existing.metrics.bytes) byPath.set(path, fact);
  }
  return [...byPath.values()].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path))).slice(0, 20000);
}

function mediaTypeFromPath(path: string): string {
  const ext = extensionOf(path);
  if (!ext) return "application/octet-stream";
  return `text/x-source-${safeMediaSuffix(ext.slice(1))}`;
}

function packageNameFromSpecifier(specifier: string): string {
  const normalized = specifier.trim();
  if (!normalized) return "";
  if (normalized.startsWith("@")) {
    const pieces = normalized.split("/");
    return pieces.length >= 2 ? `${pieces[0]}/${pieces[1]}` : normalized;
  }
  if (normalized.startsWith(".") || normalized.startsWith("/") || normalized.includes("\\")) return normalized;
  return normalized.split("/")[0] ?? normalized;
}

function canonicalPackageKey(name: string): string {
  return packageNameFromSpecifier(name).toLocaleLowerCase();
}

function scriptMentionsDependency(commands: readonly EngineeringCommandCandidate[], name: string): number {
  const lower = name.toLocaleLowerCase();
  return commands.some(command => command.command.toLocaleLowerCase().includes(lower) || command.scriptName.toLocaleLowerCase().includes(lower)) ? 1 : 0;
}

function strongestRoleConfidence(roles: readonly { roleId: string; confidence: number }[], roleId: string): number {
  return roles.filter(role => role.roleId === roleId).sort((a, b) => b.confidence - a.confidence)[0]?.confidence ?? 0;
}

function fileStemMatches(file: string, stems: readonly string[]): boolean {
  const dot = file.indexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return stems.includes(stem);
}

function pathPieces(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function basenameLike(path: string): string {
  const pieces = pathPieces(path);
  return pieces[pieces.length - 1] ?? path;
}

function sortedCounts(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function uniqueBy<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(keyFn(item))) seen.set(keyFn(item), item);
  return [...seen.values()];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function scorePresence(value: unknown): number {
  if (typeof value === "number") return value <= 0 ? 0 : value >= 8 ? 1 : Math.log2(value + 1) / 3;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  return value ? 1 : 0;
}

function safeMediaSuffix(value: string): string {
  const out: string[] = [];
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 48 && cp <= 57 || cp >= 97 && cp <= 122) out.push(char);
    else if ((char === "_" || char === "-" || char === ".") && out.length) out.push("_");
  }
  return out.join("") || "source";
}

function wordLike(text: string, word: string): boolean {
  let index = text.indexOf(word);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1] ?? "";
    const after = text[index + word.length] ?? "";
    if (!identifierLike(before) && !identifierLike(after)) return true;
    index = text.indexOf(word, index + 1);
  }
  return false;
}

function identifierLike(char: string): boolean {
  if (!char) return false;
  const cp = char.codePointAt(0) ?? 0;
  return cp === 95 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

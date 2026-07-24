import { toJsonValue } from "./primitives.js";
import { sourceCodeFileFactsFromJson, sourceRepositoryFactsFromJson } from "./source-code-graph.js";
import type { IngestionCheckpoint } from "./storage.js";
import type { JsonValue } from "./types.js";

export function routeStoreCounts(routes: Array<{ durableStores: string[] }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const route of routes) {
    for (const store of route.durableStores) out[store] = (out[store] ?? 0) + 1;
  }
  return out;
}

export function sumRecord(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

export function summarizeTypedCheckpoints(checkpoints: IngestionCheckpoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const checkpoint of checkpoints) {
    const typed = typedDiagnostics(checkpoint);
    const counts = typed?.observationCounts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) continue;
    for (const [kind, raw] of Object.entries(counts as Record<string, JsonValue>)) {
      const count = typeof raw === "number" ? raw : 0;
      out[kind] = (out[kind] ?? 0) + count;
    }
  }
  return out;
}

export function summarizeTypedRouteStores(checkpoints: IngestionCheckpoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const checkpoint of checkpoints) {
    const typed = typedDiagnostics(checkpoint);
    const routeCounts = typed?.routeCounts;
    if (!routeCounts || typeof routeCounts !== "object" || Array.isArray(routeCounts)) continue;
    for (const [store, raw] of Object.entries(routeCounts as Record<string, JsonValue>)) {
      const count = typeof raw === "number" ? raw : 0;
      out[store] = (out[store] ?? 0) + count;
    }
  }
  return out;
}

export function summarizeCodebaseCheckpoints(checkpoints: IngestionCheckpoint[]): JsonValue {
  const parsers = new Map<string, number>();
  const roles = new Map<string, number>();
  const dependencies = new Map<string, number>();
  const importedModules = new Map<string, number>();
  const declarationKinds = new Map<string, number>();
  const packageScripts = new Map<string, number>();
  const repositories = new Map<string, RepositorySummary>();
  const repositoryManifests: JsonValue[] = [];
  const routeInventory: Array<{
    repository: string;
    file: string;
    method: string;
    path: string;
    handlerHint?: string;
  }> = [];
  const testInventory: Array<{
    repository: string;
    file: string;
    name?: string;
    runnerHint?: string;
  }> = [];
  let files = 0;
  let parserFacts = 0;
  let declarations = 0;
  let imports = 0;
  let routes = 0;
  let tests = 0;
  let packages = 0;
  for (const checkpoint of checkpoints) {
    const metadata = checkpoint.metadata
      && typeof checkpoint.metadata === "object"
      && !Array.isArray(checkpoint.metadata)
      ? checkpoint.metadata as Record<string, JsonValue>
      : {};
    const codebase = metadata.codebase
      && typeof metadata.codebase === "object"
      && !Array.isArray(metadata.codebase)
      ? metadata.codebase as Record<string, JsonValue>
      : undefined;
    const facts = sourceCodeFileFactsFromJson(metadata.sourceCode);
    const repositoryFacts = sourceRepositoryFactsFromJson(metadata.repositoryFacts);
    if (repositoryFacts) {
      repositoryManifests.push(repositoryManifestSummary(repositoryFacts));
      const repo = repositorySummary(repositories, repositoryFacts.normalizedRootUri);
      repo.files = Math.max(repo.files, repositoryFacts.workspace.fileCount);
      repo.declarations = Math.max(repo.declarations, repositoryFacts.workspace.declarationCount);
      repo.imports = Math.max(repo.imports, repositoryFacts.workspace.importCount);
      repo.routes = Math.max(repo.routes, repositoryFacts.workspace.routeCount);
      repo.tests = Math.max(repo.tests, repositoryFacts.workspace.testFileCount);
      repo.packages = Math.max(repo.packages, repositoryFacts.workspace.packageCount);
      for (const pkg of repositoryFacts.packages) if (pkg.name) repo.packageNames.add(pkg.name);
      continue;
    }
    if (!codebase && !facts) continue;
    const repositoryId = typeof codebase?.rootUri === "string" && codebase.rootUri
      ? codebase.rootUri
      : "codebase:unresolved";
    const repo = repositorySummary(repositories, repositoryId);
    files++;
    repo.files++;
    if (facts) {
      parserFacts++;
      repo.parserFacts++;
      parsers.set(facts.parser.id, (parsers.get(facts.parser.id) ?? 0) + 1);
      declarations += facts.declarations.length;
      repo.declarations += facts.declarations.length;
      imports += facts.imports.length;
      repo.imports += facts.imports.length;
      routes += facts.routes.length;
      repo.routes += facts.routes.length;
      tests += facts.tests.length;
      repo.tests += facts.tests.length;
      for (const item of facts.imports) addCount(importedModules, item.moduleSpecifier);
      for (const item of facts.declarations) addCount(declarationKinds, item.kind);
      for (const item of facts.routes.slice(0, 256)) {
        routeInventory.push({
          repository: repositoryId,
          file: facts.normalizedPath,
          method: item.method,
          path: item.path,
          handlerHint: item.handlerHint
        });
      }
      for (const item of facts.tests.slice(0, 256)) {
        testInventory.push({
          repository: repositoryId,
          file: facts.normalizedPath,
          name: item.name,
          runnerHint: item.runnerHint
        });
      }
      if (facts.packageFacts) {
        packages++;
        repo.packages++;
        if (facts.packageFacts.name) repo.packageNames.add(facts.packageFacts.name);
        for (const script of facts.packageFacts.scripts) addCount(packageScripts, script.name);
        for (const dep of facts.packageFacts.dependencies) addCount(dependencies, dep.name);
      }
      for (const role of facts.roleEvidence) {
        addCount(roles, role.roleId);
        addCount(repo.roles, role.roleId);
      }
    } else if (typeof codebase?.parserFactsPresent === "boolean" && codebase.parserFactsPresent) {
      parserFacts++;
      repo.parserFacts++;
    }
  }
  return toJsonValue({
    files,
    parserFacts,
    parserCoverage: files ? parserFacts / files : 0,
    declarations,
    imports,
    routes,
    tests,
    packages,
    parsers: sortedRecord(parsers),
    roles: sortedRecord(roles),
    topImportedModules: topCounts(importedModules, 32),
    topDependencies: topCounts(dependencies, 32),
    declarationKinds: sortedRecord(declarationKinds),
    packageScripts: topCounts(packageScripts, 32),
    repositoryManifests,
    routeInventory: routeInventory.slice(0, 256),
    testInventory: testInventory.slice(0, 256),
    repositories: [...repositories.entries()].map(([id, repo]) => ({
      id,
      files: repo.files,
      parserFacts: repo.parserFacts,
      parserCoverage: repo.files ? repo.parserFacts / repo.files : 0,
      declarations: repo.declarations,
      imports: repo.imports,
      routes: repo.routes,
      tests: repo.tests,
      packages: repo.packages,
      packageNames: [...repo.packageNames].sort(),
      roles: sortedRecord(repo.roles)
    })).sort((a, b) => b.files - a.files || a.id.localeCompare(b.id))
  });
}

type RepositorySummary = {
  files: number;
  parserFacts: number;
  declarations: number;
  imports: number;
  routes: number;
  tests: number;
  packages: number;
  packageNames: Set<string>;
  roles: Map<string, number>;
};

function repositoryManifestSummary(
  facts: ReturnType<typeof sourceRepositoryFactsFromJson>
): JsonValue {
  if (!facts) return null;
  return toJsonValue({
    rootUri: facts.normalizedRootUri,
    workspace: facts.workspace,
    packageManagers: facts.workspace.packageManagers,
    packages: facts.packages.map(pkg => ({
      manifestPath: pkg.manifestPath,
      name: pkg.name,
      version: pkg.version,
      scripts: pkg.scripts.map(script => script.name),
      dependencies: pkg.dependencies.length
    })),
    distributions: facts.distributions,
    graphNodes: facts.graph.nodes.length,
    graphEdges: facts.graph.edges.length
  });
}

function repositorySummary(
  repositories: Map<string, RepositorySummary>,
  id: string
): RepositorySummary {
  let summary = repositories.get(id);
  if (!summary) {
    summary = {
      files: 0,
      parserFacts: 0,
      declarations: 0,
      imports: 0,
      routes: 0,
      tests: 0,
      packages: 0,
      packageNames: new Set<string>(),
      roles: new Map<string, number>()
    };
    repositories.set(id, summary);
  }
  return summary;
}

function addCount(map: Map<string, number>, key: string): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

function topCounts(
  map: Map<string, number>,
  limit: number
): Array<{ value: string; count: number }> {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function typedDiagnostics(
  checkpoint: IngestionCheckpoint
): Record<string, JsonValue> | undefined {
  const metadata = checkpoint.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const typed = (metadata as Record<string, JsonValue>).typedIngest;
  return typed && typeof typed === "object" && !Array.isArray(typed)
    ? typed as Record<string, JsonValue>
    : undefined;
}

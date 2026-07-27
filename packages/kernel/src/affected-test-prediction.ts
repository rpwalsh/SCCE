/**
 * Plan items 189-190. Affected-test prediction for a generated patch:
 * real static import-graph reachability, not a heuristic guess. Every
 * file this repository's TypeScript packages actually import is a
 * relative ESM specifier ending in `.js` that resolves to a sibling
 * `.ts` source file (e.g. `import { X } from "./primitives.js"` resolves
 * to `./primitives.ts`) -- this module parses exactly that real
 * convention via a lightweight regex extraction (deliberately not a full
 * TypeScript-compiler-based resolver, which would be a much larger,
 * separate undertaking) and inverts the resulting graph to answer "which
 * test files transitively import this changed file".
 */

export interface AffectedTestPredictionInput {
  /** Repo-relative paths of every source and test file to consider building the import graph over. */
  allFilePaths: readonly string[];
  /** Returns a file's real source text, or undefined if it cannot be read. */
  readFile(path: string): string | undefined;
  /** Repo-relative paths of the files a patch actually changed. */
  changedFilePaths: readonly string[];
}

const IMPORT_SPECIFIER_PATTERN = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

function extractRelativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]!;
    if (specifier.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function resolveSpecifier(fromFilePath: string, specifier: string, knownFiles: ReadonlySet<string>): string | undefined {
  const fromDirectory = fromFilePath.split("/").slice(0, -1).join("/");
  const joined = normalizePath(`${fromDirectory}/${specifier}`);
  const candidates = [
    joined.replace(/\.js$/, ".ts"),
    joined.replace(/\.js$/, ".tsx"),
    `${joined}.ts`,
    joined
  ];
  return candidates.find(candidate => knownFiles.has(candidate));
}

/**
 * The real import graph: file path -> the set of (resolvable) files it
 * directly imports. Unresolvable specifiers (external packages, files
 * outside `allFilePaths`) are silently skipped rather than treated as an
 * error -- this module only needs to reason about reachability within the
 * given file set.
 */
export function buildImportGraph(input: Pick<AffectedTestPredictionInput, "allFilePaths" | "readFile">): Map<string, Set<string>> {
  const knownFiles = new Set(input.allFilePaths);
  const graph = new Map<string, Set<string>>();
  for (const filePath of input.allFilePaths) {
    const source = input.readFile(filePath);
    if (source === undefined) { graph.set(filePath, new Set()); continue; }
    const imports = new Set<string>();
    for (const specifier of extractRelativeImportSpecifiers(source)) {
      const resolved = resolveSpecifier(filePath, specifier, knownFiles);
      if (resolved && resolved !== filePath) imports.add(resolved);
    }
    graph.set(filePath, imports);
  }
  return graph;
}

/**
 * Every file in `allFilePaths` that transitively imports at least one of
 * `changedFilePaths` -- computed via real graph reachability (a bounded
 * BFS over the *inverted* import graph), not a name/path heuristic.
 * Predicting a test file itself as directly changed also counts it as
 * affected (a changed test is trivially "affected" by itself).
 */
export function predictAffectedFiles(input: AffectedTestPredictionInput): Set<string> {
  const graph = buildImportGraph(input);
  const importers = new Map<string, Set<string>>();
  for (const [file, imports] of graph) {
    for (const imported of imports) {
      const bucket = importers.get(imported) ?? new Set<string>();
      bucket.add(file);
      importers.set(imported, bucket);
    }
  }
  const affected = new Set<string>(input.changedFilePaths);
  const queue = [...input.changedFilePaths];
  while (queue.length) {
    const current = queue.shift()!;
    for (const importer of importers.get(current) ?? []) {
      if (affected.has(importer)) continue;
      affected.add(importer);
      queue.push(importer);
    }
  }
  return affected;
}

/** The subset of `predictAffectedFiles`'s result that are actual test files, per `isTestFile`. */
export function predictAffectedTests(
  input: AffectedTestPredictionInput,
  isTestFile: (path: string) => boolean = path => path.includes("__tests__/") || path.endsWith(".test.ts")
): string[] {
  return [...predictAffectedFiles(input)].filter(isTestFile).sort();
}

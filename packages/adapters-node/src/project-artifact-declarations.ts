// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  normalizePath,
  roleEvidenceFromPath,
  UNDECLARED_SOURCE_ARTIFACT_ROLE,
  type SourceArtifactRole,
  type SourceArtifactRoleObservation,
  type SourceArtifactRoleResolution
} from "@scce/kernel";
import { pathGlobMatches, pathGlobSpecificity, pathGlobSupported } from "./path-glob.js";

/**
 * What role a project declares for its own files, read from the project's own machine-readable manifests.
 *
 * A repository states which files are tests: the test runner's `include` globs, a jest `testMatch`, a mocha
 * `spec`, an ava `files`, a `.gitattributes` `linguist-generated` or `linguist-vendored` attribute. Reading those
 * is reading declared provenance. Deciding it from a path that contains the word "test" is a string heuristic,
 * and it is the heuristic that let 840 test files stand as documentary evidence about the world.
 *
 * Nothing here executes a config module. A JS/TS config is parsed with the TypeScript parser and only its
 * array-of-string-literal values are read; a computed value, an unsupported glob dialect or a format with no
 * parser available is recorded as unreadable, which is a different fact from a project declaring nothing.
 */
export interface ProjectRoleDeclaration {
  readonly role: SourceArtifactRole;
  /** Glob relative to the manifest's own directory. */
  readonly pattern: string;
  /** Repository-relative directory the pattern resolves against. */
  readonly base: string;
  /** Repository-relative manifest that declared it. */
  readonly manifest: string;
  /** The manifest key it was declared under. */
  readonly key: string;
}

export interface UnreadableProjectDeclaration {
  readonly manifest: string;
  readonly key: string;
  readonly reason: string;
}

export interface ProjectArtifactDeclarations {
  /** Absolute directory the manifests were read from. */
  readonly projectRoot: string;
  readonly declarations: readonly ProjectRoleDeclaration[];
  readonly unreadable: readonly UnreadableProjectDeclaration[];
  /** Manifest files that were found and parsed. Empty means this directory declares nothing at all. */
  readonly manifests: readonly string[];
}

/** Manifest file names whose format this reader implements, in the order a project's own tools read them. */
const MANIFEST_FILES = [
  "package.json",
  "jest.config.json",
  ".mocharc.json",
  ".gitattributes",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.cts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs"
] as const;

/** Manifest formats that exist but need a parser this package does not depend on. Carried, never guessed at. */
const UNPARSEABLE_MANIFEST_FILES = [".mocharc.yml", ".mocharc.yaml", ".taprc", "pnpm-workspace.yaml"] as const;

/** Whether a directory declares anything at all, so a walk can find the nearest declaring ancestor. Pure. */
export function manifestFileNames(): readonly string[] {
  return [...MANIFEST_FILES, ...UNPARSEABLE_MANIFEST_FILES];
}

export async function readProjectArtifactDeclarations(projectRoot: string): Promise<ProjectArtifactDeclarations> {
  const declarations: ProjectRoleDeclaration[] = [];
  const unreadable: UnreadableProjectDeclaration[] = [];
  const manifests: string[] = [];
  // One directory listing rather than a probe per candidate name: an OSS snapshot has thousands of directories.
  const present = new Set<string>();
  try {
    for (const entry of await readdir(projectRoot, { withFileTypes: true })) if (entry.isFile()) present.add(entry.name);
  } catch {
    return { projectRoot, declarations, unreadable, manifests };
  }
  for (const manifest of MANIFEST_FILES) {
    if (!present.has(manifest)) continue;
    const text = await readIfPresent(path.join(projectRoot, manifest));
    if (text === undefined) continue;
    manifests.push(manifest);
    const read = readManifest(manifest, text);
    declarations.push(...read.declarations);
    unreadable.push(...read.unreadable);
  }
  for (const manifest of UNPARSEABLE_MANIFEST_FILES) {
    if (!present.has(manifest)) continue;
    manifests.push(manifest);
    unreadable.push({ manifest, key: "", reason: "no-parser-for-manifest-format" });
  }
  return { projectRoot, declarations, unreadable, manifests };
}

/**
 * The declared role of a file, from the nearest ancestor directory that declares anything.
 *
 * A monorepo package's own test config governs its own files, and a repository's root config governs the rest;
 * nearest-first is the order the project's own tools resolve in. Declarations are read once per directory, and
 * the walk stops at `stopAt` so ingest never reads outside the tree it was pointed at.
 */
export function createProjectDeclarationIndex(options: { stopAt: string }) {
  const stopAt = path.resolve(options.stopAt);
  const byDirectory = new Map<string, ProjectArtifactDeclarations>();
  return {
    async roleFor(absoluteFilePath: string): Promise<SourceArtifactRoleResolution> {
      const absolute = path.resolve(absoluteFilePath);
      const observations: SourceArtifactRoleObservation[] = [];
      let directory = path.dirname(absolute);
      for (;;) {
        let declarations = byDirectory.get(directory);
        if (!declarations) {
          declarations = await readProjectArtifactDeclarations(directory);
          byDirectory.set(directory, declarations);
        }
        if (declarations.declarations.length) {
          const resolved = declaredRoleForProjectPath(declarations, normalizePath(path.relative(directory, absolute)));
          if (resolved.declaredBy === "project_manifest") {
            return { ...resolved, observations: [...resolved.observations, ...observations] };
          }
          observations.push(...resolved.observations);
        }
        if (directory === stopAt) break;
        const parent = path.dirname(directory);
        if (parent === directory || !isWithin(directory, stopAt)) break;
        directory = parent;
      }
      const path_ = normalizePath(path.relative(stopAt, absolute));
      return { ...UNDECLARED_SOURCE_ARTIFACT_ROLE, observations: [...observations, ...pathRoleObservations(path_ || normalizePath(absolute))] };
    }
  };
}

function isWithin(candidate: string, root: string): boolean {
  const left = path.resolve(candidate).toLowerCase();
  const right = path.resolve(root).toLowerCase();
  return left === right || left.startsWith(`${right}${path.sep}`);
}

/**
 * The role a project declares for one of its files.
 *
 * The most specific declaration wins, ordered by literal path segments and then by manifest and pattern so the
 * answer is deterministic. Everything else that matched, and every path convention observed, is carried as an
 * observation: a path convention is evidence and never the declaration. Pure.
 */
export function artifactRoleForProjectPath(
  declarations: ProjectArtifactDeclarations,
  projectRelativePath: string
): SourceArtifactRoleResolution {
  const declared = declaredRoleForProjectPath(declarations, projectRelativePath);
  return { ...declared, observations: [...declared.observations, ...pathRoleObservations(normalizePath(projectRelativePath))] };
}

/** The manifest half alone, so a multi-level walk records each level's path conventions exactly once. Pure. */
function declaredRoleForProjectPath(
  declarations: ProjectArtifactDeclarations,
  projectRelativePath: string
): SourceArtifactRoleResolution {
  const relative = normalizePath(projectRelativePath);
  const observations: SourceArtifactRoleObservation[] = [];
  const matched = declarations.declarations
    .filter(declaration => pathGlobMatches(relative, joinPattern(declaration.base, declaration.pattern)))
    .sort(byDeclarationPrecedence);
  const winner = matched[0];
  if (!winner) return { ...UNDECLARED_SOURCE_ARTIFACT_ROLE, observations };
  for (const other of matched.slice(1)) {
    observations.unshift({ role: other.role, source: "project_manifest", evidence: [`${other.manifest}#${other.key}=${other.pattern}`] });
  }
  return {
    role: winner.role,
    declaredBy: "project_manifest",
    declaration: [`${winner.manifest}#${winner.key}=${winner.pattern}`],
    observations
  };
}

function byDeclarationPrecedence(left: ProjectRoleDeclaration, right: ProjectRoleDeclaration): number {
  const bySpecificity = pathGlobSpecificity(joinPattern(right.base, right.pattern)) - pathGlobSpecificity(joinPattern(left.base, left.pattern));
  if (bySpecificity !== 0) return bySpecificity;
  return `${left.manifest}#${left.key}=${left.pattern}`.localeCompare(`${right.manifest}#${right.key}=${right.pattern}`);
}

function joinPattern(base: string, pattern: string): string {
  const normalizedBase = normalizePath(base);
  if (!normalizedBase || normalizedBase === ".") return pattern;
  return pattern.startsWith("/") ? `${normalizedBase}${pattern}` : `${normalizedBase}/${pattern}`;
}

/**
 * The path conventions a repository happens to follow, kept as observations.
 *
 * `roleEvidenceFromPath` already computes these for the developer-intelligence lane; reading them here keeps one
 * producer rather than a second opinion, and their `source: "path"` is exactly why they cannot decide the role.
 */
function pathRoleObservations(relativePath: string): SourceArtifactRoleObservation[] {
  const out: SourceArtifactRoleObservation[] = [];
  for (const evidence of roleEvidenceFromPath(relativePath)) {
    const role = ARTIFACT_ROLE_BY_SOURCE_ROLE_ID[evidence.roleId];
    if (!role) continue;
    out.push({ role, source: "path", evidence: evidence.evidence });
  }
  return out;
}

/** The existing developer-intelligence role vocabulary, mapped onto this axis. Observations only. */
const ARTIFACT_ROLE_BY_SOURCE_ROLE_ID: Record<string, SourceArtifactRole | undefined> = {
  "source.role.test": "test_source",
  "source.role.documentation": "documentation",
  "source.role.configuration": "configuration",
  "source.role.generated": "generated"
};

interface ManifestReading {
  declarations: ProjectRoleDeclaration[];
  unreadable: UnreadableProjectDeclaration[];
}

function readManifest(manifest: string, text: string): ManifestReading {
  if (manifest === ".gitattributes") return readGitAttributes(manifest, text);
  if (manifest.endsWith(".json")) return readJsonManifest(manifest, text);
  return readConfigModule(manifest, text);
}

function readJsonManifest(manifest: string, text: string): ManifestReading {
  const parsed = parseJsonLike(text);
  if (!parsed) return { declarations: [], unreadable: [{ manifest, key: "", reason: "manifest-is-not-parseable-json" }] };
  if (manifest === "package.json") {
    const reading = emptyReading();
    collect(reading, manifest, "jest.testMatch", "test_source", pick(parsed, ["jest", "testMatch"]));
    collect(reading, manifest, "mocha.spec", "test_source", pick(parsed, ["mocha", "spec"]));
    collect(reading, manifest, "ava.files", "test_source", pick(parsed, ["ava", "files"]));
    // A regex is not a glob, and a project that states its tests only as one has stated them unreadably here.
    if (pick(parsed, ["jest", "testRegex"]) !== undefined) reading.unreadable.push({ manifest, key: "jest.testRegex", reason: "declaration-is-a-regular-expression-not-a-glob" });
    return reading;
  }
  if (manifest === "jest.config.json") {
    const reading = emptyReading();
    collect(reading, manifest, "testMatch", "test_source", pick(parsed, ["testMatch"]));
    if (pick(parsed, ["testRegex"]) !== undefined) reading.unreadable.push({ manifest, key: "testRegex", reason: "declaration-is-a-regular-expression-not-a-glob" });
    return reading;
  }
  const reading = emptyReading();
  collect(reading, manifest, "spec", "test_source", pick(parsed, ["spec"]));
  return reading;
}

/**
 * A config module's declaration, read from its parse tree.
 *
 * The TypeScript parser is already a dependency of this package and answers the only question asked here: which
 * string literals a named key's array holds. Nothing is executed, so a repository's config cannot run during
 * ingest, and a computed include list is reported as unreadable rather than approximated.
 */
function readConfigModule(manifest: string, text: string): ManifestReading {
  const reading = emptyReading();
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(manifest, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return { declarations: [], unreadable: [{ manifest, key: "", reason: "config-module-did-not-parse" }] };
  }
  const isJest = manifest.startsWith("jest.");
  const keyPaths: Array<{ key: readonly string[]; role: SourceArtifactRole }> = isJest
    ? [{ key: ["testMatch"], role: "test_source" }]
    : [{ key: ["test", "include"], role: "test_source" }, { key: ["test", "dir"], role: "test_source" }];
  for (const entry of keyPaths) {
    const found = findKeyValue(sourceFile, entry.key);
    if (!found) continue;
    if (!ts.isArrayLiteralExpression(found) && !ts.isStringLiteralLike(found)) {
      reading.unreadable.push({ manifest, key: entry.key.join("."), reason: "declaration-is-computed-not-a-literal" });
      continue;
    }
    const literals = ts.isStringLiteralLike(found)
      ? [found.text]
      : found.elements.map(element => (ts.isStringLiteralLike(element) ? element.text : undefined));
    if (literals.some(literal => literal === undefined)) {
      reading.unreadable.push({ manifest, key: entry.key.join("."), reason: "declaration-holds-a-computed-element" });
    }
    collect(reading, manifest, entry.key.join("."), entry.role, literals.filter((literal): literal is string => literal !== undefined));
  }
  if (!reading.declarations.length && !reading.unreadable.length) {
    // A vitest config with no `include` runs the tool's own default globs, which this repository did not declare.
    reading.unreadable.push({ manifest, key: isJest ? "testMatch" : "test.include", reason: "manifest-relies-on-the-tool-default-and-declares-no-glob" });
  }
  return reading;
}

/**
 * `.gitattributes` is a declaration about the files themselves.
 *
 * `linguist-generated` and `linguist-vendored` are how a repository states that a path is a build product or
 * third-party code it does not own, which is the same distinction as "does React define X" against "does
 * React's repository contain X".
 */
function readGitAttributes(manifest: string, text: string): ManifestReading {
  const reading = emptyReading();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/u);
    const pattern = parts[0];
    if (!pattern) continue;
    for (const attribute of parts.slice(1)) {
      const role = GIT_ATTRIBUTE_ROLES[attribute];
      if (!role) continue;
      collect(reading, manifest, attribute, role, [pattern]);
    }
  }
  return reading;
}

const GIT_ATTRIBUTE_ROLES: Record<string, SourceArtifactRole | undefined> = {
  "linguist-generated": "generated",
  "linguist-generated=true": "generated",
  "linguist-vendored": "vendor",
  "linguist-vendored=true": "vendor",
  "linguist-documentation": "documentation",
  "linguist-documentation=true": "documentation"
};

function collect(reading: ManifestReading, manifest: string, key: string, role: SourceArtifactRole, value: unknown): void {
  const patterns = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" ? [value] : [];
  if (Array.isArray(value) && !patterns.length && value.length) {
    reading.unreadable.push({ manifest, key, reason: "declaration-holds-no-string-patterns" });
    return;
  }
  for (const raw of patterns) {
    // `<rootDir>` is jest's own token for the project root, and these patterns are already project-relative.
    const pattern = raw.replace(/^<rootDir>\/?/u, "");
    if (!pathGlobSupported(pattern)) {
      reading.unreadable.push({ manifest, key, reason: `glob-dialect-not-implemented:${pattern}` });
      continue;
    }
    reading.declarations.push({ role, pattern, base: path.posix.dirname(normalizePath(manifest)), manifest, key });
  }
}

function emptyReading(): ManifestReading {
  return { declarations: [], unreadable: [] };
}

function pick(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The value of a dotted key path in the first object literal that holds it. Parse-tree only. */
function findKeyValue(sourceFile: ts.SourceFile, keyPath: readonly string[]): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(node)) {
      const hit = findKeyValueIn(node, keyPath);
      if (hit) {
        found = hit;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findKeyValueIn(node: ts.ObjectLiteralExpression, keyPath: readonly string[]): ts.Expression | undefined {
  const head = keyPath[0];
  if (!head) return undefined;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property) !== head) continue;
    if (keyPath.length === 1) return property.initializer;
    if (ts.isObjectLiteralExpression(property.initializer)) return findKeyValueIn(property.initializer, keyPath.slice(1));
  }
  return undefined;
}

function propertyName(node: ts.PropertyAssignment): string | undefined {
  if (ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isStringLiteralLike(node.name)) return node.name.text;
  return undefined;
}

/** JSON with comments and trailing commas, which is what a tsconfig or a jsonc manifest actually is. */
function parseJsonLike(text: string): unknown {
  const parsed = ts.parseConfigFileTextToJson("manifest.json", text);
  if (parsed.error) return undefined;
  return parsed.config;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

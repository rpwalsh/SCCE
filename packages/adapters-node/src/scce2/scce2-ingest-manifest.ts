import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toJsonValue, type BrainShardManifest, type BrainShardProvenanceClass, type JsonValue } from "@scce/kernel";
import { inspectScce2BrainBundle, isScce2BrainBundlePath, makeBrainEntryPath } from "./brain-bundle.js";

export interface Scce2GraphManifestShard {
  shardId: string;
  snapshotPath: string;
  statsPath?: string;
  pages?: number;
  triples?: number;
}

export interface Scce2GraphManifest {
  sourceId?: string;
  createdAt?: string;
  pagesTrained?: number;
  triplesTotal?: number;
  errors?: number;
  shards?: Scce2GraphManifestShard[];
}

export interface Scce2GraphShardStats {
  sourceId?: string;
  shardId?: string;
  snapshotPath?: string;
  pages?: number;
  triples?: number;
  concepts?: number;
  relations?: number;
  exportedAt?: string;
  rssMiB?: number;
  heapMiB?: number;
  [key: string]: unknown;
}

export interface Scce2TopEntry {
  value: string;
  count: number;
}

export interface Scce2ProfileFileEvidence {
  id?: string;
  title?: string;
  excerpt?: string;
  uri?: string;
  canonicalUri?: string;
  sourceUri?: string;
  originalSourceUri?: string;
  url?: string;
  sourceVersionId?: string;
  originalSourceVersionId?: string;
  revisionId?: string;
  contentHash?: string;
  byteRange?: [number, number] | number[];
  charRange?: [number, number] | number[];
  originalByteRange?: [number, number] | number[];
  originalCharRange?: [number, number] | number[];
  byteStart?: number;
  byteEnd?: number;
  charStart?: number;
  charEnd?: number;
  [key: string]: unknown;
}

export interface Scce2LanguageManifestShard {
  shardId: string;
  profilePath: string;
  pages?: number;
  chars?: number;
}

export interface Scce2LanguageManifest {
  schema?: string;
  sourceId?: string;
  languageId?: string;
  createdAt?: string;
  pagesTrained?: number;
  charsTrained?: number;
  errors?: number;
  shardCount?: number;
  shards?: Scce2LanguageManifestShard[];
  bounded?: boolean;
}

export interface Scce2LanguageProfileShard {
  schema?: string;
  sourceId?: string;
  shardId?: string;
  languageId?: string;
  script?: string;
  sourceEvidence?: Array<Record<string, unknown>>;
  fileEvidence?: Scce2ProfileFileEvidence[];
  tokenizationProfile?: {
    observedTokens?: Scce2TopEntry[];
    observedSymbols?: Scce2TopEntry[];
    observedTitleTokens?: Scce2TopEntry[];
    codepointBuckets?: Scce2TopEntry[];
    sampleWindow?: string;
  };
  syntaxProfile?: {
    punctuation?: Scce2TopEntry[];
    linePatterns?: Scce2TopEntry[];
  };
  commentPatterns?: Scce2TopEntry[];
  stringLiteralPatterns?: Scce2TopEntry[];
  identifierPatterns?: Scce2TopEntry[];
  importPatterns?: Scce2TopEntry[];
  declarationPatterns?: Scce2TopEntry[];
  buildSystemHints?: Scce2TopEntry[];
  testRunnerHints?: Scce2TopEntry[];
  packageManagerHints?: Scce2TopEntry[];
  formatterHints?: Scce2TopEntry[];
  linterHints?: Scce2TopEntry[];
  documentationPatterns?: Scce2TopEntry[];
  examplePatterns?: Array<Record<string, unknown>>;
  confidence?: number;
  createdAt?: string;
  rssMiB?: number;
  heapMiB?: number;
  [key: string]: unknown;
}

export interface Scce2ManifestBundle {
  rootPath: string;
  graphManifestPath?: string;
  graphManifest?: Scce2GraphManifest;
  graphFilePaths: Array<{ path: string; byteLength: number; sha256?: string }>;
  languageManifestPath?: string;
  languageManifest?: Scce2LanguageManifest;
  graphShardRoots: string[];
  languageShardRoots: string[];
  ngramModelPaths: Array<{ path: string; byteLength: number; sha256?: string; forceClass: BrainShardProvenanceClass }>;
  priorSectionPaths: Array<{
    sectionId: string;
    path: string;
    sectionKind: BrainShardManifest["priorSections"][number]["sectionKind"];
    forceClass: BrainShardProvenanceClass;
    byteLength: number;
    readable: boolean;
    sha256?: string;
    metadata: JsonValue;
  }>;
  brainBundlePaths: string[];
  warnings: string[];
}

export interface Scce2DiscoveryOptions {
  maxDepth?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_DEPTH = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_FILES = Number.MAX_SAFE_INTEGER;
const MAX_SCCE2_MANIFEST_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SCCE2_PROFILE_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SCCE2_STATS_JSON_BYTES = 2 * 1024 * 1024;

interface Scce2DiscoveryState {
  graphRoots: Set<string>;
  languageRoots: Set<string>;
  graphFiles: Map<string, { path: string; byteLength: number; sha256?: string }>;
  ngramPaths: Map<string, { path: string; byteLength: number; sha256?: string; forceClass: BrainShardProvenanceClass }>;
  priorSections: Map<string, Scce2ManifestBundle["priorSectionPaths"][number]>;
  brainBundlePaths: Set<string>;
  warnings: string[];
  maxDepth: number;
  maxFiles: number;
}

export async function discoverScce2ManifestBundle(rootPath: string, options: Scce2DiscoveryOptions = {}): Promise<Scce2ManifestBundle> {
  const root = path.resolve(rootPath);
  const warnings: string[] = [];
  const graphRoots = new Set<string>();
  const languageRoots = new Set<string>();
  const graphFiles = new Map<string, { path: string; byteLength: number; sha256?: string }>();
  const ngramPaths = new Map<string, { path: string; byteLength: number; sha256?: string; forceClass: BrainShardProvenanceClass }>();
  const priorSections = new Map<string, Scce2ManifestBundle["priorSectionPaths"][number]>();
  const brainBundlePaths = new Set<string>();
  const rootStat = await safeStat(root);
  if (!rootStat) {
    return emptyBundle(root, [`missing path: ${root}`]);
  }
  const state = {
    graphRoots,
    languageRoots,
    graphFiles,
    ngramPaths,
    priorSections,
    brainBundlePaths,
    warnings,
    maxDepth: Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxFiles: Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  };
  if (rootStat.isFile()) await classifyPath(root, rootStat.size, state);
  else if (!await discoverKnownRepositoryBrainRoots(root, state)) await discoverFromDirectory(root, state);
  await expandBrainBundles(state);

  const graphManifestPath = await chooseManifest([...graphRoots], "graph");
  const languageManifestPath = await chooseManifest([...languageRoots], "language");
  const graphManifest = graphManifestPath ? await readJsonFile<Scce2GraphManifest>(graphManifestPath, MAX_SCCE2_MANIFEST_JSON_BYTES).catch(error => {
    warnings.push(`cannot read graph manifest ${graphManifestPath}: ${messageOf(error)}`);
    return undefined;
  }) : undefined;
  const languageManifest = languageManifestPath ? await readJsonFile<Scce2LanguageManifest>(languageManifestPath, MAX_SCCE2_MANIFEST_JSON_BYTES).catch(error => {
    warnings.push(`cannot read language manifest ${languageManifestPath}: ${messageOf(error)}`);
    return undefined;
  }) : undefined;

  return {
    rootPath: root,
    graphManifestPath,
    graphManifest,
    graphFilePaths: [...graphFiles.values()].sort((a, b) => a.path.localeCompare(b.path)),
    languageManifestPath,
    languageManifest,
    graphShardRoots: [...graphRoots].sort(),
    languageShardRoots: [...languageRoots].sort(),
    ngramModelPaths: [...ngramPaths.values()].sort((a, b) => a.path.localeCompare(b.path)),
    priorSectionPaths: [...priorSections.values()].sort((a, b) => a.sectionId.localeCompare(b.sectionId)),
    brainBundlePaths: [...brainBundlePaths].sort(),
    warnings
  };
}

export async function materializeScce2Manifest(bundle: Scce2ManifestBundle, observedAt: number): Promise<BrainShardManifest> {
  const warnings = [...bundle.warnings];
  const graphShards = await materializeGraphShards(bundle, warnings);
  const languageShards = await materializeLanguageShards(bundle, warnings);
  const ngramStates = bundle.ngramModelPaths.map(item => ({
    stateId: ngramStateIdFromPath(item.path),
    path: item.path,
    format: inferNgramFormat(item.path),
    forceClass: item.forceClass,
    byteLength: item.byteLength,
    readable: true,
    metadata: toJsonValue({ sourceSystem: "scce2", kind: "ngram-model", sha256: item.sha256 ?? null, provenanceClass: item.forceClass })
  }));
  const sourceId = bundle.graphManifest?.sourceId ?? bundle.languageManifest?.sourceId;
  return {
    schema: "scce.brainShardManifest.v3",
    sourceSystem: "scce2",
    sourceId,
    rootPath: bundle.rootPath,
    observedAt,
    graph: graphShards.length || bundle.graphManifest
      ? {
          manifestPath: bundle.graphManifestPath,
          createdAt: bundle.graphManifest?.createdAt,
          pagesTrained: bundle.graphManifest?.pagesTrained,
          triplesTotal: bundle.graphManifest?.triplesTotal,
          errors: bundle.graphManifest?.errors,
          shardCount: graphShards.length,
          shards: graphShards
        }
      : undefined,
    language: languageShards.length || bundle.languageManifest
      ? {
          manifestPath: bundle.languageManifestPath,
          languageId: bundle.languageManifest?.languageId,
          createdAt: bundle.languageManifest?.createdAt,
          pagesTrained: bundle.languageManifest?.pagesTrained,
          charsTrained: bundle.languageManifest?.charsTrained,
          errors: bundle.languageManifest?.errors,
          shardCount: languageShards.length,
          shards: languageShards
        }
      : undefined,
    ngramStates,
    priorSections: bundle.priorSectionPaths.map(section => ({ ...section })),
    sourceRefs: buildSourceRefs(bundle, observedAt),
    warnings,
    metadata: toJsonValue({
      graphShardRoots: bundle.graphShardRoots,
      languageShardRoots: bundle.languageShardRoots,
      ngramStateCount: bundle.ngramModelPaths.length,
      brainBundlePaths: bundle.brainBundlePaths
    })
  };
}

export async function readScce2GraphShardStats(statsPath: string): Promise<Scce2GraphShardStats | undefined> {
  return readJsonFile<Scce2GraphShardStats>(statsPath, MAX_SCCE2_STATS_JSON_BYTES).catch(() => undefined);
}

export async function readScce2LanguageProfile(profilePath: string): Promise<Scce2LanguageProfileShard | undefined> {
  return readJsonFile<Scce2LanguageProfileShard>(profilePath, MAX_SCCE2_PROFILE_JSON_BYTES).catch(() => undefined);
}

export async function readJsonFile<T>(filePath: string, maxBytes = MAX_SCCE2_MANIFEST_JSON_BYTES): Promise<T> {
  const info = await safeStat(filePath);
  if (!info?.isFile()) throw new Error(`missing JSON file: ${filePath}`);
  if (info.size > maxBytes) throw new Error(`JSON file exceeds bounded read work extent ${maxBytes}: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function safeStat(filePath: string) {
  if (filePath.includes(".brain#")) return undefined;
  return stat(filePath).catch(() => undefined);
}

async function discoverFromDirectory(
  startDir: string,
  state: Scce2DiscoveryState
): Promise<void> {
  let seen = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > state.maxDepth || seen > state.maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      state.warnings.push(`cannot read directory ${dir}: ${messageOf(error)}`);
      return;
    }
    const names = new Set(entries.map(entry => entry.name));
    if (names.has("manifest.json")) {
      const manifestPath = path.join(dir, "manifest.json");
      const kind = await classifyManifest(manifestPath);
      if (kind === "graph") state.graphRoots.add(dir);
      if (kind === "language") state.languageRoots.add(dir);
    }
    if ([...names].some(name => isGraphShardName(name) || isGraphStatsName(name))) state.graphRoots.add(dir);
    if ([...names].some(isLanguageProfileName)) state.languageRoots.add(dir);
    for (const entry of entries) {
      if (++seen > state.maxFiles) {
        state.warnings.push(`discovery stopped after ${state.maxFiles} files under ${startDir}`);
        return;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
        await visit(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const s = await safeStat(fullPath);
        await classifyPath(fullPath, s?.size ?? 0, state);
      }
    }
  };
  await visit(startDir, 0);
}

async function discoverKnownRepositoryBrainRoots(root: string, state: Scce2DiscoveryState): Promise<boolean> {
  const candidates = [
    { path: path.join(root, "data", "corpora", "brain-shards"), maxDepth: 6 },
    { path: path.join(root, "data", "corpora", "language-profiles"), maxDepth: 6 },
    { path: path.join(root, "data", "models"), maxDepth: 5 },
    { path: path.join(root, ".scce"), maxDepth: 5 }
  ];
  let found = false;
  for (const candidate of candidates) {
    const info = await safeStat(candidate.path);
    if (!info?.isDirectory()) continue;
    found = true;
    await discoverFromDirectory(candidate.path, {
      ...state,
      maxDepth: Math.min(state.maxDepth, candidate.maxDepth)
    });
  }
  if (found) state.warnings.push(`used SCCE2 repository brain fast path under ${root}; generic repo-wide crawl skipped`);
  return found;
}

async function classifyPath(
  filePath: string,
  byteLength: number,
  state: Pick<Scce2DiscoveryState, "graphFiles" | "ngramPaths" | "priorSections" | "brainBundlePaths">
): Promise<void> {
  if (isScce2BrainBundlePath(filePath)) {
    state.brainBundlePaths.add(path.resolve(filePath));
    return;
  }
  if (isConceptGraphPath(filePath)) {
    state.graphFiles.set(filePath, { path: filePath, byteLength });
    return;
  }
  if (isNgramPath(filePath)) {
    state.ngramPaths.set(filePath, { path: filePath, byteLength, forceClass: ngramForceClass(ngramSectionKind(filePath)) });
    return;
  }
  const prior = priorSectionFromEntry(path.basename(filePath), filePath, byteLength);
  if (prior) state.priorSections.set(prior.path, prior);
}

async function expandBrainBundles(state: {
  graphFiles: Map<string, { path: string; byteLength: number; sha256?: string }>;
  ngramPaths: Map<string, { path: string; byteLength: number; sha256?: string; forceClass: BrainShardProvenanceClass }>;
  priorSections: Map<string, Scce2ManifestBundle["priorSectionPaths"][number]>;
  brainBundlePaths: Set<string>;
  warnings: string[];
}): Promise<void> {
  for (const bundlePath of [...state.brainBundlePaths].sort()) {
    const inspected = await inspectScce2BrainBundle(bundlePath).catch(error => {
      state.warnings.push(`cannot inspect SCCE2 brain bundle ${bundlePath}: ${messageOf(error)}`);
      return undefined;
    });
    if (!inspected) continue;
    const bundleSection: Scce2ManifestBundle["priorSectionPaths"][number] = {
      sectionId: `brain-bundle:${path.basename(bundlePath)}`,
      path: bundlePath,
      sectionKind: "brain_bundle",
      forceClass: "unknown_prior",
      byteLength: inspected.byteLength,
      readable: inspected.footerVerified,
      sha256: inspected.footerSha256,
      metadata: toJsonValue({
        label: inspected.manifest.label ?? null,
        producer: inspected.manifest.producer ?? null,
        createdAt: inspected.manifest.createdAt ?? null,
        stats: inspected.manifest.stats ?? null,
        footerVerified: inspected.footerVerified,
        entries: inspected.entries.map(entry => ({ name: entry.name, bytes: entry.bytes, sha256: entry.declaredSha256, kind: entry.kind }))
      })
    };
    state.priorSections.set(bundleSection.path, bundleSection);
    for (const entry of inspected.entries) {
      const entryPath = makeBrainEntryPath(bundlePath, entry.name);
      if (isConceptGraphPath(entry.name)) {
        state.graphFiles.set(entryPath, { path: entryPath, byteLength: entry.bytes, sha256: entry.declaredSha256 });
      } else if (isNgramEntryName(entry.name)) {
        state.ngramPaths.set(entryPath, { path: entryPath, byteLength: entry.bytes, sha256: entry.declaredSha256, forceClass: ngramForceClass(ngramSectionKind(entry.name)) });
      } else {
        const section = priorSectionFromEntry(entry.name, entryPath, entry.bytes, entry.declaredSha256);
        if (section) state.priorSections.set(section.path, section);
        else {
          state.priorSections.set(entryPath, {
            sectionId: `brain-entry:${entry.name}`,
            path: entryPath,
            sectionKind: "unknown",
            forceClass: "unknown_prior",
            byteLength: entry.bytes,
            readable: true,
            sha256: entry.declaredSha256,
            metadata: toJsonValue({ sourceSystem: "scce2", entryName: entry.name, reason: "supported bundle container with unsupported section semantics" })
          });
        }
      }
    }
  }
}

async function classifyManifest(manifestPath: string): Promise<"graph" | "language" | "unknown"> {
  const raw = await readJsonFile<Record<string, unknown>>(manifestPath, MAX_SCCE2_MANIFEST_JSON_BYTES).catch(() => undefined);
  if (!raw) return "unknown";
  if (raw.schema === "scce.learnedLanguageProfileShardManifest.v1") return "language";
  if (Array.isArray(raw.shards) && raw.shards.some(item => isRecord(item) && typeof item.profilePath === "string")) return "language";
  if (Array.isArray(raw.shards) && raw.shards.some(item => isRecord(item) && typeof item.snapshotPath === "string")) return "graph";
  return "unknown";
}

async function chooseManifest(roots: string[], kind: "graph" | "language"): Promise<string | undefined> {
  for (const root of roots.sort()) {
    const manifestPath = path.join(root, "manifest.json");
    if (await classifyManifest(manifestPath) === kind) return manifestPath;
  }
  return undefined;
}

async function materializeGraphShards(bundle: Scce2ManifestBundle, warnings: string[]): Promise<BrainShardManifest["graph"] extends infer G ? G extends { shards: infer S } ? S : never : never> {
  const manifestShards = bundle.graphManifest?.shards ?? [];
  const fromManifest = manifestShards.map(shard => ({ ...shard, snapshotPath: path.resolve(shard.snapshotPath), statsPath: shard.statsPath ? path.resolve(shard.statsPath) : undefined }));
  const inferred: Scce2GraphManifestShard[] = [];
  for (const root of bundle.graphShardRoots) {
    const files = await readdir(root).catch(() => []);
    for (const file of files) {
      const name = typeof file === "string" ? file : String(file);
      if (!isGraphShardName(name)) continue;
      const shardId = name.slice(0, -".v8".length);
      if (fromManifest.some(item => item.shardId === shardId)) continue;
      inferred.push({ shardId, snapshotPath: path.join(root, name), statsPath: path.join(root, `${shardId}.stats.json`) });
    }
  }
  for (const item of bundle.graphFilePaths) {
    const shardId = sectionIdFromPath(item.path);
    if (fromManifest.some(row => row.shardId === shardId) || inferred.some(row => row.shardId === shardId)) continue;
    inferred.push({ shardId, snapshotPath: item.path });
  }
  const out = [];
  for (const shard of [...fromManifest, ...inferred].sort((a, b) => a.shardId.localeCompare(b.shardId))) {
    const statsDoc = shard.statsPath ? await readScce2GraphShardStats(shard.statsPath) : undefined;
    const snapshotStat = await safeStat(shard.snapshotPath);
    const virtual = bundle.graphFilePaths.find(item => item.path === shard.snapshotPath);
    if (!snapshotStat && !virtual) warnings.push(`missing graph snapshot ${shard.snapshotPath}`);
    out.push({
      shardId: shard.shardId,
      snapshotPath: shard.snapshotPath,
      format: graphFormat(shard.snapshotPath),
      statsPath: shard.statsPath,
      pages: statsDoc?.pages ?? shard.pages,
      triples: statsDoc?.triples ?? shard.triples,
      concepts: statsDoc?.concepts,
      relations: statsDoc?.relations,
      byteLength: snapshotStat?.size ?? virtual?.byteLength,
      exportedAt: statsDoc?.exportedAt,
      readable: Boolean(snapshotStat?.isFile() || virtual),
      metadata: toJsonValue({ stats: statsDoc ?? null, sha256: virtual?.sha256 ?? null, provenanceClass: "learned_concept_prior", format: graphFormat(shard.snapshotPath) })
    });
  }
  return out as never;
}

async function materializeLanguageShards(bundle: Scce2ManifestBundle, warnings: string[]): Promise<BrainShardManifest["language"] extends infer L ? L extends { shards: infer S } ? S : never : never> {
  const manifestShards = bundle.languageManifest?.shards ?? [];
  const fromManifest = manifestShards.map(shard => ({ ...shard, profilePath: path.resolve(shard.profilePath) }));
  const inferred: Scce2LanguageManifestShard[] = [];
  for (const root of bundle.languageShardRoots) {
    const files = await readdir(root).catch(() => []);
    for (const file of files) {
      const name = typeof file === "string" ? file : String(file);
      if (!isLanguageProfileName(name)) continue;
      const shardId = name.slice(0, -".profile.json".length);
      if (fromManifest.some(item => item.shardId === shardId)) continue;
      inferred.push({ shardId, profilePath: path.join(root, name) });
    }
  }
  const out = [];
  for (const shard of [...fromManifest, ...inferred].sort((a, b) => a.shardId.localeCompare(b.shardId))) {
    const profile = await readScce2LanguageProfile(shard.profilePath);
    const profileStat = await safeStat(shard.profilePath);
    if (!profileStat) warnings.push(`missing language profile ${shard.profilePath}`);
    out.push({
      shardId: shard.shardId,
      profilePath: shard.profilePath,
      pages: shard.pages ?? firstNumber(profile?.sourceEvidence, "pages"),
      chars: shard.chars ?? firstNumber(profile?.sourceEvidence, "chars"),
      byteLength: profileStat?.size,
      script: profile?.script,
      languageId: profile?.languageId,
      confidence: profile?.confidence,
      observedSymbols: observedSymbolEntries(profile).length,
      titleSymbols: profile?.tokenizationProfile?.observedTitleTokens?.length ?? 0,
      punctuationPatterns: profile?.syntaxProfile?.punctuation?.length ?? 0,
      linePatterns: profile?.syntaxProfile?.linePatterns?.length ?? 0,
      fileEvidence: profile?.fileEvidence?.length ?? 0,
      readable: Boolean(profileStat?.isFile() && profile),
      metadata: toJsonValue({ profileDigest: compactLanguageProfileDigest(profile) })
    });
  }
  return out as never;
}

function buildSourceRefs(bundle: Scce2ManifestBundle, observedAt: number): BrainShardManifest["sourceRefs"] {
  const refs: BrainShardManifest["sourceRefs"] = [];
  if (bundle.graphManifestPath) refs.push(sourceRef("scce2-graph-manifest", bundle.graphManifestPath, observedAt));
  if (bundle.languageManifestPath) refs.push(sourceRef("scce2-language-manifest", bundle.languageManifestPath, observedAt));
  for (const item of bundle.ngramModelPaths) refs.push(sourceRef("scce2-ngram-model", item.path, observedAt));
  for (const item of bundle.graphFilePaths) refs.push(sourceRef("scce2-graph-model", item.path, observedAt));
  for (const item of bundle.priorSectionPaths) refs.push(sourceRef(`scce2-${item.sectionKind}`, item.path, observedAt));
  return refs;
}

function sourceRef(namespace: string, canonicalUri: string, observedAt: number): BrainShardManifest["sourceRefs"][number] {
  return {
    namespace,
    canonicalUri,
    mediaType: mediaTypeFor(canonicalUri),
    observedAt,
    trust: 0.62,
    metadata: toJsonValue({ sourceSystem: "scce2", provenanceClass: "unknown_prior" })
  };
}

function priorSectionFromEntry(entryName: string, sectionPath: string, byteLength: number, sha256?: string): Scce2ManifestBundle["priorSectionPaths"][number] | undefined {
  const normalized = entryName.split("\\").join("/").toLocaleLowerCase();
  const sectionKind = normalized === "primitives.json"
    ? "primitives"
    : normalized === "templates.json"
      ? "templates"
      : normalized === "mouth.json"
        ? "mouth"
        : normalized.startsWith("models/ngram/shards/")
          ? "ngram_shard"
          : normalized.startsWith("corpora/brain-shards/wiki-stream/")
            ? "wiki_stream"
            : undefined;
  if (!sectionKind) return undefined;
  const forceClass = sectionKind === "ngram_shard" ? ngramForceClass(ngramSectionKind(entryName)) : "learned_language_prior";
  return {
    sectionId: `brain-section:${entryName}`,
    path: sectionPath,
    sectionKind,
    forceClass,
    byteLength,
    readable: true,
    sha256,
    metadata: toJsonValue({ sourceSystem: "scce2", entryName, provenanceClass: forceClass })
  };
}

function compactLanguageProfileDigest(profile: Scce2LanguageProfileShard | undefined): JsonValue {
  if (!profile) return null;
  return toJsonValue({
    schema: profile.schema,
    sourceId: profile.sourceId,
    shardId: profile.shardId,
    languageId: profile.languageId,
    script: profile.script,
    confidence: profile.confidence,
    fileEvidence: profile.fileEvidence?.length ?? 0,
    observedSymbols: observedSymbolEntries(profile).length,
    codepointBuckets: profile.tokenizationProfile?.codepointBuckets?.slice(0, 12) ?? [],
    linePatterns: profile.syntaxProfile?.linePatterns?.slice(0, 12) ?? []
  });
}

function observedSymbolEntries(profile: Scce2LanguageProfileShard | undefined): Scce2TopEntry[] {
  return profile?.tokenizationProfile?.observedSymbols ?? profile?.tokenizationProfile?.observedTokens ?? [];
}

function emptyBundle(rootPath: string, warnings: string[]): Scce2ManifestBundle {
  return { rootPath, graphFilePaths: [], graphShardRoots: [], languageShardRoots: [], ngramModelPaths: [], priorSectionPaths: [], brainBundlePaths: [], warnings };
}

function sectionIdFromPath(filePath: string): string {
  const name = filePath.includes("#") ? decodeURIComponent(filePath.slice(filePath.indexOf("#") + 1)) : path.basename(filePath);
  return stripKnownSuffixes(name.split("/").pop() ?? name);
}

function ngramStateIdFromPath(filePath: string): string {
  const source = filePath.includes("#") ? decodeURIComponent(filePath.slice(filePath.indexOf("#") + 1)) : filePath;
  const file = source.split("\\").join("/").split("/").pop() ?? source;
  const ext = path.extname(file).toLocaleLowerCase().replace(".", "");
  const stem = stripKnownSuffixes(file);
  return ext ? `${stem}-${ext}` : stem;
}

function stripKnownSuffixes(value: string): string {
  for (const suffix of [".profile.json", ".stats.json", ".jsonl", ".json", ".bin", ".v8"]) {
    if (value.toLocaleLowerCase().endsWith(suffix)) return value.slice(0, value.length - suffix.length);
  }
  return value;
}

function firstNumber(values: Array<Record<string, unknown>> | undefined, key: string): number | undefined {
  for (const value of values ?? []) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

function isGraphShardName(name: string): boolean {
  return name.startsWith("shard-") && name.endsWith(".v8") && name.length > "shard-.v8".length;
}

function isGraphStatsName(name: string): boolean {
  return name.startsWith("shard-") && name.endsWith(".stats.json") && name.length > "shard-.stats.json".length;
}

function isLanguageProfileName(name: string): boolean {
  return name.startsWith("language-shard-") && name.endsWith(".profile.json") && name.length > "language-shard-.profile.json".length;
}

function isConceptGraphPath(filePath: string): boolean {
  const name = path.basename(filePath).toLocaleLowerCase();
  return name === "concept-graph.json" || name === "wiki-concept-graph.v8" || name.endsWith("-concept-graph.json") || name.endsWith("-concept-graph.v8");
}

function graphFormat(filePath: string): "scce2_concept_v8" | "scce2_concept_json" | "unknown" {
  const name = filePath.toLocaleLowerCase();
  if (name.endsWith(".v8")) return "scce2_concept_v8";
  if (name.endsWith(".json")) return "scce2_concept_json";
  return "unknown";
}

function isNgramEntryName(entryName: string): boolean {
  const normalized = entryName.split("\\").join("/").toLocaleLowerCase();
  const file = normalized.split("/").pop() ?? normalized;
  return isNamedNgramStateFile(file) || normalized.startsWith("models/ngram/shards/");
}

function isNgramPath(filePath: string): boolean {
  if (isConceptGraphPath(filePath) || isScce2BrainBundlePath(filePath)) return false;
  const name = path.basename(filePath).toLocaleLowerCase();
  if (!endsWithAny(name, [".bin", ".v8", ".json", ".jsonl"])) return false;
  if (name === "primitives.json" || name === "templates.json" || name === "mouth.json") return false;
  const sectionKind = ngramSectionKind(filePath);
  return sectionKind !== "unknown_ngram_section";
}

type Scce2NgramSectionKind = "prose_ngram_state" | "program_ngram_state" | "ngram_shard_state" | "unknown_ngram_section";

function ngramSectionKind(value: string): Scce2NgramSectionKind {
  const source = value.includes("#") ? decodeURIComponent(value.slice(value.indexOf("#") + 1)) : value;
  const normalized = source.split("\\").join("/").toLocaleLowerCase();
  const parts = normalized.split("/");
  const file = parts[parts.length - 1] ?? normalized;
  if (file === "prose.bin" || file === "prose.v8" || file === "hexagram-prose.bin" || file === "hexagram-prose.v8") return "prose_ngram_state";
  if (file === "code.bin" || file === "code.v8" || file === "hexagram-code.bin" || file === "hexagram-code.v8") return "program_ngram_state";
  if (parts.length >= 3 && parts[0] === "models" && parts[1] === "ngram" && parts[2] === "shards") return "ngram_shard_state";
  if (file === "ngram.bin" || file === "ngram.v8" || file === "hexagram.bin" || file === "hexagram.v8") return "ngram_shard_state";
  return "unknown_ngram_section";
}

function isNamedNgramStateFile(file: string): boolean {
  return file === "prose.bin" ||
    file === "prose.v8" ||
    file === "code.bin" ||
    file === "code.v8" ||
    file === "ngram.bin" ||
    file === "ngram.v8" ||
    file === "hexagram.bin" ||
    file === "hexagram.v8" ||
    file === "hexagram-prose.bin" ||
    file === "hexagram-prose.v8" ||
    file === "hexagram-code.bin" ||
    file === "hexagram-code.v8";
}

function ngramForceClass(sectionKind: Scce2NgramSectionKind): BrainShardProvenanceClass {
  return sectionKind === "program_ngram_state" ? "learned_program_prior" : "learned_language_prior";
}

function inferNgramFormat(filePath: string): BrainShardManifest["ngramStates"][number]["format"] {
  const source = filePath.includes("#") ? decodeURIComponent(filePath.slice(filePath.indexOf("#") + 1)) : filePath;
  const ext = path.extname(source).toLocaleLowerCase();
  if (ext === ".bin") return "scce2_binary";
  if (ext === ".v8") return "scce2_v8";
  if (ext === ".json" || ext === ".jsonl") return "scce2_json";
  return "unknown";
}

function mediaTypeFor(filePath: string): string {
  const source = filePath.includes("#") ? decodeURIComponent(filePath.slice(filePath.indexOf("#") + 1)) : filePath;
  const ext = path.extname(source).toLocaleLowerCase();
  if (ext === ".json" || ext === ".jsonl") return "application/json";
  return "application/octet-stream";
}

function endsWithAny(value: string, suffixes: string[]): boolean {
  return suffixes.some(suffix => value.endsWith(suffix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

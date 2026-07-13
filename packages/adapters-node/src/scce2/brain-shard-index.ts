import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { toJsonValue, type BrainShardInspection, type BrainShardManifest, type BrainShardProvenanceClass, type JsonValue } from "@scce/kernel";
import { Scce2BrainShardReader } from "./brain-shard-reader.js";
import { hashScce2SourcePath } from "./brain-bundle.js";
import type { Scce2DiscoveryOptions } from "./scce2-ingest-manifest.js";

export interface Scce2ShardIndexEntry {
  kind: "graph" | "language" | "ngram_state" | "prior_section";
  id: string;
  path: string;
  readable: boolean;
  byteLength: number;
  sha256?: string;
  hashStatus?: "manifest" | "computed" | "omitted_by_work_extent" | "unavailable";
  format?: string;
  forceClass: BrainShardProvenanceClass;
  pages?: number;
  records?: number;
  confidence?: number;
  sourceId?: string;
  metadata: JsonValue;
}

export interface Scce2BrainShardIndex {
  rootPath: string;
  sourceId?: string;
  entries: Scce2ShardIndexEntry[];
  totals: {
    graphShards: number;
    languageShards: number;
    ngramStates: number;
    bytes: number;
    pages: number;
    graphTriples: number;
    languageChars: number;
  };
  warnings: string[];
  filesFound: number;
  importableSections: Array<{ id: string; kind: Scce2ShardIndexEntry["kind"]; path: string; forceClass: BrainShardProvenanceClass; rowsAvailable?: number; sha256?: string }>;
  unsupportedSections: Array<{ id: string; path: string; reason: string }>;
  unknownSections: Array<{ id: string; path: string; reason: string }>;
  languagePriorCounts: { units: number; patterns: number; ngramStates: number };
  graphConceptPriorCounts: { graphShards: number; concepts: number; relations: number; triples: number };
  directEvidenceCoverage: { spans: number; profileExcerptEvidenceSpans: number; exactSourceRefs: number };
  hashing: { workExtentBytes: number; hashedBytes: number; hashedFiles: number; omittedFiles: number; unavailableFiles: number };
  manifest: BrainShardManifest;
}

export interface Scce2BrainShardIndexOptions extends Scce2DiscoveryOptions {
  hashWorkExtentBytes?: number;
  maxHashBytesPerFile?: number;
}

const DEFAULT_HASH_WORK_EXTENT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_HASH_BYTES_PER_FILE = 96 * 1024 * 1024;

export async function buildScce2BrainShardIndex(rootPath: string, options: Scce2BrainShardIndexOptions = {}, reader = new Scce2BrainShardReader()): Promise<Scce2BrainShardIndex> {
  const inspection = await reader.inspect(rootPath, options);
  return hydrateHashes(indexFromInspection(inspection), options);
}

export function indexFromInspection(inspection: BrainShardInspection): Scce2BrainShardIndex {
  const manifest = inspection.manifest;
  const entries: Scce2ShardIndexEntry[] = [];
  for (const shard of manifest.graph?.shards ?? []) {
    entries.push({
      kind: "graph",
      id: shard.shardId,
      path: shard.snapshotPath,
      readable: shard.readable,
      byteLength: shard.byteLength ?? 0,
      format: shard.metadata && typeof shard.metadata === "object" && !Array.isArray(shard.metadata) && typeof shard.metadata.format === "string" ? shard.metadata.format : "SCCE2 concept snapshot",
      forceClass: "learned_concept_prior",
      pages: shard.pages,
      records: shard.triples,
      sourceId: manifest.sourceId,
      metadata: toJsonValue({
        statsPath: shard.statsPath,
        concepts: shard.concepts,
        relations: shard.relations,
        exportedAt: shard.exportedAt,
        provenanceClass: "learned_concept_prior"
      })
    });
  }
  for (const shard of manifest.language?.shards ?? []) {
    entries.push({
      kind: "language",
      id: shard.shardId,
      path: shard.profilePath,
      readable: shard.readable,
      byteLength: shard.byteLength ?? 0,
      format: "SCCE2 language profile JSON",
      forceClass: "learned_language_prior",
      pages: shard.pages,
      records: shard.chars,
      confidence: shard.confidence,
      sourceId: manifest.sourceId,
      metadata: toJsonValue({
        script: shard.script,
        languageId: shard.languageId,
        observedSymbols: shard.observedSymbols,
        titleSymbols: shard.titleSymbols,
        linePatterns: shard.linePatterns,
        fileEvidence: shard.fileEvidence,
        provenanceClass: "learned_language_prior"
      })
    });
  }
  for (const state of manifest.ngramStates) {
    const forceClass = state.forceClass ?? "learned_language_prior";
    entries.push({
      kind: "ngram_state",
      id: state.stateId,
      path: state.path,
      readable: state.readable,
      byteLength: state.byteLength,
      format: state.format,
      forceClass,
      records: state.totalUnigrams,
      sourceId: manifest.sourceId,
      metadata: toJsonValue({
        format: state.format,
        maxOrder: state.maxOrder,
        vocabularySize: state.vocabularySize,
        orders: state.orders,
        provenanceClass: forceClass
      })
    });
  }
  for (const section of manifest.priorSections) {
    entries.push({
      kind: "prior_section",
      id: section.sectionId,
      path: section.path,
      readable: section.readable,
      byteLength: section.byteLength,
      sha256: section.sha256,
      format: section.sectionKind,
      forceClass: section.forceClass,
      records: undefined,
      sourceId: manifest.sourceId,
      metadata: toJsonValue({
        ...objectOrEmpty(section.metadata),
        sectionKind: section.sectionKind,
        provenanceClass: section.forceClass
      })
    });
  }
  const totals = {
    graphShards: manifest.graph?.shards.length ?? 0,
    languageShards: manifest.language?.shards.length ?? 0,
    ngramStates: manifest.ngramStates.length,
    bytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    pages: (manifest.graph?.pagesTrained ?? 0) || (manifest.language?.pagesTrained ?? 0) || entries.reduce((sum, entry) => sum + (entry.pages ?? 0), 0),
    graphTriples: manifest.graph?.triplesTotal ?? entries.filter(entry => entry.kind === "graph").reduce((sum, entry) => sum + (entry.records ?? 0), 0),
    languageChars: manifest.language?.charsTrained ?? entries.filter(entry => entry.kind === "language").reduce((sum, entry) => sum + (entry.records ?? 0), 0)
  };
  const importableSections = entries
    .filter(entry => entry.readable)
    .map(entry => ({ id: entry.id, kind: entry.kind, path: entry.path, forceClass: entry.forceClass, rowsAvailable: entry.records, sha256: entry.sha256 }));
  const unsupportedSections = entries
    .filter(entry => !entry.readable && entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata))
    .map(entry => ({ id: entry.id, path: entry.path, reason: String((entry.metadata as Record<string, JsonValue>).error ?? "not readable") }));
  const mappedPaths = new Set(entries.map(entry => entry.path));
  const unknownSections = manifest.sourceRefs
    .filter(ref => ref.mediaType === "application/octet-stream" || ref.mediaType === "application/unknown")
    .filter(ref => !mappedPaths.has(ref.canonicalUri))
    .map(ref => ({ id: ref.canonicalUri, path: ref.canonicalUri, reason: "source reference format was not mapped to a supported SCCE2 import section" }));
  return {
    rootPath: path.resolve(manifest.rootPath),
    sourceId: manifest.sourceId,
    entries,
    totals,
    warnings: inspection.warnings,
    filesFound: entries.length,
    importableSections,
    unsupportedSections,
    unknownSections,
    languagePriorCounts: {
      units: (manifest.language?.shards ?? []).reduce((sum, shard) => sum + (shard.observedSymbols ?? 0) + (shard.titleSymbols ?? 0), 0),
      patterns: (manifest.language?.shards ?? []).reduce((sum, shard) => sum + (shard.punctuationPatterns ?? 0) + (shard.linePatterns ?? 0), 0),
      ngramStates: manifest.ngramStates.filter(state => state.readable && (state.forceClass ?? "learned_language_prior") === "learned_language_prior").length
    },
    graphConceptPriorCounts: {
      graphShards: manifest.graph?.shards.filter(shard => shard.readable).length ?? 0,
      concepts: manifest.graph?.shards.reduce((sum, shard) => sum + (shard.concepts ?? 0), 0) ?? 0,
      relations: manifest.graph?.shards.reduce((sum, shard) => sum + (shard.relations ?? 0), 0) ?? 0,
      triples: manifest.graph?.triplesTotal ?? entries.filter(entry => entry.kind === "graph").reduce((sum, entry) => sum + (entry.records ?? 0), 0)
    },
    directEvidenceCoverage: {
      spans: 0,
      profileExcerptEvidenceSpans: manifest.language?.shards.reduce((sum, shard) => sum + (shard.fileEvidence ?? 0), 0) ?? 0,
      exactSourceRefs: manifest.sourceRefs.filter(ref => Boolean(ref.contentHash || ref.sourceVersionId)).length
    },
    hashing: { workExtentBytes: 0, hashedBytes: 0, hashedFiles: 0, omittedFiles: 0, unavailableFiles: 0 },
    manifest
  };
}

async function hydrateHashes(index: Scce2BrainShardIndex, options: Scce2BrainShardIndexOptions): Promise<Scce2BrainShardIndex> {
  const entries: Scce2ShardIndexEntry[] = [];
  const workExtentBytes = Math.max(0, options.hashWorkExtentBytes ?? DEFAULT_HASH_WORK_EXTENT_BYTES);
  const maxHashBytesPerFile = Math.max(0, options.maxHashBytesPerFile ?? DEFAULT_MAX_HASH_BYTES_PER_FILE);
  let hashedBytes = 0;
  let hashedFiles = 0;
  let omittedFiles = 0;
  let unavailableFiles = 0;
  const warnings = [...index.warnings];
  for (const entry of index.entries) {
    if (entry.sha256) {
      entries.push({ ...entry, hashStatus: "manifest" });
      continue;
    }
    if (!entry.readable) {
      unavailableFiles++;
      entries.push({ ...entry, hashStatus: "unavailable" });
      continue;
    }
    if (entry.byteLength > maxHashBytesPerFile || hashedBytes + entry.byteLength > workExtentBytes) {
      omittedFiles++;
      entries.push({ ...entry, hashStatus: "omitted_by_work_extent" });
      continue;
    }
    const sha256 = await hashScce2SourcePath(entry.path).then(result => result.sha256).catch(() => hashFile(entry.path).catch(() => undefined));
    if (sha256) {
      hashedBytes += entry.byteLength;
      hashedFiles++;
      entries.push({ ...entry, sha256, hashStatus: "computed" });
    } else {
      unavailableFiles++;
      entries.push({ ...entry, hashStatus: "unavailable" });
    }
  }
  if (omittedFiles > 0) warnings.push(`hashing omitted ${omittedFiles} SCCE2 files after bounded inspect work extent; rerun with --hash-work-extent-mb for deeper hash coverage`);
  const shaByPath = new Map(entries.map(entry => [entry.path, entry.sha256]));
  return {
    ...index,
    entries,
    warnings,
    importableSections: index.importableSections.map(section => ({ ...section, sha256: shaByPath.get(section.path) })),
    hashing: { workExtentBytes, hashedBytes, hashedFiles, omittedFiles, unavailableFiles }
  };
}

function objectOrEmpty(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(Buffer.from(chunk as Buffer)));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

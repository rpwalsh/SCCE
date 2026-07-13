import { readFile } from "node:fs/promises";
import v8 from "node:v8";
import {
  type BrainShardInspection,
  type BrainShardManifest,
  type BrainShardReader,
  toJsonValue
} from "@scce/kernel";
import {
  discoverScce2ManifestBundle,
  materializeScce2Manifest,
  type Scce2DiscoveryOptions,
  safeStat
} from "./scce2-ingest-manifest.js";
import { readBoundedScce2Source, withBrainBundleEntryStream } from "./brain-bundle.js";

export interface Scce2Concept {
  id: string;
  names?: Set<string> | string[];
  type?: string;
  properties?: Map<string, string[]> | Record<string, string[]>;
  domain?: string;
}

export interface Scce2Relation {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  source?: string;
  bidirectional?: boolean;
  bundlePriority?: number;
  bundleId?: string;
}

export interface Scce2CausalChain {
  steps: Array<{ cause: string; effect: string; mechanism: string }>;
  domain?: string;
  confidence?: number;
}

export interface Scce2ConceptSnapshot {
  version: 1 | 2;
  concepts: Map<string, Scce2Concept>;
  relations: Scce2Relation[];
  causalChains?: Scce2CausalChain[];
}

export interface Scce2NgramState {
  unigrams: Map<string, number>;
  bigrams: Map<string, Map<string, number>>;
  trigrams: Map<string, Map<string, number>>;
  quadgrams: Map<string, Map<string, number>>;
  pentagrams: Map<string, Map<string, number>>;
  hexagrams: Map<string, Map<string, number>>;
  totalUnigrams: number;
  vocabulary: Set<string>;
  bigramTotals?: Map<string, number>;
  trigramTotals?: Map<string, number>;
  quadgramTotals?: Map<string, number>;
  pentagramTotals?: Map<string, number>;
  hexagramTotals?: Map<string, number>;
  interpolationWeights?: { w2: number; w3: number; w4: number; w5: number; w6: number };
  discounts?: Record<string, unknown>;
}

export interface Scce2SnapshotReadOptions {
  maxBytes?: number;
}

export interface Scce2SnapshotReadResult<T> {
  ok: boolean;
  path: string;
  byteLength: number;
  value?: T;
  warning?: string;
}

const CONCEPT_MAGIC = Buffer.from("SCCECGV8\x00\x01");
const NGRAM_V8_MAGIC = Buffer.from("SCCEV8\x00\x01");
const NGRAM_BINARY_MAGIC = 0x45434353;
const NGRAM_BINARY_VERSION = 2;

export class Scce2BrainShardReader implements BrainShardReader {
  async inspect(rootPath: string, options: Scce2DiscoveryOptions = {}): Promise<BrainShardInspection> {
    const manifest = await this.readManifest(rootPath, options);
    const totalBytes = [
      ...(manifest.graph?.shards.map(shard => shard.byteLength ?? 0) ?? []),
      ...(manifest.language?.shards.map(shard => shard.byteLength ?? 0) ?? []),
      ...manifest.ngramStates.map(state => state.byteLength),
      ...manifest.priorSections.map(section => section.byteLength)
    ].reduce((sum, value) => sum + value, 0);
    const profileExcerptEvidenceSpans = manifest.language?.shards.reduce((sum, shard) => sum + (shard.fileEvidence ?? 0), 0) ?? 0;
    return {
      manifest,
      totalBytes,
      importable: {
        graphShards: manifest.graph?.shards.filter(shard => shard.readable).length ?? 0,
        languageShards: manifest.language?.shards.filter(shard => shard.readable).length ?? 0,
        ngramStates: manifest.ngramStates.filter(state => state.readable).length,
        directEvidenceSpans: 0,
        profileExcerptEvidenceSpans,
        learnedLanguagePriors: (manifest.language?.shards.length ?? 0)
          + manifest.ngramStates.filter(state => (state.forceClass ?? "learned_language_prior") === "learned_language_prior").length
          + manifest.priorSections.filter(section => section.forceClass === "learned_language_prior").length,
        learnedConceptPriors: manifest.graph?.shards.length ?? 0
      },
      warnings: manifest.warnings
    };
  }

  async readManifest(rootPath: string, options: Scce2DiscoveryOptions = {}): Promise<BrainShardManifest> {
    const bundle = await discoverScce2ManifestBundle(rootPath, options);
    return materializeScce2Manifest(bundle, Date.now());
  }
}

export async function readScce2ConceptSnapshot(filePath: string, options: Scce2SnapshotReadOptions = {}): Promise<Scce2SnapshotReadResult<Scce2ConceptSnapshot>> {
  const info = await safeStat(filePath);
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const byteLength = info?.size ?? await virtualByteLength(filePath).catch(() => 0);
  if (!info?.isFile() && !filePath.includes(".brain#")) return { ok: false, path: filePath, byteLength: 0, warning: "missing concept snapshot" };
  if (byteLength > maxBytes) return { ok: false, path: filePath, byteLength, warning: `concept snapshot exceeds bounded decode work extent ${maxBytes}` };
  const buf = filePath.includes(".brain#") ? await readBoundedScce2Source(filePath, maxBytes) : await readFile(filePath);
  if (buf.length < CONCEPT_MAGIC.length || !buf.subarray(0, CONCEPT_MAGIC.length).equals(CONCEPT_MAGIC)) {
    return { ok: false, path: filePath, byteLength: buf.length, warning: "bad SCCE2 concept snapshot magic" };
  }
  const value = v8.deserialize(buf.subarray(CONCEPT_MAGIC.length)) as Scce2ConceptSnapshot;
  if (value.version !== 1 && value.version !== 2) {
    return { ok: false, path: filePath, byteLength: buf.length, warning: `unsupported SCCE2 concept snapshot version ${String((value as { version?: unknown }).version)}` };
  }
  return { ok: true, path: filePath, byteLength: buf.length, value };
}

export async function readScce2NgramState(filePath: string, options: Scce2SnapshotReadOptions = {}): Promise<Scce2SnapshotReadResult<Scce2NgramState>> {
  const info = await safeStat(filePath);
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const byteLength = info?.size ?? await virtualByteLength(filePath).catch(() => 0);
  if (!info?.isFile() && !filePath.includes(".brain#")) return { ok: false, path: filePath, byteLength: 0, warning: "missing n-gram state" };
  if (byteLength > maxBytes) return { ok: false, path: filePath, byteLength, warning: `n-gram state exceeds bounded decode work extent ${maxBytes}` };
  const buf = filePath.includes(".brain#") ? await readBoundedScce2Source(filePath, maxBytes) : await readFile(filePath);
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".v8")) {
    if (buf.length < NGRAM_V8_MAGIC.length || !buf.subarray(0, NGRAM_V8_MAGIC.length).equals(NGRAM_V8_MAGIC)) {
      return { ok: false, path: filePath, byteLength: buf.length, warning: "bad SCCE2 n-gram V8 magic" };
    }
    return { ok: true, path: filePath, byteLength: buf.length, value: normalizeNgramState(v8.deserialize(buf.subarray(NGRAM_V8_MAGIC.length))) };
  }
  if (ext.endsWith(".bin")) {
    return readBinaryNgramState(filePath, buf);
  }
  if (ext.endsWith(".json")) {
    const raw = JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
    return { ok: true, path: filePath, byteLength: buf.length, value: ngramStateFromJson(raw) };
  }
  return { ok: false, path: filePath, byteLength: buf.length, warning: "unsupported n-gram state extension" };
}

async function virtualByteLength(filePath: string): Promise<number> {
  return withBrainBundleEntryStream(filePath, async input => input.byteLength);
}

export function summarizeScce2NgramState(state: Scce2NgramState) {
  return toJsonValue({
    totalUnigrams: state.totalUnigrams,
    vocabularySize: state.vocabulary.size,
    orders: [
      { order: 1, contexts: 1, continuations: state.unigrams.size },
      { order: 2, contexts: state.bigrams.size, continuations: nestedMapSize(state.bigrams) },
      { order: 3, contexts: state.trigrams.size, continuations: nestedMapSize(state.trigrams) },
      { order: 4, contexts: state.quadgrams.size, continuations: nestedMapSize(state.quadgrams) },
      { order: 5, contexts: state.pentagrams.size, continuations: nestedMapSize(state.pentagrams) },
      { order: 6, contexts: state.hexagrams.size, continuations: nestedMapSize(state.hexagrams) }
    ],
    interpolationWeights: state.interpolationWeights ?? null,
    discounts: state.discounts ?? null
  });
}

export function* iterateScce2NgramCounts(state: Scce2NgramState, limit = 10000): Iterable<{ order: number; history: string[]; symbol: string; count: number }> {
  let emitted = 0;
  for (const [symbol, count] of topMapEntries(state.unigrams, limit)) {
    yield { order: 1, history: [], symbol, count };
    if (++emitted >= limit) return;
  }
  for (const [order, map] of [
    [2, state.bigrams],
    [3, state.trigrams],
    [4, state.quadgrams],
    [5, state.pentagrams],
    [6, state.hexagrams]
  ] as const) {
    for (const [context, inner] of map) {
      const history = splitWhitespaceKey(context);
      for (const [symbol, count] of topMapEntries(inner, Math.max(1, limit - emitted))) {
        yield { order, history, symbol, count };
        if (++emitted >= limit) return;
      }
    }
  }
}

function readBinaryNgramState(filePath: string, buffer: Buffer): Scce2SnapshotReadResult<Scce2NgramState> {
  if (buffer.length < 12) return { ok: false, path: filePath, byteLength: buffer.length, warning: "truncated SCCE2 n-gram binary state" };
  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  if (magic !== NGRAM_BINARY_MAGIC) return { ok: false, path: filePath, byteLength: buffer.length, warning: "bad SCCE2 n-gram binary magic" };
  if (version !== NGRAM_BINARY_VERSION) return { ok: false, path: filePath, byteLength: buffer.length, warning: `unsupported SCCE2 n-gram binary version ${version}` };
  let offset = 12;
  const readString = (): string => {
    const len = buffer.readUInt32LE(offset);
    offset += 4;
    const value = buffer.toString("utf8", offset, offset + len);
    offset += len;
    return value;
  };
  const readNumber = (): number => {
    const value = buffer.readDoubleLE(offset);
    offset += 8;
    return value;
  };
  const readMap1 = (): Map<string, number> => {
    const size = buffer.readUInt32LE(offset);
    offset += 4;
    const out = new Map<string, number>();
    for (let i = 0; i < size; i++) out.set(readString(), readNumber());
    return out;
  };
  const readMap2 = (): Map<string, Map<string, number>> => {
    const size = buffer.readUInt32LE(offset);
    offset += 4;
    const out = new Map<string, Map<string, number>>();
    for (let i = 0; i < size; i++) out.set(readString(), readMap1());
    return out;
  };
  try {
    const totalUnigrams = readNumber();
    const vocabSize = buffer.readUInt32LE(offset);
    offset += 4;
    const vocabulary = new Set<string>();
    for (let i = 0; i < vocabSize; i++) vocabulary.add(readString());
    const state: Scce2NgramState = {
      totalUnigrams,
      vocabulary,
      unigrams: readMap1(),
      bigrams: readMap2(),
      trigrams: readMap2(),
      quadgrams: readMap2(),
      pentagrams: readMap2(),
      hexagrams: readMap2(),
      bigramTotals: readMap1(),
      trigramTotals: readMap1(),
      quadgramTotals: readMap1(),
      pentagramTotals: readMap1(),
      hexagramTotals: readMap1(),
      interpolationWeights: { w2: readNumber(), w3: readNumber(), w4: readNumber(), w5: readNumber(), w6: readNumber() }
    };
    return { ok: true, path: filePath, byteLength: buffer.length, value: state };
  } catch (error) {
    return { ok: false, path: filePath, byteLength: buffer.length, warning: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeNgramState(raw: unknown): Scce2NgramState {
  const value = raw as Partial<Scce2NgramState>;
  return {
    totalUnigrams: Number(value.totalUnigrams ?? 0),
    vocabulary: value.vocabulary instanceof Set ? value.vocabulary : new Set(),
    unigrams: asMap1(value.unigrams),
    bigrams: asMap2(value.bigrams),
    trigrams: asMap2(value.trigrams),
    quadgrams: asMap2(value.quadgrams),
    pentagrams: asMap2(value.pentagrams),
    hexagrams: asMap2(value.hexagrams),
    bigramTotals: asMap1(value.bigramTotals),
    trigramTotals: asMap1(value.trigramTotals),
    quadgramTotals: asMap1(value.quadgramTotals),
    pentagramTotals: asMap1(value.pentagramTotals),
    hexagramTotals: asMap1(value.hexagramTotals),
    interpolationWeights: value.interpolationWeights,
    discounts: value.discounts
  };
}

function ngramStateFromJson(raw: Record<string, unknown>): Scce2NgramState {
  const unigrams = new Map<string, number>(Object.entries(raw.unigrams as Record<string, number> | undefined ?? {}).map(([k, v]) => [k, Number(v)]));
  const bigrams = new Map<string, Map<string, number>>();
  for (const [context, inner] of Object.entries(raw.bigrams as Record<string, Record<string, number>> | undefined ?? {})) {
    bigrams.set(context, new Map(Object.entries(inner).map(([symbol, count]) => [symbol, Number(count)])));
  }
  return {
    totalUnigrams: Number(raw.totalUnigrams ?? [...unigrams.values()].reduce((sum, count) => sum + count, 0)),
    vocabulary: new Set(unigrams.keys()),
    unigrams,
    bigrams,
    trigrams: new Map(),
    quadgrams: new Map(),
    pentagrams: new Map(),
    hexagrams: new Map()
  };
}

function asMap1(value: unknown): Map<string, number> {
  if (value instanceof Map) return value as Map<string, number>;
  if (value && typeof value === "object") return new Map(Object.entries(value as Record<string, number>).map(([k, v]) => [k, Number(v)]));
  return new Map();
}

function asMap2(value: unknown): Map<string, Map<string, number>> {
  if (value instanceof Map) return value as Map<string, Map<string, number>>;
  if (value && typeof value === "object") {
    return new Map(Object.entries(value as Record<string, Record<string, number>>).map(([k, inner]) => [k, asMap1(inner)]));
  }
  return new Map();
}

function nestedMapSize(map: Map<string, Map<string, number>>): number {
  let count = 0;
  for (const inner of map.values()) count += inner.size;
  return count;
}

function topMapEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function splitWhitespaceKey(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value) {
    if (char.trim().length === 0) {
      if (current) out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

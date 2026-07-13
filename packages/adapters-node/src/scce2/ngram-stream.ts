import { TextDecoder } from "node:util";
import { withBrainBundleEntryStream } from "./brain-bundle.js";
import { readScce2NgramState, type Scce2NgramState } from "./brain-shard-reader.js";

export interface Scce2NgramStreamItem {
  order: number;
  history: string[];
  symbol: string;
  count: number;
}

export interface Scce2NgramStreamSummary {
  totalUnigrams: number;
  vocabularySize: number;
  orders: Array<{ order: number; contexts: number; continuations: number }>;
  interpolationWeights?: { w2: number; w3: number; w4: number; w5: number; w6: number };
  warnings: string[];
}

export interface Scce2NgramStreamOptions {
  maxBytes?: number;
}

const NGRAM_BINARY_MAGIC = 0x45434353;
const NGRAM_BINARY_VERSION = 2;
const MAX_REASONABLE_SYMBOL_BYTES = 64 * 1024 * 1024;

export async function streamScce2NgramState(
  filePath: string,
  onItem: (item: Scce2NgramStreamItem) => Promise<void>,
  options: Scce2NgramStreamOptions = {}
): Promise<Scce2NgramStreamSummary> {
  const lower = filePath.toLocaleLowerCase();
  if (lower.endsWith(".bin")) return streamBinaryNgram(filePath, onItem);
  if (lower.endsWith(".jsonl")) return streamJsonlNgram(filePath, onItem);
  if (lower.endsWith(".v8")) return streamV8Ngram(filePath, onItem, options);
  return {
    totalUnigrams: 0,
    vocabularySize: 0,
    orders: [],
    warnings: [`unsupported SCCE2 n-gram stream format for ${filePath}`]
  };
}

async function streamV8Ngram(
  filePath: string,
  onItem: (item: Scce2NgramStreamItem) => Promise<void>,
  options: Scce2NgramStreamOptions
): Promise<Scce2NgramStreamSummary> {
  const decoded = await readScce2NgramState(filePath, { maxBytes: options.maxBytes });
  if (!decoded.ok || !decoded.value) {
    return {
      totalUnigrams: 0,
      vocabularySize: 0,
      orders: [],
      warnings: [decoded.warning ?? "SCCE2 V8 n-gram snapshot not decoded"]
    };
  }
  return emitDecodedNgramState(decoded.value, onItem);
}

async function emitDecodedNgramState(
  state: Scce2NgramState,
  onItem: (item: Scce2NgramStreamItem) => Promise<void>
): Promise<Scce2NgramStreamSummary> {
  const orders: Array<{ order: number; contexts: number; continuations: number }> = [];
  let unigramContinuations = 0;
  for (const [symbol, count] of state.unigrams) {
    unigramContinuations++;
    await onItem({ order: 1, history: [], symbol, count });
  }
  orders.push({ order: 1, contexts: state.unigrams.size ? 1 : 0, continuations: unigramContinuations });
  orders.push(await emitNestedMap(2, state.bigrams, context => context ? [context] : [], onItem));
  orders.push(await emitNestedMap(3, state.trigrams, contextFromPipeKey, onItem));
  orders.push(await emitNestedMap(4, state.quadgrams, contextFromPipeKey, onItem));
  orders.push(await emitNestedMap(5, state.pentagrams, contextFromPipeKey, onItem));
  orders.push(await emitNestedMap(6, state.hexagrams, contextFromPipeKey, onItem));
  return {
    totalUnigrams: state.totalUnigrams,
    vocabularySize: state.vocabulary.size,
    orders,
    interpolationWeights: state.interpolationWeights,
    warnings: []
  };
}

async function emitNestedMap(
  order: number,
  map: Map<string, Map<string, number>>,
  historyOf: (context: string) => string[],
  onItem: (item: Scce2NgramStreamItem) => Promise<void>
): Promise<{ order: number; contexts: number; continuations: number }> {
  let contexts = 0;
  let continuations = 0;
  for (const [context, inner] of map) {
    contexts++;
    const history = historyOf(context);
    for (const [symbol, count] of inner) {
      continuations++;
      await onItem({ order, history, symbol, count });
    }
  }
  return { order, contexts, continuations };
}

function contextFromPipeKey(context: string): string[] {
  return context ? context.split("|").filter(Boolean) : [];
}

async function streamBinaryNgram(filePath: string, onItem: (item: Scce2NgramStreamItem) => Promise<void>): Promise<Scce2NgramStreamSummary> {
  return withBrainBundleEntryStream(filePath, async input => {
    const reader = new ByteStreamReader(input.stream);
    const header = await reader.readBytes(12, false);
    const magic = header.readUInt32LE(0);
    const version = header.readUInt32LE(4);
    const expectedCrc = header.readUInt32LE(8);
    if (magic !== NGRAM_BINARY_MAGIC) throw new Error(`bad SCCE2 binary n-gram magic in ${filePath}`);
    if (version !== NGRAM_BINARY_VERSION) throw new Error(`unsupported SCCE2 binary n-gram version ${version}`);
    const totalUnigrams = await reader.readNumber();
    const vocabularySize = await reader.readUInt32();
    for (let i = 0; i < vocabularySize; i++) await reader.readString();
    const orderSummaries: Array<{ order: number; contexts: number; continuations: number }> = [];
    const unigramContinuations = await readMap1(reader, async (symbol, count) => onItem({ order: 1, history: [], symbol, count }));
    orderSummaries.push({ order: 1, contexts: 1, continuations: unigramContinuations });
    for (const order of [2, 3, 4, 5, 6]) {
      const summary = await readMap2(reader, order, onItem);
      orderSummaries.push(summary);
    }
    await skipMap1(reader);
    await skipMap1(reader);
    await skipMap1(reader);
    await skipMap1(reader);
    await skipMap1(reader);
    const interpolationWeights = {
      w2: await reader.readNumber(),
      w3: await reader.readNumber(),
      w4: await reader.readNumber(),
      w5: await reader.readNumber(),
      w6: await reader.readNumber()
    };
    await reader.drainPayload();
    const computed = reader.crc32();
    if (computed !== expectedCrc) throw new Error(`SCCE2 n-gram CRC mismatch in ${filePath}`);
    return {
      totalUnigrams,
      vocabularySize,
      orders: orderSummaries,
      interpolationWeights,
      warnings: []
    };
  });
}

async function streamJsonlNgram(filePath: string, onItem: (item: Scce2NgramStreamItem) => Promise<void>): Promise<Scce2NgramStreamSummary> {
  return withBrainBundleEntryStream(filePath, async input => {
    const decoder = new TextDecoder();
    let pending = "";
    let totalUnigrams = 0;
    let vocabularySize = 0;
    const vocabulary = new Set<string>();
    const orderContexts = new Map<number, number>();
    const orderContinuations = new Map<number, number>();
    const consumeLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const unigrams = asNested0(record.unigrams);
      for (const [symbol, count] of Object.entries(unigrams)) {
        vocabulary.add(symbol);
        totalUnigrams += count;
        orderContinuations.set(1, (orderContinuations.get(1) ?? 0) + 1);
        await onItem({ order: 1, history: [], symbol, count });
      }
      for (const [order, key] of [[2, "bigrams"], [3, "trigrams"], [4, "quadgrams"], [5, "pentagrams"], [6, "hexagrams"]] as const) {
        const nested = asNested1(record[key]);
        let contexts = 0;
        let continuations = 0;
        for (const [context, inner] of Object.entries(nested)) {
          contexts++;
          const history = context ? context.split("|").filter(Boolean) : [];
          for (const [symbol, count] of Object.entries(inner)) {
            continuations++;
            vocabulary.add(symbol);
            await onItem({ order, history, symbol, count });
          }
        }
        orderContexts.set(order, (orderContexts.get(order) ?? 0) + contexts);
        orderContinuations.set(order, (orderContinuations.get(order) ?? 0) + continuations);
      }
      vocabularySize = Math.max(vocabularySize, vocabulary.size);
    };
    for await (const raw of input.stream as AsyncIterable<Buffer | Uint8Array>) {
      pending += decoder.decode(raw, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await consumeLine(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    await consumeLine(pending);
    return {
      totalUnigrams,
      vocabularySize,
      orders: [1, 2, 3, 4, 5, 6].map(order => ({
        order,
        contexts: order === 1 ? 1 : orderContexts.get(order) ?? 0,
        continuations: orderContinuations.get(order) ?? 0
      })),
      warnings: []
    };
  });
}

async function readMap1(reader: ByteStreamReader, onEntry: (symbol: string, count: number) => Promise<void>): Promise<number> {
  const size = await reader.readUInt32();
  for (let i = 0; i < size; i++) await onEntry(await reader.readString(), await reader.readNumber());
  return size;
}

async function readMap2(reader: ByteStreamReader, order: number, onItem: (item: Scce2NgramStreamItem) => Promise<void>): Promise<{ order: number; contexts: number; continuations: number }> {
  const contexts = await reader.readUInt32();
  let continuations = 0;
  for (let i = 0; i < contexts; i++) {
    const context = await reader.readString();
    const innerSize = await reader.readUInt32();
    const history = context ? context.split("|").filter(Boolean) : [];
    for (let j = 0; j < innerSize; j++) {
      const symbol = await reader.readString();
      const count = await reader.readNumber();
      continuations++;
      await onItem({ order, history, symbol, count });
    }
  }
  return { order, contexts, continuations };
}

async function skipMap1(reader: ByteStreamReader): Promise<void> {
  const size = await reader.readUInt32();
  for (let i = 0; i < size; i++) {
    await reader.readString();
    await reader.readNumber();
  }
}

function asNested0(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = Number(raw) || 0;
  return out;
}

function asNested1(value: unknown): Record<string, Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Record<string, number>> = {};
  for (const [key, raw] of Object.entries(value)) out[key] = asNested0(raw);
  return out;
}

class ByteStreamReader {
  private iterator: AsyncIterator<Buffer | Uint8Array>;
  private current: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private offset = 0;
  private finished = false;
  private crc = -1;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = (stream as unknown as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]();
  }

  async readUInt32(): Promise<number> {
    return (await this.readBytes(4, true)).readUInt32LE(0);
  }

  async readNumber(): Promise<number> {
    return (await this.readBytes(8, true)).readDoubleLE(0);
  }

  async readString(): Promise<string> {
    const length = await this.readUInt32();
    if (length > MAX_REASONABLE_SYMBOL_BYTES) throw new Error(`SCCE2 symbol length ${length} is not stream-safe`);
    return (await this.readBytes(length, true)).toString("utf8");
  }

  async readBytes(length: number, payload: boolean): Promise<Buffer<ArrayBufferLike>> {
    const out = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      await this.ensure();
      const available = this.current.byteLength - this.offset;
      if (available <= 0) throw new Error("unexpected EOF in SCCE2 stream");
      const take = Math.min(available, length - written);
      this.current.copy(out, written, this.offset, this.offset + take);
      this.offset += take;
      written += take;
    }
    if (payload) this.updateCrc(out);
    return out;
  }

  async drainPayload(): Promise<void> {
    while (true) {
      if (this.offset < this.current.byteLength) {
        const rest = this.current.subarray(this.offset);
        this.updateCrc(rest);
        this.offset = this.current.byteLength;
      }
      if (this.finished) return;
      const next = await this.iterator.next();
      if (next.done) {
        this.finished = true;
        return;
      }
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
  }

  crc32(): number {
    return (this.crc ^ -1) >>> 0;
  }

  private async ensure(): Promise<void> {
    while (this.offset >= this.current.byteLength) {
      if (this.finished) return;
      const next = await this.iterator.next();
      if (next.done) {
        this.finished = true;
        return;
      }
      this.current = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.offset = 0;
    }
  }

  private updateCrc(chunk: Buffer<ArrayBufferLike>): void {
    for (let i = 0; i < chunk.byteLength; i++) this.crc = (this.crc >>> 8) ^ (CRC32_TABLE[(this.crc ^ (chunk[i] ?? 0)) & 0xff] ?? 0);
  }
}

const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

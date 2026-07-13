import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";

const BRAIN_MAGIC = Buffer.from("SCCEBR", "utf8");
const BRAIN_VERSION = 2;
const SHA256_BYTES = 32;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_COUNT = 8192;

export interface Scce2BrainBundleManifestEntry {
  name: string;
  bytes: number;
  sha256: string;
  kind: "binary" | "json";
}

export interface Scce2BrainBundleManifest {
  magic: "SCCEBR";
  formatVersion: number;
  createdAt?: string;
  label?: string | null;
  producer?: string;
  entries: Scce2BrainBundleManifestEntry[];
  stats?: Record<string, unknown>;
  signature?: unknown;
}

export interface Scce2BrainBundleEntry extends Scce2BrainBundleManifestEntry {
  bundlePath: string;
  dataStart: number;
  dataEnd: number;
  declaredSha256: string;
  verifiedSha256?: string;
}

export interface Scce2BrainBundleInspection {
  bundlePath: string;
  byteLength: number;
  manifest: Scce2BrainBundleManifest;
  manifestSha256: string;
  footerSha256: string;
  footerVerified: boolean;
  entries: Scce2BrainBundleEntry[];
}

export interface Scce2BrainEntryRef {
  bundlePath: string;
  entryName: string;
}

export function makeBrainEntryPath(bundlePath: string, entryName: string): string {
  return `${bundlePath}#${encodeURIComponent(entryName)}`;
}

export function parseBrainEntryPath(value: string): Scce2BrainEntryRef | undefined {
  const marker = ".brain#";
  const index = value.toLocaleLowerCase().indexOf(marker);
  if (index < 0) return undefined;
  const split = index + ".brain".length;
  const bundlePath = value.slice(0, split);
  const encoded = value.slice(split + 1);
  if (!bundlePath || !encoded) return undefined;
  return { bundlePath, entryName: decodeURIComponent(encoded) };
}

export function isScce2BrainBundlePath(value: string): boolean {
  return value.toLocaleLowerCase().endsWith(".brain");
}

export async function inspectScce2BrainBundle(bundlePath: string): Promise<Scce2BrainBundleInspection> {
  const info = await stat(bundlePath);
  const file = await open(bundlePath, "r");
  try {
    let offset = 0;
    const header = await readExactly(file, offset, 12);
    offset += 12;
    if (!header.subarray(0, BRAIN_MAGIC.length).equals(BRAIN_MAGIC)) throw new Error("bad SCCE2 brain bundle magic");
    const version = header.readUInt16LE(6);
    if (version !== BRAIN_VERSION) throw new Error(`unsupported SCCE2 brain bundle version ${version}`);
    const manifestLength = header.readUInt32LE(8);
    if (manifestLength > MAX_MANIFEST_BYTES) throw new Error(`SCCE2 brain bundle manifest too large: ${manifestLength}`);
    const manifestBytes = await readExactly(file, offset, manifestLength);
    offset += manifestLength;
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Scce2BrainBundleManifest;
    if (manifest.magic !== "SCCEBR" || manifest.formatVersion !== BRAIN_VERSION || !Array.isArray(manifest.entries)) {
      throw new Error("SCCE2 brain bundle manifest header mismatch");
    }
    const countBytes = await readExactly(file, offset, 4);
    offset += 4;
    const entryCount = countBytes.readUInt32LE(0);
    if (entryCount > MAX_ENTRY_COUNT) throw new Error(`SCCE2 brain bundle entry count too large: ${entryCount}`);
    if (entryCount !== manifest.entries.length) throw new Error("SCCE2 brain bundle entry count disagrees with manifest");

    const footer = createHash("sha256");
    footer.update(manifestBytes);
    const entries: Scce2BrainBundleEntry[] = [];
    for (let i = 0; i < entryCount; i++) {
      const nameLenBytes = await readExactly(file, offset, 4);
      offset += 4;
      const nameLength = nameLenBytes.readUInt32LE(0);
      if (nameLength > 4096) throw new Error(`SCCE2 brain bundle entry ${i} name too large`);
      const nameBytes = await readExactly(file, offset, nameLength);
      offset += nameLength;
      const name = nameBytes.toString("utf8");
      const lengthBytes = await readExactly(file, offset, 8);
      offset += 8;
      const dataLengthHigh = lengthBytes.readUInt32LE(4);
      if (dataLengthHigh !== 0) throw new Error(`SCCE2 brain bundle entry ${name} exceeds supported u32 length`);
      const dataLength = lengthBytes.readUInt32LE(0);
      const dataStart = offset;
      const hashes = await hashRange(bundlePath, dataStart, dataLength, footer);
      offset += dataLength;
      const declared = await readExactly(file, offset, SHA256_BYTES);
      offset += SHA256_BYTES;
      const declaredHex = declared.toString("hex");
      const manifestEntry = manifest.entries[i];
      if (!manifestEntry || manifestEntry.name !== name) throw new Error(`SCCE2 brain bundle entry order mismatch at ${i}`);
      if (manifestEntry.bytes !== dataLength) throw new Error(`SCCE2 brain bundle entry ${name} length disagrees with manifest`);
      if (manifestEntry.sha256.toLocaleLowerCase() !== declaredHex || hashes.sha256 !== declaredHex) {
        throw new Error(`SCCE2 brain bundle entry ${name} SHA-256 mismatch`);
      }
      entries.push({
        ...manifestEntry,
        bundlePath,
        dataStart,
        dataEnd: dataStart + dataLength,
        declaredSha256: declaredHex,
        verifiedSha256: hashes.sha256
      });
    }
    const declaredFooter = await readExactly(file, offset, SHA256_BYTES);
    const computedFooter = footer.digest("hex");
    const footerSha256 = declaredFooter.toString("hex");
    return {
      bundlePath,
      byteLength: info.size,
      manifest,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      footerSha256,
      footerVerified: footerSha256 === computedFooter,
      entries
    };
  } finally {
    await file.close();
  }
}

async function findBrainBundleEntry(bundlePath: string, entryName: string): Promise<Scce2BrainBundleEntry | undefined> {
  const inspected = await inspectScce2BrainBundle(bundlePath);
  return inspected.entries.find(entry => entry.name === entryName);
}

export async function hashScce2SourcePath(value: string): Promise<{ path: string; byteLength: number; sha256: string }> {
  const ref = parseBrainEntryPath(value);
  if (!ref) {
    const info = await stat(value);
    const hash = createHash("sha256");
    await streamRange(value, 0, info.size, chunk => hash.update(chunk));
    return { path: value, byteLength: info.size, sha256: hash.digest("hex") };
  }
  const entry = await findBrainBundleEntry(ref.bundlePath, ref.entryName);
  if (!entry) throw new Error(`missing SCCE2 brain bundle entry ${ref.entryName}`);
  return { path: value, byteLength: entry.bytes, sha256: entry.verifiedSha256 ?? entry.declaredSha256 };
}

export async function withBrainBundleEntryStream<T>(
  value: string,
  fn: (input: { path: string; byteLength: number; stream: NodeJS.ReadableStream }) => Promise<T>
): Promise<T> {
  const ref = parseBrainEntryPath(value);
  if (!ref) {
    const info = await stat(value);
    return fn({ path: value, byteLength: info.size, stream: createReadStream(value) });
  }
  const entry = await findBrainBundleEntry(ref.bundlePath, ref.entryName);
  if (!entry) throw new Error(`missing SCCE2 brain bundle entry ${ref.entryName}`);
  return fn({
    path: value,
    byteLength: entry.bytes,
    stream: createReadStream(ref.bundlePath, { start: entry.dataStart, end: entry.dataEnd - 1 })
  });
}

export async function readBoundedScce2Source(value: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  await withBrainBundleEntryStream(value, async input => {
    if (input.byteLength > maxBytes) throw new Error(`SCCE2 source ${value} requires ${input.byteLength} bytes, over bounded decode work extent ${maxBytes}`);
    for await (const raw of input.stream as AsyncIterable<Buffer | Uint8Array>) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`SCCE2 source ${value} exceeded bounded decode work extent ${maxBytes}`);
      chunks.push(chunk);
    }
  });
  return Buffer.concat(chunks, total);
}

async function readExactly(file: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const result = await file.read(buffer, 0, length, position);
  if (result.bytesRead !== length) throw new Error("SCCE2 brain bundle truncated");
  return buffer;
}

async function hashRange(filePath: string, start: number, length: number, footer?: ReturnType<typeof createHash>): Promise<{ sha256: string }> {
  const hash = createHash("sha256");
  await streamRange(filePath, start, length, chunk => {
    hash.update(chunk);
    footer?.update(chunk);
  });
  return { sha256: hash.digest("hex") };
}

async function streamRange(filePath: string, start: number, length: number, onChunk: (chunk: Buffer) => void): Promise<void> {
  if (length <= 0) return;
  const stream = createReadStream(filePath, { start, end: start + length - 1 });
  try {
    for await (const raw of stream) onChunk(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array));
  } finally {
    stream.destroy();
  }
}

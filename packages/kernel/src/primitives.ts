// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Clock, Hasher, JsonValue, SourceRedactionInterval } from "./types.js";
import { unicodeSymbolSegments } from "./unicode-segmentation.js";
import { createStringMemo } from "./pure-memo.js";

interface NativeSha256Hash {
  update(data: string | Uint8Array, inputEncoding?: "utf8"): NativeSha256Hash;
  digest(encoding: "hex"): string;
}

interface NativeCryptoModule {
  createHash(algorithm: "sha256"): NativeSha256Hash;
}

interface NodeBuiltinLoader {
  getBuiltinModule?(specifier: string): unknown;
}

/**
 * Keep the browser bundle free of a static `node:crypto` dependency while
 * retaining Node's native streaming implementation on the ingestion hot path.
 * Node is pinned by the workspace; browsers have no `process` global and use
 * the byte-identical noble implementation below.
 */
function resolveNativeCrypto(): NativeCryptoModule | undefined {
  const hostProcess = Reflect.get(globalThis, "process") as NodeBuiltinLoader | undefined;
  const candidate = hostProcess?.getBuiltinModule?.("node:crypto") as Partial<NativeCryptoModule> | undefined;
  return typeof candidate?.createHash === "function" ? candidate as NativeCryptoModule : undefined;
}

function cachedNativeCrypto(): NativeCryptoModule | undefined {
  const state = cachedNativeCrypto as typeof cachedNativeCrypto & {
    resolved?: boolean;
    value?: NativeCryptoModule;
  };
  if (!state.resolved) {
    state.value = resolveNativeCrypto();
    state.resolved = true;
  }
  return state.value;
}

export function createCanonicalJson() {
  return { stringify: canonicalStringify };
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalJsonValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): JsonValue => {
    if (input === undefined || input === null) return null;
    if (typeof input === "string") return input.replace(/\u0000/g, " ");
    if (typeof input === "number") return Number.isFinite(input) ? (Object.is(input, -0) ? 0 : input) : null;
    if (typeof input === "boolean") return input;
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Uint8Array) return Array.from(input);
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(item => normalize(item));
    if (typeof input === "object") {
      if (seen.has(input)) throw new Error("canonical JSON cannot encode cycles");
      seen.add(input);
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) out[key] = normalize((input as Record<string, unknown>)[key]);
      seen.delete(input);
      return out;
    }
    return String(input);
  };
  return normalize(value);
}

// normalize already yields a fresh, JSON-safe, key-sorted tree; stringifying and reparsing it walked the turn's graphs twice more.
export function toJsonValue(value: unknown): JsonValue {
  return canonicalJsonValue(value);
}

export function createHasher(): Hasher {
  const nativeCrypto = cachedNativeCrypto();
  if (nativeCrypto) return {
    digestHex(input) {
      const hash = nativeCrypto.createHash("sha256");
      if (typeof input === "string") hash.update(input, "utf8");
      else hash.update(input);
      return hash.digest("hex");
    },
    digestChunks(chunks) {
      const hash = nativeCrypto.createHash("sha256");
      for (const chunk of chunks) hash.update(chunk);
      return hash.digest("hex");
    }
  };
  return {
    digestHex(input) {
      return bytesToHex(sha256(typeof input === "string" ? utf8Bytes(input) : input));
    },
    digestChunks(chunks) {
      const hash = sha256.create();
      for (const chunk of chunks) hash.update(chunk);
      return bytesToHex(hash.digest());
    }
  };
}

export function createClock(options: { fixedTime?: number; stepMs?: number } = {}): Clock {
  let t = options.fixedTime ?? Date.now();
  return {
    now() {
      if (options.fixedTime === undefined) return Date.now();
      const current = t;
      t += options.stepMs ?? 1;
      return current;
    }
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: readonly number[]): number {
  if (values.length <= 1) return 0;
  const m = mean(values);
  return mean(values.map(value => (value - m) ** 2));
}

export function entropy(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return 0;
  let h = 0;
  for (const value of values) {
    const p = Math.max(0, value) / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
}

export function weightedJaccard(left: readonly string[], right: readonly string[]): number {
  return weightedJaccardFromSets(new Set(left), new Set(right));
}

export function weightedJaccardFromSets(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection++;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function symbolizeData(text: string): string[] {
  return unicodeSymbolSegments(text)
    .map(segment => segment.normalized)
    .filter(Boolean)
    .slice(0, 200000);
}

/**
 * 6.8% of one profiled turn (2026-08-18) was spent re-deriving feature sets
 * for text already seen. Callers receive a fresh array every time: the
 * cached value is never handed out directly, because ~190 call sites is far
 * too many to audit for incidental mutation of a returned array.
 */
const featureSetMemo = createStringMemo(cacheKey => {
  const separator = cacheKey.indexOf(":");
  return computeFeatureSet(cacheKey.slice(separator + 1), Number(cacheKey.slice(0, separator)));
}, { maxEntries: 2048, maxKeyChars: 262_144, maxTotalChars: 8_000_000 });

export function featureSet(text: string, limit = 2000): string[] {
  return featureSetMemo(`${limit}:${text}`).slice();
}

/** Exposed for tests and diagnostics. */
export const featureSetMemoStats = (): ReturnType<typeof featureSetMemo.stats> => featureSetMemo.stats();

function computeFeatureSet(text: string, limit: number): string[] {
  const safe = text.replace(/\u0000/g, " ").normalize("NFC");
  const symbols = symbolizeData(safe);
  const features = new Set<string>();
  for (const symbol of symbols) features.add(`sym:${symbol}`);
  for (let i = 0; i < symbols.length - 1; i++) features.add(`bi:${symbols[i]}|${symbols[i + 1]}`);
  for (let i = 0; i < symbols.length - 2; i++) features.add(`tri:${symbols[i]}|${symbols[i + 1]}|${symbols[i + 2]}`);
  for (const char of safe.toLowerCase()) if (!/\s/u.test(char)) features.add(`char:${char}`);
  return [...features].sort().slice(0, limit);
}

/**
 * The units an anchor feature is built from: letter/number runs of the symbolised surface. Exported because
 * admission must split a request subject exactly the way the index split the source -- "Moby-Dick" indexes as
 * anchor:bi:moby|dick, and an admission test that kept the hyphen matched none of its 192 retrieved spans.
 */
export function anchorSymbolUnits(text: string): string[] {
  return symbolizeData(text.replace(/\u0000/g, " ").normalize("NFC"))
    .flatMap(symbol => symbol.match(/[\p{Letter}\p{Number}\p{Mark}]+/gu) ?? []);
}

export function anchorFeatureSet(text: string, limit = 256): string[] {
  const symbols = anchorSymbolUnits(text);
  const features = new Set<string>();
  for (const symbol of symbols) {
    features.add(`anchor:sym:${symbol}`);
    if (features.size >= limit) return [...features];
  }
  for (let index = 0; index < symbols.length - 1; index++) {
    features.add(`anchor:bi:${symbols[index]}|${symbols[index + 1]}`);
    if (features.size >= limit) return [...features];
  }
  return [...features];
}

/** Punctuation that bears code rather than prose; the same shape `textShapeIsSourceCode` reads, stated once per line. */
const CODE_BEARING_LINE = /[;{}]$|=>|::|->|\(\)|\{\}|\[\]/u;

/**
 * The lines of a source whose punctuation bears code, which is where a file DECLARES rather than mentions.
 *
 * A file's text contains its comments, so "contains the identifier" admitted a comment that merely names a subject
 * -- a comment in `mouth.ts` naming Einstein as an example was bound as a DECLARATION of him. Punctuation shape is
 * the distinction and it is the one this codebase already reads for source-code shape; it carries no casing, no
 * length, no word list and no script.
 */
export function codeBearingLines(text: string): string[] {
  return text.split(/\r?\n/u).map(line => line.trim()).filter(line => Boolean(line) && CODE_BEARING_LINE.test(line));
}

export function sourceTextSurface(text: string, maxChars = 1200): string {
  let out = text.replace(/\u0000/g, " ").normalize("NFC");
  out = mainSourceFragment(out);
  out = out.replace(/<script\b[\s\S]*?<\/script>/giu, " ");
  out = out.replace(/<style\b[\s\S]*?<\/style>/giu, " ");
  out = out.replace(/<!--[\s\S]*?-->/gu, " ");
  out = out.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/giu, " ");
  out = out.replace(/<table\b[^>]*(?:class|id)=["'][^"']*(?:infobox|navbox|sidebar|metadata|ambox|toc|vertical-navbox)[^"']*["'][\s\S]*?<\/table>/giu, " ");
  out = out.replace(/<div\b[^>]*(?:class|id)=["'][^"']*(?:toc|vector-|mw-navigation|mw-sidebar|navbox|sidebar|metadata|ambox|catlinks|printfooter|hatnote|shortdescription|searchaux|noprint)[^"']*["'][\s\S]*?<\/div>/giu, " ");
  out = out.replace(/<br\s*\/?>/giu, "\n");
  out = out.replace(/<\/(?:p|div|section|article|header|footer|h[1-6]|li|tr|td|th|table|ul|ol)>/giu, "\n");
  // An attribute value may itself contain ">" -- Parsoid's data-mw JSON does -- and a stripper that stops at the
  // first ">" then leaks the rest of the tag as text: "Who was Ada Lovelace?" answered with '{"wt":"10 December
  // 2014"} ...'. Quoted attribute values are skipped as units.
  out = out.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/gu, " ");
  out = decodeHtmlEntities(out);
  out = out.replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/gu, " ");
  out = out.replace(/\s+/gu, " ").trim();
  if (maxChars > 0 && [...out].length > maxChars) {
    const clipped = [...out].slice(0, Math.max(0, maxChars - 3)).join("").replace(/\s+\S*$/u, "").trimEnd();
    return `${clipped}...`;
  }
  return out;
}

function mainSourceFragment(html: string): string {
  if (!/<[a-z][\s\S]*>/iu.test(html)) return html;
  const startPatterns = [
    /<main\b[^>]*>/iu,
    /<article\b[^>]*>/iu,
    /<div\b[^>]*(?:id|class)=["'][^"']*(?:mw-content-text|mw-parser-output|article-body|articleBody|entry-content|post-content)[^"']*["'][^>]*>/iu
  ];
  const starts = startPatterns
    .map(pattern => {
      const match = pattern.exec(html);
      return match ? { index: match.index, length: match[0].length } : undefined;
    })
    .filter((item): item is { index: number; length: number } => Boolean(item))
    .sort((left, right) => left.index - right.index);
  const start = starts[0];
  if (!start) return html;
  let fragment = html.slice(start.index + start.length);
  const endPattern = /<h2\b[^>]*>\s*(?:<[^>]+>\s*)*(?:See also|References|Notes|Further reading|External links)\b|<div\b[^>]*(?:id|class)=["'][^"']*(?:catlinks|printfooter|mw-footer|footer)[^"']*["']|<\/(?:main|article)>/iu;
  const end = endPattern.exec(fragment)?.index;
  if (end !== undefined && end > 200) fragment = fragment.slice(0, end);
  return fragment;
}

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return validCodePoint(code) ? String.fromCodePoint(code) : entity;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return validCodePoint(code) ? String.fromCodePoint(code) : entity;
    }
    return named[lower] ?? entity;
  });
}

function validCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

export function stableVector(features: readonly string[], hasher: Hasher, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const feature of features) {
    const hash = hasher.digestHex(feature);
    const bucket = Number.parseInt(hash.slice(0, 8), 16) % dimensions;
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map(value => value / norm);
}

export function randomHex(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65_536) {
    throw new Error("random byte count must be an integer between zero and 65536");
  }
  const output = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(output);
  return bytesToHex(output);
}

const SECRET_REDACTION_PATTERNS = [
    /AKIA[0-9A-Z]{16}/g,
    /ASIA[0-9A-Z]{16}/g,
    /gh[pso]_[A-Za-z0-9_]{30,}/g,
    /github_pat_[A-Za-z0-9_]{22,}/g,
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    /(password|secret[_-]?key|symbol|api[_-]?key)\s*[:=]\s*\S+/gi,
    /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^@\s]+@[^\s]+/gi
];

export function redactSecretsWithMap(text: string): {
  text: string;
  redactionMap: SourceRedactionInterval[];
} {
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of text.matchAll(/\u0000/g)) {
    const start = match.index;
    replacements.push({ start, end: start + match[0].length, replacement: " " });
  }
  for (const sourcePattern of SECRET_REDACTION_PATTERNS) {
    const pattern = new RegExp(sourcePattern.source, sourcePattern.flags);
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      replacements.push({ start, end: start + match[0].length, replacement: "[REDACTED]" });
    }
  }
  const merged = replacements
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<Array<{ start: number; end: number; replacement: string }>>((out, current) => {
      const previous = out[out.length - 1];
      if (!previous || current.start >= previous.end) {
        out.push({ ...current });
        return out;
      }
      previous.end = Math.max(previous.end, current.end);
      if (current.replacement === "[REDACTED]") previous.replacement = current.replacement;
      return out;
    }, []);
  if (!merged.length) return { text, redactionMap: [] };
  let derivative = "";
  let originalCursor = 0;
  let derivativeCharOffset = 0;
  let derivativeByteOffset = 0;
  const redactionMap: SourceRedactionInterval[] = [];
  for (const replacement of merged) {
    const unchanged = text.slice(originalCursor, replacement.start);
    derivative += unchanged;
    derivativeCharOffset += codePointLength(unchanged);
    derivativeByteOffset += utf8ByteLength(unchanged);
    const derivativeCharStart = derivativeCharOffset;
    const derivativeByteStart = derivativeByteOffset;
    derivative += replacement.replacement;
    derivativeCharOffset += codePointLength(replacement.replacement);
    derivativeByteOffset += utf8ByteLength(replacement.replacement);
    redactionMap.push({
      originalCharStart: codePointLength(text.slice(0, replacement.start)),
      originalCharEnd: codePointLength(text.slice(0, replacement.end)),
      originalByteStart: utf8ByteLength(text.slice(0, replacement.start)),
      originalByteEnd: utf8ByteLength(text.slice(0, replacement.end)),
      derivativeCharStart,
      derivativeCharEnd: derivativeCharOffset,
      derivativeByteStart,
      derivativeByteEnd: derivativeByteOffset,
      replacement: replacement.replacement
    });
    originalCursor = replacement.end;
  }
  derivative += text.slice(originalCursor);
  return { text: derivative, redactionMap };
}

export function redactSecrets(text: string): string {
  return redactSecretsWithMap(text).text;
}

function codePointLength(text: string): number {
  return [...text].length;
}

function utf8Bytes(text: string): Uint8Array {
  return utf8ToBytes(text);
}

function utf8ByteLength(text: string): number {
  return utf8Bytes(text).byteLength;
}

export function normalizeVector(values: number[], prior?: number): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => prior ?? (values.length ? 1 / values.length : 0));
  return values.map(value => Math.max(0, value) / total);
}

import { createHash, randomBytes } from "node:crypto";
import type { Clock, Hasher, JsonValue } from "./types.js";

export function createCanonicalJson() {
  return { stringify: canonicalStringify };
}

export function canonicalStringify(value: unknown): string {
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
  return JSON.stringify(normalize(value));
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalStringify(value)) as JsonValue;
}

export function createHasher(): Hasher {
  return {
    digestHex(input) {
      return createHash("sha256").update(typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input)).digest("hex");
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
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function symbolizeData(text: string): string[] {
  const normalized = text.replace(/\u0000/g, " ").normalize("NFC").toLowerCase();
  return (normalized.match(/[\p{Letter}\p{Number}_]+|[^\s]/gu) ?? []).filter(Boolean).slice(0, 200000);
}

export function featureSet(text: string, limit = 2000): string[] {
  const safe = text.replace(/\u0000/g, " ").normalize("NFC");
  const symbols = symbolizeData(safe);
  const features = new Set<string>();
  for (const symbol of symbols) features.add(`sym:${symbol}`);
  for (let i = 0; i < symbols.length - 1; i++) features.add(`bi:${symbols[i]}|${symbols[i + 1]}`);
  for (let i = 0; i < symbols.length - 2; i++) features.add(`tri:${symbols[i]}|${symbols[i + 1]}|${symbols[i + 2]}`);
  for (const char of safe.toLowerCase()) if (!/\s/u.test(char)) features.add(`char:${char}`);
  return [...features].sort().slice(0, limit);
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
  out = out.replace(/<[^>]+>/gu, " ");
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
  return randomBytes(bytes).toString("hex");
}

export function redactSecrets(text: string): string {
  const patterns = [
    /AKIA[0-9A-Z]{16}/g,
    /ASIA[0-9A-Z]{16}/g,
    /gh[pso]_[A-Za-z0-9_]{30,}/g,
    /github_pat_[A-Za-z0-9_]{22,}/g,
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    /(password|secret[_-]?key|symbol|api[_-]?key)\s*[:=]\s*\S+/gi,
    /(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^@\s]+@[^\s]+/gi
  ];
  let out = text.replace(/\u0000/g, " ");
  for (const pattern of patterns) out = out.replace(pattern, "[REDACTED]");
  return out;
}

export function normalizeVector(values: number[], prior?: number): number[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return values.map(() => prior ?? (values.length ? 1 / values.length : 0));
  return values.map(value => Math.max(0, value) / total);
}

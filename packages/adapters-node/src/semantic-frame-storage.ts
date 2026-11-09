// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";

export const SEMANTIC_FRAME_STORAGE_SCHEMA = "scce.semantic_frame_table.storage.v1";
export const SEMANTIC_MEMORY_SCHEMA = "scce.induced_language_model.semantic_memory.v1";
type Row = Record<string, unknown>;
interface StoredFrames {
  schema: typeof SEMANTIC_FRAME_STORAGE_SCHEMA;
  sentences: string[];
  evidence: string[];
  frames: Row[];
  digest: string;
}
const ROLE_FIELDS = ["name", "filler", "count", "salience"] as const;
const ALTERNATIVE_FIELDS = ["surface", "posterior", "energy"] as const;
const fail = (): never => { throw Error("invalid semantic frame storage"); };
const record = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/** Source sentences and evidence identities occur once, independently of the frames they support. */
export function encodeSemanticFrames(value: readonly unknown[]): StoredFrames | undefined {
  const sentences: string[] = [], evidence: string[] = [];
  const sentenceIds = new Map<string, number>(), evidenceIds = new Map<string, number>();
  const intern = (text: string, dictionary: string[], ids: Map<string, number>): number => {
    let id = ids.get(text);
    if (id === undefined) { id = dictionary.length; dictionary.push(text); ids.set(text, id); }
    return id;
  };
  const frames: Row[] = [];
  for (const raw of value) {
    const frame = record(raw);
    if (!frame || !strings(frame.examples) || !strings(frame.evidenceIds)
      || !Array.isArray(frame.roles) || !Array.isArray(frame.predicateAlternatives)) return undefined;
    const roles = packRows(frame.roles, ROLE_FIELDS), alternatives = packRows(frame.predicateAlternatives, ALTERNATIVE_FIELDS);
    if (!roles || !alternatives) return undefined;
    const examples = frame.examples, owners = frame.evidenceIds;
    frames.push(Object.fromEntries(Object.entries(frame).map(([key, member]) => [key,
      key === "examples" ? examples.map(text => intern(text, sentences, sentenceIds))
        : key === "evidenceIds" ? owners.map(text => intern(text, evidence, evidenceIds))
          : key === "roles" ? roles : key === "predicateAlternatives" ? alternatives : member])));
  }
  return { schema: SEMANTIC_FRAME_STORAGE_SCHEMA, sentences, evidence, frames, digest: digest(value) };
}

export function decodeSemanticFrames(value: unknown): Row[] {
  const stored = record(value);
  if (!stored || stored.schema !== SEMANTIC_FRAME_STORAGE_SCHEMA || !strings(stored.sentences) || !strings(stored.evidence)
    || new Set(stored.sentences).size !== stored.sentences.length || new Set(stored.evidence).size !== stored.evidence.length
    || !Array.isArray(stored.frames) || typeof stored.digest !== "string"
    || Object.keys(stored).some(key => !["schema", "sentences", "evidence", "frames", "digest"].includes(key))) return fail();
  const sentences = stored.sentences, evidence = stored.evidence;
  const resolve = (refs: unknown, dictionary: string[]): string[] => {
    if (!Array.isArray(refs)) return fail();
    return refs.map(ref => Number.isSafeInteger(ref) && ref >= 0 && ref < dictionary.length ? dictionary[ref]! : fail());
  };
  const frames = stored.frames.map(raw => {
    const frame = record(raw);
    if (!frame || !Object.hasOwn(frame, "examples") || !Object.hasOwn(frame, "evidenceIds")
      || !Object.hasOwn(frame, "roles") || !Object.hasOwn(frame, "predicateAlternatives")) return fail();
    return Object.fromEntries(Object.entries(frame).map(([key, member]) => [key,
      key === "examples" ? resolve(member, sentences) : key === "evidenceIds" ? resolve(member, evidence)
        : key === "roles" ? unpackRows(member, ROLE_FIELDS) : key === "predicateAlternatives" ? unpackRows(member, ALTERNATIVE_FIELDS) : member]));
  });
  if (digest(frames) !== stored.digest) return fail();
  return frames;
}

function packRows(rows: readonly unknown[], fields: readonly string[]): unknown[][] | undefined {
  const result: unknown[][] = [];
  for (const value of rows) {
    const row = record(value);
    if (!row || !fields.every(key => Object.hasOwn(row, key))) return undefined;
    const tuple = fields.map(key => row[key]);
    const extension = Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
    if (Object.keys(extension).length) tuple.push(extension);
    result.push(tuple);
  }
  return result;
}

function unpackRows(value: unknown, fields: readonly string[]): Row[] {
  if (!Array.isArray(value)) return fail();
  return value.map(tuple => {
    if (!Array.isArray(tuple) || tuple.length < fields.length || tuple.length > fields.length + 1) return fail();
    const extension = tuple.length > fields.length ? record(tuple[fields.length]) : {};
    if (!extension || Object.keys(extension).some(key => fields.includes(key))) return fail();
    return Object.fromEntries([...fields.map((key, index) => [key, tuple[index]]), ...Object.entries(extension)]);
  });
}

/** Sort object keys without normalizing source strings, including NUL and combining marks. */
function digest(value: unknown): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : record(value) ? Object.fromEntries(Object.entries(value as Row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, member]) => [key, sorted(member)])) : value;
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
}

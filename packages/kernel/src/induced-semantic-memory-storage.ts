// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { createHasher } from "./primitives.js";
import { requestSeedLanguagePattern } from "./request-language-hydration.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { JsonValue } from "./types.js";

export const INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA = "scce.induced_semantic_facts.storage.v1" as const;
export const INDUCED_SEMANTIC_FACTS_STORAGE_KEY = "_scceSemanticFacts";
const MEMORY_SCHEMA = "scce.induced_language_model.semantic_memory.v1";
const COMPONENTS = ["semanticFrames", "graphBoundConstructions", "lexicalClasses", "relationHypothesisModel"] as const;
const FRAME = ["id", "predicate", "roles", "support", "alphaPrior", "predicateConfidence", "predicatePosteriorMass", "predicateAlternatives", "examples", "evidenceIds"];
const ROLE = ["name", "filler", "count", "salience"];
const ALTERNATIVE = ["surface", "posterior", "energy"];
const SLOT = ["roleId", "semanticRole", "relation", "relationDirection", "observedFillers"];
const WINDOW = ["ownerDocumentId", "startUtf16", "endUtf16"];
const STATISTICS = ["surface", "occurrenceCount", "sourceCount", "leftContextCount", "rightContextCount", "contextPairCount", "leftShapeCount", "rightShapeCount", "leftShapes", "rightShapes", "evidenceIds"];
type Row = Record<string, unknown>;
const fail = (): never => { throw Error("invalid induced semantic facts storage"); };
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : fail();
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail();
const string = (value: unknown): string => typeof value === "string" ? value : fail();
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : fail();
const copy = <T>(value: T): T => structuredClone(value);
const hasher = createHasher(), digest = (value: unknown) => canonicalDigestHex(value, hasher);
const same = (left: unknown, right: unknown): boolean => digest(left) === digest(right);

function internTable<T>() {
  const values: T[] = [], ids = new Map<string, number>();
  return { values, add(value: T): number {
    const key = JSON.stringify(value); let id = ids.get(key);
    if (id === undefined) { id = values.length; values.push(value); ids.set(key, id); }
    return id;
  } };
}
function pack(value: unknown, fields: readonly string[], encode: (key: string, value: unknown) => unknown): unknown[] {
  const source = row(value);
  if (!fields.every(key => Object.hasOwn(source, key))) return fail();
  const result = fields.map(key => encode(key, source[key]));
  const extension = Object.fromEntries(Object.entries(source).filter(([key]) => !fields.includes(key)));
  if (Object.keys(extension).length) result.push(copy(extension));
  return result;
}
function unpack(value: unknown, fields: readonly string[], decode: (key: string, value: unknown) => unknown): Row {
  const tuple = array(value);
  if (tuple.length !== fields.length && tuple.length !== fields.length + 1) return fail();
  const extension = tuple.length > fields.length ? row(tuple[fields.length]) : {};
  if (Object.keys(extension).some(key => fields.includes(key))) return fail();
  return Object.fromEntries([...fields.map((key, index) => [key, decode(key, tuple[index])] as const), ...Object.entries(copy(extension))]);
}
function entityProjection(value: Row): Row {
  const pattern: LanguagePatternRecord = { id: "", profileId: String(value.profileId ?? ""), patternKind: "semantic_role", support: 0,
    entropy: 0, evidenceIds: [], updatedAt: 0, patternJson: { ...value, schema: MEMORY_SCHEMA } as JsonValue };
  const projected = row(requestSeedLanguagePattern(pattern).patternJson);
  return { graphBoundConstructions: projected.graphBoundConstructions, lexicalClasses: projected.lexicalClasses };
}

/** Shared learned role measurements, ownership sets and frame bindings are durable facts, not copies per context. */
export function encodeInducedSemanticMemory(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Row).schema !== MEMORY_SCHEMA) return value;
  const source = row(value);
  if (Object.hasOwn(source, INDUCED_SEMANTIC_FACTS_STORAGE_KEY)) { decodeInducedSemanticMemory(source); return value; }
  if (!COMPONENTS.every(key => Object.hasOwn(source, key))) return value;
  const strings = internTable<string>(), numbers = internTable<number>(), lists = internTable<number[]>();
  const roles = internTable<unknown[]>(), alternatives = internTable<unknown[]>(), slots = internTable<unknown[]>();
  const windows = internTable<unknown[]>(), windowLists = internTable<number[]>();
  const s = (value: unknown) => strings.add(string(value)), n = (value: unknown) => numbers.add(number(value));
  const list = (value: unknown) => lists.add(array(value).map(s));
  const role = (value: unknown) => roles.add(pack(value, ROLE, (key, member) => key === "name" || key === "filler" ? s(member) : n(member)));
  const alternative = (value: unknown) => alternatives.add(pack(value, ALTERNATIVE, (key, member) => key === "surface" ? s(member) : n(member)));
  const rawFrames = array(source.semanticFrames);
  const frames = rawFrames.map(value => pack(value, FRAME, (key, member) => {
    if (key === "id") return string(member);
    if (key === "predicate") return s(member);
    if (key === "roles") return array(member).map(role);
    if (key === "predicateAlternatives") return array(member).map(alternative);
    if (key === "examples" || key === "evidenceIds") return list(member);
    return n(member);
  }));
  const frameIds = new Map<string, number[]>();
  rawFrames.forEach((value, index) => { const id = string(row(value).id); frameIds.set(id, [...(frameIds.get(id) ?? []), index]); });
  const constructions = array(source.graphBoundConstructions).map(value => {
    const original = row(value), candidates = frameIds.get(string(original.frameId));
    if (!["id", "frameId", "predicate", "support", "evidenceIds", "predicateSemanticRole", "slots"].every(key => Object.hasOwn(original, key))) return fail();
    const frameIndex = candidates?.length === 1 ? candidates[0]! : null;
    const frame = frameIndex === null ? undefined : row(rawFrames[frameIndex]);
    const fields = Object.entries(original).flatMap(([key, member]): Array<[string, unknown]> => {
      if (frame && (key === "frameId" || ["predicate", "support", "evidenceIds"].includes(key) && same(member, frame[key]))) return [];
      if (key === "predicate") return [[key, s(member)]];
      if (key === "support") return [[key, n(member)]];
      if (key === "evidenceIds") return [[key, list(member)]];
      if (key === "sourceWindows") return [[key, windowLists.add(array(member).map(window => windows.add(pack(window, WINDOW,
        (field, item) => field === "ownerDocumentId" ? s(item) : number(item)))))]];
      if (key === "slots") return [[key, array(member).map(slot => slots.add(pack(slot, SLOT,
        (field, item) => field === "observedFillers" ? list(item) : s(item))))]];
      return [[key, copy(member)]];
    });
    return [frameIndex, Object.fromEntries(fields)];
  });
  const relation = row(source.relationHypothesisModel);
  const statistics = Object.entries(row(relation.statistics)).map(([key, value]) => [s(key), pack(value, STATISTICS, (field, member) =>
    field === "surface" ? s(member) : ["leftShapes", "rightShapes", "evidenceIds"].includes(field) ? list(member) : number(member))]);
  const marker = { schema: INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA, strings: strings.values, numbers: numbers.values, lists: lists.values,
    roles: roles.values, alternatives: alternatives.values, slots: slots.values, windows: windows.values, windowLists: windowLists.values, frames, constructions,
    relation: { header: copy(Object.fromEntries(Object.entries(relation).filter(([key]) => key !== "statistics"))), statistics },
    lexicalClasses: copy(source.lexicalClasses), digest: digest(Object.fromEntries(COMPONENTS.map(key => [key, source[key]]))) };
  const result = copy(Object.fromEntries(Object.entries(source).filter(([key]) => !COMPONENTS.includes(key as typeof COMPONENTS[number]))));
  return { ...result, ...entityProjection(source), [INDUCED_SEMANTIC_FACTS_STORAGE_KEY]: marker };
}

export function decodeInducedSemanticMemory<T = unknown>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, INDUCED_SEMANTIC_FACTS_STORAGE_KEY)) return value as T;
  const source = row(value), marker = row(source[INDUCED_SEMANTIC_FACTS_STORAGE_KEY]);
  const keys = ["schema", "strings", "numbers", "lists", "roles", "alternatives", "slots", "windows", "windowLists", "frames", "constructions", "relation", "lexicalClasses", "digest"];
  if (source.schema !== MEMORY_SCHEMA || marker.schema !== INDUCED_SEMANTIC_FACTS_STORAGE_SCHEMA
    || Object.keys(marker).length !== keys.length || Object.keys(marker).some(key => !keys.includes(key)) || typeof marker.digest !== "string"
    || Object.hasOwn(source, "semanticFrames") || Object.hasOwn(source, "relationHypothesisModel")) return fail();
  const table = (key: string): unknown[] => {
    const values = array(marker[key]);
    if (new Set(values.map(value => JSON.stringify(value))).size !== values.length) return fail();
    return values;
  };
  const strings = table("strings").map(string), numbers = table("numbers").map(number), lists = table("lists");
  const roles = table("roles"), alternatives = table("alternatives"), slots = table("slots"), windows = table("windows"), windowLists = table("windowLists");
  const ref = (table: unknown[], value: unknown): unknown => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < table.length ? table[value] : fail();
  const s = (value: unknown) => string(ref(strings, value)), n = (value: unknown) => number(ref(numbers, value));
  const list = (value: unknown) => array(ref(lists, value)).map(s);
  const frameValues = array(marker.frames).map(value => unpack(value, FRAME, (key, member) => {
    if (key === "id") return string(member);
    if (key === "predicate") return s(member);
    if (key === "roles") return array(member).map(id => unpack(ref(roles, id), ROLE, (field, item) => field === "name" || field === "filler" ? s(item) : n(item)));
    if (key === "predicateAlternatives") return array(member).map(id => unpack(ref(alternatives, id), ALTERNATIVE, (field, item) => field === "surface" ? s(item) : n(item)));
    if (key === "examples" || key === "evidenceIds") return list(member);
    return n(member);
  }));
  const constructions = array(marker.constructions).map(value => {
    const tuple = array(value); if (tuple.length !== 2) return fail();
    const frame = tuple[0] === null ? undefined : row(ref(frameValues, tuple[0]));
    const inherited = frame ? { frameId: frame.id, predicate: frame.predicate, support: frame.support, evidenceIds: copy(frame.evidenceIds) } : {};
    const fields = Object.entries(row(tuple[1])).map(([key, member]): [string, unknown] => {
      if (key === "predicate") return [key, s(member)];
      if (key === "support") return [key, n(member)];
      if (key === "evidenceIds") return [key, list(member)];
      if (key === "sourceWindows") return [key, array(ref(windowLists, member)).map(id => unpack(ref(windows, id), WINDOW,
        (field, item) => field === "ownerDocumentId" ? s(item) : number(item)))];
      if (key === "slots") return [key, array(member).map(id => unpack(ref(slots, id), SLOT, (field, item) => field === "observedFillers" ? list(item) : s(item)))];
      return [key, copy(member)];
    });
    return Object.fromEntries([...Object.entries(inherited), ...fields]);
  });
  const relation = row(marker.relation);
  if (Object.keys(relation).length !== 2 || !Object.hasOwn(relation, "header") || !Object.hasOwn(relation, "statistics")) return fail();
  const statistics = array(relation.statistics).map(value => {
    const tuple = array(value); if (tuple.length !== 2) return fail();
    return [s(tuple[0]), unpack(tuple[1], STATISTICS, (field, member) => field === "surface" ? s(member)
      : ["leftShapes", "rightShapes", "evidenceIds"].includes(field) ? list(member) : number(member))] as const;
  });
  if (new Set(statistics.map(([key]) => key)).size !== statistics.length || Object.hasOwn(row(relation.header), "statistics")) return fail();
  const components = { semanticFrames: frameValues, graphBoundConstructions: constructions, lexicalClasses: copy(marker.lexicalClasses),
    relationHypothesisModel: { ...copy(row(relation.header)), statistics: Object.fromEntries(statistics) } };
  if (digest(components) !== marker.digest || !same(entityProjection(components), {
    graphBoundConstructions: source.graphBoundConstructions, lexicalClasses: source.lexicalClasses })) return fail();
  const result = copy(Object.fromEntries(Object.entries(source).filter(([key]) => key !== INDUCED_SEMANTIC_FACTS_STORAGE_KEY
    && key !== "graphBoundConstructions" && key !== "lexicalClasses")));
  return { ...result, ...components } as T;
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSourceExampleStorageJson as exactJson, decodeConstructionSourceExamples, encodeConstructionSourceExamples } from "./construction-source-example-storage.js";
import type { EvidenceSpan, Hasher, JsonValue } from "./types.js";

export const CONSTRUCTION_SOURCE_DECISION_KIND = "construction_source_decisions" as const;
export const CONSTRUCTION_SOURCE_DECISION_SCHEMA = "scce.construction_source_decisions.v1" as const;
export const CONSTRUCTION_SOURCE_DECISION_REFERENCE_SCHEMA = "scce.construction_source_decision_ref.v1" as const;
export const CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES = 256 * 1024;
const PATTERN_SCHEMA = "scce.language_construction_pattern.v1";
const EXAMPLE_ENCODING = "scce.language_construction.source_examples.v1";
const ID_PREFIX = "construction.source_decisions.";
type Row = Record<string, JsonValue>;
type Proof = { id: string; sourceId: string; sourceVersionId: string; contentHash: string; charStart: number; charEnd: number; byteStart: number; byteEnd: number };
type Observation = [number, number, number[], number, ...Array<[number, number]>];
type Binding = [string, string, number, number, number[], boolean];
interface DecisionPayload {
  schema: typeof CONSTRUCTION_SOURCE_DECISION_SCHEMA;
  evidence: Proof[];
  sourceRanges: number[][][];
  owners: Row[];
  identities: Row[];
  roleLayouts: Row[][];
  exampleLayouts: Row[];
  observations: Observation[];
  bindings: Binding[];
}
export interface ConstructionSourceDecisionPage {
  id: string;
  ownerKey: string;
  namespace: string;
  kind: typeof CONSTRUCTION_SOURCE_DECISION_KIND;
  payload: DecisionPayload;
  digest: string;
}
interface Prepared { root: Row; header: Row; examples: Row[]; compact: boolean; identity: Row; key: string; indexes: number[] }
const fail = (): never => { throw Error("invalid source-owned construction decisions"); };
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : fail();
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const index = (value: unknown): value is number => integer(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(member => typeof member === "string");
const copy = <T>(value: T): T => { try { return JSON.parse(exactJson(value)) as T; } catch { return fail(); } };
const bytes = (value: unknown): number => new TextEncoder().encode(exactJson(value)).byteLength;
const own = (value: Row, fields: readonly string[]): Row => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]!])) as Row;
const omit = (value: Row, fields: readonly string[]): Row => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const IDENTITY_FIELDS = ["schema", "storageEncoding", "sourceCompilationId", "profileId", "sourceVersionId", "sourceId", "sourceSystem",
  "requestConstructionCandidate", "sourceConstructionCandidate", "conversationalBindingId"] as const;

function prepare(value: unknown, hasher: Hasher, ordinal: number): Prepared | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = row(value), bundleValue = root.bundle;
  if (bundleValue && typeof bundleValue === "object" && !Array.isArray(bundleValue)
    && String(bundleValue.schema).startsWith("scce.construction_source_decision_ref.")) return fail();
  if (root.schema !== PATTERN_SCHEMA || root.storageEncoding !== EXAMPLE_ENCODING || !bundleValue || typeof bundleValue !== "object" || Array.isArray(bundleValue)) return undefined;
  const bundle = row(bundleValue);
  if (typeof bundle.bindingId !== "string" || !bundle.bindingId.startsWith("language.source_relation.")) return undefined;
  if (bundle.schema !== PATTERN_SCHEMA || typeof root.contentDigest !== "string" || bundle.contentDigest !== root.contentDigest
    || bundle.id !== `surface.construction.bundle.${root.contentDigest}` || !strings(bundle.evidenceIds) || !bundle.evidenceIds.length
    || !strings(bundle.evidenceContentHashes) || !strings(bundle.sourceVersionIds)
    || typeof bundle.sourceProfileId !== "string" || bundle.targetProfileId !== bundle.sourceProfileId) return fail();
  const examples = decodeConstructionSourceExamples(bundle.sourceExamples, bundle, hasher);
  if (!examples.length || examples.length > 256) return fail();
  const compact = !Array.isArray(bundle.sourceExamples);
  if (compact && exactJson(encodeConstructionSourceExamples(examples, bundle, hasher)) !== exactJson(bundle.sourceExamples)) return fail();
  const header = omit(bundle, ["sourceExamples"]), identity = own(root, IDENTITY_FIELDS);
  return { root, header, examples, compact, identity, key: exactJson([root.contentDigest, bundle.bindingId, header, examples, identity]), indexes: [ordinal] };
}

function proofOf(evidence: EvidenceSpan): Proof {
  return { id: String(evidence.id), sourceId: String(evidence.sourceId), sourceVersionId: String(evidence.sourceVersionId), contentHash: String(evidence.contentHash),
    charStart: evidence.charStart, charEnd: evidence.charEnd, byteStart: evidence.byteStart, byteEnd: evidence.byteEnd };
}
function dictionary<T>(values: T[]) {
  const ordinals = new Map<string, number>();
  return (value: T): number => {
    const key = exactJson(value), found = ordinals.get(key);
    if (found !== undefined) return found;
    const ordinal = values.length; values.push(copy(value)); ordinals.set(key, ordinal); return ordinal;
  };
}
function absoluteRoles(example: Row): { headers: Row[]; ranges: Array<[number, number]>; start: number; end: number } {
  if (!index(example.evidenceIndex) || !index(example.surfaceStartCodePoint) || !index(example.surfaceEndCodePoint)
    || example.surfaceEndCodePoint <= example.surfaceStartCodePoint || !Array.isArray(example.roles) || !example.roles.length) return fail();
  const start = example.surfaceStartCodePoint, end = example.surfaceEndCodePoint;
  const ranges: Array<[number, number]> = [], headers: Row[] = [];
  for (const member of example.roles) {
    const role = row(member);
    if (!index(role.slotIndex) || Object.hasOwn(role, "occurrenceIndex") && !index(role.occurrenceIndex)
      || !index(role.startCodePoint) || !index(role.endCodePoint) || role.endCodePoint <= role.startCodePoint
      || role.endCodePoint > end - start) return fail();
    ranges.push([start + role.startCodePoint, start + role.endCodePoint]);
    headers.push(omit(role, ["startCodePoint", "endCodePoint"]));
  }
  return { headers, ranges, start, end };
}

function buildPage(inputs: readonly Prepared[], proofsById: ReadonlyMap<string, Proof>, ownerKey: string, namespace: string, hasher: Hasher): ConstructionSourceDecisionPage {
  const ids = [...new Set(inputs.flatMap(input => input.header.evidenceIds as string[]))].sort();
  const evidence = ids.map(id => proofsById.get(id) ?? fail()), evidenceIndex = new Map(ids.map((id, ordinal) => [id, ordinal]));
  const rangeSets = evidence.map(() => new Map<string, [number, number]>());
  for (const input of inputs) {
    const declaredIds = input.header.evidenceIds as string[], declaredHashes = input.header.evidenceContentHashes as string[], declaredVersions = input.header.sourceVersionIds as string[];
    if (new Set(declaredIds).size !== declaredIds.length) return fail();
    const ownProofs = declaredIds.map(id => proofsById.get(id) ?? fail());
    if (exactJson([...new Set(ownProofs.map(proof => proof.contentHash))].sort()) !== exactJson(declaredHashes)
      || exactJson([...new Set(ownProofs.map(proof => proof.sourceVersionId))].sort()) !== exactJson(declaredVersions)) return fail();
    for (const example of input.examples) {
      const roles = absoluteRoles(example), id = declaredIds[example.evidenceIndex as number];
      if (id === undefined) return fail();
      const ei = evidenceIndex.get(id)!;
      if (roles.end > evidence[ei]!.charEnd - evidence[ei]!.charStart) return fail();
      for (const range of roles.ranges) rangeSets[ei]!.set(exactJson(range), range);
    }
  }
  const ranges = rangeSets.map(set => [...set.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  const rangeIndexes = ranges.map(list => new Map(list.map((range, ordinal) => [exactJson(range), ordinal])));
  const sourceRanges = ranges.map(list => {
    let previousEnd = 0;
    return list.map(([start, end]) => { const result = [start - previousEnd, end - start]; previousEnd = end; return result; });
  });
  const owners: Row[] = [], identities: Row[] = [], roleLayouts: Row[][] = [], exampleLayouts: Row[] = [], observations: Observation[] = [];
  const owner = dictionary(owners), identity = dictionary(identities), roles = dictionary(roleLayouts), extras = dictionary(exampleLayouts), observation = dictionary(observations);
  const bindings: Binding[] = inputs.map(input => {
    const header = input.header, declaredIds = header.evidenceIds as string[];
    const refs = input.examples.map(example => {
      const measured = absoluteRoles(example), ei = evidenceIndex.get(declaredIds[example.evidenceIndex as number]!)!;
      const extentStart = Math.min(...measured.ranges.map(range => range[0])), extentEnd = Math.max(...measured.ranges.map(range => range[1]));
      const record: Observation = [ei, roles(measured.headers), measured.ranges.map(range => rangeIndexes[ei]!.get(exactJson(range))!),
        extras(omit(example, ["evidenceIndex", "surfaceStartCodePoint", "surfaceEndCodePoint", "roles"]))];
      if (measured.start !== extentStart || measured.end !== extentEnd) record.push([measured.start, measured.end]);
      return observation(record);
    });
    return [header.contentDigest as string, header.bindingId as string, owner(omit(header, ["id", "contentDigest", "bindingId"])), identity(input.identity), refs, input.compact];
  });
  const payload: DecisionPayload = { schema: CONSTRUCTION_SOURCE_DECISION_SCHEMA, evidence, sourceRanges, owners, identities, roleLayouts, exampleLayouts, observations, bindings };
  const digest = hasher.digestHex(exactJson({ kind: CONSTRUCTION_SOURCE_DECISION_KIND, ownerKey, namespace, payload }));
  return { id: `${ID_PREFIX}${digest}`, ownerKey, namespace, kind: CONSTRUCTION_SOURCE_DECISION_KIND, payload, digest };
}

/** Factor existing measured choices in bulk; this does not run alignment, segmentation, or induction. */
export function normalizeConstructionSourceDecisions(values: readonly unknown[], input: { ownerKey: string; namespace: string; evidence: readonly EvidenceSpan[]; hasher: Hasher; maxPageBytes: number }): {
  patterns: unknown[]; pages: ConstructionSourceDecisionPage[];
} {
  if (typeof input.ownerKey !== "string" || !input.ownerKey || typeof input.namespace !== "string" || !input.namespace
    || !index(input.maxPageBytes) || input.maxPageBytes === 0 || input.maxPageBytes > CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES) return fail();
  const snapshots = copy([...values]), unique = new Map<string, Prepared>();
  for (const [ordinal, value] of snapshots.entries()) {
    const prepared = prepare(value, input.hasher, ordinal); if (!prepared) continue;
    const existing = unique.get(prepared.key); if (existing) existing.indexes.push(ordinal); else unique.set(prepared.key, prepared);
  }
  if (!unique.size) return { patterns: [...values], pages: [] };
  const proofs = new Map<string, Proof>();
  for (const evidence of input.evidence) {
    const descriptors = Object.getOwnPropertyDescriptors(evidence);
    if (["id", "sourceId", "sourceVersionId", "contentHash", "charStart", "charEnd", "byteStart", "byteEnd", "text"]
      .some(key => !descriptors[key] || descriptors[key]!.get || descriptors[key]!.set)) return fail();
    if (["id", "sourceId", "sourceVersionId", "contentHash", "text"].some(key => typeof descriptors[key]!.value !== "string")) return fail();
    const proof = copy(proofOf(evidence));
    if (!index(proof.charStart) || !index(proof.charEnd) || proof.charEnd < proof.charStart || !index(proof.byteStart) || !index(proof.byteEnd) || proof.byteEnd < proof.byteStart
      || [...evidence.text].length !== proof.charEnd - proof.charStart) return fail();
    const previous = proofs.get(proof.id); if (previous && exactJson(previous) !== exactJson(proof)) return fail();
    proofs.set(proof.id, proof);
  }
  const ordered = [...unique.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), patterns = [...snapshots], pages: ConstructionSourceDecisionPage[] = [];
  for (let start = 0; start < ordered.length;) {
    const remaining = ordered.length - start;
    let best: ConstructionSourceDecisionPage | undefined, count = 0, firstOverflow = remaining + 1;
    // Probe only as far as this page can hold; searching all remaining records for
    // every small page repeatedly rebuilt the full tail and made fitting quadratic.
    for (let probe = 1;; probe = Math.min(remaining, probe * 2)) {
      const page = buildPage(ordered.slice(start, start + probe), proofs, input.ownerKey, input.namespace, input.hasher);
      if (bytes(page) > input.maxPageBytes) { firstOverflow = probe; break; }
      best = page; count = probe;
      if (probe === remaining) break;
    }
    let low = count + 1, high = firstOverflow - 1;
    while (low <= high) {
      const candidateCount = Math.floor((low + high) / 2), page = buildPage(ordered.slice(start, start + candidateCount), proofs, input.ownerKey, input.namespace, input.hasher);
      if (bytes(page) <= input.maxPageBytes) { best = page; count = candidateCount; low = candidateCount + 1; } else high = candidateCount - 1;
    }
    // A page is an optional factored representation, not an admissibility gate.
    // A complete source-owned decision can legitimately be larger than the page
    // cap (for example, a large construction with many exact observations). Keep
    // that one decision inline and continue packing the rest of the cohort. This
    // preserves every measured choice while keeping every shared page bounded.
    if (!best) { start++; continue; }
    pages.push(best);
    for (let ordinal = 0; ordinal < count; ordinal++) for (const position of ordered[start + ordinal]!.indexes) {
      const root = row(patterns[position]);
      patterns[position] = { ...root, bundle: { schema: CONSTRUCTION_SOURCE_DECISION_REFERENCE_SCHEMA, pageId: best.id, ordinal } };
    }
    start += count;
  }
  // Count pages, hashes, owner definitions and every reference before choosing the shared form.
  if (bytes({ patterns, pages }) >= bytes({ patterns: snapshots, pages: [] })) return { patterns: [...values], pages: [] };
  return { patterns, pages };
}

export function constructionSourceDecisionPageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = row(value), bundle = root.bundle;
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || !String(bundle.schema).startsWith("scce.construction_source_decision_ref.")) return undefined;
  const reference = row(bundle);
  if (root.schema !== PATTERN_SCHEMA || root.storageEncoding !== EXAMPLE_ENCODING || reference.schema !== CONSTRUCTION_SOURCE_DECISION_REFERENCE_SCHEMA
    || Object.keys(reference).sort().join(",") !== "ordinal,pageId,schema" || !index(reference.ordinal)
    || typeof reference.pageId !== "string" || !reference.pageId.startsWith(ID_PREFIX)) return fail();
  return reference.pageId;
}

interface ValidatedPage { page: ConstructionSourceDecisionPage; ranges: Array<Array<[number, number]>> }
function validatedPage(value: unknown, ownerKey: string, hasher: Hasher, maxPageBytes: number): ValidatedPage {
  // Snapshot and measure the same canonical wire once. Rewalking the complete
  // page merely to count bytes duplicates validation on every bounded read.
  let wire: string;
  try { wire = exactJson(value); } catch { return fail(); }
  const page = JSON.parse(wire) as ConstructionSourceDecisionPage;
  if (!index(maxPageBytes) || maxPageBytes === 0 || maxPageBytes > CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES) return fail();
  if (!page || typeof page !== "object" || Array.isArray(page) || Object.keys(page).sort().join(",") !== "digest,id,kind,namespace,ownerKey,payload"
    || page.kind !== CONSTRUCTION_SOURCE_DECISION_KIND || page.ownerKey !== ownerKey || !ownerKey || typeof page.digest !== "string"
    || typeof page.namespace !== "string" || !page.namespace || page.id !== `${ID_PREFIX}${page.digest}` || new TextEncoder().encode(wire).byteLength > maxPageBytes
    || hasher.digestHex(exactJson({ kind: page.kind, ownerKey, namespace: page.namespace, payload: page.payload })) !== page.digest) return fail();
  const p = page.payload;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).sort().join(",") !== "bindings,evidence,exampleLayouts,identities,observations,owners,roleLayouts,schema,sourceRanges"
    || p.schema !== CONSTRUCTION_SOURCE_DECISION_SCHEMA || !Array.isArray(p.evidence) || !Array.isArray(p.sourceRanges) || p.sourceRanges.length !== p.evidence.length
    || !Array.isArray(p.bindings) || !p.bindings.length || !Array.isArray(p.owners) || !Array.isArray(p.identities) || !Array.isArray(p.observations)
    || !Array.isArray(p.roleLayouts) || !Array.isArray(p.exampleLayouts)) return fail();
  const ids = new Set<string>();
  for (const evidence of p.evidence) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).sort().join(",") !== "byteEnd,byteStart,charEnd,charStart,contentHash,id,sourceId,sourceVersionId"
      || ![evidence.id, evidence.sourceId, evidence.sourceVersionId, evidence.contentHash].every(value => typeof value === "string") || ids.has(evidence.id)
      || !index(evidence.charStart) || !index(evidence.charEnd) || evidence.charEnd < evidence.charStart
      || !index(evidence.byteStart) || !index(evidence.byteEnd) || evidence.byteEnd < evidence.byteStart) return fail();
    ids.add(evidence.id);
  }
  const ranges = p.sourceRanges.map((deltas, ei) => {
    if (!Array.isArray(deltas)) return fail();
    let previousEnd = 0;
    return deltas.map(delta => {
      if (!Array.isArray(delta) || delta.length !== 2 || !integer(delta[0]) || !index(delta[1]) || delta[1] === 0) return fail();
      const start = previousEnd + delta[0], end = start + delta[1];
      if (!index(start) || !index(end) || end > p.evidence[ei]!.charEnd - p.evidence[ei]!.charStart) return fail();
      previousEnd = end; return [start, end] as [number, number];
    });
  });
  for (const [ordinal, list] of ranges.entries()) {
    if (new Set(list.map(exactJson)).size !== list.length || list.some((range, i) => i > 0 && (range[0] < list[i - 1]![0] || range[0] === list[i - 1]![0] && range[1] <= list[i - 1]![1]))) return fail();
    if (ordinal > 0 && p.evidence[ordinal - 1]!.id >= p.evidence[ordinal]!.id) return fail();
  }
  for (const definitions of [p.owners, p.identities, p.roleLayouts, p.exampleLayouts]) if (new Set(definitions.map(exactJson)).size !== definitions.length) return fail();
  for (const owner of p.owners) {
    const header = row(owner);
    if (Object.keys(header).some(key => ["id", "contentDigest", "bindingId", "sourceExamples"].includes(key)) || header.schema !== PATTERN_SCHEMA
      || !strings(header.evidenceIds) || !header.evidenceIds.length || !strings(header.evidenceContentHashes) || !strings(header.sourceVersionIds)
      || typeof header.sourceProfileId !== "string" || header.targetProfileId !== header.sourceProfileId) return fail();
    const ownProofs = header.evidenceIds.map(id => p.evidence.find(evidence => evidence.id === id) ?? fail());
    if (new Set(header.evidenceIds).size !== header.evidenceIds.length
      || exactJson([...new Set(ownProofs.map(proof => proof.contentHash))].sort()) !== exactJson(header.evidenceContentHashes)
      || exactJson([...new Set(ownProofs.map(proof => proof.sourceVersionId))].sort()) !== exactJson(header.sourceVersionIds)) return fail();
  }
  for (const identity of p.identities) if (Object.keys(row(identity)).some(key => !(IDENTITY_FIELDS as readonly string[]).includes(key))) return fail();
  for (const layout of p.roleLayouts) {
    if (!Array.isArray(layout) || !layout.length) return fail();
    for (const member of layout) {
      const role = row(member);
      if (!index(role.slotIndex) || Object.hasOwn(role, "occurrenceIndex") && !index(role.occurrenceIndex)
        || Object.hasOwn(role, "startCodePoint") || Object.hasOwn(role, "endCodePoint")) return fail();
    }
  }
  for (const layout of p.exampleLayouts) if (Object.keys(row(layout)).some(key => ["evidenceIndex", "surfaceStartCodePoint", "surfaceEndCodePoint", "roles"].includes(key))) return fail();
  for (const observation of p.observations) {
    if (!Array.isArray(observation) || observation.length < 4 || observation.length > 5 || !index(observation[0]) || observation[0] >= p.evidence.length
      || !index(observation[1]) || observation[1] >= p.roleLayouts.length || !Array.isArray(observation[2]) || observation[2].length !== p.roleLayouts[observation[1]]!.length
      || observation[2].some(ref => !index(ref) || ref >= ranges[observation[0]]!.length) || !index(observation[3]) || observation[3] >= p.exampleLayouts.length) return fail();
    if (observation.length === 5 && (!Array.isArray(observation[4]) || observation[4].length !== 2 || !index(observation[4][0]) || !index(observation[4][1]) || observation[4][1] <= observation[4][0])) return fail();
    const selected = observation[2].map(ref => ranges[observation[0]]![ref]!);
    const start = observation[4]?.[0] ?? Math.min(...selected.map(range => range[0])), end = observation[4]?.[1] ?? Math.max(...selected.map(range => range[1]));
    if (end > p.evidence[observation[0]]!.charEnd - p.evidence[observation[0]]!.charStart || selected.some(range => range[0] < start || range[1] > end)) return fail();
  }
  for (const binding of p.bindings) {
    if (!Array.isArray(binding) || binding.length !== 6 || typeof binding[0] !== "string" || typeof binding[1] !== "string" || !binding[1].startsWith("language.source_relation.")
      || !index(binding[2]) || binding[2] >= p.owners.length || !index(binding[3]) || binding[3] >= p.identities.length || !Array.isArray(binding[4]) || !binding[4].length || binding[4].length > 256
      || binding[4].some(ref => !index(ref) || ref >= p.observations.length) || typeof binding[5] !== "boolean") return fail();
  }
  return { page, ranges };
}

export function validateConstructionSourceDecisionPage(value: unknown, ownerKey: string, hasher: Hasher, maxPageBytes = CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES): asserts value is ConstructionSourceDecisionPage {
  validatedPage(value, ownerKey, hasher, maxPageBytes);
}

export function createConstructionSourceDecisionRestorer(pages: ReadonlyMap<string, ConstructionSourceDecisionPage>, ownerKey: string, hasher: Hasher,
  maxPageBytes = CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES): (value: unknown) => unknown {
  const validated = new Map<string, ValidatedPage>();
  return value => {
    const id = constructionSourceDecisionPageId(value); if (id === undefined) return value;
    let cached = validated.get(id);
    if (!cached) { cached = validatedPage(pages.get(id), ownerKey, hasher, maxPageBytes); if (cached.page.id !== id) return fail(); validated.set(id, cached); }
    const root = copy(row(value)), reference = row(root.bundle), p = cached.page.payload, binding = p.bindings[reference.ordinal as number];
    if (!binding || root.contentDigest !== binding[0] || exactJson(own(root, IDENTITY_FIELDS)) !== exactJson(p.identities[binding[3]])) return fail();
    const owner = p.owners[binding[2]]!, declaredIds = owner.evidenceIds as string[];
    const examples = binding[4].map(ref => {
      const [ei, layout, refs, extra, extent] = p.observations[ref]!, selected = refs.map(ordinal => cached!.ranges[ei]![ordinal]!);
      const start = extent?.[0] ?? Math.min(...selected.map(range => range[0])), end = extent?.[1] ?? Math.max(...selected.map(range => range[1]));
      const evidenceIndex = declaredIds.indexOf(p.evidence[ei]!.id);
      if (evidenceIndex < 0 || end > p.evidence[ei]!.charEnd - p.evidence[ei]!.charStart || selected.some(range => range[0] < start || range[1] > end)) return fail();
      return { evidenceIndex, surfaceStartCodePoint: start, surfaceEndCodePoint: end,
        roles: selected.map(([left, right], ordinal) => ({ ...copy(p.roleLayouts[layout]![ordinal]!), startCodePoint: left - start, endCodePoint: right - start })), ...copy(p.exampleLayouts[extra]!) } as Row;
    });
    const header = { ...copy(owner), id: `surface.construction.bundle.${binding[0]}`, contentDigest: binding[0], bindingId: binding[1] };
    return { ...root, bundle: { ...header, sourceExamples: binding[5] ? encodeConstructionSourceExamples(examples, header, hasher) : examples } };
  };
}

export function restoreConstructionSourceDecision(value: unknown, page: ConstructionSourceDecisionPage, ownerKey: string, hasher: Hasher,
  maxPageBytes = CONSTRUCTION_SOURCE_DECISION_MAX_PAGE_BYTES): unknown {
  if (!page || typeof page !== "object") return fail();
  return createConstructionSourceDecisionRestorer(new Map([[page.id, page]]), ownerKey, hasher, maxPageBytes)(value);
}

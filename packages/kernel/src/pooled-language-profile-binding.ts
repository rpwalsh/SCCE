// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { evidenceSourceFamilyId } from "./source-family.js";
import type { EvidenceSpan, Hasher, LanguageProfile, SourceVersionId } from "./types.js";

export interface SourceLanguageFamilyRange { start: number; end: number; sourceFamilyId: string; sourceVersionId?: SourceVersionId }
export interface PooledLanguageProfileBinding { readonly inputDigest: string }
export const POOLED_LANGUAGE_PROFILE_OWNERSHIP_SCHEMA = "scce.pooled_language_profile_ownership.v1" as const;
export interface PooledLanguageProfileOwnership {
  schema: typeof POOLED_LANGUAGE_PROFILE_OWNERSHIP_SCHEMA; id: string; profileId: string; sourceVersionId: SourceVersionId;
  profileDigest: string; bindingDigest: string; textDigest: string;
  parents: readonly string[]; ranges: readonly SourceLanguageFamilyRange[];
  evidence: readonly Pick<EvidenceSpan, "id" | "sourceId" | "sourceVersionId" | "contentHash" | "byteStart" | "byteEnd" | "charStart" | "charEnd">[];
}
interface HeldBinding { readonly profileId: string; readonly sourceVersionId: SourceVersionId; readonly parents: readonly string[]; readonly evidenceIds: readonly string[]; readonly families: readonly string[]; readonly inputDigest: string;
  readonly measurementDigest: string; readonly textDigest: string; readonly ranges: readonly SourceLanguageFamilyRange[]; readonly evidence: PooledLanguageProfileOwnership["evidence"] }
const bindings = new WeakMap<PooledLanguageProfileBinding, HeldBinding>();
const preparedOwnership = new WeakSet<PooledLanguageProfileOwnership>();
const measuredProfile = (profile: LanguageProfile) => ({ id: profile.id, sourceVersionId: profile.sourceVersionId, scripts: profile.scripts,
  symbolShapes: profile.symbolShapes, charNgrams: profile.charNgrams, direction: profile.direction, entropy: profile.entropy,
  kneserNey: profile.kneserNey ?? null, ngramProfile: profile.ngramProfile ?? null, competenceVector: profile.competenceVector ?? null });
function profileDigest(profile: LanguageProfile, hasher: Hasher): string {
  const { informationLabel: _label, pooledSourceBinding: _binding, ...body } = profile;
  return canonicalDigestHex(body, hasher);
}

/** A pooled profile owns only the exact admitted parent text its ranges declare. */
export function preparePooledLanguageProfileBinding(input: {
  profile: LanguageProfile; text: string; sourceVersionId: SourceVersionId; parentSourceVersionIds: readonly string[];
  evidence: readonly EvidenceSpan[]; sourceFamilyRanges: readonly SourceLanguageFamilyRange[]; hasher: Hasher;
}): PooledLanguageProfileBinding {
  const fail = (): never => { throw new Error("pooled language profile parent binding is not source-owned"); };
  if (input.profile.sourceVersionId !== input.sourceVersionId || !input.parentSourceVersionIds.length || !input.evidence.length) fail();
  const parents = [...new Set(input.parentSourceVersionIds)].sort();
  const ranges = [...input.sourceFamilyRanges].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < end || range.end <= range.start || range.end > input.text.length
      || !range.sourceVersionId || !parents.includes(String(range.sourceVersionId)) || !range.sourceFamilyId) fail();
    end = range.end;
  }
  if (parents.some(parent => !ranges.some(range => range.sourceVersionId === parent))) fail();
  const points = new Map<SourceLanguageFamilyRange, string[]>();
  for (const span of input.evidence) {
    if (span.status !== "promoted" || !parents.includes(String(span.sourceVersionId))
      || String(span.contentHash).replace(/^sha256_/u, "") !== input.hasher.digestHex(span.text)) fail();
    const range = ranges.find(row => row.sourceVersionId === span.sourceVersionId && row.sourceFamilyId === evidenceSourceFamilyId(span));
    if (!range) return fail();
    let body = points.get(range);
    if (!body) { body = [...input.text.slice(range.start, range.end)]; points.set(range, body); }
    if (body.slice(span.charStart, span.charEnd).join("") !== span.text) fail();
  }
  if (parents.some(parent => !input.evidence.some(span => String(span.sourceVersionId) === parent))) fail();
  const material = { profileId: input.profile.id, sourceVersionId: input.sourceVersionId, parents: Object.freeze(parents),
    evidenceIds: Object.freeze([...new Set(input.evidence.map(span => String(span.id)))].sort()), families: Object.freeze([...new Set(ranges.map(range => range.sourceFamilyId))].sort()) };
  const held = Object.freeze({ ...material, inputDigest: input.hasher.digestHex(canonicalStringify({ ...material, textHash: input.hasher.digestHex(input.text), ranges })),
    measurementDigest: canonicalDigestHex(measuredProfile(input.profile), input.hasher), textDigest: input.hasher.digestHex(input.text),
    ranges: Object.freeze(ranges.map(range => Object.freeze({ ...range }))), evidence: Object.freeze(input.evidence.map(span => Object.freeze({
      id: span.id, sourceId: span.sourceId, sourceVersionId: span.sourceVersionId, contentHash: span.contentHash,
      byteStart: span.byteStart, byteEnd: span.byteEnd, charStart: span.charStart, charEnd: span.charEnd }))) });
  const token = Object.freeze({ inputDigest: held.inputDigest });
  bindings.set(token, held);
  return token;
}

export function attachPooledLanguageProfileOwnership(profile: LanguageProfile, binding: PooledLanguageProfileBinding, hasher: Hasher): LanguageProfile {
  const held = bindings.get(binding);
  if (!held || held.measurementDigest !== canonicalDigestHex(measuredProfile(profile), hasher)) throw new Error("pooled profile measurement changed");
  const body = { schema: POOLED_LANGUAGE_PROFILE_OWNERSHIP_SCHEMA, profileId: profile.id, sourceVersionId: profile.sourceVersionId,
    profileDigest: profileDigest(profile, hasher), bindingDigest: held.inputDigest, textDigest: held.textDigest,
    parents: held.parents, ranges: held.ranges, evidence: held.evidence };
  const ownership = Object.freeze({ ...body, id: canonicalDigestHex(body, hasher) });
  preparedOwnership.add(ownership);
  return { ...profile, pooledSourceBinding: ownership };
}

export function isPreparedPooledLanguageProfileOwnership(ownership: PooledLanguageProfileOwnership): boolean {
  return preparedOwnership.has(ownership);
}

export function validatePooledLanguageProfileOwnership(profile: LanguageProfile, hasher: Hasher): PooledLanguageProfileOwnership | undefined {
  const value = profile.pooledSourceBinding;
  if (value === undefined) return undefined;
  const { id, ...body } = value;
  const fail = (): never => { throw new Error("invalid pooled profile ownership"); };
  if (value.schema !== POOLED_LANGUAGE_PROFILE_OWNERSHIP_SCHEMA || value.profileId !== profile.id || value.sourceVersionId !== profile.sourceVersionId
    || value.profileDigest !== profileDigest(profile, hasher) || id !== canonicalDigestHex(body, hasher)
    || !value.bindingDigest || !value.textDigest || !Array.isArray(value.parents) || !value.parents.length
    || new Set(value.parents).size !== value.parents.length || !Array.isArray(value.evidence) || !value.evidence.length
    || !Array.isArray(value.ranges) || !value.ranges.length || new Set(value.evidence.map(row => row.id)).size !== value.evidence.length) return fail();
  if (value.parents.some(parent => typeof parent !== "string" || !parent || !value.evidence.some(row => row.sourceVersionId === parent)
    || !value.ranges.some(range => range.sourceVersionId === parent))) return fail();
  if (value.evidence.some(row => !row.id || !row.sourceId || !row.contentHash || !value.parents.includes(String(row.sourceVersionId))
    || ![row.byteStart, row.byteEnd, row.charStart, row.charEnd].every(number => Number.isSafeInteger(number) && number >= 0)
    || row.byteEnd <= row.byteStart || row.charEnd <= row.charStart)) return fail();
  return value;
}

export function pooledLanguageProfileBindingFor(input: {
  binding: PooledLanguageProfileBinding; profile: LanguageProfile; sourceVersionIds: ReadonlySet<string>; evidenceIds: readonly string[];
}): HeldBinding | undefined {
  const held = bindings.get(input.binding);
  if (!held) throw new Error("unrecognized pooled language profile binding");
  return held.profileId === input.profile.id && held.sourceVersionId === input.profile.sourceVersionId
    && input.sourceVersionIds.size > 0 && [...input.sourceVersionIds].every(id => held.parents.includes(id))
    && input.evidenceIds.length > 0 && input.evidenceIds.every(id => held.evidenceIds.includes(id)) ? held : undefined;
}

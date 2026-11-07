// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { evidenceSourceFamilyId } from "./source-family.js";
import type { EvidenceSpan, Hasher, LanguageProfile, SourceVersionId } from "./types.js";

export interface SourceLanguageFamilyRange { start: number; end: number; sourceFamilyId: string; sourceVersionId?: SourceVersionId }
export interface PooledLanguageProfileBinding { readonly inputDigest: string }
interface HeldBinding { readonly profileId: string; readonly sourceVersionId: SourceVersionId; readonly parents: readonly string[]; readonly evidenceIds: readonly string[]; readonly families: readonly string[]; readonly inputDigest: string }
const bindings = new WeakMap<PooledLanguageProfileBinding, HeldBinding>();

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
    if (!range) fail();
    let body = points.get(range);
    if (!body) { body = [...input.text.slice(range.start, range.end)]; points.set(range, body); }
    if (body.slice(span.charStart, span.charEnd).join("") !== span.text) fail();
  }
  const material = { profileId: input.profile.id, sourceVersionId: input.sourceVersionId, parents: Object.freeze(parents),
    evidenceIds: Object.freeze([...new Set(input.evidence.map(span => String(span.id)))].sort()), families: Object.freeze([...new Set(ranges.map(range => range.sourceFamilyId))].sort()) };
  const held = Object.freeze({ ...material, inputDigest: input.hasher.digestHex(canonicalStringify({ ...material, textHash: input.hasher.digestHex(input.text), ranges })) });
  const token = Object.freeze({ inputDigest: held.inputDigest });
  bindings.set(token, held);
  return token;
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

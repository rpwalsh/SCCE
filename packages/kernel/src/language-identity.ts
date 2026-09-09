// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { learnedScriptIdForCharacter } from "./language.js";

import type { Hasher, InformationLabel, JsonValue, LanguageProfile } from "./types.js";

/**
 * Language identity: what linguistic system a piece of language memory belongs to.
 *
 * Three facts about a learned artifact used to share one key, and the runtime demanded all three of a request before
 * it would use the artifact: which document it came from, which corpus role it serves, and which language it is in.
 * Only the last is what a request has to match. This module learns the last one from the corpus and nothing else:
 *
 * - A corpus family's closed class is the set of words a majority of its documents keep among their most-continued
 *   words. Learned by document frequency; no word list, no script-to-language table. On the live brain the Wikipedia
 *   family yields "the in a of and to was is as on for by at with s from", Gutenberg "the of and to i a my in that ...",
 *   the owner's source files "for from license only id by no all const scce import ...".
 * - Families are one language when each other's documents carry the identity's closed class. The document-level
 *   presence fraction is bimodal over a script bucket; the cut between the modes is Otsu's, chosen by the data.
 * - A document is assigned to the nearest identity of its script by closed-class presence, its own family breaking
 *   ties. A table-heavy article whose top words are markup still carries "the of in and" and stays English; a source
 *   file carries "const import type" and lands in the code identity even when its family is mixed.
 *
 * Provenance (source versions, evidence ids) is never consulted here and never becomes an admission condition.
 */

export const LANGUAGE_IDENTITY_SCHEMA = "scce.language_identity.v1" as const;

export interface LanguageIdentityRecord {
  schema: typeof LANGUAGE_IDENTITY_SCHEMA;
  id: string;
  script: string;
  directions: Array<{ direction: string; count: number }>;
  /** The learned function words of this language, by the share of member documents that carry them. */
  closedClass: Array<{ word: string; documentShare: number }>;
  /** Corpus families whose documents belong to this identity, with counts. */
  families: Array<{ family: string; count: number }>;
  profileCount: number;
  /** The document-level presence cut below which a document of this script is not this language. */
  membershipCut: number;
  createdAt: number;
  informationLabel?: InformationLabel;
}

export interface LanguageProfileSignature {
  id: string;
  /** Corpus family the document came from: a corpus label or a URI scheme. A prior for assignment, never a gate. */
  family: string;
  scripts: ReadonlyArray<{ script: string; mass: number }>;
  direction: string;
  /** Most-continued word symbols with their continuation counts, from the profile's compact Kneser-Ney summary. */
  topContinuation: ReadonlyArray<readonly [string, number]>;
}

export interface LanguageIdentityDiscovery {
  identities: LanguageIdentityRecord[];
  assignments: Map<string, string>;
  audit: JsonValue;
}

const MIN_FAMILY_DOCUMENTS = 4;

/** Word symbols only: letters with optional marks and apostrophes; markup, digits and punctuation are apparatus. */
export function isLanguageWordSymbol(symbol: string): boolean {
  return Boolean(symbol) && !symbol.startsWith("<") && symbol.length <= 24 && /^[\p{L}\p{M}'’-]+$/u.test(symbol) && /\p{L}/u.test(symbol);
}

/** The signature a profile contributes to identity discovery, or undefined when it carries no continuation summary. */
export function languageProfileSignature(profile: LanguageProfile, family: string): LanguageProfileSignature | undefined {
  const summary = profile.kneserNey;
  const top = summary && typeof summary === "object" && !Array.isArray(summary) ? (summary as Record<string, JsonValue>).topContinuation : undefined;
  if (!Array.isArray(top)) return undefined;
  const topContinuation = top
    .filter((row): row is JsonValue[] => Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "number")
    .map(row => [String(row[0]), Number(row[1])] as const)
    .filter(([symbol]) => isLanguageWordSymbol(symbol));
  return { id: profile.id, family, scripts: profile.scripts, direction: profile.direction, topContinuation };
}

/** Otsu's threshold over a sample: the cut maximizing between-class variance. The data chooses it. Pure. */
export function otsuThreshold(values: readonly number[]): number | undefined {
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  if (n < 4) return undefined;
  const total = xs.reduce((sum, x) => sum + x, 0);
  let sumBelow = 0;
  let best: { threshold: number; variance: number } = { threshold: xs[0]!, variance: -1 };
  for (let i = 1; i < n; i++) {
    sumBelow += xs[i - 1]!;
    const nBelow = i;
    const nAbove = n - i;
    const meanBelow = sumBelow / nBelow;
    const meanAbove = (total - sumBelow) / nAbove;
    const variance = nBelow * nAbove * (meanBelow - meanAbove) ** 2;
    if (variance > best.variance) best = { threshold: xs[i]!, variance };
  }
  return best.threshold;
}

function dominantScript(signature: LanguageProfileSignature): string {
  return [...signature.scripts].filter(row => row.mass >= 0.08).sort((a, b) => b.mass - a.mass)[0]?.script ?? "script:unknown";
}

/** The words a majority of the documents keep among their most-continued words, with their document share. Pure. */
export function majorityClosedClass(documents: readonly LanguageProfileSignature[]): Array<{ word: string; documentShare: number }> {
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const [word] of new Map(document.topContinuation)) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  return [...frequency]
    .filter(([, count]) => count > documents.length / 2)
    .map(([word, count]) => ({ word, documentShare: count / documents.length }))
    .sort((left, right) => right.documentShare - left.documentShare || (left.word < right.word ? -1 : 1));
}

/** The share of an identity's closed class a document carries among its most-continued words. Pure. */
export function closedClassPresence(document: { topContinuation: ReadonlyArray<readonly [string, number]> }, closedClass: ReadonlySet<string>): number {
  if (!closedClass.size) return 0;
  let carried = 0;
  const seen = new Set<string>();
  for (const [word] of document.topContinuation) {
    if (closedClass.has(word) && !seen.has(word)) { seen.add(word); carried++; }
  }
  return carried / closedClass.size;
}

function median(values: readonly number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)]! : 0;
}

interface Draft {
  script: string;
  closedClass: Array<{ word: string; documentShare: number }>;
  closedSet: Set<string>;
  families: Map<string, number>;
  members: LanguageProfileSignature[];
  seedFamily: string;
}

/**
 * Discover the language identities of a corpus from its profile signatures and assign every profile to one. Pure and
 * deterministic: families are visited largest first, documents assigned by nearest identity within their script.
 */
export function discoverLanguageIdentities(input: {
  signatures: readonly LanguageProfileSignature[];
  hasher: Hasher;
  now: number;
  informationLabel?: InformationLabel;
}): LanguageIdentityDiscovery {
  const byScript = new Map<string, LanguageProfileSignature[]>();
  for (const signature of input.signatures) {
    const script = dominantScript(signature);
    if (!byScript.has(script)) byScript.set(script, []);
    byScript.get(script)!.push(signature);
  }
  const identities: LanguageIdentityRecord[] = [];
  const assignments = new Map<string, string>();
  const auditBuckets: JsonValue[] = [];
  for (const [script, pool] of [...byScript].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
    const byFamily = new Map<string, LanguageProfileSignature[]>();
    for (const signature of pool) {
      if (!byFamily.has(signature.family)) byFamily.set(signature.family, []);
      byFamily.get(signature.family)!.push(signature);
    }
    const families = [...byFamily].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    const drafts: Draft[] = [];
    const smallFamilies: Array<[string, LanguageProfileSignature[]]> = [];
    for (const [family, documents] of families) {
      if (documents.length < MIN_FAMILY_DOCUMENTS) { smallFamilies.push([family, documents]); continue; }
      const closedClass = majorityClosedClass(documents);
      if (!closedClass.length) { smallFamilies.push([family, documents]); continue; }
      // A family joins the identity whose closed class its typical document carries; the cut is Otsu's over every
      // document of the script measured against that identity, so a family cannot lower the bar for itself.
      let joined: Draft | undefined;
      let joinedPresence = 0;
      for (const draft of drafts) {
        const presence = median(documents.map(document => closedClassPresence(document, draft.closedSet)));
        const cut = otsuThreshold(pool.map(document => closedClassPresence(document, draft.closedSet))) ?? 0;
        if (presence >= cut && presence > joinedPresence) { joined = draft; joinedPresence = presence; }
      }
      if (joined) {
        joined.members.push(...documents);
        joined.families.set(family, (joined.families.get(family) ?? 0) + documents.length);
        continue;
      }
      const closedSet = new Set(closedClass.map(row => row.word));
      drafts.push({ script, closedClass, closedSet, families: new Map([[family, documents.length]]), members: [...documents], seedFamily: family });
    }
    if (!drafts.length) {
      // Nothing in this script had a majority closed class (too few documents, or word-less material): one identity
      // by script alone, so the material is still addressable.
      drafts.push({ script, closedClass: [], closedSet: new Set(), families: new Map(), members: [], seedFamily: "" });
    }
    // Every document of the script goes to the nearest identity by closed-class presence; its family breaks ties.
    const familyOf = new Map<string, Draft>();
    for (const draft of drafts) for (const family of draft.families.keys()) familyOf.set(family, draft);
    const membershipCuts = drafts.map(draft => otsuThreshold(pool.map(document => closedClassPresence(document, draft.closedSet))) ?? 0);
    const assigned = new Map<Draft, LanguageProfileSignature[]>(drafts.map(draft => [draft, []]));
    for (const document of pool) {
      let best: Draft | undefined;
      let bestPresence = -1;
      for (const draft of drafts) {
        const presence = closedClassPresence(document, draft.closedSet);
        if (presence > bestPresence || (presence === bestPresence && familyOf.get(document.family) === draft)) { best = draft; bestPresence = presence; }
      }
      const home = bestPresence <= 0 ? (familyOf.get(document.family) ?? drafts[0]!) : best!;
      assigned.get(home)!.push(document);
    }
    drafts.forEach((draft, index) => {
      const members = assigned.get(draft)!;
      if (!members.length) return;
      const familyCounts = new Map<string, number>();
      const directions = new Map<string, number>();
      for (const member of members) {
        familyCounts.set(member.family, (familyCounts.get(member.family) ?? 0) + 1);
        directions.set(member.direction, (directions.get(member.direction) ?? 0) + 1);
      }
      const signature = `${script}${draft.closedClass.slice(0, 16).map(row => row.word).join("")}`;
      const id = `language_identity_${input.hasher.digestHex(signature).slice(0, 32)}`;
      identities.push({
        schema: LANGUAGE_IDENTITY_SCHEMA,
        id,
        script,
        directions: [...directions].map(([direction, count]) => ({ direction, count })).sort((a, b) => b.count - a.count),
        closedClass: draft.closedClass,
        families: [...familyCounts].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count),
        profileCount: members.length,
        membershipCut: membershipCuts[index] ?? 0,
        createdAt: input.now,
        ...(input.informationLabel ? { informationLabel: input.informationLabel } : {})
      });
      for (const member of members) assignments.set(member.id, id);
    });
    auditBuckets.push({ script, documents: pool.length, families: families.length, identities: drafts.length, smallFamilies: smallFamilies.map(([family, documents]) => `${family}:${documents.length}`) });
  }
  return { identities, assignments, audit: { schema: LANGUAGE_IDENTITY_SCHEMA, buckets: auditBuckets } };
}

/**
 * The identity a request surface is written in: the identity of its script whose closed class covers most of its
 * words; with no closed-class word in the surface, the largest identity of that script (the language the corpus
 * mostly speaks). Deterministic. Pure.
 */
export function selectLanguageIdentityForSurface(
  identities: readonly LanguageIdentityRecord[],
  surface: string
): { identity: LanguageIdentityRecord; coverage: number } | undefined {
  const words = surface.normalize("NFC").toLocaleLowerCase().split(/[^\p{L}\p{M}'’-]+/u).filter(Boolean);
  if (!identities.length) return undefined;
  const script = surfaceDominantScript(surface);
  const candidates = identities.filter(identity => !script || identity.script === script);
  const pool = candidates.length ? candidates : identities;
  let best: { identity: LanguageIdentityRecord; coverage: number } | undefined;
  for (const identity of [...pool].sort((a, b) => b.profileCount - a.profileCount || (a.id < b.id ? -1 : 1))) {
    const closed = new Set(identity.closedClass.map(row => row.word));
    const coverage = words.length ? words.filter(word => closed.has(word)).length / words.length : 0;
    if (!best || coverage > best.coverage) best = { identity, coverage };
  }
  return best;
}

/** The script most of a surface's letters belong to, named the way profiles name scripts, or undefined when it has none. */
function surfaceDominantScript(surface: string): string | undefined {
  const counts = new Map<string, number>();
  for (const char of surface) {
    if (!/\p{L}/u.test(char)) continue;
    const script = scriptOfCharacter(char);
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function scriptOfCharacter(char: string): string {
  return learnedScriptIdForCharacter(char);
}

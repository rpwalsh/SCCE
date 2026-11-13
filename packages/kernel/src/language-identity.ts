// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { learnedScriptIdForCharacter } from "./language.js";
import { canonicalStringify } from "./primitives.js";

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

export const LANGUAGE_IDENTITY_SCHEMA = "scce.language_identity.v2" as const;
export const LANGUAGE_IDENTITY_DISCOVERY_RECIPE = "scce.language_identity_discovery.v4";

export interface LanguageIdentityRecord {
  schema: typeof LANGUAGE_IDENTITY_SCHEMA;
  id: string;
  script: string;
  directions: Array<{ direction: string; count: number }>;
  /** The learned function words of this language, by the share of member documents that carry them. */
  closedClass: Array<{ word: string; documentShare: number }>;
  /** Corpus families whose documents belong to this identity, with counts and each family's own evidence. */
  families: Array<{
    family: string;
    count: number;
    closedClass?: Array<{ word: string; documentShare: number }>;
    evidence?: LanguageIdentityEvidence;
  }>;
  /** Exact corpus roles represented by the identity, counted independently of family grouping. */
  corpusRoles: Array<{ corpusRoleId: string; count: number }>;
  profileCount: number;
  evidence?: LanguageIdentityEvidence;
  /** The document-level presence cut below which a document of this script is not this language. */
  membershipCut: number;
  createdAt: number;
  informationLabel?: InformationLabel;
  discoveryRecipe?: string;
  discoveryInputDigest?: string;
}

export interface LanguageProfileSignature {
  id: string;
  /** Exact canonical source version when the store provides it; unlike a compact signature, this is safe to deduplicate. */
  sourceVersionId?: string;
  /** Corpus family the document came from: a corpus label or a URI scheme. A prior for assignment, never a gate. */
  family: string;
  /** Authoritative corpus role from source provenance; never inferred from language symbols. */
  corpusRoleId?: string;
  scripts: ReadonlyArray<{ script: string; mass: number }>;
  direction: string;
  /** Most-continued word symbols with their continuation counts, from the profile's compact Kneser-Ney summary. */
  topContinuation: ReadonlyArray<readonly [string, number]>;
}

export interface LanguageIdentityEvidence {
  observedProfileCount: number;
  sampleCount: number;
  sourceFamilyCount: number;
  independentSourceFamilyCount: number;
  status: "source_observed" | "family_measured" | "cross_family_measured";
  uncertainty: string[];
  /** Observed Kneser-Ney symbols, not a claim that each symbol is grammatical. */
  observedSymbols: Array<{ symbol: string; profileCount: number; continuationCount: number }>;
}

export interface LanguageIdentityDiscovery {
  identities: LanguageIdentityRecord[];
  assignments: Map<string, string>;
  audit: JsonValue;
}

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

/** Assign an aggregate without adding its repeated documents to discovery statistics. */
export function classifyPooledLanguageSignature(identities: readonly LanguageIdentityRecord[], signature: LanguageProfileSignature): string | undefined {
  const script = dominantScript(signature);
  const measured = identities.filter(identity => identity.script === script && identity.closedClass.length)
    .map(identity => ({ identity, presence: closedClassPresence(signature, new Set(identity.closedClass.map(row => row.word))) }))
    .filter(row => row.presence > 0 && row.presence >= row.identity.membershipCut)
    .sort((left, right) => right.presence - left.presence || left.identity.id.localeCompare(right.identity.id));
  if (!measured[0] || measured[1]?.presence === measured[0].presence) return undefined;
  return measured[0].identity.id;
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
  signatureSets: Set<string>;
}

function profileSignatureKey(signature: LanguageProfileSignature): string {
  return canonicalStringify({
    scripts: [...signature.scripts].sort((left, right) => left.script.localeCompare(right.script)),
    direction: signature.direction,
    topContinuation: [...signature.topContinuation]
      .map(([symbol, count]) => [symbol, count] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  });
}

function uniqueProfileSignatures(documents: readonly LanguageProfileSignature[]): LanguageProfileSignature[] {
  const byKey = new Map<string, LanguageProfileSignature>();
  for (const document of documents) {
    const key = document.sourceVersionId ? `source:${document.sourceVersionId}` : `profile:${document.id}`;
    if (!byKey.has(key)) byKey.set(key, document);
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right)).map(([, profile]) => profile);
}

function signatureShares(documents: readonly LanguageProfileSignature[]): Array<{ word: string; documentShare: number }> {
  const counts = new Map<string, number>();
  for (const document of documents) {
    for (const word of new Set(document.topContinuation.map(([symbol]) => symbol))) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts].map(([word, count]) => ({ word, documentShare: count / Math.max(1, documents.length) }))
    .sort((left, right) => right.documentShare - left.documentShare || left.word.localeCompare(right.word));
}

function measuredFamilyClass(documents: readonly LanguageProfileSignature[]): Array<{ word: string; documentShare: number }> {
  const samples = uniqueProfileSignatures(documents);
  // One document cannot distinguish shared grammatical material from its subject matter. Preserve its exact
  // source-owned identity and symbols, but leave the reusable class unresolved.
  if (samples.length <= 1) return [];
  const shares = signatureShares(samples);
  if (!shares.length) return [];
  const split = otsuThreshold(shares.map(row => row.documentShare));
  if (split === undefined) return [];
  return shares.filter(row => row.documentShare >= split);
}

function familySignatureSetKey(documents: readonly LanguageProfileSignature[]): string {
  return canonicalStringify(uniqueProfileSignatures(documents).map(profileSignatureKey).sort());
}

function measuredProfilePopulations(documents: readonly LanguageProfileSignature[]): LanguageProfileSignature[][] {
  const samples = uniqueProfileSignatures(documents);
  if (samples.length <= 1) return [[...documents]];
  const symbols = new Map(samples.map(document => {
    const cut = otsuThreshold(document.topContinuation.map(([, count]) => count));
    return [document.id, new Set(document.topContinuation.filter(([, count]) => cut === undefined || count >= cut).map(([word]) => word))] as const;
  }));
  const distance = (a: LanguageProfileSignature, b: LanguageProfileSignature) => {
    const left = symbols.get(a.id)!, right = symbols.get(b.id)!;
    let shared = 0; for (const word of left) if (right.has(word)) shared++;
    const union = left.size + right.size - shared;
    return union ? 1 - shared / union : 0;
  };
  const keys = new Map(samples.map(document => [document.id, profileSignatureKey(document)]));
  const ordered = [...samples].sort((a, b) => keys.get(a.id)!.localeCompare(keys.get(b.id)!) || a.id.localeCompare(b.id));
  const first = ordered[0]!;
  let second = first, farthest = 0;
  for (const document of ordered) { const measured = distance(first, document); if (measured > farthest) { second = document; farthest = measured; } }
  if (!distance(first, second)) return [[...documents]];
  const groups: LanguageProfileSignature[][] = [[], []];
  for (const document of samples) groups[distance(document, first) <= distance(document, second) ? 0 : 1]!.push(document);
  const classes = groups.map(group => measuredFamilyClass(group));
  if (classes.some(words => !words.length)) return [[...documents]];
  const sets = classes.map(words => new Set(words.map(row => row.word)));
  if (groups.some((group, index) => median(group.map(document => closedClassPresence(document, sets[index]!)
    - closedClassPresence(document, sets[1 - index]!))) <= 0)) return [[...documents]];
  const bySource = new Map(samples.map(document => [document.sourceVersionId ? `source:${document.sourceVersionId}` : `profile:${document.id}`, groups[0]!.includes(document) ? 0 : 1]));
  const original = [[], []] as LanguageProfileSignature[][];
  for (const document of documents) original[bySource.get(document.sourceVersionId ? `source:${document.sourceVersionId}` : `profile:${document.id}`)!]!.push(document);
  return original.flatMap(group => measuredProfilePopulations(group));
}

function identityEvidence(input: {
  documents: readonly LanguageProfileSignature[];
  status: LanguageIdentityEvidence["status"];
  hasMeasuredClass: boolean;
}): LanguageIdentityEvidence {
  const profiles = uniqueProfileSignatures(input.documents);
  const symbols = new Map<string, { profileCount: number; continuationCount: number }>();
  for (const profile of profiles) {
    for (const [symbol, continuationCount] of profile.topContinuation) {
      const row = symbols.get(symbol) ?? { profileCount: 0, continuationCount: 0 };
      row.profileCount += 1;
      row.continuationCount += continuationCount;
      symbols.set(symbol, row);
    }
  }
  const families = new Map<string, LanguageProfileSignature[]>();
  for (const profile of input.documents) {
    const rows = families.get(profile.family) ?? [];
    rows.push(profile);
    families.set(profile.family, rows);
  }
  const distinctFamilySignatures = new Set([...families.values()].map(familySignatureSetKey)).size;
  const uncertainty: string[] = [];
  if (!input.hasMeasuredClass) uncertainty.push("language_class_split_unresolved");
  if (distinctFamilySignatures < 2) uncertainty.push("cross_family_equivalence_unresolved");
  if (input.documents.length !== profiles.length) uncertainty.push("exact_source_version_duplicates_collapsed");
  if (distinctFamilySignatures !== families.size) uncertainty.push("identical_family_signature_sets_collapsed");
  return {
    observedProfileCount: input.documents.length,
    sampleCount: profiles.length,
    sourceFamilyCount: families.size,
    independentSourceFamilyCount: distinctFamilySignatures,
    status: input.status,
    uncertainty,
    observedSymbols: [...symbols]
      .map(([symbol, counts]) => ({ symbol, ...counts }))
      .sort((left, right) => right.profileCount - left.profileCount
        || right.continuationCount - left.continuationCount
        || left.symbol.localeCompare(right.symbol))
      .slice(0, 256)
  };
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
    const families = [...byFamily].flatMap(([family, documents]) => measuredProfilePopulations(documents).map(population => [family, population] as const))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]) || familySignatureSetKey(a[1]).localeCompare(familySignatureSetKey(b[1])));
    const drafts: Draft[] = [];
    const unresolvedFamilies: Array<[string, LanguageProfileSignature[]]> = [];
    for (const [family, documents] of families) {
      const closedClass = measuredFamilyClass(documents);
      if (!closedClass.length) {
        unresolvedFamilies.push([family, documents]);
        continue;
      }
      // A family joins the identity whose closed class its typical document carries; the cut is Otsu's over every
      // document of the script measured against that identity, so a family cannot lower the bar for itself.
      let joined: Draft | undefined;
      let joinedPresence = 0;
      const signatureSet = familySignatureSetKey(documents);
      for (const draft of drafts) {
        const exactSignatureMatch = draft.signatureSets.has(signatureSet);
        if (exactSignatureMatch) { joined = draft; joinedPresence = 1; break; }
        const presence = median(documents.map(document => closedClassPresence(document, draft.closedSet)));
        const cut = otsuThreshold(uniqueProfileSignatures(pool)
          .map(document => closedClassPresence(document, draft.closedSet)));
        if (cut === undefined) continue;
        if (presence >= cut && presence > joinedPresence) { joined = draft; joinedPresence = presence; }
      }
      if (joined) {
        joined.members.push(...documents);
        joined.families.set(family, (joined.families.get(family) ?? 0) + documents.length);
        joined.signatureSets.add(signatureSet);
        continue;
      }
      const closedSet = new Set(closedClass.map(row => row.word));
      drafts.push({ script, closedClass, closedSet, families: new Map([[family, documents.length]]), members: [...documents], seedFamily: family, signatureSets: new Set([signatureSet]) });
    }
    for (const [family, documents] of unresolvedFamilies) {
      // An unresolved family has no defensible language class of its own, but its documents can still carry a
      // measured identity's class. Join only when the same corpus-wide Otsu presence cut used above supports it;
      // retain the family's own source observations as evidence and do not invent a family closed class.
      let joined: Draft | undefined;
      let joinedPresence = 0;
      const signatureSet = familySignatureSetKey(documents);
      for (const draft of drafts) {
        const exactSignatureMatch = draft.signatureSets.has(signatureSet);
        if (exactSignatureMatch) { joined = draft; joinedPresence = 1; break; }
        if (!draft.closedSet.size) continue;
        const presence = median(documents.map(document => closedClassPresence(document, draft.closedSet)));
        const cut = otsuThreshold(uniqueProfileSignatures(pool)
          .map(document => closedClassPresence(document, draft.closedSet)));
        if (cut === undefined) continue;
        if (presence >= cut && presence > joinedPresence) { joined = draft; joinedPresence = presence; }
      }
      if (joined) {
        joined.members.push(...documents);
        joined.families.set(family, (joined.families.get(family) ?? 0) + documents.length);
        joined.signatureSets.add(signatureSet);
        continue;
      }
      drafts.push({
        script,
        closedClass: [],
        closedSet: new Set(),
        families: new Map([[family, documents.length]]),
        members: [...documents],
        seedFamily: family, signatureSets: new Set([signatureSet])
      });
    }
    if (!drafts.length) {
      // Word-less signatures still receive a script identity so their profiles remain addressable.
      drafts.push({ script, closedClass: [], closedSet: new Set(), families: new Map(), members: [], seedFamily: "", signatureSets: new Set() });
    }
    // Assign unresolved families to their own identity; measured families use closed-class presence.
    const familyOf = new Map<string, Draft>();
    for (const draft of drafts) for (const family of draft.families.keys()) familyOf.set(family, draft);
    const ownerOf = new Map(drafts.flatMap(draft => draft.members.map(member => [member.id, draft] as const)));
    const membershipCuts = drafts.map(draft => otsuThreshold(uniqueProfileSignatures(pool)
      .map(document => closedClassPresence(document, draft.closedSet))) ?? 0);
    const assigned = new Map<Draft, LanguageProfileSignature[]>(drafts.map(draft => [draft, []]));
    for (const document of pool) {
      const sourceOwned = ownerOf.get(document.id) ?? familyOf.get(document.family);
      if (sourceOwned && sourceOwned.closedClass.length === 0) {
        assigned.get(sourceOwned)!.push(document);
        continue;
      }
      let best: Draft | undefined;
      let bestPresence = -1;
      for (const draft of drafts) {
        const presence = closedClassPresence(document, draft.closedSet);
        if (presence > bestPresence || (presence === bestPresence && sourceOwned === draft)) { best = draft; bestPresence = presence; }
      }
      const home = bestPresence <= 0 ? (sourceOwned ?? drafts[0]!) : best!;
      assigned.get(home)!.push(document);
    }
    drafts.forEach((draft, index) => {
      const members = assigned.get(draft)!;
      if (!members.length) return;
      const familyCounts = new Map<string, number>();
      const familyMembers = new Map<string, LanguageProfileSignature[]>();
      const corpusRoleCounts = new Map<string, number>();
      const directions = new Map<string, number>();
      for (const member of members) {
        familyCounts.set(member.family, (familyCounts.get(member.family) ?? 0) + 1);
        if (member.corpusRoleId) corpusRoleCounts.set(member.corpusRoleId, (corpusRoleCounts.get(member.corpusRoleId) ?? 0) + 1);
        const bucket = familyMembers.get(member.family);
        if (bucket) bucket.push(member); else familyMembers.set(member.family, [member]);
        directions.set(member.direction, (directions.get(member.direction) ?? 0) + 1);
      }
      const signature = `${script}${draft.closedClass.slice(0, 16).map(row => row.word).join("")}`;
      const sameClassDrafts = drafts.filter(other => other !== draft
        && other.script === draft.script
        && other.closedClass.slice(0, 16).map(row => row.word).join("\u001f")
          === draft.closedClass.slice(0, 16).map(row => row.word).join("\u001f"));
      const identityMaterial = draft.closedClass.length && !sameClassDrafts.length
        ? signature
        : `${signature}\u001fsource-family:${draft.seedFamily}`;
      const id = `language_identity_${input.hasher.digestHex(identityMaterial).slice(0, 32)}`;
      identities.push({
        schema: LANGUAGE_IDENTITY_SCHEMA,
        id,
        script,
        directions: [...directions].map(([direction, count]) => ({ direction, count })).sort((a, b) => b.count - a.count),
        closedClass: draft.closedClass,
        // A family that joined another family's identity keeps the class its own documents carry; it is what that corpus role speaks.
        families: [...familyCounts].map(([family, count]) => {
          const own = familyMembers.get(family) ?? [];
          const closedClass = measuredFamilyClass(own);
          const evidence = identityEvidence({
            documents: own,
            status: closedClass.length
              ? (draft.closedClass.length ? "family_measured" : "cross_family_measured")
              : "source_observed",
            hasMeasuredClass: closedClass.length > 0
          });
          return { family, count, ...(closedClass.length ? { closedClass } : {}), evidence };
        }).sort((a, b) => b.count - a.count),
        corpusRoles: [...corpusRoleCounts].map(([corpusRoleId, count]) => ({ corpusRoleId, count }))
          .sort((a, b) => b.count - a.count || a.corpusRoleId.localeCompare(b.corpusRoleId)),
        profileCount: members.length,
        evidence: identityEvidence({
          documents: members,
          status: draft.closedClass.length
            ? (new Set([...familyCounts.keys()].map(family => familySignatureSetKey(familyMembers.get(family) ?? []))).size > 1
              ? "cross_family_measured"
              : "family_measured")
            : "source_observed",
          hasMeasuredClass: draft.closedClass.length > 0
        }),
        membershipCut: membershipCuts[index] ?? 0,
        createdAt: input.now,
        ...(input.informationLabel ? { informationLabel: input.informationLabel } : {})
      });
      for (const member of members) assignments.set(member.id, id);
    });
    auditBuckets.push({
      script,
      documents: pool.length,
      uniqueProfileSignatures: uniqueProfileSignatures(pool).length,
      families: families.length,
      identities: drafts.length,
      unresolvedFamilies: unresolvedFamilies.map(([family, documents]) => ({ family, profiles: documents.length }))
    });
  }
  return { identities, assignments, audit: { schema: LANGUAGE_IDENTITY_SCHEMA, buckets: auditBuckets } };
}

/**
 * The closed class of the corpus family a turn is speaking in, falling back to the identity's own.
 *
 * One family's class, never a union of several: the owner's source files make "walsh" and "copyright" function words
 * of the code identity, and unioning that into the prose class would excuse a real content word as form. When several
 * families answer to the same corpus role, the one holding the most documents of this identity speaks. Pure.
 */
export function closedClassForFamilies(identity: LanguageIdentityRecord, families: readonly string[]): string[] {
  const wanted = new Set(families);
  const spoken = identity.families
    .filter(row => wanted.has(row.family) && (row.closedClass?.length ?? 0) > 0)
    .sort((left, right) => right.count - left.count || (left.family < right.family ? -1 : 1))[0];
  return (spoken?.closedClass ?? identity.closedClass).map(row => row.word);
}

/**
 * Route by measured closed class, then observed profile symbols; an unresolved tie stays unresolved.
 *
 * Membership alone is not enough: independently learned identities can carry the same form word. The measured
 * document share is the evidence that distinguishes a word used throughout one population from an incidental word
 * in a much larger population. Profile count is deliberately not a tie-breaker; corpus volume is not language
 * evidence, and letting it decide made a large code/documentation population capture ordinary dialogue.
 */
export function selectLanguageIdentityForSurface(
  identities: readonly LanguageIdentityRecord[],
  surface: string,
  options: { excludeCorpusRoleIds?: readonly string[] } = {}
): { identity: LanguageIdentityRecord; coverage: number } | undefined {
  const words = surface.normalize("NFC").toLocaleLowerCase().split(/[^\p{L}\p{M}'’-]+/u).filter(Boolean);
  if (!identities.length) return undefined;
  const script = surfaceDominantScript(surface);
  const excludedRoles = new Set(options.excludeCorpusRoleIds ?? []);
  const roleEligible = (identity: LanguageIdentityRecord) => {
    const roles = identity.corpusRoles ?? [];
    // An identity can be spoken naturally if any observed role carrying it is not excluded. Unknown roles remain
    // eligible: the source has supplied no typed evidence that it is symbolic.
    return !roles.length || roles.some(role => !excludedRoles.has(role.corpusRoleId));
  };
  const eligible = identities.filter(roleEligible);
  if (!eligible.length) return undefined;
  const candidates = eligible.filter(identity => !script || identity.script === script);
  const pool = candidates.length ? candidates : eligible;
  let best: { identity: LanguageIdentityRecord; coverage: number; strength: number } | undefined;
  let tiedBest = false;
  let bestObserved: { identity: LanguageIdentityRecord; coverage: number } | undefined;
  let tiedObserved = false;
  for (const identity of [...pool].sort((a, b) => a.id.localeCompare(b.id))) {
    const closed = new Map(identity.closedClass.map(row => [row.word, row.documentShare]));
    const matchedShares = words.flatMap(word => {
      const share = closed.get(word);
      return share === undefined || !Number.isFinite(share) ? [] : [Math.max(0, Math.min(1, share))];
    });
    const coverage = words.length ? matchedShares.length / words.length : 0;
    const strength = words.length ? matchedShares.reduce((sum, share) => sum + share, 0) / words.length : 0;
    if (!best || coverage > best.coverage || (coverage === best.coverage && strength > best.strength)) {
      best = { identity, coverage, strength };
      tiedBest = false;
    } else if (coverage === best.coverage && strength === best.strength) {
      tiedBest = true;
    }
    if (!closed.size) {
      const observed = new Set(identity.evidence?.observedSymbols.map(row => row.symbol) ?? []);
      const observedCoverage = words.length ? words.filter(word => observed.has(word)).length / words.length : 0;
      if (observedCoverage > (bestObserved?.coverage ?? 0)) {
        bestObserved = { identity, coverage: observedCoverage };
        tiedObserved = false;
      } else if (observedCoverage > 0 && observedCoverage === bestObserved?.coverage) {
        tiedObserved = true;
      }
    }
  }
  if (best && best.coverage > 0 && !tiedBest) return { identity: best.identity, coverage: best.coverage };
  if (bestObserved && bestObserved.coverage > 0 && !tiedObserved) return bestObserved;
  return pool.length === 1 && best ? { identity: best.identity, coverage: best.coverage } : undefined;
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

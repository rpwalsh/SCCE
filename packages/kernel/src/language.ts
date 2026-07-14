import type { IdFactory } from "./ids.js";
import type { EvidenceSpan, JsonValue, LanguageCompetenceVector, LanguageProfile, SourceVersionId } from "./types.js";
import { clamp01, entropy, symbolizeData } from "./primitives.js";
import { compactKneserNeyForProfile, trainKneserNey } from "./kneser-ney.js";
import { createNgramProseAnalyzer } from "./ngram-prose.js";

export interface LanguageProfileSurfaceMatch {
  profile: LanguageProfile;
  score: number;
  trigramCoverage: number;
  repertoireCoverage: number;
  shapeCoverage: number;
}

export interface LanguageProfileCluster {
  id: string;
  members: LanguageProfile[];
  profileIds: string[];
  sourceVersionIds: SourceVersionId[];
  discoveredNames: Array<{
    surface: string;
    evidenceRefs: string[];
    confidence: number;
    owners: Array<{
      profileId: string;
      sourceVersionId: SourceVersionId;
      evidenceRefs: string[];
      sourceVersionRefs: SourceVersionId[];
      confidence: number;
    }>;
  }>;
  scripts: Array<{ script: string; mass: number }>;
  symbolShapes: Array<{ shape: string; count: number }>;
  charNgrams: Array<{ ngram: string; count: number }>;
  direction: LanguageProfile["direction"];
  artifactSupport: number;
}

export interface LanguageProfileClusterSurfaceMatch {
  cluster: LanguageProfileCluster;
  score: number;
  trigramCoverage: number;
  repertoireCoverage: number;
  shapeCoverage: number;
}

export interface LanguageProfileClusterSelection extends LanguageProfileClusterSurfaceMatch {
  margin: number;
}

const MIN_CLUSTER_DISTRIBUTION_FIT = 0.55;
const MAX_CLUSTER_CANDIDATES_PER_BUCKET = 16;
const MIN_SURFACE_SELECTION_SCORE = 0.48;
const MIN_SURFACE_SELECTION_MARGIN = 0.12;

/**
 * Ranks persisted language profiles from their learned surface statistics.
 * The matcher deliberately does not map script names, language names, or
 * hand-authored vocabularies. That keeps unknown and constructed languages on
 * the same path as every other corpus profile.
 */
export function rankLanguageProfilesForSurface(
  profiles: readonly LanguageProfile[],
  surface: string
): LanguageProfileSurfaceMatch[] {
  const input = surfaceStatistics(surface);
  return profiles.map(profile => ({ profile, ...scoreSurfaceDistribution(input, profile) }))
    .sort((left, right) => right.score - left.score || compareCodePoint(left.profile.id, right.profile.id));
}

/**
 * Groups source-bound profiles by their learned surface distributions. Member
 * ids remain provenance only; the cluster identity is derived exclusively from
 * normalized n-gram, repertoire, shape, script, and direction statistics.
 */
export function buildLanguageProfileClusters(profiles: readonly LanguageProfile[]): LanguageProfileCluster[] {
  const ordered = [...profiles]
    .filter(profile => Boolean(profile.id) && Boolean(profile.sourceVersionId))
    .sort((left, right) => compareCodePoint(profileIndexBucket(left), profileIndexBucket(right))
      || compareCodePoint(profileDistributionKey(left), profileDistributionKey(right))
      || compareCodePoint(left.id, right.id));
  const buckets = new Map<string, Array<{ representative: LanguageProfile; members: LanguageProfile[] }>>();
  for (const profile of ordered) {
    const key = profileIndexBucket(profile);
    const groups = buckets.get(key) ?? [];
    const candidates = groups.slice(-MAX_CLUSTER_CANDIDATES_PER_BUCKET)
      .map((group, index) => ({
        group,
        index: groups.length - Math.min(groups.length, MAX_CLUSTER_CANDIDATES_PER_BUCKET) + index,
        fit: profileDistributionFit(profile, group.representative)
      }))
      .filter(candidate => !verifiedAliasesConflict(profile, candidate.group.representative))
      .filter(candidate => candidate.fit.score >= MIN_CLUSTER_DISTRIBUTION_FIT)
      .sort((left, right) => right.fit.score - left.fit.score || left.index - right.index);
    const selected = candidates[0]?.group;
    if (selected) selected.members.push(profile);
    else groups.push({ representative: profile, members: [profile] });
    buckets.set(key, groups);
  }
  return [...buckets.values()].flatMap(groups => groups.map(group => aggregateLanguageProfileCluster(group.members)))
    .sort((left, right) => compareCodePoint(left.id, right.id));
}

/** Deterministic provisional fallback over learned artifact/source support. */
export function selectDominantLanguageProfileCluster(
  clusters: readonly LanguageProfileCluster[]
): LanguageProfileCluster | undefined {
  return [...clusters]
    .sort((left, right) => right.artifactSupport - left.artifactSupport || compareCodePoint(left.id, right.id))[0];
}

export function selectLanguageProfileClusterForSourceVersions(
  clusters: readonly LanguageProfileCluster[],
  sourceVersionIds: readonly SourceVersionId[]
): LanguageProfileCluster | undefined {
  const requested = new Set(sourceVersionIds.map(String));
  if (!requested.size) return undefined;
  const ranked = clusters.map(cluster => ({
    cluster,
    matches: cluster.sourceVersionIds.reduce((count, sourceVersionId) => count + Number(requested.has(String(sourceVersionId))), 0)
  })).filter(row => row.matches > 0)
    .sort((left, right) => right.matches - left.matches || right.cluster.artifactSupport - left.cluster.artifactSupport || compareCodePoint(left.cluster.id, right.cluster.id));
  if (!ranked[0] || ranked[0].matches === ranked[1]?.matches) return undefined;
  return ranked[0].cluster;
}

export function rankLanguageProfileClustersForSurface(
  clusters: readonly LanguageProfileCluster[],
  surface: string
): LanguageProfileClusterSurfaceMatch[] {
  const input = surfaceStatistics(surface);
  return clusters.map(cluster => ({ cluster, ...scoreSurfaceDistribution(input, cluster) }))
    .sort((left, right) => right.score - left.score || compareCodePoint(left.cluster.id, right.cluster.id));
}

export function selectLanguageProfileClusterForSurface(
  clusters: readonly LanguageProfileCluster[],
  surface: string
): LanguageProfileClusterSelection | undefined {
  const input = surfaceStatistics(surface);
  if (input.signalCount === 0) return undefined;
  const ranked = rankLanguageProfileClustersForSurface(clusters, surface);
  const selected = ranked[0];
  if (!selected || selected.score < MIN_SURFACE_SELECTION_SCORE) return undefined;
  const margin = selected.score - (ranked[1]?.score ?? 0);
  if (margin < MIN_SURFACE_SELECTION_MARGIN) return undefined;
  return { ...selected, margin };
}

export function selectLanguageProfileForSurface(
  profiles: readonly LanguageProfile[],
  surface: string
): LanguageProfile | undefined {
  const selected = selectLanguageProfileClusterForSurface(buildLanguageProfileClusters(profiles), surface);
  return selected?.cluster.members.slice().sort((left, right) => compareCodePoint(left.id, right.id))[0];
}

export function languageProfileClusterCacheKey(cluster: LanguageProfileCluster | undefined): string {
  if (!cluster) return "language-cluster:unscoped";
  return [
    cluster.id,
    ...cluster.profileIds.slice().sort(compareCodePoint),
    ...cluster.sourceVersionIds.map(String).sort(compareCodePoint)
  ].join("\u001f");
}

export function languageHintFromProfile(profile: LanguageProfile): string {
  const script = [...profile.scripts]
    .filter(row => Number.isFinite(row.mass) && row.mass >= 0)
    .sort((left, right) => right.mass - left.mass || compareCodePoint(left.script, right.script))[0]?.script ?? "unknown";
  return `script:${script};direction:${profile.direction}`;
}

export function languageAliasSurfacesFromMetadata(metadata: JsonValue | undefined): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const row = metadata as Record<string, JsonValue>;
  return uniqueStrings([
    ...aliasStrings(row.language),
    ...aliasStrings(row.languageTag),
    ...aliasStrings(row.languageId),
    ...aliasStrings(row.locale),
    ...aliasStrings(row.languageAliases)
  ]);
}

export function attachSourceDerivedLanguageAliases(input: {
  profile: LanguageProfile;
  metadata?: JsonValue;
  evidence?: readonly EvidenceSpan[];
}): LanguageProfile {
  const sourceAliases = languageAliasSurfacesFromMetadata(input.metadata).map(surface => ({
    surface,
    evidenceRefs: [],
    sourceVersionRefs: [input.profile.sourceVersionId],
    confidence: 1
  }));
  const evidenceAliases = (input.evidence ?? []).flatMap(span => {
    if (span.sourceVersionId !== input.profile.sourceVersionId) return [];
    return languageAliasSurfacesFromMetadata(span.languageHints).map(surface => ({
      surface,
      evidenceRefs: [String(span.id)],
      confidence: 1
    }));
  });
  const discoveredNames = normalizedDiscoveredNames(
    [...(input.profile.discoveredNames ?? []), ...sourceAliases, ...evidenceAliases],
    input.profile.sourceVersionId
  );
  return discoveredNames.length ? { ...input.profile, discoveredNames } : input.profile;
}

export function createLanguageAcquisitionEngine(options: { idFactory: IdFactory }) {
  const prose = createNgramProseAnalyzer({ maxOrder: 6, topK: 128 });
  return {
    acquire(input: {
      sourceVersionId: SourceVersionId;
      text: string;
      createdAt: number;
      discoveredNames?: LanguageProfile["discoveredNames"];
    }): LanguageProfile {
      const chars = [...input.text.normalize("NFC")].filter(char => !/\s/u.test(char));
      const scripts = scriptMass(chars);
      const symbols = symbolizeData(input.text).slice(0, 10000);
      const shapeCounts = count(symbols.map(symbolShape));
      const ngrams = count(charNgrams(chars.join("").toLowerCase(), 3));
      const kneserNey = trainKneserNey(symbols, { order: 6, discount: 0.75, vocabularyLimit: 12000 });
      const ngramProfile = prose.analyze(input.text);
      const values = [...ngrams.values()];
      const direction = directionFrom(chars);
      const competenceVector = competenceFrom({ chars, symbols, scripts, ngramProfile });
      return {
        id: options.idFactory.semanticId("language_profile", { sourceVersionId: input.sourceVersionId, scripts, top: [...ngrams.entries()].slice(0, 16) }),
        sourceVersionId: input.sourceVersionId,
        ...(normalizedDiscoveredNames(input.discoveredNames, input.sourceVersionId).length
          ? { discoveredNames: normalizedDiscoveredNames(input.discoveredNames, input.sourceVersionId) }
          : {}),
        scripts: [...scripts.entries()].map(([script, mass]) => ({ script, mass })),
        symbolShapes: [...shapeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([shape, c]) => ({ shape, count: c })),
        charNgrams: [...ngrams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256).map(([ngram, c]) => ({ ngram, count: c })),
        direction,
        entropy: entropy(values),
        competenceVector,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        artifactSupport: symbols.length,
        kneserNey: compactKneserNeyForProfile(kneserNey, input.text),
        ngramProfile: ngramProfile.audit
      };
    }
  };
}

function scriptMass(chars: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of chars) {
    const script = learnedScriptIdForCharacter(char);
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  const total = Math.max(1, chars.length);
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([script, count]) => [script, count / total]));
}

export function learnedScriptIdForCharacter(char: string): string {
  if (/\p{Script=Latin}/u.test(char)) return "script:Latn";
  if (/\p{Script=Arabic}/u.test(char)) return "script:Arab";
  if (/\p{Script=Hebrew}/u.test(char)) return "script:Hebr";
  if (/\p{Script=Han}/u.test(char)) return "script:Hani";
  if (/\p{Script=Hangul}/u.test(char)) return "script:Hang";
  if (/\p{Script=Hiragana}/u.test(char)) return "script:Hira";
  if (/\p{Script=Katakana}/u.test(char)) return "script:Kana";
  if (/\p{Script=Cyrillic}/u.test(char)) return "script:Cyrl";
  if (/\p{Script=Devanagari}/u.test(char)) return "script:Deva";
  if (/\p{Script=Thai}/u.test(char)) return "script:Thai";
  if (/\p{Script=Greek}/u.test(char)) return "script:Greek";
  if (/\p{Number}/u.test(char)) return "script:Zyyy:number";
  if (/[\p{Letter}\p{Mark}]/u.test(char)) {
    const block = Math.floor((char.codePointAt(0) ?? 0) / 256).toString(16).padStart(4, "0");
    return `script:opaque:block:${block}`;
  }
  if (/[\p{Punctuation}\p{Symbol}]/u.test(char)) return "script:Zyyy";
  return "script:Zxxx";
}

function directionFrom(chars: string[]): LanguageProfile["direction"] {
  const rtl = chars.filter(char => /\p{Script=Arabic}|\p{Script=Hebrew}/u.test(char)).length;
  const ltr = chars.filter(char => /\p{Script=Latin}|\p{Script=Cyrillic}|\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(char)).length;
  if (rtl > 0 && ltr > 0) return "mixed";
  if (rtl > 0) return "rtl";
  if (ltr > 0) return "ltr";
  return "unknown";
}

function symbolShape(symbol: string): string {
  return [...symbol].map(char => (/\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : "P")).join("");
}

function charNgrams(text: string, n: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i <= chars.length - n; i++) out.push(chars.slice(i, i + n).join(""));
  return out;
}

function count(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function weightedInputCoverage(input: ReadonlyMap<string, number>, learned: ReadonlyMap<string, number>): number {
  let total = 0;
  let covered = 0;
  for (const [value, rawCount] of input) {
    const count = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
    total += count;
    if ((learned.get(value) ?? 0) > 0) covered += count;
  }
  return total > 0 ? clamp01(covered / total) : 0;
}

function setCoverage(input: ReadonlySet<string>, learned: ReadonlySet<string>): number {
  if (input.size === 0 || learned.size === 0) return 0;
  let covered = 0;
  for (const value of input) if (learned.has(value)) covered += 1;
  return clamp01(covered / input.size);
}

function compareCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

interface SurfaceStatistics {
  signalCount: number;
  trigrams: Map<string, number>;
  shapes: Map<string, number>;
  repertoire: Set<string>;
}

interface SurfaceDistribution {
  charNgrams: readonly { ngram: string; count: number }[];
  symbolShapes: readonly { shape: string; count: number }[];
}

function surfaceStatistics(surface: string): SurfaceStatistics {
  const normalized = surface.replace(/\u0000/gu, " ").normalize("NFC").toLowerCase();
  const chars = [...normalized].filter(char => /[\p{Letter}\p{Mark}\p{Number}]/u.test(char));
  return {
    signalCount: chars.length,
    trigrams: count(charNgrams(chars.join(""), 3)),
    shapes: count(symbolizeData(normalized).map(symbolShape)),
    repertoire: new Set(chars)
  };
}

function scoreSurfaceDistribution(input: SurfaceStatistics, distribution: SurfaceDistribution): Omit<LanguageProfileClusterSurfaceMatch, "cluster"> {
  if (input.signalCount === 0) return { score: 0, trigramCoverage: 0, repertoireCoverage: 0, shapeCoverage: 0 };
  const learnedTrigrams = new Map(distribution.charNgrams
    .filter(row => row.ngram.normalize("NFC") === row.ngram && Number.isFinite(row.count) && row.count > 0)
    .map(row => [row.ngram.toLowerCase(), row.count]));
  const learnedShapes = new Map(distribution.symbolShapes
    .filter(row => Number.isFinite(row.count) && row.count > 0)
    .map(row => [row.shape, row.count]));
  const learnedRepertoire = new Set([...learnedTrigrams.keys()].flatMap(ngram => [...ngram]).filter(char => /[\p{Letter}\p{Mark}\p{Number}]/u.test(char)));
  const trigramCoverage = weightedInputCoverage(input.trigrams, learnedTrigrams);
  const repertoireCoverage = setCoverage(input.repertoire, learnedRepertoire);
  const shapeCoverage = weightedInputCoverage(input.shapes, learnedShapes);
  const weights = [
    ...(input.trigrams.size > 0 && learnedTrigrams.size > 0 ? [[0.68, trigramCoverage] as const] : []),
    ...(input.repertoire.size > 0 && learnedRepertoire.size > 0 ? [[0.24, repertoireCoverage] as const] : []),
    ...(input.shapes.size > 0 && learnedShapes.size > 0 ? [[0.08, shapeCoverage] as const] : [])
  ];
  const denominator = weights.reduce((sum, [weight]) => sum + weight, 0);
  return {
    score: denominator > 0 ? clamp01(weights.reduce((sum, [weight, value]) => sum + weight * value, 0) / denominator) : 0,
    trigramCoverage,
    repertoireCoverage,
    shapeCoverage
  };
}

function profileDistributionFit(left: LanguageProfile, right: LanguageProfile): { score: number; lexical: number } {
  const trigram = weightedDistributionOverlap(
    new Map(left.charNgrams.map(row => [row.ngram.normalize("NFC").toLowerCase(), row.count])),
    new Map(right.charNgrams.map(row => [row.ngram.normalize("NFC").toLowerCase(), row.count]))
  );
  const leftRepertoire = new Set(left.charNgrams.flatMap(row => [...row.ngram.normalize("NFC").toLowerCase()]));
  const rightRepertoire = new Set(right.charNgrams.flatMap(row => [...row.ngram.normalize("NFC").toLowerCase()]));
  const repertoire = symmetricSetOverlap(leftRepertoire, rightRepertoire);
  const characterDistribution = weightedDistributionOverlap(
    characterDistributionFromTrigrams(left.charNgrams),
    characterDistributionFromTrigrams(right.charNgrams)
  );
  const scripts = weightedDistributionOverlap(new Map(left.scripts.map(row => [row.script, row.mass])), new Map(right.scripts.map(row => [row.script, row.mass])));
  const shapes = weightedDistributionOverlap(new Map(left.symbolShapes.map(row => [row.shape, row.count])), new Map(right.symbolShapes.map(row => [row.shape, row.count])));
  const direction = left.direction === right.direction ? 1 : left.direction === "unknown" || right.direction === "unknown" ? 0.5 : 0;
  return {
    lexical: clamp01(0.48 * characterDistribution + 0.32 * repertoire + 0.2 * trigram),
    // Provisional learned-distribution routing feature. Topic-sensitive exact
    // trigrams are bounded so they cannot become the identity gate.
    score: clamp01(0.3 * characterDistribution + 0.22 * repertoire + 0.2 * trigram + 0.15 * scripts + 0.08 * shapes + 0.05 * direction)
  };
}

function characterDistributionFromTrigrams(rows: readonly { ngram: string; count: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const weight = finitePositive(row.count);
    if (!weight) continue;
    for (const char of row.ngram.normalize("NFC").toLowerCase()) {
      if (!/[\p{Letter}\p{Mark}\p{Number}]/u.test(char)) continue;
      out.set(char, (out.get(char) ?? 0) + weight);
    }
  }
  return out;
}

function weightedDistributionOverlap(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
  const leftTotal = [...left.values()].reduce((sum, value) => sum + finitePositive(value), 0);
  const rightTotal = [...right.values()].reduce((sum, value) => sum + finitePositive(value), 0);
  if (leftTotal <= 0 || rightTotal <= 0) return 0;
  const keys = new Set([...left.keys(), ...right.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const a = finitePositive(left.get(key) ?? 0) / leftTotal;
    const b = finitePositive(right.get(key) ?? 0) / rightTotal;
    intersection += Math.min(a, b);
    union += Math.max(a, b);
  }
  return union > 0 ? clamp01(intersection / union) : 0;
}

function symmetricSetOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return clamp01(intersection / Math.max(1, left.size + right.size - intersection));
}

function aggregateLanguageProfileCluster(rawMembers: readonly LanguageProfile[]): LanguageProfileCluster {
  const members = [...rawMembers].sort((left, right) => compareCodePoint(left.id, right.id));
  const scripts = aggregateNormalizedRows(members.map(member => member.scripts.map(row => [row.script, row.mass] as const)))
    .map(([script, mass]) => ({ script, mass }));
  const symbolShapes = aggregateNormalizedRows(members.map(member => member.symbolShapes.map(row => [row.shape, row.count] as const)))
    .map(([shape, count]) => ({ shape, count }));
  const charNgrams = aggregateNormalizedRows(members.map(member => member.charNgrams.map(row => [row.ngram.normalize("NFC").toLowerCase(), row.count] as const)))
    .map(([ngram, count]) => ({ ngram, count }));
  const directionCounts = count(members.map(member => member.direction));
  const direction = [...directionCounts.entries()].sort((left, right) => right[1] - left[1] || compareCodePoint(left[0], right[0]))[0]?.[0] as LanguageProfile["direction"] | undefined;
  const discoveredNames = aggregateDiscoveredNames(members);
  const distributionKey = JSON.stringify({
    scripts: scripts.slice(0, 24).map(row => [row.script, rounded(row.mass)]),
    shapes: symbolShapes.slice(0, 64).map(row => [row.shape, rounded(row.count)]),
    trigrams: charNgrams.slice(0, 256).map(row => [row.ngram, rounded(row.count)]),
    direction: direction ?? "unknown"
  });
  return {
    id: `language-cluster:${stableDistributionHash(distributionKey)}`,
    members,
    profileIds: members.map(member => member.id),
    sourceVersionIds: members.map(member => member.sourceVersionId).sort((left, right) => compareCodePoint(String(left), String(right))),
    discoveredNames,
    scripts,
    symbolShapes,
    charNgrams,
    direction: direction ?? "unknown",
    artifactSupport: members.reduce((sum, member) => sum + finitePositive(member.artifactSupport ?? inferredProfileSupport(member)), 0)
  };
}

function aggregateNormalizedRows(
  memberRows: readonly (readonly (readonly [string, number])[])[]
): Array<[string, number]> {
  const aggregate = new Map<string, number>();
  for (const rows of memberRows) {
    const total = rows.reduce((sum, [, value]) => sum + finitePositive(value), 0);
    if (total <= 0) continue;
    for (const [key, value] of rows) aggregate.set(key, (aggregate.get(key) ?? 0) + finitePositive(value) / total);
  }
  const divisor = Math.max(1, memberRows.length);
  return [...aggregate.entries()]
    .map(([key, value]) => [key, value / divisor] as [string, number])
    .sort((left, right) => right[1] - left[1] || compareCodePoint(left[0], right[0]));
}

function aggregateDiscoveredNames(members: readonly LanguageProfile[]): LanguageProfileCluster["discoveredNames"] {
  const bySurface = new Map<string, {
    surface: string;
    evidenceRefs: Set<string>;
    confidence: number;
    owners: LanguageProfileCluster["discoveredNames"][number]["owners"];
  }>();
  for (const member of members) {
    for (const name of member.discoveredNames ?? []) {
      const surface = name.surface.normalize("NFC").trim();
      if (!surface) continue;
      const key = surface.toLowerCase();
      const existing = bySurface.get(key) ?? { surface, evidenceRefs: new Set<string>(), confidence: 0, owners: [] };
      for (const ref of name.evidenceRefs) if (ref) existing.evidenceRefs.add(ref);
      existing.confidence = Math.max(existing.confidence, clamp01(name.confidence));
      existing.owners.push({
        profileId: member.id,
        sourceVersionId: member.sourceVersionId,
        evidenceRefs: uniqueStrings(name.evidenceRefs),
        sourceVersionRefs: (name.sourceVersionRefs ?? []).filter(ref => ref === member.sourceVersionId),
        confidence: clamp01(name.confidence)
      });
      bySurface.set(key, existing);
    }
  }
  return [...bySurface.values()].map(row => ({
    surface: row.surface,
    evidenceRefs: [...row.evidenceRefs].sort(compareCodePoint),
    confidence: row.confidence,
    owners: row.owners.sort((left, right) => compareCodePoint(left.profileId, right.profileId))
  })).sort((left, right) => compareCodePoint(left.surface.toLowerCase(), right.surface.toLowerCase()));
}

function profileIndexBucket(profile: LanguageProfile): string {
  const scripts = [...profile.scripts]
    .filter(row => finitePositive(row.mass) >= 0.08)
    .sort((left, right) => right.mass - left.mass || compareCodePoint(left.script, right.script))
    .slice(0, 3)
    .map(row => row.script)
    .sort(compareCodePoint);
  return JSON.stringify({ scripts, direction: profile.direction });
}

function verifiedAliasesConflict(left: LanguageProfile, right: LanguageProfile): boolean {
  const leftAliases = verifiedProfileAliasKeys(left);
  const rightAliases = verifiedProfileAliasKeys(right);
  if (!leftAliases.size || !rightAliases.size) return false;
  for (const alias of leftAliases) if (rightAliases.has(alias)) return false;
  return true;
}

function verifiedProfileAliasKeys(profile: LanguageProfile): Set<string> {
  return new Set((profile.discoveredNames ?? [])
    .filter(name => name.evidenceRefs.length > 0 || (name.sourceVersionRefs ?? []).includes(profile.sourceVersionId))
    .map(name => name.surface.normalize("NFC").trim().toLowerCase())
    .filter(Boolean));
}

function normalizedDiscoveredNames(
  names: LanguageProfile["discoveredNames"] | undefined,
  sourceVersionId: SourceVersionId
): NonNullable<LanguageProfile["discoveredNames"]> {
  const bySurface = new Map<string, NonNullable<LanguageProfile["discoveredNames"]>[number]>();
  for (const name of names ?? []) {
    const surface = name.surface.normalize("NFC").trim();
    if (!surface) continue;
    const evidenceRefs = uniqueStrings(name.evidenceRefs);
    const sourceVersionRefs = (name.sourceVersionRefs ?? []).filter(ref => ref === sourceVersionId);
    if (!evidenceRefs.length && !sourceVersionRefs.length) continue;
    const candidate = {
      surface,
      evidenceRefs,
      ...(sourceVersionRefs.length ? { sourceVersionRefs } : {}),
      confidence: clamp01(name.confidence)
    };
    const key = surface.toLowerCase();
    const existing = bySurface.get(key);
    if (!existing || candidate.confidence > existing.confidence) bySurface.set(key, candidate);
  }
  return [...bySurface.values()].sort((left, right) => compareCodePoint(left.surface.toLowerCase(), right.surface.toLowerCase()));
}

function inferredProfileSupport(profile: LanguageProfile): number {
  return profile.charNgrams.reduce((sum, row) => sum + finitePositive(row.count), 0)
    + profile.symbolShapes.reduce((sum, row) => sum + finitePositive(row.count), 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.normalize("NFC").trim()).filter(Boolean))].sort(compareCodePoint);
}

function aliasStrings(value: JsonValue | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(aliasStrings);
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, JsonValue>;
  return [
    ...aliasStrings(row.id),
    ...aliasStrings(row.tag),
    ...aliasStrings(row.name),
    ...aliasStrings(row.aliases)
  ];
}

function profileDistributionKey(profile: LanguageProfile): string {
  return JSON.stringify({
    scripts: [...profile.scripts].sort((left, right) => compareCodePoint(left.script, right.script)).map(row => [row.script, rounded(row.mass)]),
    shapes: [...profile.symbolShapes].sort((left, right) => compareCodePoint(left.shape, right.shape)).slice(0, 64).map(row => [row.shape, rounded(row.count)]),
    trigrams: [...profile.charNgrams].sort((left, right) => compareCodePoint(left.ngram, right.ngram)).slice(0, 256).map(row => [row.ngram, rounded(row.count)]),
    direction: profile.direction
  });
}

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function rounded(value: number): number {
  return Math.round(finitePositive(value) * 1_000_000) / 1_000_000;
}

function stableDistributionHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    left = Math.imul(left ^ point, 0x01000193) >>> 0;
    right = Math.imul(right ^ point, 0x85ebca6b) >>> 0;
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0");
}

function competenceFrom(input: {
  chars: string[];
  symbols: string[];
  scripts: Map<string, number>;
  ngramProfile: ReturnType<ReturnType<typeof createNgramProseAnalyzer>["analyze"]>;
}): LanguageCompetenceVector {
  const dominantScriptMass = Math.max(0, ...input.scripts.values());
  const uniqueSymbols = new Set(input.symbols).size;
  const symbolCount = input.symbols.length;
  const symbolOrders = input.ngramProfile.symbolOrders;
  const highOrder = Math.max(0, ...symbolOrders.filter(order => order.order >= 3).map(order => order.total));
  const cadence = input.ngramProfile.cadence;
  const scriptRecognition = clamp01(dominantScriptMass * Math.min(1, input.chars.length / 24));
  const segmentationQuality = clamp01(symbolCount ? Math.min(1, symbolCount / 512) * (uniqueSymbols / Math.max(1, symbolCount)) ** 0.25 : 0);
  const lexicalCoverage = clamp01(Math.log2(1 + uniqueSymbols) / 15);
  const phraseFluency = clamp01(Math.log2(1 + highOrder) / 16);
  const syntacticCoverage = clamp01(Math.min(1, cadence.sentenceCount / 64) * (1 - Math.min(0.7, cadence.symbolRate)));
  const generationReliability = clamp01(0.34 * lexicalCoverage + 0.33 * phraseFluency + 0.33 * segmentationQuality);
  return {
    scriptRecognition,
    segmentationQuality,
    lexicalCoverage,
    phraseFluency,
    syntacticCoverage,
    semanticFrameCoverage: 0,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability,
    correctionStability: 0,
    localizationReliability: 0
  };
}

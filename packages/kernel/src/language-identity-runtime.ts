// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  discoverLanguageIdentities,
  selectLanguageIdentityForSurface,
  LANGUAGE_IDENTITY_SCHEMA,
  LANGUAGE_IDENTITY_DISCOVERY_RECIPE,
  type LanguageIdentityRecord,
  type LanguageProfileSignature
} from "./language-identity.js";
import { isLanguageWordSymbol } from "./language-identity.js";
import { CORPUS_ROLE_IDS, createCorpusRegistry, corpusRoleIdForSourceSystem, type CorpusRegistryEntry } from "./corpus-registry.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "./storage.js";
import type { Hasher, InformationLabel, JsonValue } from "./types.js";
import { canonicalStringify } from "./primitives.js";

/** Resolves an artifact's language from what the artifact says about itself: its profile, or failing that its corpus. */
export interface LanguageResolver {
  profile(profileId: string): string | undefined;
  corpus(sourceSystem: string | undefined): string | undefined;
}

export function languageIdentityProfileIdsForArtifacts(input: {
  profiles?: readonly { id: string }[];
  units?: readonly { profileId: string }[];
  patterns?: readonly { profileId: string }[];
  models?: readonly { modelJson: JsonValue }[];
  observations?: readonly { metadata: JsonValue }[];
  semanticFrames?: readonly { frameJson: JsonValue }[];
}): string[] {
  const jsonOwner = (value: JsonValue): string | undefined => value && typeof value === "object" && !Array.isArray(value)
    && typeof value.profileId === "string" ? value.profileId : undefined;
  return [...new Set([
    ...(input.profiles ?? []).map(profile => profile.id),
    ...(input.units ?? []).map(unit => unit.profileId),
    ...(input.patterns ?? []).map(pattern => pattern.profileId),
    ...(input.models ?? []).map(model => jsonOwner(model.modelJson)),
    ...(input.observations ?? []).map(observation => jsonOwner(observation.metadata)),
    ...(input.semanticFrames ?? []).map(frame => jsonOwner(frame.frameJson))
  ].filter((id): id is string => typeof id === "string" && Boolean(id)))].sort();
}

export type LanguageIdentityReadiness = "not_loaded" | "ready" | "missing" | "requires_rebuild" | "unavailable";
export interface LanguageIdentityLoadResult {
  identities: LanguageIdentityRecord[];
  /** Null when serving did not enumerate the global assignment population. */
  assigned: number | null;
  discovered: boolean;
  readiness: LanguageIdentityReadiness;
  elapsedMs: number;
}

export interface LanguageIdentityRuntime {
  /** Serving reads the catalog; discovery requires an explicit initialization or rebuild. */
  ensure(input?: { rebuild?: boolean; initializeIfMissing?: boolean; finalize?: boolean; requiredProfileIds?: readonly string[] }): Promise<LanguageIdentityLoadResult>;
  identities(): readonly LanguageIdentityRecord[];
  readiness(): LanguageIdentityReadiness;
  /** Immutable assignment snapshot for precisely the owners present in bounded work. */
  resolver(profileIds: readonly string[]): Promise<LanguageResolver | undefined>;
  /** The identity a request surface is written in, once identities are loaded. */
  selectForSurface(surface: string, options?: { excludeCorpusRoleIds?: readonly string[] }): { identity: LanguageIdentityRecord; coverage: number } | undefined;
  /** The identity most of a corpus family's documents belong to. */
  identityForFamily(family: string): LanguageIdentityRecord | undefined;
}

/**
 * The corpus family a source URI belongs to. Families are a prior for assignment and the key by which artifacts
 * without a profile resolve their language; they are read from provenance and never used as an admission gate.
 */
export function corpusFamilyForSourceUri(uri: string): string {
  if (!uri) return "none";
  if (uri.startsWith("scce://construction-training")) return "training-batch";
  if (uri.startsWith("wikipedia://")) return "wikipedia";
  if (/gutenberg/iu.test(uri)) return "gutenberg";
  if (uri.startsWith("file:///") || uri.startsWith("workspace:")) return "files";
  if (uri.includes("request-requirement")) return "request-corpus";
  if (uri.startsWith("http://") || uri.startsWith("https://")) return "web";
  return uri.split(":")[0]?.slice(0, 24) || "none";
}

/** The corpus family an artifact's `sourceSystem` label belongs to, so profile-less records can resolve a language. */
export function corpusFamilyForSourceSystem(sourceSystem: string): string {
  if (sourceSystem === "wikipedia" || sourceSystem === "wikimedia") return "wikipedia";
  if (sourceSystem === "gutenberg") return "gutenberg";
  if (sourceSystem === "corrections") return "request-corpus";
  if (sourceSystem === "oss_code" || sourceSystem === "oss_docs" || sourceSystem.startsWith("source_")) return "files";
  return sourceSystem;
}

/**
 * The corpus families a corpus role's registered source systems belong to, so a turn speaking in one role can read
 * the closed class that role's own documents taught rather than the identity's seed family's.
 */
export function corpusFamiliesForRole(
  registry: readonly { sourceSystem: string; corpusRoleId: string }[],
  roleId: string
): string[] {
  return [...new Set(registry
    .filter(entry => String(entry.corpusRoleId) === String(roleId))
    .map(entry => corpusFamilyForSourceSystem(entry.sourceSystem)))];
}

/**
 * The corpus family a document belongs to. Its registered source system decides, because that is what the corpus
 * role is read from; the URI scheme answers only when no registered system does, since a scheme is transport and
 * says nothing about what a document is. `file:///…/corpus/dialogue/pg1005.txt` is dialogue, not source code.
 */
export function corpusFamilyForSource(
  source: { sourceSystem: string; sourceUri: string },
  registry: readonly { sourceSystem: string; sourceSystemId: string }[]
): string {
  const system = source.sourceSystem.trim();
  const registered = system
    ? registry.find(entry => entry.sourceSystemId === system || entry.sourceSystem === system)
    : undefined;
  return registered ? corpusFamilyForSourceSystem(registered.sourceSystem) : corpusFamilyForSourceUri(source.sourceUri);
}

/** Formal-code generation reads the symbolic population by its typed corpus role, independent of request language. */
export function roleHydrationLanguageIdentityId(roleId: string | undefined, requestLanguageId: string | undefined): string | undefined {
  return roleId === CORPUS_ROLE_IDS.softwareSymbolic ? undefined : requestLanguageId;
}

function signatureFromRow(row: LanguageProfileSignatureRow, registry: readonly CorpusRegistryEntry[]): LanguageProfileSignature {
  const registered = registry.find(entry => entry.sourceSystemId === row.sourceSystem || entry.sourceSystem === row.sourceSystem);
  return {
    id: row.id,
    sourceVersionId: row.sourceVersionId,
    family: corpusFamilyForSource(row, registry),
    ...(row.sourceSystem ? { corpusRoleId: registered?.corpusRoleId ?? corpusRoleIdForSourceSystem(row.sourceSystem) } : {}),
    scripts: row.scripts,
    direction: row.direction,
    topContinuation: row.topContinuation.filter(([symbol]) => isLanguageWordSymbol(symbol))
  };
}

export function createLanguageIdentityRuntime(options: {
  store: LanguageIdentityStore | undefined;
  hasher: Hasher;
  now: () => number;
  /** The durable information label every kernel-written record carries. */
  informationLabel?: InformationLabel;
  /** The configured corpus registry, which is what a document's source system is resolved against. */
  corpusRegistry?: readonly CorpusRegistryEntry[];
}): LanguageIdentityRuntime {
  const corpusRegistry = options.corpusRegistry ?? createCorpusRegistry();
  let loaded: LanguageIdentityRecord[] = [];
  let familyLanguage = new Map<string, string>();
  let readiness: LanguageIdentityReadiness = "not_loaded";
  let ensuring: Promise<LanguageIdentityLoadResult> | undefined;

  const index = () => {
    familyLanguage = new Map();
    // A family belongs to the identity holding most of its documents.
    const best = new Map<string, number>();
    for (const identity of loaded) {
      for (const row of identity.families) {
        if ((best.get(row.family) ?? -1) < row.count) { best.set(row.family, row.count); familyLanguage.set(row.family, identity.id); }
      }
    }
  };

  async function signaturesForDiscovery(): Promise<LanguageProfileSignature[]> {
    const store = options.store!;
    const signatures: LanguageProfileSignature[] = [];
    let afterId = "";
    for (;;) {
      const page = await store.listProfileSignatures({ afterId, limit: 4000 });
      if (!page.length) break;
      for (const row of page) signatures.push(signatureFromRow(row, corpusRegistry));
      afterId = page[page.length - 1]!.id;
    }
    return signatures;
  }
  const inputDigest = (signatures: readonly LanguageProfileSignature[]) => options.hasher.digestHex(canonicalStringify([...signatures]
    .sort((a, b) => a.id.localeCompare(b.id) || canonicalStringify(a).localeCompare(canonicalStringify(b)))));
  async function discover(signatures: LanguageProfileSignature[]): Promise<{ identities: LanguageIdentityRecord[]; assigned: number }> {
    const store = options.store!;
    const discovery = discoverLanguageIdentities({ signatures, hasher: options.hasher, now: options.now(), informationLabel: options.informationLabel });
    const digest = inputDigest(signatures);
    discovery.identities = discovery.identities.map(identity => ({ ...identity, discoveryRecipe: LANGUAGE_IDENTITY_DISCOVERY_RECIPE, discoveryInputDigest: digest }));
    if (store.replaceIdentities) await store.replaceIdentities(discovery.identities);
    else await store.putIdentities(discovery.identities);
    const assignments = [...discovery.assignments].map(([profileId, languageId]) => ({ profileId, languageId }));
    await store.assignProfileLanguages(assignments);
    return { identities: discovery.identities, assigned: assignments.length };
  }

  return {
    async ensure(input = {}) {
      if (ensuring) {
        const current = await ensuring;
        if (!input.rebuild && !input.finalize && !input.requiredProfileIds?.length && !(input.initializeIfMissing && current.readiness !== "ready")) return current;
      }
      ensuring = (async () => {
        const started = Date.now();
        if (!options.store) {
          readiness = "unavailable";
          return { identities: [], assigned: null, discovered: false, readiness, elapsedMs: 0 };
        }
        let identities = input.rebuild ? [] : await options.store.listIdentities();
        let discovered = false;
        let assignedCount: number | null = null;
        const stale = identities.some(identity => identity.schema !== LANGUAGE_IDENTITY_SCHEMA || !Array.isArray(identity.corpusRoles));
        readiness = stale ? "requires_rebuild" : identities.length ? "ready" : "missing";
        const required = [...new Set(input.requiredProfileIds ?? [])].sort();
        const assignments = required.length ? await options.store.listProfileLanguages({ profileIds: required }) : [];
        const assigned = new Map(assignments.map(row => [row.profileId, row.languageId]));
        const catalogIds = new Set(identities.map(identity => identity.id));
        const missingOwners = required.some(id => !catalogIds.has(assigned.get(id) ?? ""));
        const recipeStale = (input.finalize || required.length > 0) && identities.some(identity => identity.discoveryRecipe !== LANGUAGE_IDENTITY_DISCOVERY_RECIPE);
        const signatures = input.finalize ? await signaturesForDiscovery() : undefined;
        const changedPopulation = signatures !== undefined && identities.some(identity => identity.discoveryInputDigest !== inputDigest(signatures));
        if (input.rebuild || missingOwners || recipeStale || changedPopulation || (input.initializeIfMissing && readiness !== "ready")) {
          const result = await discover(signatures ?? await signaturesForDiscovery());
          identities = result.identities;
          assignedCount = result.assigned;
          discovered = true;
          readiness = identities.length ? "ready" : "missing";
        }
        loaded = readiness === "ready" ? identities : [];
        index();
        return { identities: loaded, assigned: assignedCount, discovered, readiness, elapsedMs: Date.now() - started };
      })();
      try { return await ensuring; }
      catch (error) { loaded = []; index(); readiness = "unavailable"; throw error; }
      finally { ensuring = undefined; }
    },
    identities: () => loaded,
    readiness: () => readiness,
    resolver: async requestedIds => {
      if (!loaded.length || !options.store) return undefined;
      const profileIds = [...new Set(requestedIds.filter(Boolean))].sort();
      const requested = new Set(profileIds);
      const assignments = profileIds.length ? await options.store.listProfileLanguages({ profileIds }) : [];
      const profileLanguage = new Map(assignments.filter(row => requested.has(row.profileId)).map(row => [row.profileId, row.languageId]));
      const families = new Map(familyLanguage);
      return {
        profile: profileId => profileLanguage.get(profileId),
        corpus: sourceSystem => (sourceSystem ? families.get(corpusFamilyForSourceSystem(sourceSystem)) : undefined)
      };
    },
    selectForSurface: (surface, selection = {}) => selectLanguageIdentityForSurface(loaded, surface, {
      ...selection,
      excludeCorpusRoleIds: [...new Set([CORPUS_ROLE_IDS.softwareSymbolic, ...(selection.excludeCorpusRoleIds ?? [])])]
    }),
    identityForFamily: family => loaded.find(identity => identity.id === familyLanguage.get(family))
  };
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  discoverLanguageIdentities,
  selectLanguageIdentityForSurface,
  type LanguageIdentityRecord,
  type LanguageProfileSignature
} from "./language-identity.js";
import { isLanguageWordSymbol } from "./language-identity.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "./storage.js";
import type { Hasher, InformationLabel } from "./types.js";

/** Resolves an artifact's language from what the artifact says about itself: its profile, or failing that its corpus. */
export interface LanguageResolver {
  profile(profileId: string): string | undefined;
  corpus(sourceSystem: string | undefined): string | undefined;
}

export interface LanguageIdentityRuntime {
  /** Load the persisted identities and assignments; discover and persist them first when none exist or on rebuild. */
  ensure(input?: { rebuild?: boolean }): Promise<{ identities: LanguageIdentityRecord[]; assigned: number; discovered: boolean; elapsedMs: number }>;
  identities(): readonly LanguageIdentityRecord[];
  resolver(): LanguageResolver | undefined;
  /** The identity a request surface is written in, once identities are loaded. */
  selectForSurface(surface: string): { identity: LanguageIdentityRecord; coverage: number } | undefined;
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

function signatureFromRow(row: LanguageProfileSignatureRow): LanguageProfileSignature {
  return {
    id: row.id,
    family: corpusFamilyForSourceUri(row.sourceUri),
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
}): LanguageIdentityRuntime {
  let loaded: LanguageIdentityRecord[] = [];
  let profileLanguage = new Map<string, string>();
  let familyLanguage = new Map<string, string>();
  let ensuring: Promise<{ identities: LanguageIdentityRecord[]; assigned: number; discovered: boolean; elapsedMs: number }> | undefined;

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

  async function discover(): Promise<{ identities: LanguageIdentityRecord[]; assigned: number }> {
    const store = options.store!;
    const signatures: LanguageProfileSignature[] = [];
    let afterId = "";
    for (;;) {
      const page = await store.listProfileSignatures({ afterId, limit: 4000 });
      if (!page.length) break;
      for (const row of page) signatures.push(signatureFromRow(row));
      afterId = page[page.length - 1]!.id;
    }
    const discovery = discoverLanguageIdentities({ signatures, hasher: options.hasher, now: options.now(), informationLabel: options.informationLabel });
    await store.putIdentities(discovery.identities);
    const assignments = [...discovery.assignments].map(([profileId, languageId]) => ({ profileId, languageId }));
    await store.assignProfileLanguages(assignments);
    return { identities: discovery.identities, assigned: assignments.length };
  }

  return {
    async ensure(input = {}) {
      if (ensuring) return ensuring;
      ensuring = (async () => {
        const started = Date.now();
        if (!options.store) return { identities: [], assigned: 0, discovered: false, elapsedMs: 0 };
        let identities = input.rebuild ? [] : await options.store.listIdentities();
        let discovered = false;
        let assigned = 0;
        if (!identities.length) {
          const result = await discover();
          identities = result.identities;
          assigned = result.assigned;
          discovered = true;
        }
        loaded = identities;
        profileLanguage = new Map((await options.store.listProfileLanguages()).map(row => [row.profileId, row.languageId]));
        if (!discovered) assigned = profileLanguage.size;
        index();
        return { identities, assigned, discovered, elapsedMs: Date.now() - started };
      })();
      try { return await ensuring; } finally { ensuring = undefined; }
    },
    identities: () => loaded,
    resolver: () => loaded.length
      ? {
        profile: profileId => profileLanguage.get(profileId),
        corpus: sourceSystem => (sourceSystem ? familyLanguage.get(corpusFamilyForSourceSystem(sourceSystem)) : undefined)
      }
      : undefined,
    selectForSurface: surface => selectLanguageIdentityForSurface(loaded, surface),
    identityForFamily: family => loaded.find(identity => identity.id === familyLanguage.get(family))
  };
}

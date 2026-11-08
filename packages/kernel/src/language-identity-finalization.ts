// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { LANGUAGE_IDENTITY_DISCOVERY_RECIPE, type LanguageIdentityRecord } from "./language-identity.js";
import type { LanguageIdentityRuntime } from "./language-identity-runtime.js";
import type { LanguageIdentityStore } from "./storage.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import type { Hasher } from "./types.js";

export async function inspectLanguageIdentityFinalization(input: {
  store: LanguageIdentityStore | undefined;
  runtime: LanguageIdentityRuntime;
  hasher: Hasher;
  readRevision?: () => Promise<string>;
  synchronize: () => Promise<void>;
  activeBrain: () => Promise<{ activeBrainVersion?: string; activeImportRunIds: string[] }>;
}) {
  const before = await input.readRevision?.();
  await input.synchronize();
  const [catalog, population, activeBrain] = await Promise.all([input.store?.listIdentities() ?? [], input.store?.profileAssignments?.(), input.activeBrain()]);
  const revision = await input.readRevision?.();
  const digest = (identities: readonly LanguageIdentityRecord[]) => canonicalDigestHex([...identities].sort((a, b) => a.id.localeCompare(b.id)), input.hasher);
  const persistedCatalogDigest = digest(catalog), loadedCatalogDigest = digest(input.runtime.identities());
  const ids = new Set(catalog.map(identity => identity.id));
  const profiles = population?.slice().sort((a, b) => a.profileId.localeCompare(b.profileId));
  const missingProfileCount = profiles?.filter(profile => profile.languageId === null).length ?? null;
  const unknownIdentityCount = profiles?.filter(profile => profile.languageId !== null && !ids.has(profile.languageId)).length ?? null;
  const recipeCurrent = catalog.length > 0 && catalog.every(identity => identity.discoveryRecipe === LANGUAGE_IDENTITY_DISCOVERY_RECIPE && Boolean(identity.discoveryInputDigest));
  const stable = typeof before === "string" && Boolean(before) && before === revision;
  const ready = stable && Boolean(profiles?.length) && missingProfileCount === 0 && unknownIdentityCount === 0
    && recipeCurrent && input.runtime.readiness() === "ready" && persistedCatalogDigest === loadedCatalogDigest
    && Boolean(activeBrain.activeBrainVersion || activeBrain.activeImportRunIds.length);
  return { schema: "scce.language_identity_finalization.v1" as const, ready, stable, revision: revision ?? null,
    profileCount: profiles?.length ?? null, assignedProfileCount: profiles ? profiles.length - (missingProfileCount ?? 0) - (unknownIdentityCount ?? 0) : null,
    missingProfileCount, unknownIdentityCount, identityCount: catalog.length, discoveryRecipe: LANGUAGE_IDENTITY_DISCOVERY_RECIPE, recipeCurrent,
    persistedCatalogDigest, loadedCatalogDigest, assignmentDigest: profiles ? canonicalDigestHex(profiles, input.hasher) : null,
    activeBrain, competenceVerified: false as const };
}

export type LanguageIdentityFinalizationManifest = Awaited<ReturnType<typeof inspectLanguageIdentityFinalization>>;

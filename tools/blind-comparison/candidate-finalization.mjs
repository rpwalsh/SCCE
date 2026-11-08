import { hash } from './protocol.mjs';

export function verifyCandidateFinalization(receipt) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  if (!receipt || receipt.schema !== 'scce.language_identity_finalization.v1' || receipt.ready !== true || receipt.stable !== true
    || receipt.recipeCurrent !== true || typeof receipt.revision !== 'string' || !receipt.revision
    || typeof receipt.discoveryRecipe !== 'string' || !receipt.discoveryRecipe || !Number.isSafeInteger(receipt.identityCount) || receipt.identityCount < 1
    || !Number.isSafeInteger(receipt.profileCount) || receipt.profileCount < 1 || receipt.assignedProfileCount !== receipt.profileCount
    || receipt.missingProfileCount !== 0 || receipt.unknownIdentityCount !== 0
    || !sha(receipt.assignmentDigest) || !sha(receipt.persistedCatalogDigest) || receipt.loadedCatalogDigest !== receipt.persistedCatalogDigest
    || !receipt.activeBrain || !(receipt.activeBrain.activeBrainVersion || receipt.activeBrain.activeImportRunIds?.length)
    || receipt.competenceVerified !== false) throw new Error('Candidate brain is not finalized: require current exact profile assignments, matching loaded catalog, stable durable revision, and actual brain activation; this check certifies no task competence.');
  return { receipt, digest: hash(receipt) };
}

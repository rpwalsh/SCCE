import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCandidateFinalization } from '../candidate-finalization.mjs';

const valid = () => ({ schema: 'scce.language_identity_finalization.v1', ready: true, stable: true, recipeCurrent: true, revision: '182', profileCount: 515,
  assignedProfileCount: 515, missingProfileCount: 0, unknownIdentityCount: 0, discoveryRecipe: 'scce.language_identity_discovery.v3', identityCount: 3, assignmentDigest: 'a'.repeat(64), persistedCatalogDigest: 'b'.repeat(64),
  loadedCatalogDigest: 'b'.repeat(64), activeBrain: { activeBrainVersion: 'actual.brain', activeImportRunIds: ['actual.import'] }, competenceVerified: false });
test('accepts actual coherent assignment/catalog receipt without claiming task competence', () => {
  const result = verifyCandidateFinalization(valid()); assert.match(result.digest, /^[a-f0-9]{64}$/u); assert.equal(result.receipt.competenceVerified, false);
});
test('refuses missing, stale, unassigned, mismatched and unactivated candidate preparation rather than silently freezing it', () => {
  for (const receipt of [undefined, {}, { ...valid(), assignedProfileCount: 514 }, { ...valid(), missingProfileCount: 1 }, { ...valid(), unknownIdentityCount: 1 },
    { ...valid(), loadedCatalogDigest: 'c'.repeat(64) }, { ...valid(), stable: false }, { ...valid(), recipeCurrent: false }, { ...valid(), activeBrain: { activeImportRunIds: [] } }, { ...valid(), competenceVerified: true }])
    assert.throws(() => verifyCandidateFinalization(receipt), /not finalized/u);
});

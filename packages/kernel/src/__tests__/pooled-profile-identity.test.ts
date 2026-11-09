// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { pooledProfileOwnerFixture } from "./fixtures/pooled-profile-owner.js";
import { classifyPooledLanguageSignature, discoverLanguageIdentities, languageProfileSignature } from "../language-identity.js";
import { createLanguageIdentityRuntime } from "../language-identity-runtime.js";
import { attachPooledLanguageProfileOwnership, preparePooledLanguageProfileBinding, validatePooledLanguageProfileOwnership } from "../pooled-language-profile-binding.js";
import type { LanguageIdentityRecord } from "../language-identity.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow } from "../storage.js";

const english = ["the river is in the valley and the water is blue.", "the house is in the garden and the tree is green.",
  "the bird is in the forest and the sky is clear.", "the boat is in the harbour and the sail is white."];
const spanish = ["el agua est\u00e1 en el valle y la casa es azul.", "el barco est\u00e1 en el puerto y la vela es blanca.", "el gato est\u00e1 en el patio y la hierba es verde.", "el libro est\u00e1 en el cuarto y la mesa es roja."];

it("cold-verifies exact pooled measurements and rejects changed, forged or partially owned input", () => {
  const fixture = pooledProfileOwnerFixture(english);
  const cold = JSON.parse(JSON.stringify(fixture.owned)) as typeof fixture.owned;
  expect(validatePooledLanguageProfileOwnership(cold, fixture.hasher)?.parents).toHaveLength(4);
  expect(() => validatePooledLanguageProfileOwnership({ ...cold, entropy: cold.entropy + 1 }, fixture.hasher)).toThrow("invalid pooled");
  expect(() => attachPooledLanguageProfileOwnership({ ...fixture.profile, entropy: fixture.profile.entropy + 1 }, fixture.binding, fixture.hasher)).toThrow("measurement changed");
  expect(() => attachPooledLanguageProfileOwnership(fixture.profile, { ...fixture.binding }, fixture.hasher)).toThrow("measurement changed");
  expect(() => preparePooledLanguageProfileBinding({ ...fixture, evidence: fixture.evidence.slice(1) })).toThrow("not source-owned");
});

it("assigns English and non-English aggregates from their own measurements without counting pages twice", async () => {
  const en = pooledProfileOwnerFixture(english, "fixture.en"), ru = pooledProfileOwnerFixture(spanish, "fixture.es");
  const samples = [...en.pages, ...ru.pages].map(page => languageProfileSignature(page.profile, "mixed")!);
  const discovery = discoverLanguageIdentities({ signatures: samples, hasher: en.hasher, now: 1 });
  expect(discovery.identities.reduce((count, identity) => count + identity.profileCount, 0)).toBe(8);
  const enId = classifyPooledLanguageSignature(discovery.identities, languageProfileSignature(en.owned, "irrelevant")!);
  const ruId = classifyPooledLanguageSignature(discovery.identities, languageProfileSignature(ru.owned, "irrelevant")!);
  expect(enId).toBeTruthy(); expect(ruId).toBeTruthy(); expect(ruId).not.toBe(enId);
  expect(classifyPooledLanguageSignature([...discovery.identities, { ...discovery.identities.find(identity => identity.id === enId)!, id: "ambiguous" }], languageProfileSignature(en.owned, "")!)).toBeUndefined();
  const row = (profile: typeof en.profile): LanguageProfileSignatureRow => {
    const signature = languageProfileSignature(profile, "")!;
    return { id: profile.id, sourceVersionId: profile.sourceVersionId, sourceSystem: "wikipedia", sourceUri: "", scripts: [...signature.scripts],
      direction: signature.direction, topContinuation: signature.topContinuation.map(([word, count]) => [word, count] as [string, number]) };
  };
  const rows = [...en.pages, ...ru.pages].map(page => row(page.profile));
  let identities: LanguageIdentityRecord[] = []; const assignments = new Map<string, string>();
  const store: LanguageIdentityStore = {
    async putIdentities(values) { identities = [...values]; }, async listIdentities() { return identities; },
    async assignProfileLanguages(values) { for (const item of values) assignments.set(item.profileId, item.languageId); },
    async listProfileLanguages(query) { return [...assignments].filter(([id]) => !query || query.profileIds.includes(id)).map(([profileId, languageId]) => ({ profileId, languageId })); },
    async listProfileSignatures(query) { return rows.filter(item => item.id > (query.afterId ?? "")).sort((a, b) => a.id.localeCompare(b.id)).slice(0, query.limit); },
    async listPooledProfileSignatures(query) { return [row(en.owned), row(ru.owned)].filter(value => value.id > (query.afterId ?? ""))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, query.limit); }
  };
  const runtime = createLanguageIdentityRuntime({ store, hasher: en.hasher, now: () => 1 });
  const result = await runtime.ensure({ rebuild: true });
  expect(result.identities.reduce((count, identity) => count + identity.profileCount, 0)).toBe(8);
  expect((await runtime.resolver([en.profile.id, ru.profile.id]))?.profile(en.profile.id)).toBe(enId);
  expect((await runtime.resolver([en.profile.id, ru.profile.id]))?.profile(ru.profile.id)).toBe(ruId);
});


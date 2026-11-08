// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageIdentityRuntime } from "../language-identity-runtime.js";
import { createSurfaceLanguageRuntime } from "../surface-language-runtime.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createClock, createHasher } from "../primitives.js";
import type { LanguageIdentityRecord } from "../language-identity.js";
import type { LanguageIdentityStore, LanguageProfileSignatureRow, ScceKernelDeps } from "../storage.js";

const hasher = createHasher();
function fixture() {
  let catalog: LanguageIdentityRecord[] = [];
  const rows: LanguageProfileSignatureRow[] = [];
  const assignments = new Map<string, string>();
  const signatures = vi.fn(async ({ afterId = "", limit }: { afterId?: string; limit: number }) => rows.filter(row => row.id > afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit));
  const replace = vi.fn(async (next: readonly LanguageIdentityRecord[]) => { catalog = [...next]; });
  const store: LanguageIdentityStore = { putIdentities: replace, replaceIdentities: replace, listIdentities: async () => catalog,
    listProfileSignatures: signatures, assignProfileLanguages: async next => { for (const row of next) assignments.set(row.profileId, row.languageId); },
    listProfileLanguages: async query => [...assignments].filter(([id]) => !query || query.profileIds.includes(id)).map(([profileId, languageId]) => ({ profileId, languageId })) };
  const add = (id: string, words: string[]) => rows.push({ id, sourceVersionId: `${id}:version` as never, sourceSystem: "dialogue", sourceUri: `file:///opaque/${id}`,
    scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr", topContinuation: [...words, id].map(word => [word, 1]) });
  return { store, rows, assignments, signatures, replace, add, catalog: () => catalog };
}

describe("off-turn identity finalization and serving revision", () => {
  it("assigns newly trained exact owners and upgrades cached recipe once without rediscovery on an unchanged replay", async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) f.add(`a${i}`, ["the", "and", "of"]);
    const runtime = createLanguageIdentityRuntime({ store: f.store, hasher, now: () => 1 });
    await runtime.ensure({ initializeIfMissing: true });
    for (let i = 0; i < 3; i++) f.add(`b${i}`, ["els", "amb", "dels"]);
    const upgraded = await runtime.ensure({ requiredProfileIds: ["b0", "b1", "b2"], initializeIfMissing: true });
    expect(upgraded).toMatchObject({ discovered: true, assigned: 6 });
    expect(["b0", "b1", "b2"].every(id => f.catalog().some(identity => identity.id === f.assignments.get(id)))).toBe(true);
    const reads = f.signatures.mock.calls.length, writes = f.replace.mock.calls.length;
    expect(await runtime.ensure({ requiredProfileIds: ["b0", "b1", "b2"], initializeIfMissing: true })).toMatchObject({ discovered: false });
    expect(f.signatures).toHaveBeenCalledTimes(reads); expect(f.replace).toHaveBeenCalledTimes(writes);
    expect(await runtime.ensure({ finalize: true, initializeIfMissing: true })).toMatchObject({ discovered: false });
    expect(f.replace).toHaveBeenCalledTimes(writes);
    f.add("c0", ["el", "con", "del"]);
    expect(await runtime.ensure({ finalize: true, initializeIfMissing: true })).toMatchObject({ discovered: true, assigned: 7 });
    expect(f.assignments.has("c0")).toBe(true);
  });

  it("reloads a changed durable catalog before a warm serving runtime selects a language, without source discovery", async () => {
    const f = fixture(); for (let i = 0; i < 3; i++) f.add(`a${i}`, ["the", "and", "of"]);
    const identities = createLanguageIdentityRuntime({ store: f.store, hasher, now: () => 1 });
    await identities.ensure({ initializeIfMissing: true });
    let revision = "1";
    const surface = createSurfaceLanguageRuntime({ deps: { storage: { languageMemory: { readRevision: async () => revision } } as unknown as ScceKernelDeps["storage"] },
      languageMemoryRuntime: createLanguageMemoryRuntime({ hasher }), hasher, clock: createClock({ fixedTime: 1 }), cacheMs: 1000, profileLimit: 32,
      onDurableRevision: () => identities.ensure() });
    await surface.synchronizeWithStorage();
    const external = createLanguageIdentityRuntime({ store: f.store, hasher, now: () => 2 });
    for (let i = 0; i < 3; i++) f.add(`b${i}`, ["els", "amb", "dels"]);
    await external.ensure({ rebuild: true, initializeIfMissing: true });
    revision = "2"; const reads = f.signatures.mock.calls.length;
    await surface.synchronizeWithStorage();
    expect(identities.identities().map(row => row.id)).toEqual(external.identities().map(row => row.id));
    expect(f.signatures).toHaveBeenCalledTimes(reads);
  });
});

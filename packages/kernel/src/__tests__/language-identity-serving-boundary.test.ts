// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createLanguageIdentityRuntime, languageIdentityProfileIdsForArtifacts } from "../language-identity-runtime.js";
import { LANGUAGE_IDENTITY_SCHEMA, type LanguageIdentityRecord } from "../language-identity.js";
import { createHasher } from "../primitives.js";
import type { LanguageIdentityStore } from "../storage.js";

const identity: LanguageIdentityRecord = { schema: LANGUAGE_IDENTITY_SCHEMA, id: "identity.owned", script: "script:Latn",
  directions: [], closedClass: [], families: [{ family: "wikipedia", count: 1 }], corpusRoles: [], profileCount: 1, membershipCut: 0, createdAt: 1 };

function fixture(identities = [identity]) {
  const assignments = new Map<string, string>([...[...Array(4000)].map((_, index) => [`unrequested:${index}`, "identity.foreign"] as const),
    ["Profile", identity.id], ["profile", "identity.foreign"]]);
  const listProfileLanguages = vi.fn(async (query?: { profileIds: readonly string[] }) =>
    [...(query ? query.profileIds : assignments.keys())].flatMap(profileId => assignments.has(profileId)
      ? [{ profileId, languageId: assignments.get(profileId)! }] : []));
  const listProfileSignatures = vi.fn(async () => []);
  const store: LanguageIdentityStore = { putIdentities: async () => undefined, listIdentities: async () => identities,
    assignProfileLanguages: async () => undefined, listProfileLanguages, listProfileSignatures };
  return { assignments, listProfileLanguages, listProfileSignatures,
    runtime: createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 1 }) };
}

describe("bounded serving language identity assignments", () => {
  it("collects all exact artifact owner fields, including observations and control patterns", () => {
    expect(languageIdentityProfileIdsForArtifacts({ profiles: [{ id: "Profile" }], units: [{ profileId: "profile" }],
      patterns: [{ profileId: "profile.control" }], models: [{ modelJson: { profileId: "profile.model", model: {} } }],
      observations: [{ metadata: { profileId: "profile.observation" } }], semanticFrames: [{ frameJson: { profileId: "profile.frame" } }]
    })).toEqual(["Profile", "profile", "profile.control", "profile.frame", "profile.model", "profile.observation"]);
  });
  it("loads no global assignment rows at startup and resolves only exact requested owner IDs", async () => {
    const f = fixture();
    const loaded = await f.runtime.ensure();
    expect(f.listProfileLanguages).not.toHaveBeenCalled();
    expect(f.listProfileSignatures).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({ readiness: "ready", assigned: null, discovered: false });
    const snapshot = await f.runtime.resolver(["Profile", "profile", "not-assigned", "Profile"]);
    expect(f.listProfileLanguages).toHaveBeenCalledTimes(1);
    expect(f.listProfileLanguages).toHaveBeenCalledWith({ profileIds: ["Profile", "not-assigned", "profile"] });
    expect(snapshot?.profile("Profile")).toBe(identity.id);
    expect(snapshot?.profile("profile")).toBe("identity.foreign");
    expect(snapshot?.profile("not-assigned")).toBeUndefined();
    expect(snapshot?.profile("unrequested:0")).toBeUndefined();
    expect(snapshot?.corpus("wikipedia")).toBe(identity.id);
  });

  it("keeps immutable per-hydration snapshots without accumulating assignments across requests", async () => {
    const f = fixture(); await f.runtime.ensure();
    const first = await f.runtime.resolver(["Profile"]);
    f.assignments.set("Profile", "identity.changed");
    const second = await f.runtime.resolver(["profile"]);
    const refreshed = await f.runtime.resolver(["Profile"]);
    expect(first?.profile("Profile")).toBe(identity.id);
    expect(second?.profile("Profile")).toBeUndefined();
    expect(second?.profile("profile")).toBe("identity.foreign");
    expect(refreshed?.profile("Profile")).toBe("identity.changed");
    expect(f.listProfileLanguages.mock.calls.every(([query]) => query?.profileIds.length === 1)).toBe(true);
  });

  it.each(["missing", "requires_rebuild"] as const)("reports %s catalog without corpus-wide rediscovery during serving", async readiness => {
    const f = fixture(readiness === "missing" ? [] : [{ ...identity, schema: "scce.language_identity.v1" } as unknown as LanguageIdentityRecord]);
    const result = await f.runtime.ensure();
    expect(result).toMatchObject({ readiness, assigned: null, discovered: false, identities: [] });
    expect(f.listProfileLanguages).not.toHaveBeenCalled();
    expect(f.listProfileSignatures).not.toHaveBeenCalled();
    expect(await f.runtime.resolver(["Profile"])).toBeUndefined();
  });

  it("does not let concurrent serving inspection suppress explicit initial discovery", async () => {
    let identities: LanguageIdentityRecord[] = [];
    const signatureReads = vi.fn(async (query: { afterId?: string }) => query.afterId ? [] : [{
      id: "initial.profile", sourceVersionId: "initial.source" as never, sourceSystem: "wikipedia", sourceUri: "wikipedia://initial",
      scripts: [{ script: "script:Latn", mass: 1 }], direction: "ltr", topContinuation: [["azurite", 3] as [string, number]]
    }]);
    const store: LanguageIdentityStore = { listIdentities: async () => identities, putIdentities: async rows => { identities = [...rows]; },
      assignProfileLanguages: async () => undefined, listProfileLanguages: async () => { throw Error("initialization must not enumerate assignments"); },
      listProfileSignatures: signatureReads };
    const runtime = createLanguageIdentityRuntime({ store, hasher: createHasher(), now: () => 1 });
    const [serving, initialized] = await Promise.all([runtime.ensure(), runtime.ensure({ initializeIfMissing: true })]);
    expect(serving).toMatchObject({ readiness: "missing", assigned: null, discovered: false });
    expect(initialized).toMatchObject({ readiness: "ready", assigned: 1, discovered: true });
    expect(initialized.identities).toHaveLength(1);
    expect(signatureReads).toHaveBeenCalledTimes(2);
    expect(await runtime.ensure()).toMatchObject({ readiness: "ready", assigned: null, discovered: false });
    expect(signatureReads).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable storage without claiming an initialized catalog", async () => {
    const runtime = createLanguageIdentityRuntime({ store: undefined, hasher: createHasher(), now: () => 1 });
    expect(await runtime.ensure()).toMatchObject({ readiness: "unavailable", assigned: null, identities: [], discovered: false });
    expect(runtime.readiness()).toBe("unavailable");
  });
});

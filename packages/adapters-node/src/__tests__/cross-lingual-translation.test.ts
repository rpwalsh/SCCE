// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createNgramMemoryCompiler, type InformationLabel, type JsonValue, type LanguageIdentityRecord, type LanguageProfile, type NgramModelRecord } from "@scce/kernel";
import { closedClassFor, compileCrossLingualTranslationSeeds, type CrossLingualTranslationStorage } from "../cross-lingual-translation.js";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

// Brick 2b wiring: read per-language bigrams and closed class, align by structure, store seeds. Validated with
// a fake storage so the plumbing is proven without a live multilingual brain (real validation comes when
// Arabic/Russian are co-trained after English). Two toy languages share nothing at the surface; only a hidden
// structural relabeling connects them.

const N = 8;
function fixedWeights(): number[][] {
  let seed = 1234567;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 1000) / 1000; };
  const w = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) w[i]![j] = 0.05 + next();
  return w;
}
const mass = (w: number[][], i: number) => w[i]!.reduce((a, b) => a + b, 0);

function bigramRows(w: number[][], relabel: (i: number) => number) {
  const rows: Array<{ previous: string; next: string; total: string }> = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) {
    rows.push({ previous: `x${relabel(i)}`, next: `x${relabel(j)}`, total: String(Math.round(w[i]![j]! * 100)) });
  }
  return rows;
}
const closedClass = (w: number[][], relabel: (i: number) => number) =>
  [...Array(N).keys()].sort((a, b) => mass(w, b) - mass(w, a)).map((i, rank) => ({ word: `x${relabel(i)}`, documentShare: 1 - rank * 0.05 }));

function fakeStorage(w: number[][], permutation: number[], options: { optimized?: boolean; models?: { source: JsonValue; target: JsonValue } } = {}) {
  const stored: Array<{ sourceLanguage: string; targetLanguage: string; seeds: unknown[] }> = [];
  let observationQueries = 0;
  const storage: CrossLingualTranslationStorage = {
    table: name => name,
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      if (sql.includes("language_profiles")) {
        const identity = params[0] === "identity:source" ? "profile:source" : "profile:target";
        return [{ id: identity }] as unknown as T[];
      }
      const profileIds = params[0] as string[];
      const source = profileIds?.includes("profile:source");
      const rows = source ? bigramRows(w, i => i) : bigramRows(w, i => 100 + permutation[i]!);
      if (sql.includes("ngram_models")) {
        if (!options.optimized) return [] as T[];
        const modelJson = options.models?.[source ? "source" : "target"];
        const counts = modelJson && typeof modelJson === "object" && !Array.isArray(modelJson)
          && typeof (modelJson as Record<string, unknown>).model === "object"
          ? ((modelJson as Record<string, unknown>).model as Record<string, unknown>).counts
          : Object.fromEntries(rows.map(row => [`${row.previous}\u0001${row.next}`, Number(row.total)]));
        const entries = counts && typeof counts === "object" && !Array.isArray(counts) ? Object.entries(counts as Record<string, unknown>) : [];
        return entries
          .filter(([key, count]) => key.split("\u0001").length === 2 && typeof count === "number")
          .map(([key, count]) => {
            const [previous, next] = key.split("\u0001");
            return { previous, next, total: count };
          }) as unknown as T[];
      }
      if (sql.includes("ngram_observations")) observationQueries++;
      return rows as unknown as T[];
    },
    languageIdentities: {
      async listIdentities() {
        return [
          { id: "identity:source", script: "script:Src", closedClass: closedClass(w, i => i), families: [] },
          { id: "identity:target", script: "script:Tgt", closedClass: closedClass(w, i => 100 + permutation[i]!), families: [] }
        ];
      }
    },
    translationSeeds: {
      async putSeeds(input) { stored.push({ sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage, seeds: [...input.seeds] }); }
    }
  };
  return { storage, stored, observationQueries: () => observationQueries };
}

function compiledModelJson(profileId: string, script: string, text: string): JsonValue {
  const hasher = createHasher();
  const compiler = createNgramMemoryCompiler({
    hasher,
    idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
  });
  const profile = {
    id: profileId,
    sourceVersionId: `source:${profileId}` as never,
    scripts: [{ script, mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "ltr" as const,
    entropy: 0,
    createdAt: 1
  };
  return compiler.compile({
    streamId: `stream:${profileId}`,
    profile,
    sourceVersionId: profile.sourceVersionId,
    text,
    evidence: [],
    createdAt: 1,
    maxOrder: 3
  }).models[0]!.modelJson;
}

describe("compiling cross-lingual translation seeds from ingested statistics", () => {
  it("aligns two languages and stores seeds, using only bigrams and closed class", async () => {
    const w = fixedWeights();
    const permutation = [3, 5, 0, 7, 1, 6, 2, 4];
    const { storage, stored } = fakeStorage(w, permutation);

    const result = await compileCrossLingualTranslationSeeds(storage, {
      sourceLanguage: "identity:source", targetLanguage: "identity:target",
      sourceScript: "script:Src", targetScript: "script:Tgt",
      observedAt: 1_700_000_000_000
    });

    expect(result.aligned).toBe(N);
    expect(result.seedCount).toBeGreaterThan(0);
    expect(stored).toHaveLength(1);
    // Most seeds are the correct structural correspondence: source x_i -> target x_{100+perm[i]}.
    const seeds = stored[0]!.seeds as Array<{ sourceSymbol: string; targetSymbol: string; basis: string }>;
    let correct = 0;
    for (const seed of seeds) {
      const i = Number(seed.sourceSymbol.slice(1));
      if (seed.targetSymbol === `x${100 + permutation[i]!}`) correct += 1;
      expect(seed.basis).toBe("shared_context");
    }
    expect(correct).toBeGreaterThanOrEqual(6);
  });

  it("uses the requested learned identity when scripts are shared", () => {
    const identities = [
      { id: "identity:english", script: "script:Latin", closedClass: [{ word: "the", documentShare: 0.9 }] },
      { id: "identity:german", script: "script:Latin", closedClass: [{ word: "der", documentShare: 0.9 } ] }
    ];
    expect(closedClassFor(identities, "identity:german", "script:Latin")).toEqual([{ word: "der", documentShare: 0.9 }]);
  });

  it("reads compiled model bigrams when optimized training omitted observations", async () => {
    const w = fixedWeights();
    const permutation = [3, 5, 0, 7, 1, 6, 2, 4];
    const sourceText = "a b c a b d a c b a d c a b";
    const targetText = "x y z x y w x z y x w z x y";
    const sourceModel = compiledModelJson("profile:source", "script:Src", sourceText);
    const targetModel = compiledModelJson("profile:target", "script:Tgt", targetText);
    const sourceCounts = (sourceModel as Record<string, unknown>).model as Record<string, unknown>;
    expect(sourceCounts.counts).toBeTruthy();
    const { storage, stored, observationQueries } = fakeStorage(w, permutation, {
      optimized: true,
      models: { source: sourceModel, target: targetModel }
    });
    const result = await compileCrossLingualTranslationSeeds(storage, {
      sourceLanguage: "identity:source", targetLanguage: "identity:target",
      sourceScript: "script:Src", targetScript: "script:Tgt", observedAt: 1_700_000_000_000
    });
    expect(result.seedCount).toBeGreaterThan(0);
    expect(stored).toHaveLength(1);
    expect(observationQueries()).toBe(0);
  });

  it("is a no-op, not a failure, when a language has no structure yet", async () => {
    const storage: CrossLingualTranslationStorage = {
      table: name => name,
      async query<T>(): Promise<T[]> { return [] as T[]; },
      languageIdentities: { async listIdentities() { return []; } },
      translationSeeds: { async putSeeds() { throw new Error("must not store when there is nothing to align"); } }
    };
    const result = await compileCrossLingualTranslationSeeds(storage, {
      sourceLanguage: "source", targetLanguage: "target", sourceScript: "a", targetScript: "b", observedAt: 0
    });
    expect(result.seedCount).toBe(0);
    expect(result.skippedReason).toContain("pass stable language identity ids");
  });
});

const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();

describe("cross-lingual translation against PostgreSQL", () => {
  (liveDatabaseUrl ? it : it.skip)("reads assigned profiles and compiled model counts with an empty observation table", async () => {
    const schema = `scce_translation_${randomUUID().replaceAll("-", "")}`;
    let adapter: PostgresStorageAdapter | undefined = createPostgresStorageAdapter({
      url: liveDatabaseUrl!, schema,
      informationAccess: { tenantId: "system", principalId: "system", compartments: [], maximumExportClass: "internal" }
    });
    expect(schema).toMatch(/^scce_translation_[a-f0-9]{32}$/u);
    let ownsSchema = false;
    const label: InformationLabel = { tenantId: "system", principals: ["system"], compartments: [], exportClass: "internal", mergePolicy: "isolated" };
    const sourceProfileId = "profile.live.source";
    const targetProfileId = "profile.live.target";
    const sourceIdentityId = "identity.live.source";
    const targetIdentityId = "identity.live.target";
    try {
      const namespace = await adapter.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists",
        [schema]
      );
      expect(namespace[0]?.exists).toBe(false);
      ownsSchema = true;
      await adapter.migrate();
      const sourceProfile: LanguageProfile = {
        id: sourceProfileId, sourceVersionId: "source.live.source" as never,
        scripts: [{ script: "script:Latin", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0, createdAt: 1, informationLabel: label
      };
      const targetProfile: LanguageProfile = {
        id: targetProfileId, sourceVersionId: "source.live.target" as never,
        scripts: [{ script: "script:Latin", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 0, createdAt: 1, informationLabel: label
      };
      await adapter.model.putLanguageProfiles!([sourceProfile, targetProfile]);
      const identity = (id: string, script: string, closedWord: string, profileCount: number): LanguageIdentityRecord => ({
        schema: "scce.language_identity.v1", id, script, directions: [{ direction: "ltr", count: profileCount }],
        closedClass: [{ word: closedWord, documentShare: 1 }], families: [], profileCount, membershipCut: 0, createdAt: 1, informationLabel: label
      });
      await adapter.languageIdentities.putIdentities([identity(sourceIdentityId, "script:Latin", "a", 1), identity(targetIdentityId, "script:Latin", "x", 1)]);
      await adapter.languageIdentities.assignProfileLanguages([
        { profileId: sourceProfileId, languageId: sourceIdentityId },
        { profileId: targetProfileId, languageId: targetIdentityId }
      ]);
      const models: NgramModelRecord[] = [
        { id: "model.live.source", streamId: "stream.live.source", languageHint: "script:Latin;direction:ltr", maxOrder: 3, discount: 0.75, modelJson: compiledModelJson(sourceProfileId, "script:Latin", "a b c a b d a c b a d c a b"), updatedAt: 1, informationLabel: label },
        { id: "model.live.target", streamId: "stream.live.target", languageHint: "script:Latin;direction:ltr", maxOrder: 3, discount: 0.75, modelJson: compiledModelJson(targetProfileId, "script:Latin", "x y z x y w x z y x w z x y"), updatedAt: 1, informationLabel: label }
      ];
      await adapter.languageMemory.putNgramModels!(models);
      const raw = await adapter.query<{ count: string }>(`SELECT COUNT(*)::bigint AS count FROM ${adapter.table("ngram_observations")}`);
      expect(Number(raw[0]?.count)).toBe(0);
      const assigned = await adapter.query<{ id: string; language_id: string }>(`SELECT id, language_id FROM ${adapter.table("language_profiles")} ORDER BY id`);
      expect(assigned).toEqual([
        { id: sourceProfileId, language_id: sourceIdentityId },
        { id: targetProfileId, language_id: targetIdentityId }
      ]);
      const result = await compileCrossLingualTranslationSeeds(adapter, {
        sourceLanguage: sourceIdentityId, targetLanguage: targetIdentityId,
        sourceScript: "script:Latin", targetScript: "script:Latin", observedAt: 1_700_000_000_000
      });
      expect(result.seedCount).toBeGreaterThan(0);
    } finally {
      if (adapter) {
        try {
          if (ownsSchema) await adapter.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await adapter.close();
        }
      }
    }
  });
});

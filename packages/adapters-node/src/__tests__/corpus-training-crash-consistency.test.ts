// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher, type ScceStorage } from "@scce/kernel";
import { trainLanguageCorpusText } from "../language-corpus-trainer.js";

// The shard training path no longer runs inside one Postgres transaction, because it held a backend in
// `idle in transaction` across a 54-second compile. That is only safe if a crash part-way through, followed by
// a resume, converges on the same state as an uninterrupted run. This proves it rather than arguing it.
//
// The property it rests on is the real store's write semantics, which this fake reproduces exactly:
//
//   ON CONFLICT(id) DO UPDATE SET count = EXCLUDED.count
//
// Replace, not `n.count + EXCLUDED.count`. Had n-gram counts been additive, re-running a shard after a crash
// would have DOUBLE-COUNTED the language model, and removing the transaction would have been a corruption bug.
// So the fake keys every table by id and replaces on conflict; if the production statement ever changes to
// increment, this test's premise is void and the transaction has to come back.

type Row = Record<string, unknown> & { id?: unknown };

interface Tables {
  sourceVersions: Map<string, Row>;
  evidence: Map<string, Row>;
  ngramObservations: Map<string, Row>;
  ngramModels: Map<string, Row>;
  languageUnits: Map<string, Row>;
  languagePatterns: Map<string, Row>;
  semanticFrames: Map<string, Row>;
  events: Map<string, Row>;
  blobs: Map<string, Uint8Array>;
}

function emptyTables(): Tables {
  return {
    sourceVersions: new Map(), evidence: new Map(), ngramObservations: new Map(),
    ngramModels: new Map(), languageUnits: new Map(), languagePatterns: new Map(),
    semanticFrames: new Map(), events: new Map(), blobs: new Map()
  };
}

/** Where a crash is injected: the first write to this table throws, as a lost connection would. */
type CrashAt = keyof Tables | "none";

function storage(tables: Tables, crashAt: CrashAt = "none"): ScceStorage {
  const hasher = createHasher();
  let crashed = false;
  const upsert = (table: keyof Tables, rows: readonly Row[]): void => {
    if (crashAt === table && !crashed) {
      crashed = true;
      throw new Error(`injected crash before writing ${table}`);
    }
    const target = tables[table] as Map<string, Row>;
    for (const row of rows) {
      const key = String(row.id ?? row.sourceVersionId ?? JSON.stringify(row));
      // Replace on conflict, exactly as the production upsert does.
      target.set(key, row);
    }
  };
  return {
    events: {
      append: async (event: Row) => upsert("events", [event]),
      appendBatch: async (events: readonly Row[]) => upsert("events", events),
      readEpisode: async () => [...tables.events.values()],
      readRange: async () => [...tables.events.values()],
      latestLedgerHash: async () => ""
    },
    evidence: {
      putSourceVersion: async (row: Row) => upsert("sourceVersions", [row]),
      putEvidenceSpan: async (row: Row) => upsert("evidence", [row]),
      putEvidenceSpans: async (rows: readonly Row[]) => upsert("evidence", rows),
      promoteEvidence: async (ids: readonly unknown[]) => ids.length,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [],
      sourceVersionsForEvidence: async () => [],
      listEvidenceBackedSourceVersions: async () => []
    },
    blobs: {
      put: async (bytes: Uint8Array) => {
        const hash = hasher.digestHex(Buffer.from(bytes));
        tables.blobs.set(hash, bytes);
        return hash;
      },
      get: async (hash: string) => {
        const found = tables.blobs.get(hash);
        if (!found) throw new Error(`no blob ${hash}`);
        return found;
      }
    },
    quarantine: { put: async () => undefined, get: async () => null, list: async () => [], decide: async () => undefined },
    model: {
      readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async () => undefined,
      listLanguageProfiles: async () => []
    },
    languageMemory: {
      putNgramObservation: async (row: Row) => upsert("ngramObservations", [row]),
      putNgramObservationsBatch: async (rows: readonly Row[]) => upsert("ngramObservations", rows),
      putNgramModel: async (row: Row) => upsert("ngramModels", [row]),
      putNgramModels: async (rows: readonly Row[]) => upsert("ngramModels", rows),
      putLanguageUnit: async (row: Row) => upsert("languageUnits", [row]),
      putLanguageUnits: async (rows: readonly Row[]) => upsert("languageUnits", rows),
      putLanguagePattern: async (row: Row) => upsert("languagePatterns", [row]),
      putLanguagePatterns: async (rows: readonly Row[]) => upsert("languagePatterns", rows),
      putSemanticFrame: async (row: Row) => upsert("semanticFrames", [row]),
      putSemanticFrames: async (rows: readonly Row[]) => upsert("semanticFrames", rows),
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => [],
      listNgramObservations: async () => [],
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => [],
      listTranslationAlignments: async () => []
    },
    graph: { getSlice: async () => { throw new Error("no graph in this fixture"); } },
    init: async () => undefined,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined
  } as unknown as ScceStorage;
}

const LABEL = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public" as const,
  provenanceClass: "public_corpus",
  retention: "corpus",
  legalBasis: "public_domain"
} as never;

/** Enough text to produce many n-gram rows, so a partial write is a real partial write. */
const TEXT = Array.from({ length: 40 }, (_, index) =>
  `Paragraph ${index}: the measured quantity varies between paragraphs because the words do, and the trainer `
  + `reads each of those rather than being told what they are worth.`).join("\n\n");

function shard(store: ScceStorage) {
  return trainLanguageCorpusText({
    storage: store,
    sourceSystem: "wikipedia",
    streamUri: "wiki://shard/crash-fixture",
    sourceUri: "wiki://shard/crash-fixture",
    text: TEXT,
    informationLabel: LABEL,
    createdAt: 1_000,
    // The shard path: no source rows of its own, which is the case the transaction was removed from.
    persistSource: false,
    evidence: []
  });
}

const fingerprint = (tables: Tables) => ({
  ngramObservations: [...tables.ngramObservations.keys()].sort(),
  ngramModels: [...tables.ngramModels.keys()].sort(),
  languageUnits: [...tables.languageUnits.keys()].sort(),
  languagePatterns: [...tables.languagePatterns.keys()].sort(),
  semanticFrames: [...tables.semanticFrames.keys()].sort()
});

describe("a shard that crashes mid-write converges on resume", () => {
  it("writes the same rows whether run once or twice, because every write is keyed and replaces", async () => {
    // Idempotence is the property the whole argument rests on: resume re-runs the shard, and re-running must
    // not accumulate. If n-gram counts were additive this would fail on the second pass.
    const tables = emptyTables();
    await shard(storage(tables));
    const afterFirst = fingerprint(tables);
    expect(afterFirst.ngramObservations.length).toBeGreaterThan(0);

    await shard(storage(tables));
    const afterSecond = fingerprint(tables);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("recovers to the uninterrupted state after crashing before the language patterns land", async () => {
    // The worst case the removed transaction used to cover: n-grams already written, patterns not yet. A single
    // transaction would have rolled both back; without one, the resume has to finish the job.
    const clean = emptyTables();
    await shard(storage(clean));
    const expected = fingerprint(clean);

    const crashed = emptyTables();
    await expect(shard(storage(crashed, "languagePatterns"))).rejects.toThrow(/injected crash/);
    // A partial state, by construction: some tables written, the one crashed on empty.
    expect(crashed.ngramObservations.size).toBeGreaterThan(0);
    expect(crashed.languagePatterns.size).toBe(0);
    expect(fingerprint(crashed)).not.toEqual(expected);

    // Resume, with a store that no longer fails.
    await shard(storage(crashed));
    expect(fingerprint(crashed)).toEqual(expected);
  });

  it("recovers from a crash at each write stage of the shard path", async () => {
    const clean = emptyTables();
    await shard(storage(clean));
    const expected = fingerprint(clean);

    for (const stage of ["ngramObservations", "ngramModels", "languageUnits", "languagePatterns", "semanticFrames"] as const) {
      const tables = emptyTables();
      await expect(shard(storage(tables, stage)), stage).rejects.toThrow(/injected crash/);
      await shard(storage(tables));
      expect(fingerprint(tables), `resume after crashing at ${stage}`).toEqual(expected);
    }
  });

  it("leaves no row a clean run would not have written", async () => {
    // Convergence must be exact in both directions: a resumed shard must not carry extra rows from its first
    // partial attempt, which is what would happen if any id were derived from attempt-local state such as a
    // timestamp or a counter rather than from content.
    const clean = emptyTables();
    await shard(storage(clean));
    const tables = emptyTables();
    await expect(shard(storage(tables, "languageUnits"))).rejects.toThrow(/injected crash/);
    await shard(storage(tables));

    for (const table of ["ngramObservations", "ngramModels", "languageUnits", "languagePatterns", "semanticFrames"] as const) {
      const extra = [...tables[table].keys()].filter(key => !clean[table].has(key));
      expect(extra, `${table} gained rows a clean run never wrote`).toEqual([]);
    }
  });
});

describe("the premise the crash tests rest on", () => {
  it("keeps the n-gram upsert a replace, never an increment", async () => {
    // Everything above is valid only because ON CONFLICT replaces the count. If that statement ever becomes
    // `count = n.count + EXCLUDED.count`, the fake above keeps passing while production silently doubles the
    // language model on every resumed shard -- a corruption no other test in the suite would notice. So the
    // statement itself is asserted, against the source, and this test fails the moment the premise changes.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "..", "postgres.ts"), "utf8");

    const upsertIndex = source.indexOf("INSERT INTO ${storage.table(\"ngram_observations\")}");
    expect(upsertIndex, "the ngram_observations upsert moved; find it and re-point this guard").toBeGreaterThan(-1);
    const statement = source.slice(upsertIndex, upsertIndex + 3_000);

    expect(statement).toContain("ON CONFLICT(id) DO UPDATE");
    expect(statement).toContain("SET count=EXCLUDED.count");
    // The shapes an accumulating write would take.
    expect(statement).not.toMatch(/count\s*=\s*n\.count\s*\+/);
    expect(statement).not.toMatch(/count\s*=\s*ngram_observations\.count\s*\+/);
    expect(statement).not.toMatch(/count\s*=\s*COALESCE\s*\(\s*n\.count/);
  });
});

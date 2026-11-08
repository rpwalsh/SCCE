// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as kernel from "@scce/kernel";
import * as trainer from "../language-corpus-trainer.js";
import { trainDialogueCorpus } from "../dialogue-corpus.js";
import type { IngestionCheckpoint, LanguagePatternProjection, LanguagePatternRecord, ScceStorage } from "@scce/kernel";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const label = { tenantId: "fixture.tenant", principals: ["fixture.owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scce-owned-acts-")); roots.push(root);
  const sources = new Map<string, { sourceId: string; sourceVersionId: string; profileId: string; span: Record<string, unknown> }>();
  const checkpoints = new Map<string, IngestionCheckpoint>(), patterns = new Map<string, LanguagePatternRecord>();
  const projections = new Map<string, LanguagePatternProjection>();
  let writes = 0;
  const key = (scope: Pick<LanguagePatternProjection, "sourceId" | "sourceSystem" | "patternSchema">) => kernel.canonicalStringify([scope.sourceId, scope.sourceSystem, scope.patternSchema]);
  const storage = { transaction: async <T>(operation: () => Promise<T>) => operation(),
    ingestion: { get: async (id: string) => checkpoints.get(id) ?? null, put: async (row: IngestionCheckpoint) => { writes++; checkpoints.set(row.id, row); } },
    model: { listLanguageProfiles: async (query: { sourceVersionIds?: string[] }) => [...sources.values()].filter(row => !query.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId)).map(row => ({ id: row.profileId, sourceVersionId: row.sourceVersionId })) },
    evidence: { sourceVersionById: async (id: string) => [...sources.values()].find(row => row.sourceVersionId === id) ?? null,
      searchEvidence: async (query: { sourceVersionId?: string }) => [...sources.values()].filter(row => !query.sourceVersionId || row.sourceVersionId === query.sourceVersionId).map(row => ({ span: row.span, score: 1 })),
      sourceVersionsForEvidence: async () => [...sources.values()] },
    languageMemory: {
      getLanguagePatternProjection: async (query: LanguagePatternProjection) => { const active = projections.get(key(query)); return active && active.profileId === query.profileId && active.sourceVersionId === query.sourceVersionId ? active : undefined; },
      replaceLanguagePatternProjection: async (input: { projection: LanguagePatternProjection; patterns: LanguagePatternRecord[] }) => {
        writes++; for (const row of input.patterns) patterns.set(row.id, row); projections.set(key(input.projection), structuredClone(input.projection));
      },
      putLanguagePatterns: async (rows: LanguagePatternRecord[]) => { for (const row of rows) patterns.set(row.id, row); },
      putLanguagePattern: async (row: LanguagePatternRecord) => { patterns.set(row.id, row); }
    }
  } as unknown as ScceStorage;
  const add = async (name: string, request: string, reply: string, commitmentScope: "conversation" | "external") => {
    const text = request + "\n" + reply, sourceUri = pathToFileURL(path.join(root, name)).href;
    const sourceVersionId = trainer.corpusSourceVersionIdFor({ text, sourceUri });
    const turns = [{ index: 0, speakerId: "owner", surface: request, startCodePoint: 0, endCodePoint: [...request].length },
      { index: 1, speakerId: "peer", surface: reply, startCodePoint: [...request].length + 1, endCodePoint: [...text].length, replyToTurnIndex: 0, commitmentScope }];
    await writeFile(path.join(root, name), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns }));
    const sourceId = `source.${name}`, profileId = `profile.${sourceVersionId}`;
    sources.set(name, { sourceId, sourceVersionId, profileId, span: { id: `evidence.${sourceVersionId}`, sourceId, sourceVersionId,
      charStart: 0, charEnd: [...text].length, text, status: "promoted", features: kernel.anchorFeatureSet(text) } });
  };
  const active = () => [...patterns.values()].filter(row => [...projections.values()].some(scope => scope.patternIds.includes(row.id)));
  const train = (options: Partial<Parameters<typeof trainDialogueCorpus>[0]> = {}) => trainDialogueCorpus({ rootPath: root, storage,
    authorship: "human_authored", informationLabel: label, actsOnly: true, ...options });
  return { root, storage, add, train, active, sources, checkpoints, projections, writes: () => writes };
}

it("publishes independent current owners across EN neutral, RU conversation, CA subsets and exact replay", async () => {
  const f = await fixture();
  await f.add("01-en.json", "kapa dun serik", "serik has a recorded value", "external");
  await f.train();
  await f.add("02-ru.json", "обсудим мою идею", "давай обсудим идею", "conversation");
  await f.train({ startFileIndex: 1, maxFilesPerRun: 1 });
  await f.add("03-ca.json", "parlem del projecte", "podem revisar el projecte", "conversation");
  await f.train({ startFileIndex: 2, maxFilesPerRun: 1 });
  expect(f.active().filter(row => (row.patternJson as { schema?: string }).schema === kernel.REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA)).toHaveLength(3);
  const model = kernel.requestCommunicativeActModelFromPatterns(f.active())!;
  expect(model.classCounts[kernel.DIALOGUE_ACT_IDS.neutral]).toBe(1);
  expect(Object.values(model.classCounts).reduce((sum, count) => sum + count, 0)).toBe(3);
  const writes = f.writes(), compile = vi.spyOn(kernel, "compileRequestCommunicativeActModel");
  await f.train({ startFileIndex: 2, maxFilesPerRun: 1 });
  expect(compile).not.toHaveBeenCalled(); expect(f.writes()).toBe(writes);
  await f.add("02-ru.json", "обсудим другой вопрос", "давай обсудим вопрос", "conversation");
  await f.train({ startFileIndex: 1, maxFilesPerRun: 1 });
  expect(Object.values(kernel.requestCommunicativeActModelFromPatterns(f.active())!.classCounts).reduce((sum, count) => sum + count, 0)).toBe(3);
  const ru = [...f.projections.values()].find(scope => scope.sourceId === "source.02-ru.json")!;
  await f.storage.languageMemory.replaceLanguagePatternProjection!({ projection: { ...ru, patternIds: [] }, patterns: [] });
  expect(Object.values(kernel.requestCommunicativeActModelFromPatterns(f.active())!.classCounts).reduce((sum, count) => sum + count, 0)).toBe(2);
});

it("upgrades a normal cached-source replay once, then skips auxiliary preparation and writes", async () => {
  const f = await fixture(); await f.add("source.json", "kapa dun", "the value is recorded", "external");
  vi.spyOn(trainer, "readCompletedCorpusCheckpoint").mockImplementation(async input => ({ sourceVersionId: trainer.corpusSourceVersionIdFor({ sourceUri: input.sourceUri!, text: input.text }) }) as never);
  const trainBody = vi.spyOn(trainer, "trainLanguageCorpusText").mockRejectedValue(new Error("cached source must not retrain"));
  const first = await f.train({ actsOnly: false });
  expect(first.communicativeActs.patternsPersisted).toBe(1); expect(trainBody).not.toHaveBeenCalled();
  const writes = f.writes(), compile = vi.spyOn(kernel, "compileRequestCommunicativeActModel");
  await f.train({ actsOnly: false });
  expect(compile).not.toHaveBeenCalled(); expect(trainBody).not.toHaveBeenCalled(); expect(f.writes()).toBe(writes);
});

it("attributes a single pooled measurement once per source and preserves it on a smaller replay shard", async () => {
  const f = await fixture();
  await f.add("01.json", "parlem del projecte", "podem revisar el projecte", "conversation");
  await f.add("02.json", "look at the pump feed", "compare the pump feed with the earlier pump feed", "conversation");
  await f.add("03.json", "kapa dun serik", "serik has a recorded value", "external");
  const sources = await Promise.all(["01.json", "02.json", "03.json"].map(async name => JSON.parse(await readFile(path.join(f.root, name), "utf8"))));
  const pooled = kernel.compileRequestCommunicativeActModel(kernel.dialogueRequestActObservations(sources).observations);
  await f.train();
  const actual = kernel.requestCommunicativeActModelFromPatterns(f.active())!;
  expect(actual.classCounts).toEqual(pooled.classCounts);
  expect(actual.features).toEqual(pooled.features);
  const before = structuredClone(f.active()), writes = f.writes(), compile = vi.spyOn(kernel, "compileRequestCommunicativeActModel");
  await f.train({ startFileIndex: 0, maxFilesPerRun: 1 });
  expect(compile).not.toHaveBeenCalled(); expect(f.writes()).toBe(writes + 1);
  expect(f.active()).toEqual(before);
  const subsetWrites = f.writes();
  await f.train({ startFileIndex: 0, maxFilesPerRun: 1 });
  expect(f.writes()).toBe(subsetWrites); expect(compile).not.toHaveBeenCalled();
});

it("records a fully processed empty component once instead of retrying model preparation forever", async () => {
  const f = await fixture(); await f.add("source.json", "kapa dun", "the value is recorded", "external");
  const text = "kapa dun\nthe value is recorded";
  await writeFile(path.join(f.root, "source.json"), JSON.stringify({ schema: "scce.dialogue_transcript.v1", text, turns: [] }));
  const first = await f.train();
  expect(first.communicativeActs.patternsPersisted).toBe(0);
  expect([...f.projections.values()][0]!.patternIds).toEqual([]);
  const writes = f.writes(), compile = vi.spyOn(kernel, "compileRequestCommunicativeActModel");
  await f.train(); expect(compile).not.toHaveBeenCalled(); expect(f.writes()).toBe(writes);
});

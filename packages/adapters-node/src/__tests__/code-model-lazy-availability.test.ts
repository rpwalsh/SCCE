// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import type { NgramModelRecord } from "@scce/kernel";
import { createLearnedCodeProposer } from "../learned-code-proposer.js";

const input = { request: "opaque source repair", context: { targetPath: "source.go", targetText: "package source\n", language: "go", symbols: [], imports: [] }, diagnostics: [], attempt: 1 };

it("does not read models to report availability, then shares one actual learned load and distinguishes measured zero", async () => {
  let reads = 0;
  let release!: (records: NgramModelRecord[]) => void;
  const pending = new Promise<NgramModelRecord[]>(resolve => { release = resolve; });
  const proposer = createLearnedCodeProposer({ storage: { languageMemory: { listNgramModels: async () => { reads++; return pending; } } } as never });
  expect(proposer.corpusAvailability("go")).toEqual({ languageId: "go", modelLimit: 96, countSemantics: "admitted_run_models", status: "unqueried", modelsAvailable: null });
  const detached = proposer.corpusAvailability("go");
  Object.assign(detached, { status: "loaded", modelsAvailable: 99 });
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "unqueried", modelsAvailable: null });
  expect(reads).toBe(0);
  const first = proposer.propose(input), concurrent = proposer.propose({ ...input, attempt: 2 });
  expect(reads).toBe(1);
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "loading", modelsAvailable: null });
  release([]);
  expect(await Promise.all([first, concurrent])).toEqual([undefined, undefined]);
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "loaded", modelsAvailable: 0, countSemantics: "admitted_run_models" });
  expect(await proposer.propose({ ...input, attempt: 3 })).toBeUndefined();
  expect(await proposer.availableModelCount("go")).toBe(0);
  expect(reads).toBe(1);
  expect(proposer.corpusAvailability("python")).toMatchObject({ status: "unqueried", modelsAvailable: null });
});

it("does not turn a failed model read into an observed zero-model corpus", async () => {
  let reads = 0;
  const proposer = createLearnedCodeProposer({ storage: { languageMemory: { listNgramModels: async () => { reads++; throw new Error("unavailable source records"); } } } as never });
  await expect(proposer.propose(input)).rejects.toThrow("unavailable source records");
  expect(proposer.corpusAvailability("go")).toMatchObject({ status: "failed", modelsAvailable: null });
  await expect(proposer.propose({ ...input, attempt: 2 })).rejects.toThrow("unavailable source records");
  expect(reads).toBe(1);
});

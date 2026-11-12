// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { CONTEXTUAL_QA_COMPILER_FINGERPRINT, createHasher, toJsonValue,
  type IngestionCheckpoint, type ScceStorage } from "@scce/kernel";
import { prepareDialogueSourceComponentBinding, runDialogueContextualQaComponent } from "../dialogue-conversational-checkpoint.js";

it("never treats an empty contextual-QA publication as a completed checkpoint", async () => {
  const rootUri = "fixture://contextual-qa-v5", informationLabel = { tenantId: "owner", principals: ["owner"], compartments: [],
    exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const sources = [{ sourceUri: "fixture://contextual-qa-v5/source", sourceVersionId: "version.source",
    contentHash: "sha256_source", byteLength: 17, transcriptDigest: "sha256_transcript" }];
  const { binding, byteLength } = prepareDialogueSourceComponentBinding({ rootUri, informationLabel, authorship: "human_authored", sources });
  const contentHash = createHasher().digestHex(binding), id = `dialogue_contextual_qa_compilation_${contentHash}`;
  const checkpoints = new Map<string, IngestionCheckpoint>([[id, { id, rootUri, itemUri: rootUri, phase: "stored", status: "complete",
    offsetBytes: byteLength, contentHash: contentHash as IngestionCheckpoint["contentHash"], byteLength, updatedAt: 1,
    metadata: toJsonValue({ schema: "scce.dialogue_contextual_qa_compilation.v1", binding,
      compilerFingerprint: CONTEXTUAL_QA_COMPILER_FINGERPRINT, projections: [] }) }]]);
  const storage = {
    ingestion: { get: async (key: string) => checkpoints.get(key) ?? null,
      put: async (row: IngestionCheckpoint) => { checkpoints.set(row.id, structuredClone(row)); }, list: async () => [...checkpoints.values()] },
    languageMemory: { getLanguagePatternProjection: async () => undefined, listLanguagePatterns: async () => [] },
    transaction: async <T>(work: () => Promise<T>) => work()
  } as unknown as ScceStorage;
  const compile = vi.fn(async () => ({ report: "compiled", projections: [] }));
  const input = { storage, rootUri, informationLabel, authorship: "human_authored", sources, compile, unchanged: () => "unchanged" };

  expect(await runDialogueContextualQaComponent(input)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(1);
  const metadata = checkpoints.get(id)!.metadata as Record<string, unknown>;
  expect(metadata.compilerFingerprint).toBe(CONTEXTUAL_QA_COMPILER_FINGERPRINT);
  expect(CONTEXTUAL_QA_COMPILER_FINGERPRINT).toBe("kernel.dialogue_contextual_qa.compiler.v12");
  expect(metadata.projections).toEqual([]);

  expect(await runDialogueContextualQaComponent(input)).toBe("compiled");
  expect(compile).toHaveBeenCalledTimes(2);
});

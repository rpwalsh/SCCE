// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareExtractiveQa } from "../../../../tools/prepare-extractive-qa.mjs";
import { validateDeclaredTranscriptSource } from "../dialogue-communicative-act-learning.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scce-extractive-preparation-")); roots.push(root);
  const context = "\ud83e\udded \u00c5ster \ua66e 907.", answer = "907";
  const paragraph = (id: string) => ({ context, qas: [
    { id, question: "\u27e1 \u00c5ster \u22b9?", is_impossible: false, answers: [{ text: answer, answer_start: [...context].length - 4 }] },
    { id: `${id}.second`, question: "\u00c5ster \u22b9?", is_impossible: false, answers: [{ text: answer, answer_start: [...context].length - 4 }] },
    { id: `${id}.unanswerable`, question: "opaque?", is_impossible: true, answers: [] }
  ] });
  const source = { version: "v2.0", data: [{ title: "original.article.one", paragraphs: [paragraph("qa.1"), paragraph("qa.2")] },
    { title: "original.article.two", paragraphs: [paragraph("qa.3")] }] };
  const inputPath = join(root, "train.json");
  const write = async () => { const bytes = JSON.stringify(source); await writeFile(inputPath, bytes); return {
    dataset: "test-authored-extractive-fixture", source: "fixture://pinned-human-extractive-training", split: "train", authorship: "human_authored",
    sourceLicense: "fixture", sha256: createHash("sha256").update(bytes).digest("hex") }; };
  return { root, source, inputPath, context, write };
}
it("stores each paragraph once, verifies code-point answer offsets and preserves QA IDs and original article holdouts across shards", async () => {
  const f = await fixture(), metadata = await f.write();
  const prep = async (name: string, maxOutputFileBytes: number) => {
    const outputDir = join(f.root, name), result = await prepareExtractiveQa({ inputPath: f.inputPath, outputDir, metadata, limits: { maxOutputFileBytes } });
    const raw = await Promise.all(result.outputs.map(async output => JSON.parse(await readFile(join(outputDir, output.path), "utf8"))));
    const docs = raw.map(validateDeclaredTranscriptSource);
    return { result, raw, docs, turns: docs.flatMap(doc => doc.turns) };
  };
  const whole = await prep("whole", 100000), sharded = await prep("sharded", 1600);
  expect(whole.result.preparation).toMatchObject({ paragraphs: 3, questions: 9, prepared: 6, unanswerable: 3, ambiguousAnnotations: 0, holdoutPartition: "original_article" });
  expect(sharded.result.outputs.length).toBeGreaterThan(whole.result.outputs.length);
  expect(sharded.turns.map(turn => [turn.sourceRecordId, turn.sourceFamilyId])).toEqual(whole.turns.map(turn => [turn.sourceRecordId, turn.sourceFamilyId]));
  expect(new Set(whole.turns.map(turn => turn.sourceRecordId))).toEqual(new Set(["qa.1", "qa.1.second", "qa.2", "qa.2.second", "qa.3", "qa.3.second"]));
  expect(whole.turns[0]!.sourceFamilyId).toBe(whole.turns[4]!.sourceFamilyId);
  expect(whole.turns[0]!.sourceFamilyId).not.toBe(whole.turns[8]!.sourceFamilyId);
  expect(whole.raw[0].text.split(f.context)).toHaveLength(4);
  expect(whole.raw[0].turns.filter(turn => turn.supportingSourceRanges).every(turn => turn.supportingSourceRanges.every(range => !Object.hasOwn(range, "surface")))).toBe(true);
  expect(whole.turns.filter(turn => turn.supportingSourceRanges).every(turn => turn.supportingSourceRanges!.every(range => range.surface === f.context))).toBe(true);
  const wrong = structuredClone(whole.raw[0]); wrong.turns[1].supportingSourceRanges[0].surface = "foreign context";
  expect(() => validateDeclaredTranscriptSource(wrong)).toThrow("invalid declared transcript support");
});
it("rejects changed hashes, invalid original offsets and duplicate original QA IDs without publishing partial output", async () => {
  const f = await fixture(), metadata = await f.write(), outputDir = join(f.root, "rejected");
  await expect(prepareExtractiveQa({ inputPath: f.inputPath, outputDir, metadata: { ...metadata, sha256: "0".repeat(64) } })).rejects.toThrow("SHA-256 mismatch");
  f.source.data[0]!.paragraphs[0]!.qas[0]!.answers[0]!.answer_start--;
  await expect(prepareExtractiveQa({ inputPath: f.inputPath, outputDir, metadata: await f.write() })).rejects.toThrow("invalid original answer offset");
  expect((await readdir(f.root)).sort()).toEqual(["train.json"]);
  f.source.data[0]!.paragraphs[0]!.qas[0]!.answers[0]!.answer_start++;
  f.source.data[1]!.paragraphs[0]!.qas[0]!.id = "qa.1";
  await expect(prepareExtractiveQa({ inputPath: f.inputPath, outputDir, metadata: await f.write() })).rejects.toThrow("repeated original QA identity");
  expect((await readdir(f.root)).sort()).toEqual(["train.json"]);
});

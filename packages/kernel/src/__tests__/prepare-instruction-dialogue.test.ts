import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareInstructionDialogue } from "../../../../tools/prepare-instruction-dialogue.mjs";
import { validateDeclaredTranscriptSource } from "../dialogue-communicative-act-learning.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function metadata(categoryCommitmentScopes: Record<string, "conversation" | "external"> = {
  creative_writing: "conversation",
  open_qa: "external"
}) {
  return {
    dataset: "fixture/opaque-instructions",
    uri: "https://example.invalid/datasets/opaque-instructions/tree/0123456789abcdef0123456789abcdef01234567",
    pinnedRevision: "0123456789abcdef0123456789abcdef01234567",
    license: "CC-BY-SA-3.0",
    attribution: "Synthetic fixture attribution.",
    shareAlikeNotice: "Synthetic fixture share-alike notice.",
    changeNotice: "Synthetic fixture transformation notice.",
    categoryCommitmentScopes
  };
}

async function fixtureDirectory() {
  const root = await mkdtemp(join(tmpdir(), "prepare-instruction-dialogue-"));
  roots.push(root);
  return root;
}

describe("instruction dialogue preparation", () => {
  it("writes NFC speech spans and keeps context only as non-speech support ranges", async () => {
    const root = await fixtureDirectory();
    const inputPath = join(root, "opaque.jsonl");
    const input = [
      { instruction: "A\u030a🪶", response: "ž𐐷", context: "𐐷 source — context", category: "creative_writing" },
      { instruction: "what value?", response: "µ", context: "", category: "open_qa" }
    ];
    const inputBytes = Buffer.from(input.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await writeFile(inputPath, inputBytes);

    const result = await prepareInstructionDialogue({
      inputPath,
      outputDir: join(root, "prepared"),
      metadata: metadata()
    });
    const trainingRoot = join(root, "prepared", result.preparation.transcriptDirectory);
    const trainingEntries = await readdir(trainingRoot, { withFileTypes: true });
    expect(result.preparation.transcriptDirectory).toBe("transcripts");
    expect(trainingEntries.every(entry => entry.isFile() && entry.name.endsWith(".json"))).toBe(true);
    expect(trainingEntries.map(entry => `transcripts/${entry.name}`).sort()).toEqual(result.outputs.map(output => output.path).sort());
    const shard = JSON.parse(await readFile(join(root, "prepared", result.outputs[0]!.path), "utf8"));
    const validated = validateDeclaredTranscriptSource(shard);
    const points = [...validated.text];

    expect(validated.schema).toBe("scce.dialogue_transcript.v1");
    expect(validated.text).toBe(validated.text.normalize("NFC"));
    expect(validated.turns.map(turn => turn.surface)).toEqual(["Å🪶", "ž𐐷", "what value?", "µ"]);
    expect(validated.turns[1]).toMatchObject({ replyToTurnIndex: 0, commitmentScope: "conversation" });
    expect(validated.turns[3]).toMatchObject({ replyToTurnIndex: 2, commitmentScope: "external" });
    expect(validated.turns[1]!.supportingSourceRanges).toHaveLength(1);
    const contextRange = validated.turns[1]!.supportingSourceRanges![0]!;
    expect(points.slice(contextRange.startCodePoint, contextRange.endCodePoint).join("")).toBe("𐐷 source — context");
    expect(validated.turns.some(turn => turn.surface.includes("source"))).toBe(false);
    expect(result.source.rawJsonlSha256).toBe(createHash("sha256").update(inputBytes).digest("hex"));
    expect(result.source.rawJsonlBytes).toBe(inputBytes.byteLength);
    expect(result.preparation.recordsPrepared).toBe(2);
    expect(result.outputs[0]!.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.source.shareAlikeNotice).toBe(metadata().shareAlikeNotice);
    expect(result.preparation.categoryCommitmentScopes).toEqual(metadata().categoryCommitmentScopes);
    expect("generatedAt" in result).toBe(false);
    for (const entry of trainingEntries) {
      const declared = validateDeclaredTranscriptSource(JSON.parse(await readFile(join(trainingRoot, entry.name), "utf8")));
      expect(declared.schema).toBe("scce.dialogue_transcript.v1");
    }
    expect((await readdir(join(root, "prepared"))).sort()).toEqual(["manifest.json", "transcripts"]);
  });

  it("uses only the explicit category mapping, regardless of instruction wording", async () => {
    const root = await fixtureDirectory();
    const inputPath = join(root, "opaque.jsonl");
    const rows = [
      { instruction: "What is 1 + 1?", response: "two", context: "", category: "creative_writing" },
      { instruction: "write a story", response: "opaque", context: "", category: "open_qa" }
    ];
    await writeFile(inputPath, rows.map(row => JSON.stringify(row)).join("\n"), "utf8");

    const result = await prepareInstructionDialogue({ inputPath, outputDir: join(root, "prepared"), metadata: metadata() });
    const shard = JSON.parse(await readFile(join(root, "prepared", result.outputs[0]!.path), "utf8"));

    expect(shard.turns[1]!.commitmentScope).toBe("conversation");
    expect(shard.turns[3]!.commitmentScope).toBe("external");
  });

  it("rejects an unmapped source category without leaving partial output", async () => {
    const root = await fixtureDirectory();
    const inputPath = join(root, "opaque.jsonl");
    const outputDir = join(root, "prepared");
    await writeFile(inputPath, `${JSON.stringify({ instruction: "x", response: "y", context: "", category: "unmapped" })}\n`, "utf8");

    await expect(prepareInstructionDialogue({ inputPath, outputDir, metadata: metadata() })).rejects.toThrow(/unmapped category/u);
    await expect(readFile(join(outputDir, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays byte-for-byte and enforces the configured shard cap", async () => {
    const root = await fixtureDirectory();
    const inputPath = join(root, "opaque.jsonl");
    await writeFile(inputPath, `${JSON.stringify({ instruction: "x", response: "y", context: "", category: "open_qa" })}\n`, "utf8");
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    const first = await prepareInstructionDialogue({ inputPath, outputDir: firstDir, metadata: metadata() });
    const second = await prepareInstructionDialogue({ inputPath, outputDir: secondDir, metadata: metadata() });

    expect(await readFile(join(firstDir, "manifest.json"), "utf8")).toBe(await readFile(join(secondDir, "manifest.json"), "utf8"));
    expect((await readFile(join(firstDir, first.outputs[0]!.path))).equals(await readFile(join(secondDir, second.outputs[0]!.path)))).toBe(true);
    await expect(prepareInstructionDialogue({
      inputPath,
      outputDir: join(root, "too-small"),
      metadata: metadata(),
      limits: { maxOutputFileBytes: 64 }
    })).rejects.toThrow(/cannot fit maxOutputFileBytes/u);
    await expect(prepareInstructionDialogue({
      inputPath,
      outputDir: join(root, "too-many-files"),
      metadata: metadata(),
      limits: { maxOutputFiles: 1 }
    })).rejects.toThrow(/maxOutputFiles/u);
    await expect(prepareInstructionDialogue({
      inputPath,
      outputDir: join(root, "too-many-bytes"),
      metadata: metadata(),
      limits: { maxOutputBytes: 64 }
    })).rejects.toThrow(/maxOutputBytes/u);
    await expect(prepareInstructionDialogue({
      inputPath,
      outputDir: join(root, "too-large-input"),
      metadata: metadata(),
      limits: { maxInputBytes: 1 }
    })).rejects.toThrow(/maxInputBytes/u);
  });
});

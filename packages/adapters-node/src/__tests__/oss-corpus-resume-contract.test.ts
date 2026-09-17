import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import type { ScceStorage } from "@scce/kernel";
import { inspectEngineeringCorpusFolder } from "../engineering-corpus-folder.js";
import {
  boundedOssHeapCheckpointMb,
  ingestMaterialSnapshot,
  trainOssCorpus
} from "../oss-corpus.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-oss-resume-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "fixture docs\n", "utf8");
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "b.ts"), "export const b = 2;\n", "utf8");
  return root;
}

async function measuredSnapshot(root: string): Promise<string> {
  const inspection = await inspectEngineeringCorpusFolder(root, {
    maxFiles: 10,
    maxFileBytes: 100_000,
    maxDepth: 12,
    includeUnsupported: false
  });
  return ingestMaterialSnapshot(inspection.files.filter(file => file.importable)).snapshotHash;
}

describe("OSS corpus resume contract", () => {
  it("requires the previous snapshot hash before resuming a mutable local checkout", async () => {
    const root = await fixture();
    await expect(trainOssCorpus({
      storage: {} as ScceStorage,
      rootPath: root,
      startFileIndex: 1,
      maxFiles: 10,
      maxFilesPerRun: 1
    })).rejects.toThrow(/requires expectedSnapshotHash/iu);
  });

  it("refuses a resume when the local ingest material changed before storage is touched", async () => {
    const root = await fixture();
    const previousSnapshot = await measuredSnapshot(root);
    await writeFile(path.join(root, "src", "b.ts"), "export const b = 3;\n", "utf8");

    await expect(trainOssCorpus({
      storage: {} as ScceStorage,
      rootPath: root,
      startFileIndex: 1,
      expectedSnapshotHash: previousSnapshot,
      maxFiles: 10,
      maxFilesPerRun: 1
    })).rejects.toThrow(/snapshot changed/iu);
  });

  it("keeps maxFiles as the repository inventory ceiling rather than silently redefining it as the run window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-oss-inventory-"));
    roots.push(root);
    // Unsupported files consume the scanner's inventory ceiling but never enter training, so this exercises the
    // bound without needing a storage fixture or depending on current heap usage.
    await writeFile(path.join(root, "one.unknown"), "one\n", "utf8");
    await writeFile(path.join(root, "two.unknown"), "two\n", "utf8");

    const report = await trainOssCorpus({
      storage: {} as ScceStorage,
      rootPath: root,
      maxFiles: 1,
      maxFilesPerRun: 1
    });
    expect(report.inspectionTruncated).toBe(true);
    expect(report.snapshotComplete).toBe(false);
    expect(report.filesConsidered).toBe(0);
  });

  it("hashes ingest material independent of input order", () => {
    const left = ingestMaterialSnapshot([
      { path: "src/a.ts", contentHash: "a" },
      { path: "README.md", contentHash: "b" }
    ]);
    const right = ingestMaterialSnapshot([
      { path: "README.md", contentHash: "b" },
      { path: "src/a.ts", contentHash: "a" }
    ]);
    expect(left.snapshotHash).toBe(right.snapshotHash);
  });

  it("never places the default checkpoint above the process's real V8 heap ceiling", () => {
    const limitMb = Math.floor(getHeapStatistics().heap_size_limit / (1024 * 1024));
    expect(boundedOssHeapCheckpointMb()).toBeGreaterThan(0);
    expect(boundedOssHeapCheckpointMb()).toBeLessThan(limitMb);
    expect(boundedOssHeapCheckpointMb(limitMb * 10)).toBeLessThan(limitMb);
  });
});

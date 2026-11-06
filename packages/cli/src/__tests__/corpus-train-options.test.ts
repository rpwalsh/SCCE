// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { ossCorpusTrainOptionsFrom, parseCorpusTrainOptions, storedCorpusTrainOptionsFrom } from "../corpus-train-options.js";

describe("corpus train option forwarding", () => {
  it("resumes a bounded local window against the same complete source snapshot", () => {
    const snapshotHash = "a".repeat(64);
    expect(ossCorpusTrainOptionsFrom(parseCorpusTrainOptions([
      "--max-files-per-repo=50000", "--max-files-per-run=64", "--start-file-index=128",
      `--expected-snapshot-hash=${snapshotHash}`
    ]))).toEqual({ maxFilesPerRepo: 50000, maxFilesPerRun: 64, startFileIndex: 128, expectedSnapshotHash: snapshotHash });
  });
  it("carries every bound and resume flag the local OSS trainer needs", () => {
    const options = parseCorpusTrainOptions([
      "--max-files=2000",
      "--start-file-index=4000",
      "--heap-checkpoint-mb=5120",
      "--source-uri-base=https://github.com/owner/repo/tree/0123456789abcdef0123456789abcdef01234567",
      "--commit=0123456789abcdef0123456789abcdef01234567",
      "--max-file-bytes=1000000",
      "--max-depth=12",
      "--code-only"
    ]);

    // Both of these were parsed and then dropped at the `oss` call site, so a 47,404-file corpus ran
    // unbounded and every run redid the same first 2,000 files of the walk.
    expect(options.startFileIndex).toBe(4000);
    expect(options.heapCheckpointMb).toBe(5120);
    expect(options.commitSha).toBe("0123456789abcdef0123456789abcdef01234567");

    expect(ossCorpusTrainOptionsFrom(options)).toEqual({
      maxFiles: 2000,
      maxFileBytes: 1_000_000,
      maxDepth: 12,
      startFileIndex: 4000,
      heapCheckpointMb: 5120,
      sourceUriBase: "https://github.com/owner/repo/tree/0123456789abcdef0123456789abcdef01234567",
      includeDocs: false,
      includeSource: true
    });
  });

  it("forwards stored-source replay selection, byte bounds and its batch cursor", () => {
    expect(storedCorpusTrainOptionsFrom(parseCorpusTrainOptions([
      "--source-system=dialogue", "--start-batch=7", "--max-total-bytes=65536", "--max-file-bytes=4096",
      "--batch-bytes=8192", "--heap-checkpoint-mb=2048", "--uri-prefix=file:///corpus/", "--source-version-ids=sv-a,sv-b",
      "--min-article-bytes=0", "--max-article-bytes=500000"
    ]))).toEqual({ sourceSystem: "dialogue", startBatchIndex: 7, maxTotalBytes: 65536, batchBytes: 8192,
      heapCheckpointMb: 2048, includeUriPrefixes: ["file:///corpus/"], sourceVersionIds: ["sv-a", "sv-b"],
      minArticleBytes: 0, maxArticleBytes: 500000 });
    expect(storedCorpusTrainOptionsFrom(parseCorpusTrainOptions([]))).toEqual({});
  });

  it("forwards the deterministic source cursor without changing the selected source system", () => {
    expect(storedCorpusTrainOptionsFrom(parseCorpusTrainOptions([
      "--source-system=code", "--after-source-version=sv-100001", "--source-page-size=31", "--max-source-attempts=64"
    ]))).toEqual({ sourceSystem: "code", afterSourceVersionId: "sv-100001", sourcePageSize: 31, maxSourceAttempts: 64 });
    expect(() => parseCorpusTrainOptions(["--source-system="])).toThrow(/unknown corpus train option/u);
  });

  it("omits what the command line did not state, so the trainer keeps its own defaults", () => {
    expect(ossCorpusTrainOptionsFrom(parseCorpusTrainOptions([]))).toEqual({});
  });

  it("refuses an option it does not know rather than silently ignoring it", () => {
    expect(() => parseCorpusTrainOptions(["--start-file-idx=3"])).toThrow(/unknown corpus train option/u);
  });
});

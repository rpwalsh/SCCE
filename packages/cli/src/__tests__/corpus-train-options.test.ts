// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { ossCorpusTrainOptionsFrom, parseCorpusTrainOptions } from "../corpus-train-options.js";

describe("corpus train option forwarding", () => {
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

  it("omits what the command line did not state, so the trainer keeps its own defaults", () => {
    expect(ossCorpusTrainOptionsFrom(parseCorpusTrainOptions([]))).toEqual({});
  });

  it("refuses an option it does not know rather than silently ignoring it", () => {
    expect(() => parseCorpusTrainOptions(["--start-file-idx=3"])).toThrow(/unknown corpus train option/u);
  });
});

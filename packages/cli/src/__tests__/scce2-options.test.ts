import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseScce2ImportOptions, parseScce2InspectOptions, type Scce2CliImportOptions } from "../scce2-options.js";

describe("SCCE2 CLI option parsing", () => {
  it("keeps all source-only SCCE2 import limit and work extent fields typed", () => {
    const options = parseScce2ImportOptions([
      "--graph-shard-limit=2",
      "--language-shard-limit=3",
      "--ngram-state-limit=4",
      "--ngram-observation-limit=5",
      "--graph-relation-limit=6",
      "--graph-concept-limit=7",
      "--max-state-mb=8",
      "--v8-decode-work-extent-mb=9",
      "--hash-work-extent-mb=10",
      "--max-hash-file-mb=11",
      "--heap-checkpoint-mb=192",
      "--status=tmp/scce2-status.json",
      "--stop-file=tmp/scce2-stop.json",
      "--no-direct-evidence"
    ]);

    const requiredShape: Required<Pick<
      Scce2CliImportOptions,
      | "graphShardLimit"
      | "languageShardLimit"
      | "ngramStateLimit"
      | "ngramObservationLimit"
      | "graphRelationLimit"
      | "graphConceptLimit"
      | "maxStateBytes"
      | "v8DecodeWorkExtentBytes"
      | "hashWorkExtentBytes"
      | "maxHashBytesPerFile"
      | "heapCheckpointMb"
      | "stopFile"
      | "importDirectEvidence"
    >> = {
      graphShardLimit: required(options.graphShardLimit, "graphShardLimit"),
      languageShardLimit: required(options.languageShardLimit, "languageShardLimit"),
      ngramStateLimit: required(options.ngramStateLimit, "ngramStateLimit"),
      ngramObservationLimit: required(options.ngramObservationLimit, "ngramObservationLimit"),
      graphRelationLimit: required(options.graphRelationLimit, "graphRelationLimit"),
      graphConceptLimit: required(options.graphConceptLimit, "graphConceptLimit"),
      maxStateBytes: required(options.maxStateBytes, "maxStateBytes"),
      v8DecodeWorkExtentBytes: required(options.v8DecodeWorkExtentBytes, "v8DecodeWorkExtentBytes"),
      hashWorkExtentBytes: required(options.hashWorkExtentBytes, "hashWorkExtentBytes"),
      maxHashBytesPerFile: required(options.maxHashBytesPerFile, "maxHashBytesPerFile"),
      heapCheckpointMb: required(options.heapCheckpointMb, "heapCheckpointMb"),
      stopFile: required(options.stopFile, "stopFile"),
      importDirectEvidence: required(options.importDirectEvidence, "importDirectEvidence")
    };

    expect(requiredShape.graphShardLimit).toBe(2);
    expect(requiredShape.languageShardLimit).toBe(3);
    expect(requiredShape.ngramStateLimit).toBe(4);
    expect(requiredShape.ngramObservationLimit).toBe(5);
    expect(requiredShape.graphRelationLimit).toBe(6);
    expect(requiredShape.graphConceptLimit).toBe(7);
    expect(requiredShape.maxStateBytes).toBe(8 * 1024 * 1024);
    expect(requiredShape.v8DecodeWorkExtentBytes).toBe(9 * 1024 * 1024);
    expect(requiredShape.hashWorkExtentBytes).toBe(10 * 1024 * 1024);
    expect(requiredShape.maxHashBytesPerFile).toBe(11 * 1024 * 1024);
    expect(requiredShape.heapCheckpointMb).toBe(192);
    expect(requiredShape.stopFile).toBe(path.resolve("tmp/scce2-stop.json"));
    expect(requiredShape.importDirectEvidence).toBe(false);
    expect(options.statusPath).toBe(path.resolve("tmp/scce2-status.json"));
  });

  it("maps summary-only import and inspect to bounded source-only behavior", () => {
    const imported = parseScce2ImportOptions(["--summary-only", "--no-hashes"]);
    expect(imported.graphConceptLimit).toBe(0);
    expect(imported.graphRelationLimit).toBe(0);
    expect(imported.ngramObservationLimit).toBe(0);
    expect(imported.importDirectEvidence).toBe(false);
    expect(imported.hashWorkExtentBytes).toBe(0);

    const inspected = parseScce2InspectOptions(["--summary-only", "--hash-work-extent-mb=12", "--max-hash-file-mb=13", "--max-depth=4", "--max-files=40"]);
    expect(inspected.summaryOnly).toBe(true);
    expect(inspected.hashWorkExtentBytes).toBe(12 * 1024 * 1024);
    expect(inspected.maxHashBytesPerFile).toBe(13 * 1024 * 1024);
    expect(inspected.maxDepth).toBe(4);
    expect(inspected.maxFiles).toBe(40);
  });
});

function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw new Error(`missing parsed option: ${key}`);
  return value;
}

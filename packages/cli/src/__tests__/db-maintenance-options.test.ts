// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { parseUnitMetadataMaintenanceOptions } from "../db-maintenance-options.js";

it("parses explicit maintenance bounds and the opaque committed cursor", () => {
  expect(parseUnitMetadataMaintenanceOptions([])).toEqual({});
  expect(parseUnitMetadataMaintenanceOptions(["--batch-size=7", "--max-batches", "3", "--max-batch-bytes=8192", "--after-id=unit:α"])).toEqual({
    batchSize: 7, maxBatches: 3, maxBatchBytes: 8192, afterId: "unit:α" });
});

it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid bounds %s", value => {
  expect(() => parseUnitMetadataMaintenanceOptions([`--batch-size=${value}`])).toThrow();
});

it.each([{ args: ["--batch-size"] }, { args: ["--after-id="] }, { args: ["--unknown=1"] }, { args: ["--max-batches=1", "--max-batches=2"] }])("rejects incomplete or ambiguous options $args", ({ args }) => {
  expect(() => parseUnitMetadataMaintenanceOptions(args)).toThrow();
});

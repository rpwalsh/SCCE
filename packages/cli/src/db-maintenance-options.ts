// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { UnitMetadataMaintenanceOptions } from "@scce/adapters-node";

export function parseUnitMetadataMaintenanceOptions(args: readonly string[]): UnitMetadataMaintenanceOptions {
  const result: UnitMetadataMaintenanceOptions = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const separator = token.indexOf("=");
    const key = separator < 0 ? token : token.slice(0, separator);
    if (!["--batch-size", "--max-batches", "--max-batch-bytes", "--after-id"].includes(key) || seen.has(key)) throw new Error(`unknown or repeated maintenance option: ${key}`);
    seen.add(key);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value || value.startsWith("--")) throw new Error(`missing maintenance option value: ${key}`);
    if (key === "--after-id") result.afterId = value;
    else {
      const parsed = Number(value);
      if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(parsed)) throw new Error(`${key} must be a positive safe integer`);
      if (key === "--batch-size") result.batchSize = parsed;
      else if (key === "--max-batches") result.maxBatches = parsed;
      else result.maxBatchBytes = parsed;
    }
  }
  return result;
}

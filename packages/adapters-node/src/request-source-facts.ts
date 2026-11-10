// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { JsonValue } from "@scce/kernel";

/** Producer-owned provenance is immutable while many learned features reference it. */
export function immutableRequestSourceFact<T extends JsonValue>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutableRequestSourceFact(child);
    Object.freeze(value);
  }
  return value;
}

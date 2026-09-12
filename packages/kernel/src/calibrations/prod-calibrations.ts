// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { PUBLIC_CALIBRATIONS, type CalibrationKey } from "./public-calibrations.js";

/**
 * Production overrides for the public bootstrap table, and the resolver every call site reads through.
 *
 * The public repository ships no fitted values: this module starts as a copy of PUBLIC_CALIBRATIONS and stays
 * that way until a production instance installs its own. That is the boundary private-runtime/README.md
 * describes -- the algorithm and the default are public, the value that won is not.
 *
 * Resolution order is prod override, then public bootstrap. Overrides are resolved eagerly into a flat record
 * so `calibrated` stays a single property read: requestUnitMatchesSurface calls it per unit per sentence per
 * span, and the turn budget is 10s.
 */
const resolved: Record<CalibrationKey, number> = { ...PUBLIC_CALIBRATIONS };
let installed: CalibrationKey[] = [];

/** The value in force for `key`: the production override when one is installed, otherwise the public bootstrap. */
export function calibrated(key: CalibrationKey): number {
  return resolved[key];
}

/**
 * Installs production values, keyed by the same ids. Unknown ids and non-finite values are ignored and
 * reported rather than applied, so a stale private artifact cannot silently introduce a constant that no call
 * site reads. Returns what was applied, which is what an operator needs to see at boot.
 */
export function installProdCalibrations(values: Readonly<Record<string, number>>): {
  installed: CalibrationKey[];
  ignored: string[];
} {
  const applied: CalibrationKey[] = [];
  const ignored: string[] = [];
  for (const [id, value] of Object.entries(values)) {
    if (id in PUBLIC_CALIBRATIONS && typeof value === "number" && Number.isFinite(value)) {
      resolved[id as CalibrationKey] = value;
      applied.push(id as CalibrationKey);
      continue;
    }
    ignored.push(id);
  }
  installed = [...new Set([...installed, ...applied])];
  return { installed: applied, ignored };
}

/** Which ids a production profile is currently overriding. Empty in a public clone. */
export function prodCalibrationIds(): readonly CalibrationKey[] {
  return installed;
}

/** Drops every override and returns to the public bootstrap. */
export function clearProdCalibrations(): void {
  Object.assign(resolved, PUBLIC_CALIBRATIONS);
  installed = [];
}

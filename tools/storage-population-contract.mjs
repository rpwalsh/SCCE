// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export function storagePopulationMeasurement(status, table) {
  if (!record(status)) return undefined;
  if (status.detail === "exact" && status.countSemantics === "postgres_exact_table_counts") {
    const rows = status.tableCounts?.[table];
    return count(rows) ? { sampledRows: rows, cap: null, exact: true, capReached: false } : undefined;
  }
  if (status.detail !== "population" || status.countSemantics !== "postgres_bounded_population") return undefined;
  const probe = status.tablePopulation?.[table];
  if (!record(probe) || !count(probe.sampledRows) || !count(probe.cap) || probe.cap < 1 || probe.sampledRows > probe.cap
    || probe.exact !== (probe.sampledRows < probe.cap) || probe.capReached !== (probe.sampledRows === probe.cap)) return undefined;
  return { sampledRows: probe.sampledRows, cap: probe.cap, exact: probe.exact, capReached: probe.capReached };
}
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

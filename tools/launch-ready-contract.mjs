// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { storagePopulationMeasurement } from "./storage-population-contract.mjs";
export const HYDRATION_REQUIREMENTS = Object.freeze({
  source_versions: 10000,
  evidence_spans: 10000,
  graph_nodes: 250000,
  graph_edges: 250000,
  ngram_models: 1,
  language_units: 25000,
  semantic_frames: 10000
});

export function hydrationSummary(readiness) {
  const failures = [];
  const warmup = record(readiness?.warmup);
  if (warmup?.ok !== true || warmup?.phase !== "ready" || warmup?.complete !== true) {
    failures.push(`runtime warmup is not complete (phase=${String(warmup?.phase ?? "missing")})`);
  }

  const postgres = record(readiness?.postgres);
  if (!["postgres_exact_table_counts", "postgres_bounded_population"].includes(postgres?.countSemantics)) {
    failures.push(`readiness population is not measured (semantics=${String(postgres?.countSemantics ?? "missing")})`);
  }

  const rows = {};
  const measurements = {};
  for (const [table, minimum] of Object.entries(HYDRATION_REQUIREMENTS)) {
    const measurement = storagePopulationMeasurement(postgres, table);
    measurements[table] = measurement ?? null;
    const actual = measurement?.sampledRows;
    rows[table] = actual ?? null;
    if (actual === undefined) failures.push(`hydration table ${table} has no valid population measurement`);
    else if (actual < minimum) failures.push(`hydration table ${table} has ${actual}, expected at least ${minimum}`);
  }

  const observationMeasurement = storagePopulationMeasurement(postgres, "ngram_observations");
  const observations = observationMeasurement?.sampledRows;
  measurements.ngram_observations = observationMeasurement ?? null;
  rows.ngram_observations = observations ?? null;
  if (observations === undefined || (observations === 0 && !observationMeasurement.exact)) failures.push("hydration table ngram_observations has no exact emptiness measurement");
  else if (observations !== 0) failures.push(`hydration table ngram_observations has ${observations}, expected 0`);

  return {
    ok: failures.length === 0,
    countSemantics: postgres?.countSemantics ?? null,
    rows,
    measurements,
    required: { ...HYDRATION_REQUIREMENTS, ngram_observations: 0 },
    failures
  };
}

export const exactHydrationSummary = hydrationSummary;

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

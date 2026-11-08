// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { storagePopulationMeasurement } from "./storage-population-contract.mjs";

export function productionReadinessFailures(body) {
  const postgres = body?.postgres;
  const activeBrain = body?.postgres?.activeBrain;
  return [
    [body?.ok === true, "ready.ok"],
    [body?.warmup?.ok === true && body?.warmup?.complete === true && body?.warmup?.phase === "ready", "warmup.complete"],
    [body?.postgres?.schema === "scce.postgres.status.v1", "postgres.status_schema"],
    [body?.postgres?.ok === true && body?.postgres?.connected === true, "postgres.connected"],
    [["postgres_exact_table_counts", "postgres_bounded_population"].includes(postgres?.countSemantics), "postgres.population_measurements"],
    [positiveCount(postgres, "sources"), "postgres.sources_hydrated"],
    [positiveCount(postgres, "evidence_spans"), "postgres.evidence_hydrated"],
    [positiveCount(postgres, "graph_nodes") && positiveCount(postgres, "graph_edges"), "postgres.graph_hydrated"],
    [positiveCount(postgres, "language_profiles"), "postgres.language_profiles_hydrated"],
    [positiveCount(postgres, "language_patterns") && positiveCount(postgres, "ngram_models"), "postgres.language_state_hydrated"],
    [exactZeroCount(postgres, "ngram_observations"), "postgres.raw_ngram_observations_empty"],
    [typeof activeBrain?.activeBrainVersion === "string" && activeBrain.activeBrainVersion.length > 0, "postgres.active_brain"],
    [Array.isArray(activeBrain?.activeImportRunIds) && activeBrain.activeImportRunIds.length > 0, "postgres.active_import"]
  ].filter(([passed]) => !passed).map(([, id]) => id);
}

function positiveCount(status, key) {
  const probe = storagePopulationMeasurement(status, key);
  return probe !== undefined && probe.sampledRows > 0;
}

function exactZeroCount(status, key) {
  const probe = storagePopulationMeasurement(status, key);
  return probe?.exact === true && probe.sampledRows === 0;
}

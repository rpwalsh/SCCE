// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export function productionReadinessFailures(body) {
  const counts = body?.postgres?.tableCounts;
  const activeBrain = body?.postgres?.activeBrain;
  return [
    [body?.ok === true, "ready.ok"],
    [body?.warmup?.ok === true && body?.warmup?.complete === true && body?.warmup?.phase === "ready", "warmup.complete"],
    [body?.postgres?.schema === "scce.postgres.status.v1", "postgres.status_schema"],
    [body?.postgres?.ok === true && body?.postgres?.connected === true, "postgres.connected"],
    [body?.postgres?.countSemantics === "postgres_exact_table_counts" && body?.exactCounts === true, "postgres.exact_counts"],
    [positiveCount(counts, "sources"), "postgres.sources_hydrated"],
    [positiveCount(counts, "evidence_spans"), "postgres.evidence_hydrated"],
    [positiveCount(counts, "graph_nodes") && positiveCount(counts, "graph_edges"), "postgres.graph_hydrated"],
    [positiveCount(counts, "language_profiles"), "postgres.language_profiles_hydrated"],
    [positiveCount(counts, "language_patterns") && positiveCount(counts, "ngram_models"), "postgres.language_state_hydrated"],
    [exactZeroCount(counts, "ngram_observations"), "postgres.raw_ngram_observations_empty"],
    [typeof activeBrain?.activeBrainVersion === "string" && activeBrain.activeBrainVersion.length > 0, "postgres.active_brain"],
    [Array.isArray(activeBrain?.activeImportRunIds) && activeBrain.activeImportRunIds.length > 0, "postgres.active_import"]
  ].filter(([passed]) => !passed).map(([, id]) => id);
}

function positiveCount(counts, key) {
  return isRecord(counts) && Number(counts[key]) > 0;
}

function exactZeroCount(counts, key) {
  return isRecord(counts) && Number.isSafeInteger(counts[key]) && counts[key] === 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const HYDRATION_REQUIREMENTS = Object.freeze({
  source_versions: 10000,
  evidence_spans: 10000,
  graph_nodes: 250000,
  graph_edges: 250000,
  ngram_observations: 1000000,
  language_units: 25000,
  semantic_frames: 10000
});

export function exactHydrationSummary(readiness) {
  const failures = [];
  const warmup = record(readiness?.warmup);
  if (warmup?.ok !== true || warmup?.phase !== "ready" || warmup?.complete !== true) {
    failures.push(`runtime warmup is not complete (phase=${String(warmup?.phase ?? "missing")})`);
  }

  const postgres = record(readiness?.postgres);
  if (postgres?.countSemantics !== "postgres_exact_table_counts") {
    failures.push(`readiness counts are not exact (semantics=${String(postgres?.countSemantics ?? "missing")})`);
  }
  const tableCounts = record(postgres?.tableCounts);
  if (!tableCounts) failures.push("readiness did not provide exact tableCounts");

  const rows = {};
  for (const [table, minimum] of Object.entries(HYDRATION_REQUIREMENTS)) {
    const value = tableCounts?.[table];
    const actual = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    rows[table] = actual ?? null;
    if (actual === undefined) failures.push(`hydration table ${table} has no exact count`);
    else if (actual < minimum) failures.push(`hydration table ${table} has ${actual}, expected at least ${minimum}`);
  }

  return {
    ok: failures.length === 0,
    countSemantics: postgres?.countSemantics ?? null,
    rows,
    required: { ...HYDRATION_REQUIREMENTS },
    failures
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

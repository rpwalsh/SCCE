import type { GraphSlice, JsonValue } from "./types.js";
import { toJsonValue } from "./primitives.js";

export type WalshSpineStatus = "wired" | "partial" | "absent";

export interface WalshSpineComponent {
  id: string;
  status: WalshSpineStatus;
  mathRole: string;
  runtimeSignals: string[];
  durableRows: Record<string, number>;
  graphSignals: Record<string, number>;
  limitation?: string;
}

export interface WalshSpineReport {
  generatedAt: string;
  components: WalshSpineComponent[];
  summary: {
    wired: number;
    partial: number;
    absent: number;
    durableTablesObserved: number;
    graphNodesObserved: number;
    graphEdgesObserved: number;
  };
}

export function createWalshSpineReport(input: {
  stats: JsonValue;
  graph: GraphSlice;
  languageMemory: JsonValue;
  localization: JsonValue;
  now: number;
}): WalshSpineReport {
  const rows = tableRows(input.stats);
  const graphSignals = graphSignalCounts(input.graph);
  const components: WalshSpineComponent[] = [
    component({
      id: "source.identity",
      mathRole: "source-versioned evidence identity and provenance mass",
      rows,
      graphSignals,
      durableTables: ["sources", "source_versions", "evidence_spans", "quarantine_sources"],
      graphKeys: ["observation_store", "dataset", "code_file"],
      limitation: "Source truth still depends on adapter extraction quality."
    }),
    component({
      id: "typed.observation",
      mathRole: "typed observations separated from language-bearing memory",
      rows,
      graphSignals,
      durableTables: ["ingestion_checkpoints", "graph_nodes", "graph_edges"],
      graphKeys: ["observation:language", "observation:table", "observation:cell", "observation:schema", "observation:time_series", "observation:figure", "observation:code"],
      limitation: "AST-level code facts and high-precision OCR geometry remain adapter-dependent."
    }),
    component({
      id: "language.memory",
      mathRole: "unigram-through-hexagram memory, script competence vectors, and translation alignments",
      rows,
      graphSignals,
      durableTables: ["language_profiles", "language_units", "language_patterns", "ngram_observations", "ngram_models", "semantic_frames", "translation_alignments"],
      graphKeys: ["observation:language"],
      extraSignals: jsonHasSignal(input.languageMemory) ? ["language-memory.inspectable"] : []
    }),
    component({
      id: "alpha.field",
      mathRole: "alpha coupling, typed graph activation, and contradiction mass",
      rows,
      graphSignals,
      durableTables: ["alpha_traces", "graph_nodes", "graph_edges"],
      graphKeys: ["graph.has_alpha"],
      extraSignals: input.graph.nodes.some(node => node.alpha > 0) || input.graph.edges.some(edge => edge.alpha > 0) ? ["alpha.values.present"] : []
    }),
    component({
      id: "ppf.powerwalk",
      mathRole: "personalized Perron-Frobenius flow and heterogeneous temporal walks",
      rows,
      graphSignals,
      durableTables: ["ppf_cache", "alpha_traces"],
      graphKeys: ["graph.edges.weighted"],
      extraSignals: input.graph.edges.some(edge => edge.weight > 0) ? ["weighted.edges.present"] : [],
      limitation: "Large-corpus convergence quality depends on populated Postgres state."
    }),
    component({
      id: "semantic.proof",
      mathRole: "proof graph obligations, evidence bindings, contradiction/underdetermination accounting",
      rows,
      graphSignals,
      durableTables: ["semantic_proofs", "evidence_spans"],
      graphKeys: ["observation:language", "observation:measurement", "observation:code"],
      limitation: "This is a typed evidence proof system, not a full external theorem prover."
    }),
    component({
      id: "construct.emission",
      mathRole: "ConstructGraph, ValidationGraph, EmissionGraph, and proof-carrying artifacts",
      rows,
      graphSignals,
      durableTables: ["construct_graphs", "validation_graphs", "emission_graphs", "program_builds", "blobs"],
      graphKeys: ["code_file", "symbol"]
    }),
    component({
      id: "mouth.localization",
      mathRole: "surface realization from proof force, correction memory, locale bundles, and language memory",
      rows,
      graphSignals,
      durableTables: ["correction_rules", "locale_bundles", "events"],
      graphKeys: ["observation:language"],
      extraSignals: jsonHasSignal(input.localization) ? ["localization.inspectable"] : []
    }),
    component({
      id: "learning.forecast.self",
      mathRole: "learning needs, spectral forecasting, counterfactual repair, and self-rewrite ledger",
      rows,
      graphSignals,
      durableTables: ["learning_needs", "forecast_states", "forecast_envelopes", "self_rewrite_episodes", "self_rewrite_patches"],
      graphKeys: ["derived_observation"],
      limitation: "Promotion and self-modifying action remain approval gated."
    })
  ];
  const summary = {
    wired: components.filter(item => item.status === "wired").length,
    partial: components.filter(item => item.status === "partial").length,
    absent: components.filter(item => item.status === "absent").length,
    durableTablesObserved: rows.size,
    graphNodesObserved: input.graph.nodes.length,
    graphEdgesObserved: input.graph.edges.length
  };
  return { generatedAt: new Date(input.now).toISOString(), components, summary };
}

function component(input: {
  id: string;
  mathRole: string;
  rows: Map<string, number>;
  graphSignals: Record<string, number>;
  durableTables: string[];
  graphKeys: string[];
  extraSignals?: string[];
  limitation?: string;
}): WalshSpineComponent {
  const durableRows = Object.fromEntries(input.durableTables.map(table => [table, input.rows.get(table) ?? 0]));
  const graphMatches = Object.fromEntries(input.graphKeys.map(key => [key, input.graphSignals[key] ?? 0]));
  const durablePresent = Object.values(durableRows).some(count => count > 0);
  const graphPresent = Object.values(graphMatches).some(count => count > 0);
  const extraPresent = Boolean(input.extraSignals?.length);
  const status: WalshSpineStatus = durablePresent && (graphPresent || extraPresent)
    ? "wired"
    : durablePresent || graphPresent || extraPresent
      ? "partial"
      : "absent";
  return {
    id: input.id,
    status,
    mathRole: input.mathRole,
    runtimeSignals: [...(input.extraSignals ?? []), ...Object.entries(graphMatches).filter(([, count]) => count > 0).map(([key, count]) => `${key}:${count}`)],
    durableRows,
    graphSignals: graphMatches,
    limitation: input.limitation
  };
}

function tableRows(stats: JsonValue): Map<string, number> {
  const out = new Map<string, number>();
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return out;
  const tables = (stats as { tables?: JsonValue }).tables;
  if (!Array.isArray(tables)) return out;
  for (const table of tables) {
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const name = (table as { table?: JsonValue }).table;
    const rows = (table as { rows?: JsonValue }).rows;
    if (typeof name === "string" && typeof rows === "number") out.set(name, rows);
  }
  return out;
}

function graphSignalCounts(graph: GraphSlice): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (key: string) => {
    out[key] = (out[key] ?? 0) + 1;
  };
  for (const node of graph.nodes) {
    add(String(node.typeId));
    for (const feature of node.features.slice(0, 64)) add(feature);
    if (node.alpha > 0) add("graph.has_alpha");
  }
  for (const edge of graph.edges) {
    add(String(edge.relationId));
    if (edge.weight > 0) add("graph.edges.weighted");
    if (edge.alpha > 0) add("graph.has_alpha");
  }
  return out;
}

function jsonHasSignal(value: JsonValue): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

export function walshSpineReportToJson(report: WalshSpineReport): JsonValue {
  return toJsonValue(report);
}


import type { FunctionalSelfState, ModelState, PolicyProfile } from "./types.js";
import type { ScceStorage } from "./storage.js";
import { clamp01 } from "./primitives.js";

export async function createFunctionalSelfModel(input: {
  storage: ScceStorage;
  model: ModelState;
  policy: PolicyProfile;
  recentFailures?: string[];
}): Promise<FunctionalSelfState> {
  const stats = await input.storage.stats();
  const tableRows = Array.isArray((stats as { tables?: unknown }).tables) ? (stats as { tables: Array<{ table: string; rows: number }> }).tables : [];
  const rows = (table: string) => tableRows.find(item => item.table === table)?.rows ?? 0;
  const memoryState = {
    nodes: rows("graph_nodes"),
    edges: rows("graph_edges"),
    evidence: rows("evidence_spans"),
    sourceVersions: rows("source_versions"),
    proofs: rows("semantic_proofs")
  };
  const uncertainty = clamp01(1 / (1 + input.model.trainingSteps + memoryState.evidence / 10));
  const fcs = clamp01(
    0.18 * (memoryState.evidence > 0 ? 1 : 0) +
      0.16 * (memoryState.proofs > 0 ? 1 : 0) +
      0.16 * (input.model.latentConcepts.length > 0 ? 1 : 0) +
      0.16 * (input.model.languageProfiles.length > 0 ? 1 : 0) +
      0.18 * (input.policy.requireTwoPhaseCommit ? 1 : 0) +
      0.16 * (1 - uncertainty)
  );
  return {
    currentGoals: input.model.learningGoals.slice(0, 12),
    memoryState,
    knownLimits: ["No alternate model-backed cognition path", "PostgreSQL required", "External connectors require config and permission", "Proof force is bounded by promoted evidence"],
    uncertainty,
    capabilities: ["filesystem.read", "filesystem.write", "process.build_test", "network.fetch", "outlook", "youtube", "telephone"],
    activePolicies: Object.entries(input.policy).filter(([, value]) => Boolean(value)).map(([key]) => key),
    recentFailures: input.recentFailures ?? [],
    commitments: ["event-sourced memory", "content-addressed artifacts", "alpha-coupled proof/action boundary"],
    permissions: [input.policy.allowMutation ? "mutation allowed under policy" : "mutation dry-run unless approved"],
    learningGoals: input.model.learningGoals.slice(),
    fcs,
    dci: clamp01((memoryState.nodes + memoryState.edges + memoryState.evidence + memoryState.proofs) / 1000)
  };
}

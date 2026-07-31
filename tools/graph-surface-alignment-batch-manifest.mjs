#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildSurfaceLattice,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  solveSparseFusedUnbalancedTransportWithResourceBudget
} from "../packages/kernel/dist/index.js";

// Plan item 119: run one real alignment batch against a multi-document
// synthetic corpus and record objective components + convergence in a
// durable manifest. Not a fabricated pass/fail probe -- this exercises the
// real sparse candidate generation + fused unbalanced transport solver
// against genuinely different documents (a paraphrase of the same fact, an
// unrelated fact, and a document with no graph-relevant content at all) and
// records the solver's real output.

const hasher = createHasher();

const documents = [
  { id: "document.ada.original", text: "Ada built the engine." },
  { id: "document.ada.paraphrase", text: "The engine was built by Ada." },
  { id: "document.charles.unrelated", text: "Charles designed the analytical machine." },
  { id: "document.no_graph_content", text: "It rained heavily yesterday afternoon." }
];

const nodes = [
  graphNode("node.ada", "Ada"),
  graphNode("node.engine", "engine"),
  graphNode("node.charles", "Charles"),
  graphNode("node.machine", "analytical machine")
];

const hyperedges = [
  relationHyperedge("hyperedge.built", "relation.built", "node.ada", "node.engine", "evidence.built"),
  relationHyperedge("hyperedge.designed", "relation.designed", "node.charles", "node.machine", "evidence.designed")
];

// The Ada documents (original + paraphrase) legitimately share
// "evidence.built" with the built relation below -- they are real textual
// instances of that same fact. The Charles document legitimately shares
// "evidence.designed" with the designed relation. The no-graph-content
// document must NOT share either: a real earlier bug in this fixture let
// it fall through to "evidence.built" by default (its id contains neither
// "charles" nor an explicit built/designed match), fabricating
// shared_exact_evidence support against a graph it has zero real
// connection to and inflating its candidate count with nothing behind it.
function documentEvidenceId(documentId) {
  if (documentId.includes("charles")) return "evidence.designed";
  if (documentId.includes("ada")) return "evidence.built";
  return `evidence.unrelated.${documentId}`;
}

const lattices = documents.map(document => buildSurfaceLattice({
  documentId: document.id,
  sourceVersionId: `source-version.${document.id}`,
  text: document.text,
  evidenceIds: [documentEvidenceId(document.id)],
  hasher
}));

const compiled = compileSparseAlignmentCandidateSupports({
  lattices,
  nodes,
  hyperedges,
  maxCandidateDegree: 6,
  hasher
});

const batches = compiled.supports.map((support, index) => {
  const document = documents[index];
  const { plan, resourceUsage } = solveSparseFusedUnbalancedTransportWithResourceBudget({
    support,
    targetIndex: compiled.targetIndex,
    budget: { maxOuterIterations: 8, maxSinkhornIterations: 96, maxStructuralComparisons: 200_000 },
    hasher
  });
  return {
    documentId: document.id,
    text: document.text,
    candidateCount: support.candidates.length,
    status: plan.status,
    finalObjectiveComponents: plan.iterations.at(-1) ?? null,
    convergenceTrace: plan.iterations.map(iteration => ({
      outerIteration: iteration.outerIteration,
      objective: iteration.objective,
      surfaceMarginalResidual: iteration.surfaceMarginalResidual,
      graphMarginalResidual: iteration.graphMarginalResidual,
      relativeObjectiveImprovement: iteration.relativeObjectiveImprovement
    })),
    resourceUsage,
    globalOptimalityClaimed: plan.globalOptimalityClaimed
  };
});

const manifest = {
  schema: "scce.graph_surface_alignment_batch_manifest.v1",
  completedAt: new Date().toISOString(),
  fixtureContainsSyntheticDataOnly: true,
  incidenceGraphId: compiled.incidenceGraph.id,
  targetIndexId: compiled.targetIndex.id,
  documentCount: documents.length,
  batches,
  status: batches.every(batch => batch.status === "converged" || batch.status === "iteration_budget_exhausted" || batch.status === "work_budget_exhausted")
    ? "passed"
    : "failed"
};

await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/graph-surface-alignment-batch-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ schema: manifest.schema, status: manifest.status, documentCount: manifest.documentCount, batchStatuses: batches.map(batch => batch.status) })}\n`);
if (manifest.status !== "passed") process.exitCode = 1;

function graphNode(id, representation) {
  return {
    id,
    typeId: "dimension.fixture",
    representation,
    alpha: 1,
    evidenceIds: [representation.includes("Charles") || representation.includes("machine") ? "evidence.designed" : "evidence.built"],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function relationHyperedge(id, relationId, leftNodeId, rightNodeId, evidenceId) {
  return {
    schema: "scce.hyperedge.v2",
    id,
    relationId,
    participantPorts: [
      { portId: `${id}.left`, roleId: "role.opaque.1", nodeId: leftNodeId, valueKind: "observable.string", realization: "observed", evidenceIds: [evidenceId] },
      { portId: `${id}.right`, roleId: "role.opaque.2", nodeId: rightNodeId, valueKind: "observable.string", realization: "observed", evidenceIds: [evidenceId] }
    ],
    memberNodeIds: [leftNodeId, rightNodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: [evidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: [evidenceId],
    createdAt: 1,
    updatedAt: 1
  };
}

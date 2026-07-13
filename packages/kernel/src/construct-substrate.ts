import type { ConstructGraph, EpisodeId, FileArtifact, Hasher, JsonValue, ProgramGraph, SemanticEntailmentResult } from "./types.js";
import type { IdFactory } from "./ids.js";
import { clamp01, createHasher, mean, toJsonValue } from "./primitives.js";
import type { InducedLanguageModel } from "./language-induction.js";
import type { SemanticProofResult } from "./semantic-proof-system.js";
import type { ToolCognitionPlan } from "./tool-cognition.js";

export type ConstructLayerKind =
  | "presentation"
  | "interaction"
  | "api"
  | "business"
  | "proof"
  | "learning"
  | "persistence"
  | "connector"
  | "governance"
  | "observability";

export interface ConstructResponsibility {
  id: string;
  layer: ConstructLayerKind;
  label: string;
  inputs: string[];
  outputs: string[];
  invariants: string[];
  risk: number;
  evidence: string[];
}

export interface ConstructBoundary {
  id: string;
  from: ConstructLayerKind;
  to: ConstructLayerKind;
  contract: string;
  allowedPayloads: string[];
  forbiddenPayloads: string[];
  checks: string[];
  weight: number;
}

export interface WorkbenchSurfaceModel {
  activityBar: Array<{ id: string; icon: string; label: string; pane: string }>;
  panes: Array<{ id: string; title: string; commands: string[]; dataSources: string[] }>;
  editors: Array<{ id: string; title: string; kind: string; readonly: boolean; payloadKind: string }>;
  statusItems: Array<{ id: string; label: string; severity: "info" | "warning" | "error"; source: string }>;
  approvalControls: Array<{ id: string; label: string; operatorGrantEligible: boolean; planId?: string; risk: number }>;
}

export interface PersistenceSurfaceModel {
  engine: "postgres";
  schemas: Array<{ name: string; tables: string[] }>;
  transactions: Array<{ name: string; reads: string[]; writes: string[]; isolation: "read_committed" | "repeatable_read" | "serializable" }>;
  prohibitedStores: string[];
  encryptedColumns: Array<{ table: string; column: string; reason: string }>;
}

export interface ConstructAssembly {
  id: string;
  episodeId: EpisodeId;
  responsibilities: ConstructResponsibility[];
  boundaries: ConstructBoundary[];
  workbench: WorkbenchSurfaceModel;
  persistence: PersistenceSurfaceModel;
  routes: Array<{ method: "GET" | "POST"; path: string; mutates: boolean; layer: ConstructLayerKind; approvalRequired: boolean }>;
  eventFlow: Array<{ event: string; emittedBy: ConstructLayerKind; consumedBy: ConstructLayerKind[]; durable: boolean }>;
  validation: Array<{ id: string; passed: boolean; score: number; message: string }>;
  constructGraph: ConstructGraph;
  audit: JsonValue;
}

export function createConstructSubstratePlanner(options: { idFactory: IdFactory; hasher?: Hasher }) {
  const hasher = options.hasher ?? createHasher();
  return {
    assemble(input: {
      episodeId: EpisodeId;
      requestText: string;
      entailment: SemanticEntailmentResult;
      semanticProof?: SemanticProofResult;
      toolPlan?: ToolCognitionPlan;
      languageModel?: InducedLanguageModel;
      program?: ProgramGraph;
      artifacts?: FileArtifact[];
    }): ConstructAssembly {
      const responsibilities = responsibilitiesFor(input, hasher);
      const boundaries = boundariesFor(responsibilities, input);
      const workbench = workbenchFor(input, responsibilities);
      const persistence = persistenceFor(input);
      const routes = routesFor(input);
      const eventFlow = eventFlowFor(input);
      const validation = validateAssembly({ responsibilities, boundaries, workbench, persistence, routes, eventFlow, input });
      const constructGraph = projectConstructGraph({ ...input, responsibilities, boundaries, workbench, persistence, routes, eventFlow, validation }, options.idFactory, hasher);
      const id = `construct_assembly_${hasher.digestHex(JSON.stringify({ episodeId: input.episodeId, responsibilities: responsibilities.map(r => r.id), boundaries: boundaries.map(b => b.id) })).slice(0, 32)}`;
      return {
        id,
        episodeId: input.episodeId,
        responsibilities,
        boundaries,
        workbench,
        persistence,
        routes,
        eventFlow,
        validation,
        constructGraph,
        audit: toJsonValue({
          requestHash: hasher.digestHex(input.requestText),
          proof: { force: input.entailment.force, support: input.entailment.support, contradiction: input.entailment.contradiction },
          semanticProof: input.semanticProof ? { verdict: input.semanticProof.verdict, obligations: input.semanticProof.obligations.length, counterexamples: input.semanticProof.counterexamples.length } : null,
          toolPlan: input.toolPlan ? { plans: input.toolPlan.capabilityPlans.length, approvals: input.toolPlan.approvals.length, operatorGrant: input.toolPlan.session.operatorGrant } : null,
          languageModel: input.languageModel ? { symbolCount: input.languageModel.symbolCount, frames: input.languageModel.semanticFrames.length, ngrams: input.languageModel.ngrams.length } : null,
          program: input.program ? { language: input.program.language, files: input.program.files.length } : null,
          validation
        })
      };
    }
  };
}

function responsibilitiesFor(input: {
  requestText: string;
  entailment: SemanticEntailmentResult;
  semanticProof?: SemanticProofResult;
  toolPlan?: ToolCognitionPlan;
  languageModel?: InducedLanguageModel;
  program?: ProgramGraph;
  artifacts?: FileArtifact[];
}, hasher: Hasher): ConstructResponsibility[] {
  const proofRisk = clamp01(input.entailment.contradiction + (1 - input.entailment.faithfulnessLcb) * 0.35);
  const programPressure = input.program ? 1 : 0.18;
  const languagePressure = input.languageModel ? clamp01(Math.log1p(input.languageModel.symbolCount) / 12) : 0.22;
  const toolRisk = input.toolPlan ? mean(input.toolPlan.scores.map(score => score.risk)) : 0.2;
  const evidence = input.entailment.evidenceIds.map(String);
  const rows: ConstructResponsibility[] = [
    responsibility("presentation", "i18n:construct.resp.001", ["scce.construct.in.001", "scce.construct.in.002", "scce.construct.in.003"], ["scce.construct.out.001", "scce.construct.out.002", "scce.construct.out.003", "scce.construct.out.004"], ["scce.construct.inv.001", "scce.construct.inv.002", "scce.construct.inv.003"], 0.22 + proofRisk * 0.1, evidence, hasher),
    responsibility("interaction", "i18n:construct.resp.002", ["scce.construct.in.004", "scce.construct.in.005"], ["scce.construct.out.005", "scce.construct.out.006"], ["scce.construct.inv.004", "scce.construct.inv.005", "scce.construct.inv.006"], 0.28 + toolRisk * 0.25, evidence, hasher),
    responsibility("api", "i18n:construct.resp.003", ["scce.construct.in.007"], ["scce.construct.out.007", "scce.construct.out.008"], ["scce.construct.inv.007", "scce.construct.inv.008", "scce.construct.inv.009"], 0.35, evidence, hasher),
    responsibility("business", "i18n:construct.resp.004", ["scce.construct.in.008", "scce.construct.in.009", "scce.construct.in.010"], ["scce.construct.out.009", "scce.construct.out.010"], ["scce.construct.inv.010", "scce.construct.inv.011", "scce.construct.inv.012"], proofRisk, evidence, hasher),
    responsibility("proof", "i18n:construct.resp.005", ["scce.construct.in.011", "scce.construct.in.012", "scce.construct.in.013"], ["scce.construct.out.011", "scce.construct.out.012", "scce.construct.out.013"], ["scce.construct.inv.013", "scce.construct.inv.014"], proofRisk, evidence, hasher),
    responsibility("learning", "i18n:construct.resp.006", ["scce.construct.in.014"], ["scce.construct.out.014", "scce.construct.out.015", "scce.construct.out.016"], ["scce.construct.inv.015", "scce.construct.inv.016", "scce.construct.inv.017"], 0.24 + languagePressure * 0.12, evidence, hasher),
    responsibility("persistence", "i18n:construct.resp.007", ["scce.construct.in.015", "scce.construct.in.016", "scce.construct.in.017", "scce.construct.in.018", "scce.construct.in.019", "scce.construct.in.020", "scce.construct.in.021"], ["scce.construct.out.017", "scce.construct.out.018"], ["scce.construct.inv.018", "scce.construct.inv.019", "scce.construct.inv.020"], 0.4, evidence, hasher),
    responsibility("connector", "i18n:construct.resp.008", ["scce.construct.in.022", "scce.construct.in.003"], ["scce.construct.out.019", "scce.construct.out.020", "scce.construct.out.008"], ["scce.construct.inv.021", "scce.construct.inv.022", "scce.construct.inv.023"], toolRisk, evidence, hasher),
    responsibility("governance", "i18n:construct.resp.009", ["scce.construct.in.023", "scce.construct.in.024", "scce.construct.in.025"], ["scce.construct.out.021", "scce.construct.out.022", "scce.construct.out.023"], ["scce.construct.inv.024", "scce.construct.inv.025", "scce.construct.inv.026"], 0.42 + toolRisk * 0.3, evidence, hasher),
    responsibility("observability", "i18n:construct.resp.010", ["scce.construct.in.015", "scce.construct.in.026", "scce.construct.in.019", "scce.construct.in.027"], ["scce.construct.out.024", "scce.construct.out.025", "scce.construct.out.026"], ["scce.construct.inv.027", "scce.construct.inv.028", "scce.construct.inv.029"], 0.18, evidence, hasher)
  ];
  if (programPressure > 0.6) {
    rows.push(responsibility("business", "i18n:construct.resp.011", ["scce.construct.in.028", "scce.construct.in.029"], ["scce.construct.out.027", "scce.construct.out.028"], ["scce.construct.inv.030", "scce.construct.inv.031", "scce.construct.inv.032"], 0.35 + programPressure * 0.2, evidence, hasher));
  }
  return rows;
}

function responsibility(layer: ConstructLayerKind, label: string, inputs: string[], outputs: string[], invariants: string[], risk: number, evidence: string[], hasher: Hasher): ConstructResponsibility {
  return {
    id: `resp_${hasher.digestHex(`${layer}:${label}:${inputs.join("|")}:${outputs.join("|")}`).slice(0, 24)}`,
    layer,
    label,
    inputs,
    outputs,
    invariants,
    risk: clamp01(risk),
    evidence
  };
}

function boundariesFor(responsibilities: readonly ConstructResponsibility[], input: { toolPlan?: ToolCognitionPlan }): ConstructBoundary[] {
  const hasLayer = (layer: ConstructLayerKind) => responsibilities.some(item => item.layer === layer);
  const boundaries: ConstructBoundary[] = [];
  const push = (from: ConstructLayerKind, to: ConstructLayerKind, contract: string, allowed: string[], forbidden: string[], checks: string[], weight: number) => {
    if (!hasLayer(from) || !hasLayer(to)) return;
    boundaries.push({
      id: `boundary:${from}->${to}:${contract.replace(/\s+/g, "_")}`,
      from,
      to,
      contract,
      allowedPayloads: allowed,
      forbiddenPayloads: forbidden,
      checks,
      weight: clamp01(weight)
    });
  };
  push("presentation", "interaction", "scce.boundary.001", ["scce.payload.001", "scce.payload.002", "scce.payload.003", "scce.payload.004"], ["scce.payload.forbid.001", "scce.payload.forbid.002"], ["scce.boundary.check.001", "scce.boundary.check.002"], 0.9);
  push("interaction", "api", "scce.boundary.002", ["scce.payload.005", "scce.payload.006", "scce.payload.007"], ["scce.payload.forbid.003", "scce.payload.forbid.004"], ["scce.boundary.check.003", "scce.boundary.check.004", "scce.boundary.check.005"], 0.88);
  push("api", "business", "scce.boundary.003", ["OwnerInput", "IngestInput", "TrainInput", "InspectionTarget"], ["scce.payload.forbid.005", "scce.payload.forbid.006", "scce.payload.forbid.007"], ["scce.boundary.check.006", "scce.boundary.check.007"], 0.86);
  push("business", "proof", "scce.boundary.004", ["Claim", "EvidenceSpan", "GraphSnapshot", "FieldState"], ["scce.payload.forbid.008", "scce.payload.forbid.009"], ["scce.boundary.check.008", "scce.boundary.check.009"], 0.94);
  push("business", "learning", "scce.boundary.005", ["EvidenceSpan", "LanguageProfile", "SourceVersion"], ["scce.payload.forbid.010", "scce.payload.forbid.011"], ["scce.boundary.check.010", "scce.boundary.check.011"], 0.84);
  push("business", "persistence", "scce.boundary.006", ["scce.payload.008", "scce.payload.009", "scce.payload.010", "scce.payload.011", "scce.payload.012", "scce.payload.013", "scce.payload.014"], ["scce.payload.forbid.012"], ["scce.boundary.check.012", "scce.boundary.check.013"], 0.96);
  push("business", "connector", "scce.boundary.007", ["CapabilityPlan", "ApprovalState", "QuotaState"], ["scce.payload.forbid.013", "scce.payload.forbid.014"], ["scce.boundary.check.014", "scce.boundary.check.015", "scce.boundary.check.016"], 0.9);
  push("connector", "persistence", "scce.boundary.008", ["ToolOutputContent", "SourceVersion", "CapabilitySucceeded", "CapabilityFailed"], ["scce.payload.forbid.015", "scce.payload.forbid.016"], ["scce.boundary.check.017", "scce.boundary.check.018", "scce.boundary.check.019"], 0.82);
  push("governance", "connector", "scce.boundary.009", ["scce.payload.015", "scce.payload.016", "scce.payload.017"], ["scce.payload.forbid.017"], ["scce.boundary.check.020", "scce.boundary.check.021", "scce.boundary.check.022"], input.toolPlan?.session.operatorGrant ? 0.78 : 0.93);
  push("observability", "persistence", "scce.boundary.010", ["ScceEvent", "ProofGraph", "ConstructGraph", "EmissionGraph"], ["scce.payload.forbid.018"], ["scce.boundary.check.023", "scce.boundary.check.024"], 0.9);
  return boundaries;
}

function workbenchFor(input: { toolPlan?: ToolCognitionPlan; semanticProof?: SemanticProofResult; program?: ProgramGraph; languageModel?: InducedLanguageModel }, responsibilities: readonly ConstructResponsibility[]): WorkbenchSurfaceModel {
  const approvals = input.toolPlan?.approvals ?? [];
  const obligationCount = input.semanticProof?.obligations.length ?? 0;
  const counterexampleCount = input.semanticProof?.counterexamples.length ?? 0;
  const frames = input.languageModel?.semanticFrames.length ?? 0;
  return {
    activityBar: [
      { id: "activity.explorer", icon: "Files", label: "i18n:workbench.activity.explorer", pane: "explorer" },
      { id: "activity.search", icon: "Search", label: "i18n:workbench.activity.search", pane: "search" },
      { id: "activity.proof", icon: "Network", label: "i18n:workbench.activity.proof", pane: "proof" },
      { id: "activity.program", icon: "Code", label: "i18n:workbench.activity.program", pane: "program" },
      { id: "activity.approvals", icon: "ShieldCheck", label: "i18n:workbench.activity.approvals", pane: "approvals" }
    ],
    panes: [
      { id: "pane.explorer", title: "i18n:workbench.pane.sources", commands: ["ingest.file", "inspect.snapshot"], dataSources: ["source_versions", "evidence_spans", "artifacts"] },
      { id: "pane.proof", title: "i18n:workbench.pane.proof", commands: ["proof.replay", "proof.counterexamples"], dataSources: ["semantic_proofs", "proof_obligations"] },
      { id: "pane.program", title: "i18n:workbench.pane.program", commands: ["program.open", "artifact.diff"], dataSources: ["construct_graphs", "blobs"] },
      { id: "pane.approvals", title: "i18n:workbench.pane.approvals", commands: ["approval.approve", "approval.deny", "approval.operatorGrant"], dataSources: ["capability_calls", "session_policy"] }
    ],
    editors: [
      { id: "editor.chat", title: "chat.turn", kind: "chat", readonly: false, payloadKind: "OwnerInput" },
      { id: "editor.proof", title: `i18n:workbench.editor.proof:${obligationCount}`, kind: "graph", readonly: true, payloadKind: "SemanticProof" },
      { id: "editor.counterexamples", title: `i18n:workbench.editor.counterexamples:${counterexampleCount}`, kind: "table", readonly: true, payloadKind: "ProofCounterexample[]" },
      { id: "editor.program", title: input.program ? `program.${input.program.language}` : "program.graph", kind: "code_graph", readonly: true, payloadKind: "ProgramGraph" },
      { id: "editor.language", title: `i18n:workbench.editor.language:${frames}`, kind: "table", readonly: true, payloadKind: "InducedLanguageModel" }
    ],
    statusItems: [
      { id: "status.postgres", label: "PostgreSQL", severity: "info", source: "persistence" },
      { id: "status.proof", label: obligationCount ? `i18n:workbench.status.proof_obligations:${obligationCount}` : "i18n:workbench.status.proof_clean", severity: obligationCount ? "warning" : "info", source: "proof" },
      { id: "status.approvals", label: approvals.length ? `i18n:workbench.status.approvals:${approvals.length}` : "i18n:workbench.status.no_approvals", severity: approvals.length ? "warning" : "info", source: "governance" },
      { id: "status.layers", label: `i18n:workbench.status.layers:${new Set(responsibilities.map(r => r.layer)).size}`, severity: "info", source: "construct" }
    ],
    approvalControls: approvals.map(approval => ({
      id: approval.id,
      label: approval.title,
      operatorGrantEligible: approval.operatorGrantEligible,
      planId: String(approval.planId),
      risk: approval.risk
    }))
  };
}

function persistenceFor(input: { toolPlan?: ToolCognitionPlan; languageModel?: InducedLanguageModel; program?: ProgramGraph }): PersistenceSurfaceModel {
  const tables = [
    "events",
    "source_versions",
    "evidence_spans",
    "graph_nodes",
    "graph_edges",
    "semantic_proofs",
    "construct_graphs",
    "validation_graphs",
    "emission_graphs",
    "capability_calls",
    "blobs",
    "model_state"
  ];
  if (input.languageModel) tables.push("language_units", "language_patterns", "ngram_models", "semantic_frames", "translation_alignments");
  if (input.toolPlan) tables.push("approval_sessions", "connector_quota_ledger");
  if (input.program) tables.push("program_graphs", "program_files", "repair_episodes");
  return {
    engine: "postgres",
    schemas: [{ name: "scce", tables: [...new Set(tables)] }],
    transactions: [
      { name: "ingest_source_version", reads: ["source_versions"], writes: ["source_versions", "evidence_spans", "events"], isolation: "read_committed" },
      { name: "turn_episode", reads: ["evidence_spans", "graph_nodes", "graph_edges", "model_state"], writes: ["events", "semantic_proofs", "construct_graphs", "validation_graphs", "emission_graphs", "capability_calls"], isolation: "repeatable_read" },
      { name: "approval_commit", reads: ["capability_calls", "approval_sessions"], writes: ["capability_calls", "events", "connector_quota_ledger"], isolation: "serializable" },
      { name: "model_promotion", reads: ["evidence_spans", "model_state"], writes: ["language_units", "language_patterns", "ngram_models", "semantic_frames", "model_state", "events"], isolation: "repeatable_read" }
    ],
    prohibitedStores: ["non_postgresql_durable_store", "implicit_database_url_configuration", "browser_local_storage_for_durable_state"],
    encryptedColumns: [
      { table: "secrets", column: "ciphertext", reason: "scce.encrypt.reason.001" },
      { table: "approval_sessions", column: "sensitive_payload", reason: "scce.encrypt.reason.002" },
      { table: "blobs", column: "content", reason: "scce.encrypt.reason.003" }
    ]
  };
}

function routesFor(input: { toolPlan?: ToolCognitionPlan; program?: ProgramGraph }): ConstructAssembly["routes"] {
  const routes: ConstructAssembly["routes"] = [
    { method: "GET", path: "/", mutates: false, layer: "presentation", approvalRequired: false },
    { method: "GET", path: "/api/ready", mutates: false, layer: "api", approvalRequired: false },
    { method: "POST", path: "/api/ingest", mutates: true, layer: "api", approvalRequired: false },
    { method: "POST", path: "/api/train", mutates: true, layer: "api", approvalRequired: false },
    { method: "POST", path: "/api/turn", mutates: true, layer: "api", approvalRequired: false },
    { method: "GET", path: "/api/inspect", mutates: false, layer: "api", approvalRequired: false },
    { method: "GET", path: "/api/replay/:episodeId", mutates: false, layer: "api", approvalRequired: false },
    { method: "POST", path: "/api/session/approve", mutates: true, layer: "governance", approvalRequired: false },
    { method: "POST", path: "/api/session/operator-grant", mutates: true, layer: "governance", approvalRequired: false }
  ];
  if (input.toolPlan) {
    routes.push(
      { method: "POST", path: "/api/connectors/search", mutates: false, layer: "connector", approvalRequired: false },
      { method: "POST", path: "/api/connectors/outlook/send", mutates: true, layer: "connector", approvalRequired: true },
      { method: "POST", path: "/api/connectors/telephone/call", mutates: true, layer: "connector", approvalRequired: true }
    );
  }
  if (input.program) routes.push({ method: "GET", path: "/api/program/:id", mutates: false, layer: "business", approvalRequired: false });
  return routes;
}

function eventFlowFor(input: { toolPlan?: ToolCognitionPlan; semanticProof?: SemanticProofResult; languageModel?: InducedLanguageModel; program?: ProgramGraph }): ConstructAssembly["eventFlow"] {
  const flow: ConstructAssembly["eventFlow"] = [
    { event: "OwnerAsked", emittedBy: "interaction", consumedBy: ["api", "business", "observability"], durable: true },
    { event: "FieldActivated", emittedBy: "business", consumedBy: ["proof", "observability"], durable: true },
    { event: "SemanticEntailmentChecked", emittedBy: "proof", consumedBy: ["business", "presentation", "observability"], durable: true },
    { event: "ConstructGraphBuilt", emittedBy: "business", consumedBy: ["presentation", "persistence", "observability"], durable: true },
    { event: "ValidationGraphBuilt", emittedBy: "business", consumedBy: ["presentation", "governance", "observability"], durable: true },
    { event: "EmissionGraphBuilt", emittedBy: "business", consumedBy: ["presentation", "persistence", "observability"], durable: true }
  ];
  if (input.semanticProof) flow.push({ event: "ProofObligationObserved", emittedBy: "proof", consumedBy: ["learning", "presentation"], durable: true });
  if (input.languageModel) flow.push({ event: "LanguagePatternLearned", emittedBy: "learning", consumedBy: ["business", "persistence", "presentation"], durable: true });
  if (input.toolPlan) flow.push({ event: "CapabilityPlanned", emittedBy: "connector", consumedBy: ["governance", "presentation", "persistence"], durable: true });
  if (input.program) flow.push({ event: "ProgramGraphBuilt", emittedBy: "business", consumedBy: ["presentation", "persistence"], durable: true });
  return flow;
}

function validateAssembly(input: {
  responsibilities: ConstructResponsibility[];
  boundaries: ConstructBoundary[];
  workbench: WorkbenchSurfaceModel;
  persistence: PersistenceSurfaceModel;
  routes: ConstructAssembly["routes"];
  eventFlow: ConstructAssembly["eventFlow"];
  input: { entailment: SemanticEntailmentResult; toolPlan?: ToolCognitionPlan; program?: ProgramGraph };
}): ConstructAssembly["validation"] {
  const layers = new Set(input.responsibilities.map(resp => resp.layer));
  const requiredLayers: ConstructLayerKind[] = ["presentation", "interaction", "api", "business", "proof", "persistence", "governance", "observability"];
  const routeMutationChecks = input.routes.filter(route => route.mutates && route.approvalRequired && route.layer !== "connector").length === 0;
  const postgresOnly = input.persistence.engine === "postgres" && input.persistence.prohibitedStores.includes("non_postgresql_durable_store") && input.persistence.prohibitedStores.includes("implicit_database_url_configuration");
  const uiComplete = input.workbench.activityBar.length >= 5 && input.workbench.editors.some(editor => editor.kind === "chat") && input.workbench.approvalControls.every(control => control.risk >= 0);
  const proofSeparation = input.boundaries.some(boundary => boundary.from === "business" && boundary.to === "proof") && input.boundaries.some(boundary => boundary.from === "business" && boundary.to === "persistence");
  const operatorGrantScoped = !input.input.toolPlan || input.input.toolPlan.session.operatorGrant === Boolean(input.input.toolPlan.session.operatorGrant);
  const programArtifacts = !input.input.program || input.input.program.files.every(file => file.path && !file.path.includes(".."));
  return [
    check("required-layers", requiredLayers.every(layer => layers.has(layer)), requiredLayers.filter(layer => !layers.has(layer)).length ? 0.2 : 1, "i18n:construct.validation.required_layers"),
    check("postgres-only", postgresOnly, postgresOnly ? 1 : 0, "i18n:construct.validation.postgres_only"),
    check("route-mutation-approval", routeMutationChecks, routeMutationChecks ? 1 : 0.35, "i18n:construct.validation.route_mutation_approval"),
    check("workbench-surface", uiComplete, uiComplete ? 0.95 : 0.4, "i18n:construct.validation.workbench_surface"),
    check("proof-persistence-separation", proofSeparation, proofSeparation ? 0.93 : 0.2, "i18n:construct.validation.proof_persistence_separation"),
    check("operatorGrant-session-scoped", operatorGrantScoped, operatorGrantScoped ? 1 : 0.1, "i18n:construct.validation.temporary_operator_grant_scoped"),
    check("program-artifacts-contained", programArtifacts, programArtifacts ? 1 : 0.1, "i18n:construct.validation.program_artifacts_contained")
  ];
}

function check(id: string, passed: boolean, score: number, message: string): ConstructAssembly["validation"][number] {
  return { id, passed, score: clamp01(score), message };
}

function projectConstructGraph(input: {
  episodeId: EpisodeId;
  entailment: SemanticEntailmentResult;
  responsibilities: ConstructResponsibility[];
  boundaries: ConstructBoundary[];
  workbench: WorkbenchSurfaceModel;
  persistence: PersistenceSurfaceModel;
  routes: ConstructAssembly["routes"];
  eventFlow: ConstructAssembly["eventFlow"];
  validation: ConstructAssembly["validation"];
  program?: ProgramGraph;
  artifacts?: FileArtifact[];
}, idFactory: IdFactory, hasher: Hasher): ConstructGraph {
  const artifacts = [...(input.artifacts ?? []), ...(input.program?.files ?? [])];
  const nodes = [
    ...input.responsibilities.map(resp => ({ id: resp.id, kind: `responsibility:${resp.layer}`, label: resp.label, metadata: toJsonValue(resp) })),
    ...input.boundaries.map(boundary => ({ id: boundary.id, kind: "layer_boundary", label: `${boundary.from}->${boundary.to}`, metadata: toJsonValue(boundary) })),
    ...input.routes.map(route => ({ id: `route:${route.method}:${route.path}`, kind: `route:${route.layer}`, label: `${route.method} ${route.path}`, metadata: toJsonValue(route) })),
    ...input.eventFlow.map(flow => ({ id: `event:${flow.event}`, kind: "event_flow", label: flow.event, metadata: toJsonValue(flow) })),
    { id: "surface:workbench", kind: "workbench_surface", label: "VS-Code-like SCCE workbench", metadata: toJsonValue(input.workbench) },
    { id: "surface:persistence", kind: "postgres_surface", label: "PostgreSQL durable substrate", metadata: toJsonValue(input.persistence) },
    ...input.validation.map(item => ({ id: `validation:${item.id}`, kind: item.passed ? "validation:passed" : "validation:failed", label: item.message, metadata: toJsonValue(item) }))
  ];
  const edges = [
    ...input.boundaries.map(boundary => ({ source: layerAnchor(input.responsibilities, boundary.from), target: layerAnchor(input.responsibilities, boundary.to), relation: boundary.contract, weight: boundary.weight })),
    ...input.routes.map(route => ({ source: layerAnchor(input.responsibilities, route.layer), target: `route:${route.method}:${route.path}`, relation: "exposes_route", weight: route.approvalRequired ? 0.78 : 0.9 })),
    ...input.eventFlow.flatMap(flow => flow.consumedBy.map(layer => ({ source: `event:${flow.event}`, target: layerAnchor(input.responsibilities, layer), relation: flow.durable ? "durably_consumed_by" : "consumed_by", weight: flow.durable ? 0.92 : 0.7 }))),
    ...input.validation.map(item => ({ source: item.id.includes("postgres") ? "surface:persistence" : "surface:workbench", target: `validation:${item.id}`, relation: item.passed ? "passes" : "fails", weight: item.score }))
  ];
  const validationScore = mean(input.validation.map(item => item.score));
  return {
    id: idFactory.constructId({ episodeId: input.episodeId, responsibilities: input.responsibilities.map(item => item.id), validation: input.validation.map(item => [item.id, item.passed]) }),
    episodeId: input.episodeId,
    forceVector: toJsonValue({
      force: input.entailment.force,
      support: input.entailment.support,
      contradiction: input.entailment.contradiction,
      validationScore,
      graphHash: hasher.digestHex(JSON.stringify({ nodes: nodes.map(node => node.id), edges: edges.map(edge => `${edge.source}->${edge.target}`) }))
    }),
    nodes,
    edges,
    program: input.program,
    artifacts
  };
}

function layerAnchor(responsibilities: readonly ConstructResponsibility[], layer: ConstructLayerKind): string {
  return responsibilities.find(resp => resp.layer === layer)?.id ?? `layer:${layer}`;
}

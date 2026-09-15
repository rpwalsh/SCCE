// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import type { FileArtifact, JsonValue, ProgramBehaviorRequirement, ProgramGraph } from "./types.js";

/** A typed callable surface observed on one source artifact. IDs remain source-derived and opaque. */
export interface ProgramModulePort {
  readonly callableId: string;
  readonly argumentTypes: readonly string[];
  readonly resultType: string;
}

/** A source artifact together with the callable surfaces it provides and consumes. */
export interface ProgramModuleSpec {
  readonly moduleId: string;
  readonly artifact: FileArtifact;
  readonly provides: readonly ProgramModulePort[];
  readonly requires?: readonly ProgramModulePort[];
}

export interface ProgramCompositionInput {
  /** The existing graph, which may be an empty workspace graph. */
  readonly base: ProgramGraph;
  readonly modules: readonly ProgramModuleSpec[];
  /** Owner-observed typed obligations. Held-out obligations never select modules. */
  readonly obligations: readonly ProgramBehaviorRequirement[];
  /** Optional source-derived entrypoint module identity. */
  readonly entrypointModuleId?: string;
}

export interface ProgramCompositionResult {
  readonly graph: ProgramGraph;
  readonly selectedModuleIds: readonly string[];
  readonly fitObligationIds: readonly string[];
  readonly heldOutObligationIds: readonly string[];
  readonly unmetHeldOutObligationIds: readonly string[];
}

export interface ProgramCompositionBehaviorOutcome {
  readonly obligationId: string;
  readonly verificationRole: ProgramBehaviorRequirement["verificationRole"];
  readonly callableId: string;
  readonly status: "passed" | "failed";
  readonly expectedResult: JsonValue;
  readonly observedResult?: JsonValue;
  readonly error?: string;
}

export interface ProgramCompositionBehaviorValidation {
  readonly passed: boolean;
  readonly outcomes: readonly ProgramCompositionBehaviorOutcome[];
}

/**
 * Composes a graph from typed behavior obligations and module contracts.
 *
 * Selection is contract based: a fit obligation selects a provider whose
 * callable and JSON value types agree, then recursively selects providers for
 * that module's required ports. No request wording or artifact path is read.
 */
export function composeProgramGraphFromBehavior(input: ProgramCompositionInput): ProgramCompositionResult {
  const modules = validateModules(input.modules);
  validateObligations(input.obligations);
  const basePaths = new Set(input.base.files.map(file => file.path));
  if (modules.some(module => basePaths.has(module.artifact.path))) {
    throw new Error("program module artifact path collides with the base graph");
  }
  const moduleById = new Map(modules.map(module => [module.moduleId, module]));
  const selected = new Set<string>();
  const selecting = new Set<string>();
  const selectedFit = input.obligations.filter(obligation => obligation.verificationRole === "fit");
  const heldOut = input.obligations.filter(obligation => obligation.verificationRole === "held_out");
  const providerFor = (port: ProgramModulePort, excludedModuleId?: string): ProgramModuleSpec | undefined =>
      modules
      .filter(module => module.moduleId !== excludedModuleId && module.provides.some(candidate => portsCompatible(candidate, port)))
      .sort((left, right) => compareCanonical(left.moduleId, right.moduleId))[0];

  const selectModule = (module: ProgramModuleSpec): void => {
    if (selected.has(module.moduleId)) return;
    if (selecting.has(module.moduleId)) throw new Error(`program module dependency cycle: ${module.moduleId}`);
    selecting.add(module.moduleId);
    for (const requirement of module.requires ?? []) {
      const provider = providerFor(requirement, module.moduleId);
      if (!provider) throw new Error(`program module dependency is unsatisfied: ${module.moduleId} requires ${requirement.callableId}`);
      selectModule(provider);
    }
    selecting.delete(module.moduleId);
    selected.add(module.moduleId);
  };

  for (const obligation of selectedFit) {
    const provider = providerFor(portForObligation(obligation));
    if (!provider) throw new Error(`program behavior obligation is unsatisfied: ${obligation.id}`);
    selectModule(provider);
  }
  if (input.entrypointModuleId !== undefined) {
    const entrypoint = moduleById.get(input.entrypointModuleId);
    if (!entrypoint) throw new Error(`program entrypoint module is unknown: ${input.entrypointModuleId}`);
    selectModule(entrypoint);
  }

  const selectedModules = modules.filter(module => selected.has(module.moduleId));
  const unmetHeldOutObligationIds = heldOut
    .filter(obligation => !selectedModules.some(module => module.provides.some(port => portsCompatible(port, portForObligation(obligation)))))
    .map(obligation => obligation.id)
    .sort(compareCanonical);
  const graph = graphWithComposition(input.base, selectedModules, input.obligations, input.entrypointModuleId, selectedFit);
  return Object.freeze({
    graph,
    selectedModuleIds: Object.freeze(selectedModules.map(module => module.moduleId)),
    fitObligationIds: Object.freeze(selectedFit.map(obligation => obligation.id).sort(compareCanonical)),
    heldOutObligationIds: Object.freeze(heldOut.map(obligation => obligation.id).sort(compareCanonical)),
    unmetHeldOutObligationIds: Object.freeze(unmetHeldOutObligationIds)
  });
}

/** Runs the same fit and held-out obligations against an external artifact executor. */
export async function validateProgramCompositionBehavior(input: {
  readonly composition: ProgramCompositionResult;
  readonly obligations: readonly ProgramBehaviorRequirement[];
  readonly execute: (obligation: ProgramBehaviorRequirement, graph: ProgramGraph) => JsonValue | Promise<JsonValue>;
}): Promise<ProgramCompositionBehaviorValidation> {
  const outcomes: ProgramCompositionBehaviorOutcome[] = [];
  for (const obligation of input.obligations) {
    try {
      const observedResult = await input.execute(obligation, input.composition.graph);
      const passed = canonicalStringify(observedResult) === canonicalStringify(obligation.expectedResult);
      outcomes.push({ obligationId: obligation.id, verificationRole: obligation.verificationRole, callableId: obligation.callableId, status: passed ? "passed" : "failed", expectedResult: obligation.expectedResult, ...(passed ? {} : { observedResult }) });
    } catch (error) {
      outcomes.push({ obligationId: obligation.id, verificationRole: obligation.verificationRole, callableId: obligation.callableId, status: "failed", expectedResult: obligation.expectedResult, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Object.freeze({ passed: outcomes.every(outcome => outcome.status === "passed"), outcomes: Object.freeze(outcomes) });
}

/** Stable, language-neutral value shape used by module contracts. */
export function jsonValueTypeId(value: JsonValue): string {
  if (value === null) return "json.null";
  if (Array.isArray(value)) return "json.array";
  switch (typeof value) {
    case "boolean": return "json.boolean";
    case "number": return "json.number";
    case "string": return "json.string";
    default: return "json.object";
  }
}

function portForObligation(obligation: ProgramBehaviorRequirement): ProgramModulePort {
  return {
    callableId: obligation.callableId,
    argumentTypes: obligation.arguments.map(jsonValueTypeId),
    resultType: jsonValueTypeId(obligation.expectedResult)
  };
}

function portsCompatible(provider: ProgramModulePort, requested: ProgramModulePort): boolean {
  return provider.callableId === requested.callableId
    && provider.argumentTypes.length === requested.argumentTypes.length
    && provider.argumentTypes.every((type, index) => type === "json.any" || type === requested.argumentTypes[index])
    && (provider.resultType === "json.any" || provider.resultType === requested.resultType);
}

function validateModules(modules: readonly ProgramModuleSpec[]): ProgramModuleSpec[] {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const module of modules) {
    if (!module.moduleId || ids.has(module.moduleId)) throw new Error(`program module identity is invalid: ${module.moduleId}`);
    if (!module.artifact.path || paths.has(module.artifact.path)) throw new Error(`program module artifact path is invalid: ${module.artifact.path}`);
    ids.add(module.moduleId);
    paths.add(module.artifact.path);
    validatePorts(module.provides, module.moduleId, "provides");
    validatePorts(module.requires ?? [], module.moduleId, "requires");
  }
  return [...modules].sort((left, right) => compareCanonical(left.moduleId, right.moduleId));
}

function validateObligations(obligations: readonly ProgramBehaviorRequirement[]): void {
  const ids = new Set<string>();
  for (const obligation of obligations) {
    if (!obligation.id || ids.has(obligation.id)) throw new Error(`program behavior obligation identity is invalid: ${obligation.id}`);
    if (!obligation.callableId) throw new Error(`program behavior obligation callable is invalid: ${obligation.id}`);
    ids.add(obligation.id);
  }
}

function validatePorts(ports: readonly ProgramModulePort[], moduleId: string, relation: string): void {
  const keys = new Set<string>();
  for (const port of ports) {
    if (!port.callableId || !port.resultType || port.argumentTypes.some(type => !type)) throw new Error(`program module ${relation} port is invalid: ${moduleId}`);
    const key = `${port.callableId}\u0000${port.argumentTypes.join(",")}\u0000${port.resultType}`;
    if (keys.has(key)) throw new Error(`program module ${relation} port is duplicated: ${moduleId}`);
    keys.add(key);
  }
}

function graphWithComposition(base: ProgramGraph, modules: readonly ProgramModuleSpec[], obligations: readonly ProgramBehaviorRequirement[], entrypointModuleId: string | undefined, fitObligations: readonly ProgramBehaviorRequirement[]): ProgramGraph {
  const hasher = createHasher();
  const selectedIds = modules.map(module => module.moduleId);
  const graphIdentity = canonicalStringify({
    baseId: base.id,
    selectedIds,
    fit: fitObligations.map(obligation => ({ id: obligation.id, callableId: obligation.callableId, argumentTypes: obligation.arguments.map(jsonValueTypeId), resultType: jsonValueTypeId(obligation.expectedResult) }))
  });
  const moduleNodes = modules.map(module => ({
    id: moduleNodeId(module.moduleId),
    kind: "program.module",
    label: module.moduleId,
    metadata: {
      moduleId: module.moduleId,
      artifactPath: module.artifact.path,
      provides: module.provides.map(portIdentity),
      requires: (module.requires ?? []).map(portIdentity)
    } as JsonValue
  }));
  const artifactNodes = modules.map(module => ({ id: artifactNodeId(module.artifact.artifactId), kind: "program.artifact", label: module.artifact.path, metadata: { artifactId: module.artifact.artifactId, path: module.artifact.path, role: module.artifact.role } as JsonValue }));
  const obligationNodes = obligations.map(obligation => ({ id: obligationNodeId(obligation.id), kind: "program.behavior_obligation", label: obligation.callableId, metadata: { obligationId: obligation.id, callableId: obligation.callableId, verificationRole: obligation.verificationRole, argumentTypes: obligation.arguments.map(jsonValueTypeId), resultType: jsonValueTypeId(obligation.expectedResult) } as JsonValue }));
  const moduleEdges = modules.flatMap(module => [
    { source: moduleNodeId(module.moduleId), target: artifactNodeId(module.artifact.artifactId), relation: "program.module.emits_artifact", weight: 1 },
    ...(module.requires ?? []).flatMap(requirement => {
      const provider = modules.find(candidate => candidate.moduleId !== module.moduleId && candidate.provides.some(port => portsCompatible(port, requirement)));
      return provider ? [{ source: moduleNodeId(module.moduleId), target: moduleNodeId(provider.moduleId), relation: "program.module.requires", weight: 1 }] : [];
    })
  ]);
  const obligationEdges = obligations.flatMap(obligation => {
    const provider = modules.find(module => module.provides.some(port => portsCompatible(port, portForObligation(obligation))));
    return provider ? [{ source: obligationNodeId(obligation.id), target: moduleNodeId(provider.moduleId), relation: "program.obligation.selects_provider", weight: obligation.verificationRole === "fit" ? 1 : 0.5 }] : [];
  });
  const entrypoint = entrypointModuleId ? modules.find(module => module.moduleId === entrypointModuleId)?.artifact.path : base.entrypoint;
  return {
    ...base,
    id: `program.composition.${hasher.digestHex(graphIdentity).slice(0, 40)}`,
    entrypoint: entrypoint ?? base.entrypoint,
    nodes: [...base.nodes, ...moduleNodes, ...artifactNodes, ...obligationNodes],
    edges: [...base.edges, ...moduleEdges, ...obligationEdges],
    files: [...base.files, ...modules.map(module => module.artifact)]
  };
}

function portIdentity(port: ProgramModulePort): JsonValue {
  return { callableId: port.callableId, argumentTypes: [...port.argumentTypes], resultType: port.resultType };
}

function moduleNodeId(moduleId: string): string { return `program.composition.module.${moduleId}`; }
function artifactNodeId(artifactId: string): string { return `program.composition.artifact.${artifactId}`; }
function obligationNodeId(obligationId: string): string { return `program.composition.obligation.${obligationId}`; }
function compareCanonical(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

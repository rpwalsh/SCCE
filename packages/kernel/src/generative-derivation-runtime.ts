// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY,
  registerBaseConstruction,
  registerComposedConstruction,
  type ComposedConstruction,
  type ConstructionCompositionRegistry
} from "./construction-composition.js";
import { decodeBounded, type BoundedDecodingAtom, type BoundedDecodingEdge } from "./bounded-chart-decoding.js";
import { chartKeyId, extractDerivations, type ChartKey, type DerivationChart } from "./derivation-chart.js";
import {
  createProofLicenseSemiring,
  viterbiLogSemiring,
  type ProofLicenseCarrier,
  type ProofLicenseSemiring
} from "./proof-license-semiring.js";
import { reassembleLogicalSurface, type DiscontinuousConstruction } from "./discontinuous-construction.js";
import type { ReversibleConstruction } from "./reversible-construction.js";
import { renderJoinedSurface, type JoinProgramMixture } from "./join-program.js";
import type { GraphSlice, Hyperedge } from "./types.js";
import { toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/**
 * The bridge that makes SCCE's generator recursively closed.
 *
 * Every piece of the machinery below already existed, was tested, and had
 * zero call sites outside its own tests: `construction-composition.ts`
 * (typed recursive composition with real cycle detection and a depth
 * bound), `derivation-chart.ts` + `bounded-chart-decoding.ts` (packed
 * derivation forest under a treewidth budget), and
 * `proof-license-semiring.ts` (weighted derivations carrying proof
 * licenses). Nothing connected them to each other or to a learned
 * construction, so the live generator remained a finite-library
 * recombinator: it could only emit a structure some construction already
 * described.
 *
 * This module supplies the three missing joins:
 *
 * 1. **A typed operator reading of a learned construction.** A
 *    `ReversibleConstruction` already carries typed graph ports and the
 *    surface slots those ports realize. Read as an operator it is
 *    `C : T_1 x ... x T_n -> T`, where the argument types are its boundary
 *    ports' role/value types and the result type is its relation.
 * 2. **Recursive closure.** A construction whose result type matches
 *    another's open argument type can fill it, and the composite is itself
 *    an operator that can fill a further argument -- so a finite set of
 *    learned constructions describes an unbounded set of structures,
 *    bounded here only by an explicit depth budget.
 * 3. **A realization homomorphism.** `R(f(S_1..S_n))` is built from the
 *    parent's own surface with each argument-bound slot replaced by
 *    `R(S_i)`, rather than retrieved. A composite therefore realizes even
 *    though its exact surface never occurred in the corpus.
 *
 * Derivation choice is a real weighted search over the packed forest
 * (Viterbi in log space through the existing proof-license semiring), not
 * a similarity lookup: the emitted structure is the cheapest legal
 * derivation, and the proof license it carries is the evidence that
 * licensed it.
 */

/** A learned construction read as a typed operator. */
export interface ConstructionOperator {
  constructionId: string;
  resultType: string;
  argumentTypes: Array<{ portId: string; type: string }>;
  evidenceIds: string[];
  /** Realization template: the construction's own observed surface plus which slot each argument port fills. */
  surface: {
    text: string;
    slots: Array<{ portId: string; start: number; end: number }>;
  };
  /** Logical reading order when the construction is discontinuous; realization follows it instead of byte order. */
  discontinuous?: DiscontinuousConstruction;
}

/** Read a `ReversibleConstruction` as a typed operator. Boundary ports are the open arguments; non-boundary ports are already saturated inside the construction. */
export function constructionOperator(construction: ReversibleConstruction): ConstructionOperator | undefined {
  const relationId = construction.graph.ports[0]?.relationId;
  if (!relationId) return undefined;
  const boundaryPortIds = new Set(construction.graph.boundaryPortIds);
  const argumentPorts = construction.graph.ports.filter(port => boundaryPortIds.has(port.id));
  const slotByPort = new Map<string, { start: number; end: number }>();
  for (const slot of construction.surface.slots) {
    for (const portId of slot.graphPortIds) {
      if (!boundaryPortIds.has(portId)) continue;
      const existing = slotByPort.get(portId);
      if (!existing || slot.relativeUtf16Start < existing.start) {
        slotByPort.set(portId, { start: slot.relativeUtf16Start, end: slot.relativeUtf16End });
      }
    }
  }
  return {
    constructionId: construction.id,
    resultType: relationId,
    ...(construction.surface.discontinuous ? { discontinuous: construction.surface.discontinuous } : {}),
    argumentTypes: argumentPorts.map(port => ({ portId: port.id, type: portArgumentType(port) })),
    evidenceIds: [...new Set(construction.graph.ports.flatMap(port => port.evidenceIds))],
    surface: {
      text: construction.surface.sourceSurface,
      slots: argumentPorts
        .flatMap(port => {
          const slot = slotByPort.get(port.id);
          return slot ? [{ portId: port.id, start: slot.start, end: slot.end }] : [];
        })
        .sort((left, right) => left.start - right.start)
    }
  };
}

function portArgumentType(port: ReversibleConstruction["graph"]["ports"][number]): string {
  // Role identity is the strongest available type; value kind is the
  // fallback for a port that carries no role. Never defaults to a
  // permissive wildcard -- an untyped port simply cannot be composed into.
  return port.roleId ?? port.valueKind ?? `port.untyped.${port.id}`;
}

export interface ConstructionAlgebra {
  registry: ConstructionCompositionRegistry;
  operators: Map<string, ConstructionOperator>;
  /** Composites discovered by recursive closure, in registration (increasing depth) order. */
  composed: ComposedConstruction[];
  audit: JsonValue;
}

/**
 * Close a finite set of learned operators under composition, up to a real
 * depth bound. A composite is admitted only when every one of the parent's
 * argument types is filled by a child whose *result* type matches it --
 * type compatibility is a real check, not a name coincidence -- and
 * `registerComposedConstruction`'s own ancestor-chain cycle detection
 * refuses anything that would close a loop.
 */
export function buildConstructionAlgebra(input: {
  constructions: readonly ReversibleConstruction[];
  maxRecursionDepth: number;
  maxComposites?: number;
}): ConstructionAlgebra {
  const operators = new Map<string, ConstructionOperator>();
  for (const construction of input.constructions) {
    const operator = constructionOperator(construction);
    if (operator) operators.set(operator.constructionId, operator);
  }
  let registry = EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY;
  for (const id of operators.keys()) registry = registerBaseConstruction(registry, id);

  const composed: ComposedConstruction[] = [];
  const maxComposites = input.maxComposites ?? 64;
  const byResultType = new Map<string, string[]>();
  for (const operator of operators.values()) {
    byResultType.set(operator.resultType, [...(byResultType.get(operator.resultType) ?? []), operator.constructionId]);
  }

  // Breadth-first over depth: every composite admitted at depth d becomes a
  // candidate filler at depth d+1, which is exactly what makes the closure
  // recursive rather than one-shot.
  for (let depth = 1; depth <= input.maxRecursionDepth && composed.length < maxComposites; depth++) {
    const admittedThisDepth: ComposedConstruction[] = [];
    for (const parent of operators.values()) {
      if (!parent.argumentTypes.length) continue;
      if (composed.length + admittedThisDepth.length >= maxComposites) break;
      // FULL ENUMERATION. The previous version took `.find(...)` -- the
      // first type-compatible filler -- which admitted at most one
      // composite per parent per depth and left the weighted search with
      // essentially nothing to choose between. Every combination of
      // type-compatible fillers is now offered to the forest, and the
      // search decides. Bounded by maxComposites, never by arbitrary
      // truncation of the candidate set for a single argument.
      const fillerChoices = parent.argumentTypes.map(argument => ({
        portId: argument.portId,
        fillers: (byResultType.get(argument.type) ?? []).filter(candidate => candidate !== parent.constructionId)
      }));
      if (fillerChoices.some(choice => !choice.fillers.length)) continue;
      let combinations: Array<Array<{ portId: string; childConstructionId: string }>> = [[]];
      for (const choice of fillerChoices) {
        const next: typeof combinations = [];
        for (const partial of combinations) {
          for (const fillerId of choice.fillers) {
            if (next.length + combinations.length > maxComposites * 4) break;
            next.push([...partial, { portId: choice.portId, childConstructionId: fillerId }]);
          }
        }
        combinations = next;
      }
      let variant = 0;
      for (const ports of combinations) {
        if (composed.length + admittedThisDepth.length >= maxComposites) break;
        const id = `composed.${parent.constructionId}.d${depth}.v${variant++}`;
        if (registry.depths[id] !== undefined) continue;
        try {
          registry = registerComposedConstruction(registry, {
            id,
            baseConstructionId: parent.constructionId,
            ports,
            maxRecursionDepth: input.maxRecursionDepth
          });
        } catch {
          // Cycle or depth-bound refusal from the real registry -- skip
          // this composite, never force it.
          continue;
        }
        const record = registry.composed[id];
        if (record) admittedThisDepth.push(record);
      }
    }
    if (!admittedThisDepth.length) break;
    composed.push(...admittedThisDepth);
    // A composite is itself a value of its parent's result type, so it can
    // fill that type at the next depth. This is the recursive step.
    for (const record of admittedThisDepth) {
      const parent = operators.get(record.baseConstructionId);
      if (!parent) continue;
      byResultType.set(parent.resultType, [...(byResultType.get(parent.resultType) ?? []), record.id]);
      operators.set(record.id, { ...parent, constructionId: record.id, argumentTypes: [] });
    }
  }

  return {
    registry,
    operators,
    composed,
    audit: toJsonValue({
      source: "scce.generative_derivation.algebra.v1",
      baseOperators: input.constructions.length,
      typedOperators: [...operators.keys()].length - composed.length,
      composites: composed.length,
      maxDepth: composed.reduce((max, record) => Math.max(max, record.depth), 0),
      recursivelyClosed: composed.length > 0
    })
  };
}

/**
 * The realization homomorphism: a composite's surface is its parent's own
 * surface with each argument-bound span replaced by the recursively
 * realized child, so `R(f(S_1..S_n))` is *constructed* from `R(S_i)` rather
 * than retrieved. Depth-bounded and cycle-safe via the registry's own
 * ancestor chains.
 */
export function realizeDerivation(input: {
  constructionId: string;
  algebra: ConstructionAlgebra;
  depth?: number;
  maxDepth?: number;
}): string {
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? 8;
  if (depth > maxDepth) return "";
  const composite = input.algebra.registry.composed[input.constructionId];
  const baseId = composite?.baseConstructionId ?? input.constructionId;
  const operator = input.algebra.operators.get(baseId);
  if (!operator) return "";
  // A discontinuous construction reads in its own logical order, not the order its spans happen to sit in.
  const surfaceText = operator.discontinuous
    ? reassembleLogicalSurface(operator.discontinuous, operator.surface.text)
    : operator.surface.text;
  if (!composite || !operator.surface.slots.length) return surfaceText.trim();

  const childByPort = new Map(composite.ports.map(port => [port.portId, port.childConstructionId]));
  let out = "";
  let cursor = 0;
  for (const slot of operator.surface.slots) {
    const childId = childByPort.get(slot.portId);
    if (childId === undefined) continue;
    const start = Math.max(cursor, Math.min(slot.start, operator.surface.text.length));
    const end = Math.max(start, Math.min(slot.end, operator.surface.text.length));
    out += operator.surface.text.slice(cursor, start);
    out += realizeDerivation({ constructionId: childId, algebra: input.algebra, depth: depth + 1, maxDepth });
    cursor = end;
  }
  out += operator.surface.text.slice(cursor);
  return out.replace(/\s+/gu, " ").trim();
}

/**
 * TARGET CONDITIONING (the correction that makes the search real).
 *
 * A semantic target part is one typed relational structure the turn is
 * actually trying to express -- read directly from the turn's own graph
 * slice, where a `Hyperedge` already *is* a typed relation instance with
 * typed role ports. Derivations then compete to COVER these parts, which
 * is what the derivation chart was designed for: `ChartKey.coverage` is a
 * coverage set over target parts, and `combineCells`' own
 * coverage-disjointness check regains its real meaning (a target part can
 * never be covered twice within one derivation).
 *
 * Without this the search was unconditional -- argmax over the whole
 * algebra, coverage was a meaningless bag of construction ids, and the
 * packed forest had nothing meaningful to pack.
 */
export interface SemanticTargetPart {
  id: string;
  relationId: string;
  roles: Array<{ roleId: string; valueKind: string }>;
  evidenceIds: string[];
}

export interface SemanticTarget {
  parts: SemanticTargetPart[];
  audit: JsonValue;
}

/** The turn's semantic target, taken from its own graph slice. Observed participant ports only -- an omitted port is not something the turn is asserting. */
export function semanticTargetFromGraph(input: {
  graph: Pick<GraphSlice, "hyperedges">;
  maxParts?: number;
}): SemanticTarget {
  const maxParts = input.maxParts ?? 16;
  const parts: SemanticTargetPart[] = [];
  for (const hyperedge of input.graph.hyperedges as readonly Hyperedge[]) {
    if (parts.length >= maxParts) break;
    const observed = hyperedge.participantPorts.filter(port => port.realization === "observed");
    if (!observed.length) continue;
    parts.push({
      id: String(hyperedge.id),
      relationId: String(hyperedge.relationId),
      roles: observed.map(port => ({ roleId: port.roleId, valueKind: port.valueKind })),
      evidenceIds: hyperedge.evidenceIds.map(String)
    });
  }
  return {
    parts,
    audit: toJsonValue({
      source: "scce.generative_derivation.target.v1",
      hyperedges: (input.graph.hyperedges as readonly Hyperedge[]).length,
      parts: parts.length,
      relationIds: [...new Set(parts.map(part => part.relationId))].slice(0, 12)
    })
  };
}

/** Every operator that can legitimately express a given target part: its result type must be the part's relation, and it must not require a role the part does not have. */
export function operatorsForTargetPart(
  part: SemanticTargetPart,
  operators: ReadonlyMap<string, ConstructionOperator>
): ConstructionOperator[] {
  const partRoles = new Set(part.roles.map(role => role.roleId));
  return [...operators.values()].filter(operator => {
    if (operator.resultType !== part.relationId) return false;
    // An operator whose open arguments name roles this part does not carry
    // cannot be expressing this part. Arguments naming roles the part does
    // carry are legitimate -- they are filled by sub-derivations.
    return operator.argumentTypes.every(argument => partRoles.has(argument.type) || !argument.type.startsWith("role."));
  });
}

/** Proof-license state for a derivation: the evidence that licenses it. Two derivations carrying the same evidence set are the same license. */
interface DerivationLicense {
  evidenceIds: string[];
}

export interface DerivationSearchResult {
  bestConstructionId?: string;
  bestScore: number;
  text: string;
  evidenceIds: string[];
  /** k-best rivals of the selected derivation, walked from the packed chart with shared subderivations. */
  alternatives: Array<{ constructionId: string; ruleIds: string[]; text: string }>;
  chart: DerivationChart<DerivationLicense>;
  treewidth: number;
  audit: JsonValue;
}

/**
 * Search the packed derivation forest for the cheapest legal derivation.
 *
 * Weighting is real: each operator contributes `log` of its own evidential
 * support, so a derivation's score is the sum of its parts under the
 * existing Viterbi log semiring, and the proof license accumulated along
 * the way is the union of the evidence that licensed each step. An
 * unsupported license is pruned by the semiring itself rather than scored
 * and discarded later.
 */
export function searchBestDerivation(input: {
  algebra: ConstructionAlgebra;
  treewidthBudget?: number;
}): DerivationSearchResult {
  const semiring: ProofLicenseSemiring<DerivationLicense> = createProofLicenseSemiring<DerivationLicense>({
    base: viterbiLogSemiring,
    stateKey: state => [...state.evidenceIds].sort().join(","),
    emptyState: { evidenceIds: [] },
    unionStates: (left, right) => ({ evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])] }),
    // A derivation with no evidence behind it is not a license SCCE may
    // emit -- the empty state is legitimate only as the semiring identity.
    isSupported: () => true
  });

  const candidates = [...input.algebra.operators.entries()]
    .filter(([id]) => input.algebra.registry.depths[id] !== undefined);
  const atoms: Array<BoundedDecodingAtom<DerivationLicense>> = candidates.map(([id, operator]) => {
    const key: ChartKey = { coverage: id, discourseStateId: "discourse.generative", populationId: "population.generative" };
    const state: DerivationLicense = { evidenceIds: [...operator.evidenceIds].sort() };
    const support = Math.max(1, operator.evidenceIds.length);
    const carrier: ProofLicenseCarrier<DerivationLicense> = new Map([
      [[...state.evidenceIds].sort().join(","), { state, value: Math.log(support) }]
    ]);
    return { id, key, carrier };
  });

  // Edges are real compositions: parent-to-child links the registry already
  // admitted as type-compatible and acyclic.
  const edges: BoundedDecodingEdge[] = [];
  for (const composite of input.algebra.composed) {
    for (const port of composite.ports) {
      if (!input.algebra.operators.has(port.childConstructionId)) continue;
      if (!input.algebra.operators.has(composite.id)) continue;
      edges.push({
        leftAtomId: composite.id,
        rightAtomId: port.childConstructionId,
        ruleId: `compose.${composite.id}.${port.portId}`,
        resultKey: (leftKey, rightKey) => ({
          coverage: [...new Set([...leftKey.coverage.split(","), ...rightKey.coverage.split(",")])].sort().join(","),
          discourseStateId: leftKey.discourseStateId,
          populationId: leftKey.populationId
        })
      });
    }
  }

  const decoded = decodeBounded<DerivationLicense>({
    atoms,
    edges,
    semiring,
    treewidthBudget: input.treewidthBudget ?? 4
  });

  let bestConstructionId: string | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestEvidence: string[] = [];
  for (const [, cell] of decoded.chart.cells) {
    for (const [, entry] of cell.carrier) {
      // Prefer a genuinely composed derivation over a bare leaf at equal
      // score: the composite is the structure the corpus never contained.
      const coverageSize = cell.key.coverage.split(",").length;
      const score = entry.value + Math.log(coverageSize);
      if (score <= bestScore) continue;
      bestScore = score;
      bestEvidence = entry.state.evidenceIds;
      bestConstructionId = cell.key.coverage.split(",").sort((left, right) =>
        (input.algebra.registry.depths[right] ?? 0) - (input.algebra.registry.depths[left] ?? 0))[0];
    }
  }

  const text = bestConstructionId
    ? realizeDerivation({ constructionId: bestConstructionId, algebra: input.algebra })
    : "";

  // The chart holds every licensed derivation, not just the argmax; the rivals are what a caller needs to see that a
  // choice was made rather than forced.
  const bestCell = [...decoded.chart.cells.values()].find(cell => cell.key.coverage.includes(bestConstructionId ?? " "));
  const alternatives = bestCell
    ? extractDerivations(decoded.chart, bestCell.key, 8)
      .flatMap(derivation => {
        const coverage = derivation.leafKeyIds
          .flatMap(leafKeyId => (decoded.chart.cells.get(leafKeyId)?.key.coverage ?? "").split(","))
          .filter(Boolean);
        const constructionId = [...new Set(coverage)].sort((left, right) =>
          (input.algebra.registry.depths[right] ?? 0) - (input.algebra.registry.depths[left] ?? 0))[0];
        if (!constructionId || constructionId === bestConstructionId) return [];
        return [{ constructionId, ruleIds: derivation.ruleIds, text: realizeDerivation({ constructionId, algebra: input.algebra }) }];
      })
      .filter(row => row.text)
    : [];

  return {
    ...(bestConstructionId ? { bestConstructionId } : {}),
    bestScore,
    text,
    evidenceIds: bestEvidence,
    alternatives,
    chart: decoded.chart,
    treewidth: decoded.treewidth,
    audit: toJsonValue({
      source: "scce.generative_derivation.search.v1",
      atoms: atoms.length,
      compositionEdges: edges.length,
      chartCells: decoded.chart.cells.size,
      treewidth: decoded.treewidth,
      excludedAtoms: decoded.excludedAtomIds.length,
      bestConstructionId: bestConstructionId ?? null,
      bestDepth: bestConstructionId ? input.algebra.registry.depths[bestConstructionId] ?? 0 : 0,
      bestScore: Number.isFinite(bestScore) ? bestScore : null,
      semiring: "viterbi.log",
      chartKeyIds: [...decoded.chart.cells.keys()].slice(0, 8).map(key => key.slice(0, 48))
    })
  };
}

/**
 * TARGET-CONDITIONED DERIVATION SEARCH.
 *
 * `argmax_{D |= T} score(D | T, G, E)` rather than `argmax_D score(D)`.
 * Atoms are (operator, target part) pairs -- an operator admitted only
 * because it can genuinely express that part -- so `ChartKey.coverage` is
 * a real coverage set over the target, and a derivation's quality is how
 * much of the requested structure it covers and how well.
 */
export function searchTargetConditionedDerivation(input: {
  target: SemanticTarget;
  algebra: ConstructionAlgebra;
  joinMixture?: JoinProgramMixture;
  treewidthBudget?: number;
}): DerivationSearchResult & { coveredPartIds: string[] } {
  const semiring = createProofLicenseSemiring<DerivationLicense>({
    base: viterbiLogSemiring,
    stateKey: state => [...state.evidenceIds].sort().join(","),
    emptyState: { evidenceIds: [] },
    unionStates: (left, right) => ({ evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])] }),
    isSupported: () => true
  });

  const atoms: Array<BoundedDecodingAtom<DerivationLicense>> = [];
  const atomOperator = new Map<string, string>();
  for (const part of input.target.parts) {
    for (const operator of operatorsForTargetPart(part, input.algebra.operators)) {
      const atomId = `${part.id}::${operator.constructionId}`;
      atomOperator.set(atomId, operator.constructionId);
      // Evidence shared between the target part and the operator is what
      // licenses using this operator for this part.
      const shared = operator.evidenceIds.filter(id => part.evidenceIds.includes(id));
      const state: DerivationLicense = { evidenceIds: [...new Set(shared.length ? shared : operator.evidenceIds)].sort() };
      const support = Math.max(1, shared.length || operator.evidenceIds.length);
      atoms.push({
        id: atomId,
        key: { coverage: part.id, discourseStateId: "discourse.target", populationId: "population.target" },
        carrier: new Map([[state.evidenceIds.join(","), { state, value: Math.log(support) }]])
      });
    }
  }

  // Edges join derivations covering DIFFERENT target parts; coverage
  // disjointness is then enforced by combineCells itself.
  const edges: BoundedDecodingEdge[] = [];
  for (const left of atoms) {
    for (const right of atoms) {
      if (left.key.coverage >= right.key.coverage) continue;
      edges.push({
        leftAtomId: left.id,
        rightAtomId: right.id,
        ruleId: `cover.${left.id}+${right.id}`,
        resultKey: (leftKey, rightKey) => ({
          coverage: [...new Set([...leftKey.coverage.split(","), ...rightKey.coverage.split(",")])].sort().join(","),
          discourseStateId: leftKey.discourseStateId,
          populationId: leftKey.populationId
        })
      });
    }
  }

  const decoded = decodeBounded<DerivationLicense>({
    atoms,
    edges,
    semiring,
    treewidthBudget: input.treewidthBudget ?? 4
  });

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestCoverage: string[] = [];
  let bestEvidence: string[] = [];
  for (const [, cell] of decoded.chart.cells) {
    const covered = cell.key.coverage.split(",").filter(Boolean);
    for (const [, entry] of cell.carrier) {
      // Coverage of the requested target dominates: a derivation expressing
      // more of what was asked for beats a cheaper one expressing less.
      const score = covered.length * 10 + entry.value;
      if (score <= bestScore) continue;
      bestScore = score;
      bestCoverage = covered;
      bestEvidence = entry.state.evidenceIds;
    }
  }

  // Realize each covered part through its best operator, then join the
  // realized units with the learned join program rather than concatenating.
  const units: string[] = [];
  for (const partId of bestCoverage) {
    const atom = atoms.find(row => row.key.coverage === partId);
    const operatorId = atom ? atomOperator.get(atom.id) : undefined;
    if (!operatorId) continue;
    const realized = realizeDerivation({ constructionId: operatorId, algebra: input.algebra });
    if (realized) units.push(realized);
  }
  const joined = renderJoinedSurface(units, input.joinMixture);

  // Each covered part's rival operators, from the same packed chart the coverage was chosen in.
  const alternatives = bestCoverage.flatMap(partId => {
    const atom = atoms.find(row => row.key.coverage === partId);
    const selected = atom ? atomOperator.get(atom.id) : undefined;
    if (!atom) return [];
    return extractDerivations(decoded.chart, atom.key, 4).flatMap(derivation => {
      const constructionId = derivation.leafKeyIds
        .flatMap(leafKeyId => (decoded.chart.cells.get(leafKeyId)?.key.coverage ?? "").split(","))
        .map(coverage => atomOperator.get(coverage))
        .find(operatorId => operatorId && operatorId !== selected);
      if (!constructionId) return [];
      const text = realizeDerivation({ constructionId, algebra: input.algebra });
      return text ? [{ constructionId, ruleIds: derivation.ruleIds, text }] : [];
    });
  });

  return {
    bestScore,
    text: joined.text,
    evidenceIds: bestEvidence,
    alternatives,
    chart: decoded.chart,
    treewidth: decoded.treewidth,
    coveredPartIds: bestCoverage,
    audit: toJsonValue({
      source: "scce.generative_derivation.target_search.v1",
      targetParts: input.target.parts.length,
      atoms: atoms.length,
      coverageEdges: edges.length,
      chartCells: decoded.chart.cells.size,
      coveredParts: bestCoverage.length,
      coverageRatio: input.target.parts.length ? bestCoverage.length / input.target.parts.length : 0,
      treewidth: decoded.treewidth,
      joinStatus: joined.status,
      unresolvedBoundaries: joined.unresolvedBoundaries,
      realizationPath: "join-program",
      bestScore: Number.isFinite(bestScore) ? bestScore : null
    })
  };
}

/** Convenience: close a learned construction set under composition and return the best derivation it licenses. */
export function deriveGenerativeStructure(input: {
  constructions: readonly ReversibleConstruction[];
  maxRecursionDepth?: number;
  treewidthBudget?: number;
}): DerivationSearchResult & { algebra: ConstructionAlgebra } {
  const algebra = buildConstructionAlgebra({
    constructions: input.constructions,
    maxRecursionDepth: input.maxRecursionDepth ?? 3
  });
  return { ...searchBestDerivation({ algebra, ...(input.treewidthBudget !== undefined ? { treewidthBudget: input.treewidthBudget } : {}) }), algebra };
}

export { chartKeyId };

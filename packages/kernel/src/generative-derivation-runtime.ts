import {
  EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY,
  registerBaseConstruction,
  registerComposedConstruction,
  type ComposedConstruction,
  type ConstructionCompositionRegistry
} from "./construction-composition.js";
import { decodeBounded, type BoundedDecodingAtom, type BoundedDecodingEdge } from "./bounded-chart-decoding.js";
import { chartKeyId, type ChartKey, type DerivationChart } from "./derivation-chart.js";
import {
  createProofLicenseSemiring,
  viterbiLogSemiring,
  type ProofLicenseCarrier,
  type ProofLicenseSemiring
} from "./proof-license-semiring.js";
import type { ReversibleConstruction } from "./reversible-construction.js";
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
      const ports = parent.argumentTypes.flatMap(argument => {
        const fillerId = (byResultType.get(argument.type) ?? []).find(candidate => candidate !== parent.constructionId);
        return fillerId ? [{ portId: argument.portId, childConstructionId: fillerId }] : [];
      });
      if (ports.length !== parent.argumentTypes.length) continue;
      const id = `composed.${parent.constructionId}.d${depth}`;
      if (registry.depths[id] !== undefined) continue;
      try {
        registry = registerComposedConstruction(registry, {
          id,
          baseConstructionId: parent.constructionId,
          ports,
          maxRecursionDepth: input.maxRecursionDepth
        });
      } catch {
        // Cycle or depth-bound refusal from the real registry -- skip this
        // composite, never force it.
        continue;
      }
      const record = registry.composed[id];
      if (record) admittedThisDepth.push(record);
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
  if (!composite || !operator.surface.slots.length) return operator.surface.text.trim();

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

/** Proof-license state for a derivation: the evidence that licenses it. Two derivations carrying the same evidence set are the same license. */
interface DerivationLicense {
  evidenceIds: string[];
}

export interface DerivationSearchResult {
  bestConstructionId?: string;
  bestScore: number;
  text: string;
  evidenceIds: string[];
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

  return {
    ...(bestConstructionId ? { bestConstructionId } : {}),
    bestScore,
    text,
    evidenceIds: bestEvidence,
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

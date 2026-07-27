/**
 * Plan item 96. Recursive construction composition through typed graph
 * ports, with a bounded recursion-depth policy and real cycle detection --
 * additive to `reversible-construction.ts` rather than modifying it: a
 * `ComposedConstruction` references other constructions (base
 * `ReversibleConstruction`s or other composed constructions) by id through
 * named ports, which `ReversibleConstructionGraphPort` could not do (it
 * only references raw graph targets).
 */

export interface ComposedConstructionPort {
  portId: string;
  childConstructionId: string;
}

export interface ComposedConstruction {
  id: string;
  baseConstructionId: string;
  ports: ComposedConstructionPort[];
  depth: number;
}

export interface ConstructionCompositionRegistry {
  depths: Record<string, number>;
  ancestors: Record<string, string[]>;
  composed: Record<string, ComposedConstruction>;
}

export const EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY: ConstructionCompositionRegistry = {
  depths: {},
  ancestors: {},
  composed: {}
};

/** Registers a leaf/base construction (an existing `ReversibleConstruction`) at depth 0 -- the recursion base case. */
export function registerBaseConstruction(
  registry: ConstructionCompositionRegistry,
  constructionId: string
): ConstructionCompositionRegistry {
  if (registry.depths[constructionId] !== undefined) {
    throw new Error(`construction already registered: ${constructionId}`);
  }
  return {
    ...registry,
    depths: { ...registry.depths, [constructionId]: 0 },
    ancestors: { ...registry.ancestors, [constructionId]: [] }
  };
}

export interface RegisterComposedConstructionInput {
  id: string;
  baseConstructionId: string;
  ports: readonly ComposedConstructionPort[];
  maxRecursionDepth: number;
}

/**
 * Registers a composed construction referencing other, already-registered
 * constructions through its ports. Real cycle detection: a port cannot
 * reference the construction being defined, nor any of that construction's
 * own would-be ancestors (i.e. any construction whose own port chain
 * already leads back to this one) -- checked directly against each
 * referenced child's recorded ancestor chain, not merely by depth
 * arithmetic (which alone cannot distinguish a cycle from a coincidentally
 * equal depth). Depth is `1 + max(child depths)`, and construction is
 * refused outright if this exceeds `maxRecursionDepth` -- a real bound,
 * not an advisory one.
 */
export function registerComposedConstruction(
  registry: ConstructionCompositionRegistry,
  input: RegisterComposedConstructionInput
): ConstructionCompositionRegistry {
  if (registry.depths[input.id] !== undefined) {
    throw new Error(`construction already registered: ${input.id}`);
  }
  if (!input.ports.length) {
    throw new Error(`composed construction ${input.id} must reference at least one child construction`);
  }
  const childAncestorSets: string[][] = [];
  for (const port of input.ports) {
    const childId = port.childConstructionId;
    if (childId === input.id) {
      throw new Error(`cycle detected: ${input.id} cannot reference itself via port ${port.portId}`);
    }
    const childDepth = registry.depths[childId];
    const childAncestors = registry.ancestors[childId];
    if (childDepth === undefined || childAncestors === undefined) {
      throw new Error(`composed construction ${input.id} references unregistered construction: ${childId}`);
    }
    if (childAncestors.includes(input.id)) {
      throw new Error(`cycle detected: ${childId} is already an ancestor-dependent of ${input.id}, via port ${port.portId}`);
    }
    childAncestorSets.push([childId, ...childAncestors]);
  }
  const depth = 1 + Math.max(...input.ports.map(port => registry.depths[port.childConstructionId]!));
  if (depth > input.maxRecursionDepth) {
    throw new Error(`composed construction ${input.id} would exceed max recursion depth ${input.maxRecursionDepth} (computed depth ${depth})`);
  }
  const ancestors = [...new Set(childAncestorSets.flat())].sort();
  const composedConstruction: ComposedConstruction = {
    id: input.id,
    baseConstructionId: input.baseConstructionId,
    ports: [...input.ports],
    depth
  };
  return {
    depths: { ...registry.depths, [input.id]: depth },
    ancestors: { ...registry.ancestors, [input.id]: ancestors },
    composed: { ...registry.composed, [input.id]: composedConstruction }
  };
}

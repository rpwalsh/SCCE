import { describe, expect, it } from "vitest";
import {
  EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY,
  registerBaseConstruction,
  registerComposedConstruction,
  type ConstructionCompositionRegistry
} from "../construction-composition.js";

function registryWithLeaves(...ids: string[]): ConstructionCompositionRegistry {
  return ids.reduce((registry, id) => registerBaseConstruction(registry, id), EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY);
}

describe("recursive construction composition (plan item 96)", () => {
  it("a base construction is registered at depth 0", () => {
    const registry = registerBaseConstruction(EMPTY_CONSTRUCTION_COMPOSITION_REGISTRY, "construction.leaf");
    expect(registry.depths["construction.leaf"]).toBe(0);
  });

  it("composes two base constructions into one at depth 1", () => {
    let registry = registryWithLeaves("construction.subject", "construction.verb");
    registry = registerComposedConstruction(registry, {
      id: "construction.clause",
      baseConstructionId: "construction.clause.base",
      ports: [
        { portId: "subject", childConstructionId: "construction.subject" },
        { portId: "verb", childConstructionId: "construction.verb" }
      ],
      maxRecursionDepth: 8
    });
    expect(registry.depths["construction.clause"]).toBe(1);
    expect(registry.composed["construction.clause"]!.ports).toHaveLength(2);
  });

  it("recursion depth grows correctly across multiple real composition levels", () => {
    let registry = registryWithLeaves("construction.noun");
    registry = registerComposedConstruction(registry, {
      id: "construction.noun-phrase",
      baseConstructionId: "construction.np.base",
      ports: [{ portId: "head", childConstructionId: "construction.noun" }],
      maxRecursionDepth: 8
    });
    registry = registerComposedConstruction(registry, {
      id: "construction.prepositional-phrase",
      baseConstructionId: "construction.pp.base",
      ports: [{ portId: "object", childConstructionId: "construction.noun-phrase" }],
      maxRecursionDepth: 8
    });
    registry = registerComposedConstruction(registry, {
      id: "construction.sentence",
      baseConstructionId: "construction.sentence.base",
      ports: [{ portId: "modifier", childConstructionId: "construction.prepositional-phrase" }],
      maxRecursionDepth: 8
    });
    expect(registry.depths["construction.noun-phrase"]).toBe(1);
    expect(registry.depths["construction.prepositional-phrase"]).toBe(2);
    expect(registry.depths["construction.sentence"]).toBe(3);
  });

  it("refuses a construction that would exceed the max recursion depth -- a real, enforced bound", () => {
    let registry = registryWithLeaves("construction.a");
    registry = registerComposedConstruction(registry, {
      id: "construction.b",
      baseConstructionId: "b.base",
      ports: [{ portId: "p", childConstructionId: "construction.a" }],
      maxRecursionDepth: 8
    });
    expect(() => registerComposedConstruction(registry, {
      id: "construction.c",
      baseConstructionId: "c.base",
      ports: [{ portId: "p", childConstructionId: "construction.b" }],
      maxRecursionDepth: 1
    })).toThrow(/exceed max recursion depth/);
  });

  it("refuses direct self-reference", () => {
    const registry = registryWithLeaves("construction.a");
    expect(() => registerComposedConstruction(registry, {
      id: "construction.a-wrapper",
      baseConstructionId: "base",
      ports: [{ portId: "p", childConstructionId: "construction.a-wrapper" }],
      maxRecursionDepth: 8
    })).toThrow(/cannot reference itself/);
  });

  it("the ancestor-chain cycle check itself refuses a genuinely cyclic registry state", () => {
    // The public API is append-only (a composed construction's children
    // must already be registered), which structurally prevents a true
    // cycle from ever being *constructed* through normal calls alone --
    // there is no way to make an already-registered child's ancestor
    // chain contain an id that does not exist yet. That does not mean the
    // ancestor-chain check is dead code: it is the defense against a
    // corrupted registry (e.g. built by hand, or by a future caller that
    // stops going through these functions). This test proves that defense
    // actually refuses such a state rather than silently accepting it, by
    // constructing exactly that corrupted state directly.
    let registry = registryWithLeaves("construction.a");
    registry = registerComposedConstruction(registry, {
      id: "construction.b",
      baseConstructionId: "b.base",
      ports: [{ portId: "p", childConstructionId: "construction.a" }],
      maxRecursionDepth: 8
    });
    const corrupted: ConstructionCompositionRegistry = {
      ...registry,
      // Pretend "construction.b" already (incorrectly) lists the
      // not-yet-registered "construction.c" as one of its own ancestors.
      ancestors: { ...registry.ancestors, "construction.b": [...registry.ancestors["construction.b"]!, "construction.c"] }
    };
    expect(() => registerComposedConstruction(corrupted, {
      id: "construction.c",
      baseConstructionId: "c.base",
      ports: [{ portId: "p", childConstructionId: "construction.b" }],
      maxRecursionDepth: 8
    })).toThrow(/cycle detected/);
  });

  it("refuses referencing an unregistered construction", () => {
    const registry = registryWithLeaves("construction.a");
    expect(() => registerComposedConstruction(registry, {
      id: "construction.b",
      baseConstructionId: "base",
      ports: [{ portId: "p", childConstructionId: "construction.missing" }],
      maxRecursionDepth: 8
    })).toThrow(/unregistered construction/);
  });

  it("refuses a composed construction with zero ports", () => {
    const registry = registryWithLeaves("construction.a");
    expect(() => registerComposedConstruction(registry, {
      id: "construction.empty",
      baseConstructionId: "base",
      ports: [],
      maxRecursionDepth: 8
    })).toThrow(/at least one child construction/);
  });

  it("refuses registering the same construction id twice", () => {
    const registry = registryWithLeaves("construction.a");
    expect(() => registerBaseConstruction(registry, "construction.a")).toThrow(/already registered/);
  });
});

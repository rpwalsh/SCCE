import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  composeProgramGraphFromBehavior,
  createClock,
  createHasher,
  createIdFactory,
  createProgramPlanner,
  validateProgramCompositionBehavior,
  type FileArtifact,
  type ProgramBehaviorRequirement,
  type ProgramGraph,
  type ProgramModuleSpec
} from "../index.js";

describe("requirement-driven program module composition", () => {
  it("composes dependent artifacts from a blank graph and validates a held-out call", async () => {
    const modules: ProgramModuleSpec[] = [
      {
        moduleId: "module:primitive",
        artifact: artifact("unit/primitive.mjs", "export function lift(value) { return value * 2; }"),
        provides: [port("op:lift", ["json.number"], "json.number")]
      },
      {
        moduleId: "module:application",
        artifact: artifact("unit/application.mjs", "import { lift } from './primitive.mjs'; export function apply(value) { return lift(value); }"),
        provides: [port("op:apply", ["json.number"], "json.number")],
        requires: [port("op:lift", ["json.number"], "json.number")]
      },
      {
        moduleId: "module:incompatible",
        artifact: artifact("unit/incompatible.mjs", "export function apply(value) { return String(value); }"),
        provides: [port("op:apply", ["json.number"], "json.string")]
      }
    ];
    const fit = requirement("fit.apply", "op:apply", 3, 6, "fit");
    const heldOut = requirement("held.apply", "op:apply", 11, 22, "held_out");
    const composition = composeProgramGraphFromBehavior({
      base: blankGraph(),
      modules,
      obligations: [fit, heldOut],
      entrypointModuleId: "module:application"
    });

    expect(composition.selectedModuleIds).toEqual(["module:application", "module:primitive"]);
    expect(composition.unmetHeldOutObligationIds).toEqual([]);
    expect(composition.graph.files.map(file => file.path)).toEqual(["unit/application.mjs", "unit/primitive.mjs"]);
    expect(composition.graph.entrypoint).toBe("unit/application.mjs");
    expect(composition.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "program.module.requires", source: "program.composition.module.module:application", target: "program.composition.module.module:primitive" }),
      expect.objectContaining({ relation: "program.obligation.selects_provider", target: "program.composition.module.module:application" })
    ]));
    expect(composition.graph.files.map(file => file.path)).not.toContain("unit/incompatible.mjs");

    const validation = await validateProgramCompositionBehavior({
      composition,
      obligations: [fit, heldOut],
      execute: (obligation, graph) => {
        const paths = new Set(graph.files.map(file => file.path));
        if (!paths.has("unit/primitive.mjs") || !paths.has("unit/application.mjs")) throw new Error("dependency artifacts are absent");
        return obligation.arguments[0] as number * 2;
      }
    });
    expect(validation.passed).toBe(true);
    expect(validation.outcomes.map(outcome => [outcome.verificationRole, outcome.status])).toEqual([
      ["fit", "passed"],
      ["held_out", "passed"]
    ]);
  });

  it("does not use a held-out obligation to pull an otherwise unused module into the graph", () => {
    const heldOutOnly = requirement("held.future", "op:future", "x", "y", "held_out");
    const composition = composeProgramGraphFromBehavior({
      base: blankGraph(),
      modules: [{
        moduleId: "module:future",
        artifact: artifact("unit/future.mjs", "export function future(value) { return value; }") ,
        provides: [port("op:future", ["json.string"], "json.string")]
      }],
      obligations: [heldOutOnly]
    });
    expect(composition.selectedModuleIds).toEqual([]);
    expect(composition.unmetHeldOutObligationIds).toEqual(["held.future"]);
    expect(composition.graph.files).toEqual([]);
  });

  it("wires typed owner requirements through planner emission into executable dependent artifacts", async () => {
    const clock = createClock({ fixedTime: 44000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const fit = requirement("fit.lift", "lift", 3, 3, "fit");
    const secondFit = requirement("fit.apply", "apply", 11, 11, "fit");
    const heldOutOnly = requirement("held.ghost", "ghost", 5, 5, "held_out");
    const program = createProgramPlanner({ idFactory: ids, hasher }).emit({
      episodeId: ids.episodeId(),
      requestText: "opaque source request",
      evidence: [],
      entailment: plannerEntailment(ids),
      programIntent: {
        artifactKindIds: ["artifact:opaque"],
        capabilityIds: [],
        behaviorRequirements: [fit, secondFit, heldOutOnly],
        behaviorImplementationPhase: "probe"
      }
    });
    const moduleNodes = program.nodes.filter(node => node.kind === "program.module");
    const applicationNode = moduleNodes.find(node => node.label.startsWith("module:application:"));
    expect(applicationNode).toBeDefined();
    const applicationPath = (applicationNode?.metadata as { artifactPath: string }).artifactPath;
    expect(program.files.map(file => file.path)).toEqual(expect.arrayContaining([applicationPath]));
    expect(program.files.filter(file => file.path.includes("ghost")).length).toBe(0);
    expect(program.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "program.module.requires" }),
      expect.objectContaining({ relation: "program.obligation.selects_provider" })
    ]));

    const root = mkdtempSync(join(tmpdir(), "scce-composed-program-"));
    try {
      for (const file of program.files.filter(file => file.path.endsWith(".mjs"))) {
        const target = join(root, file.path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }
      const loaded = await import(pathToFileURL(join(root, applicationPath)).href);
      expect(loaded.apply(11)).toBe(11);
      expect(loaded.lift(3)).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function port(callableId: string, argumentTypes: readonly string[], resultType: string) {
  return { callableId, argumentTypes, resultType };
}

function requirement(id: string, callableId: string, argument: ProgramBehaviorRequirement["arguments"][number], expectedResult: ProgramBehaviorRequirement["expectedResult"], verificationRole: ProgramBehaviorRequirement["verificationRole"]): ProgramBehaviorRequirement {
  return { id, requestHash: `sha256:${"a".repeat(64)}`, callableId, arguments: [argument], expectedResult, verificationRole, relationSurface: "\u0001", sourceSpan: { charStart: 0, charEnd: 1 } };
}

function artifact(path: string, content: string): FileArtifact {
  return { artifactId: `artifact:${path}` as FileArtifact["artifactId"], path, mediaType: "text/javascript", content, contentHash: `hash:${path}` as FileArtifact["contentHash"], role: "source" };
}

function blankGraph(): ProgramGraph {
  return {
    id: "program.blank",
    language: "runtime:opaque",
    packageManager: "package:opaque",
    entrypoint: "",
    nodes: [],
    edges: [],
    files: [],
    build: { command: "runtime:check", args: [], cwd: "." },
    test: { command: "runtime:test", args: [], cwd: "." }
  };
}

function plannerEntailment(ids: ReturnType<typeof createIdFactory>) {
  const claimId = ids.claimId("opaque planner claim");
  const proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return {
    claim: { id: claimId, text: "opaque planner claim", normalized: "opaque planner claim", features: [], polarity: 1 },
    verdict: "underdetermined" as const,
    semanticVerdict: "underdetermined" as const,
    force: "inferred" as const,
    support: 0.7,
    contradiction: 0,
    faithfulnessLcb: 0.7,
    confidence: { verdict: "underdetermined" as const, support: 0.7, contradiction: 0, faithfulnessLcb: 0.7, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0, stability: 0.8, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, faithfulnessLCB: 0.7, contradiction: 0, causalMass: 0, stability: 0.8 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "inferred" as const, confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 44000 }
  };
}

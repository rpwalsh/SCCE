import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  codeRequestSignal,
  COGNITIVE_OPERATOR_IDS,
  createClock,
  createHasher,
  createIdFactory,
  createProgramGraphBuilder,
  programIntentForTurn,
  replanOwnerBehaviorProgramIntent,
  type SemanticEntailmentResult
} from "../index.js";

describe("stateful typed behavior composition", () => {
  it("composes a blank graph into provider/application modules after failed probe validation", async () => {
    const request = [
      "hold(key, value); peek(key); drop(key)",
      "hold(\"a\", 4); peek(\"a\") => 4",
      "hold(\"a\", 9); peek(\"a\") => 9",
      "drop(\"a\"); peek(\"a\") => null",
      "hold(\"b\", {\"n\": 2}); peek(\"b\") => {\"n\": 2}"
    ].join("\n");
    const clock = createClock({ fixedTime: 91000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const signal = codeRequestSignal(request);
    const intent = programIntentForTurn({
      requestedAuthority: "program",
      activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning],
      codeSignal: signal,
      evidence: []
    });
    expect(intent?.statefulBehaviorRequirements).toHaveLength(4);
    const builder = createProgramGraphBuilder({ idFactory: ids, hasher });
    const probe = builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: clock.now(),
      evidence: [],
      entailment: entailment(ids),
      programIntent: intent
    }).program!;
    const moduleNodes = probe.nodes.filter(node => node.kind === "program.module");
    expect(moduleNodes.map(node => node.label)).toEqual(expect.arrayContaining([
      expect.stringContaining("stateful-provider"),
      expect.stringContaining("stateful-application")
    ]));
    expect(probe.files.map(file => file.path)).toEqual(expect.arrayContaining([
      expect.stringMatching(/stateful-provider-.*\.mjs/u),
      expect.stringMatching(/stateful-application-.*\.mjs/u)
    ]));

    const retry = replanOwnerBehaviorProgramIntent({
      intent: intent!,
      program: probe,
      failure: {
        observationId: "stateful.composition.probe.failure",
        programId: probe.id,
        planHash: "stateful.composition.probe.plan",
        validatorId: "validator.owner.node",
        checkId: "tests",
        status: "failed",
        ownerRequirementIds: intent?.statefulBehaviorRequirements?.map(requirement => requirement.id) ?? [],
        command: probe.test
      },
      hasher
    });
    const repaired = builder.build({
      episodeId: ids.episodeId(),
      text: request,
      createdAt: clock.now(),
      evidence: [],
      entailment: entailment(ids),
      programIntent: retry.intent
    }).program!;
    const provider = repaired.files.find(file => /stateful-provider-.*\.mjs/u.test(file.path));
    const application = repaired.files.find(file => /stateful-application-.*\.mjs/u.test(file.path));
    expect(provider?.content).toContain("state.set(statefulKey(args[0]), args[1])");
    expect(provider?.content).not.toContain("expectedResult");
    expect(application?.content).toContain("createStatefulProgram");

    const root = mkdtempSync(join(tmpdir(), "scce-stateful-composition-"));
    try {
      for (const file of repaired.files.filter(file => file.path.endsWith(".mjs"))) {
        const target = join(root, file.path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, file.content, "utf8");
      }
      const loaded = await import(pathToFileURL(join(root, application!.path)).href);
      const stateful = loaded.createStatefulProgram();
      stateful.hold("c", 12);
      expect(stateful.peek("c")).toBe(12);
      stateful.hold("z", { n: 3 });
      expect(stateful.peek("z")).toEqual({ n: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function entailment(ids: ReturnType<typeof createIdFactory>): SemanticEntailmentResult {
  const claimId = ids.claimId("stateful composition claim");
  const proofId = ids.proofId({ claimId, evidenceIds: [], transforms: [], validatorVersion: "fixture" });
  return {
    claim: { id: claimId, text: "stateful composition claim", normalized: "stateful composition claim", features: [], polarity: 1 },
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force: "inferred",
    support: 0.7,
    contradiction: 0,
    faithfulnessLcb: 0.7,
    confidence: { verdict: "underdetermined", support: 0.7, contradiction: 0, faithfulnessLcb: 0.7, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, causalMass: 0, stability: 0.8, satisfiedObligations: 0, requiredObligations: 0 },
    scores: { structuralCoverage: 0.5, roleCoverage: 0.5, relationCompatibility: 0.5, transformationSupport: 0.5, faithfulnessLCB: 0.7, contradiction: 0, causalMass: 0, stability: 0.8 },
    obligations: [], mappings: [], transforms: [], counterexamples: [], missing: [], evidenceIds: [], boundaries: [],
    proof: { id: proofId, claimId, verdict: "inferred", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 91000 }
  };
}

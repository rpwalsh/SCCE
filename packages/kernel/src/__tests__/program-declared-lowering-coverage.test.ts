// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { codeRequestSignal } from "../code-request.js";
import { programIntentForTurn } from "../program-intent.js";
import { createProgramPlanner } from "../program-planner.js";
import { COGNITIVE_OPERATOR_IDS } from "../turn-requirements.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createScceKernel } from "../kernel.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

interface PublicRequest { id: string; language: string; spec: string; requiredCallable: string; requiredArtifacts: string[] }
const requests = (JSON.parse(readFileSync(new URL("./fixtures/application-declared-contract-requests.json", import.meta.url), "utf8")) as { requests: PublicRequest[] }).requests;

function runtime() {
  const clock = createClock({ fixedTime: 1, stepMs: 1 }), hasher = createHasher();
  const fixture = storageFixtureForEvaluation({ evidence: [], clockNow: () => clock.now() });
  fixture.storage.userModelClaims = { putClaim: async () => undefined, listClaims: async () => [] };
  fixture.storage.taskResumption = { putSnapshot: async () => undefined, getLatestSnapshot: async () => null };
  fixture.storage.documentGeneration = { putSession: async () => undefined, getSession: async () => null, compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null }) };
  fixture.storage.dialogueMemory = createInMemoryDialogueMemoryStore();
  const executeProgram = vi.fn(async () => { throw Error("Unlowered request must not execute a native process"); });
  return { executeProgram, kernel: createScceKernel({ storage: fixture.storage, clock,
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }), deterministicReplay: true,
    files: { streamPath: async function* () {} }, buildTest: { executeProgram } }) };
}

it.each(requests)("preserves the exact public $id declared ports and artifact targets", request => {
  const signal = codeRequestSignal(request.spec);
  const intent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: signal, evidence: [] });
  expect(signal.language).toBe(request.language);
  expect(signal.declaredCallableIds).toContain(request.requiredCallable);
  expect(intent?.declaredCallableIds).toContain(request.requiredCallable);
  expect(intent?.requiredArtifactPaths).toEqual(request.requiredArtifacts);
  expect(intent?.behaviorRequirements).toEqual([]);
  expect(intent?.statefulBehaviorRequirements).toEqual([]);
});

it("keeps markup targets independent of the executable language and preserves opaque zero-argument ports", () => {
  const signal = codeRequestSignal("index.html TypeScript μ.ts\nλ()");
  const intent = programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: signal, evidence: [] });
  expect(signal.language).toBe("typescript");
  expect(signal.paths).toEqual(["μ.ts"]);
  expect(signal.artifactPaths).toEqual(["index.html", "μ.ts"]);
  expect(intent?.entrypointPath).toBe("μ.ts");
  expect(intent?.declaredCallableIds).toEqual(["λ"]);
  expect(intent?.requiredArtifactPaths).toEqual(["index.html", "μ.ts"]);
});

it.each(requests)("keeps the exact public $id unresolved instead of emitting a generic utility as its implementation", async request => {
  const { kernel, executeProgram } = runtime();
  const result = await kernel.turn({ text: request.spec, requestedAuthority: "program" });
  expect(Boolean(result.constructGraph.program)).toBe(false);
  expect(result.constructGraph.artifacts).toEqual([]);
  const unavailable = result.constructGraph.nodes.find(node => node.kind === "program_emission_unavailable");
  expect(unavailable?.metadata).toMatchObject({ status: "unavailable", languageId: request.language,
    unresolved: { callableIds: expect.arrayContaining([request.requiredCallable]) } });
  if (request.language === "typescript") expect(unavailable?.metadata).toMatchObject({ unresolved: { artifactPaths: ["index.html"] } });
  expect(executeProgram).not.toHaveBeenCalled();
  const clock = createClock({ fixedTime: 1 }), hasher = createHasher();
  const planner = createProgramPlanner({ hasher, idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }) });
  const input = { episodeId: result.episodeId, requestText: request.spec, entailment: result.entailment, evidence: result.evidence,
    programIntent: programIntentForTurn({ requestedAuthority: "program", activeOperatorIds: [COGNITIVE_OPERATOR_IDS.programPlanning], codeSignal: codeRequestSignal(request.spec), evidence: [] }) };
  const plan = planner.plan(input);
  expect(() => planner.emitPlanned(plan, input)).toThrow("Owner-declared program ports or artifact targets have no owned lowering");
});

it("retains generic utility emission when no unimplemented owner ports were declared", async () => {
  const { kernel } = runtime();
  const result = await kernel.turn({ text: "javascript utility.cjs", requestedAuthority: "program" });
  expect(result.constructGraph.program).toBeDefined();
  expect(result.constructGraph.program!.files.some(file => file.path === "utility.cjs")).toBe(true);
});

it.each([
  "javascript opaque.cjs\nopaquePulse(2,3) => 5\nopaquePulse(7,4) => 11\nopaquePulse(-3,1) => -2",
  'javascript opaque.cjs\nu(k,v); q(k);\nu("a",1); q("a") => 1;\nu("a",2); q("a") => 2;\nq("missing") => null;'
])("preserves real typed scalar/stateful probe and retry admission: %s", async request => {
  const { kernel } = runtime();
  const result = await kernel.turn({ text: request, requestedAuthority: "program" });
  expect(result.constructGraph.program).toBeDefined();
  expect(result.constructGraph.program!.hydration?.ownerRequirementIds?.length).toBeGreaterThan(0);
});

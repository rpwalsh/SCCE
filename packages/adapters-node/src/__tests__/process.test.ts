// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHasher,
  createProgramHydrationContract,
  hydrationSummary,
  planObservedProgramRepairTransition,
  type ConstructGraph,
  type EpisodeId,
  type FileArtifact,
  type ProgramGraph
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "../config.js";
import { NodeBuildTestAdapter } from "../process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("NodeBuildTestAdapter execution authority", () => {
  it("reports an injected compiler failure without applying an adapter-owned repair", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "scce-build-observer-"));
    roots.push(tempRoot);
    const source = artifact("src/program.mjs", "export function value() { return 1; }\n", "source");
    const test = artifact("test/program.test.mjs", "import '../src/program.mjs';\n", "test");
    const construct = {
      id: "construct.build-observer",
      artifacts: [source, test],
      program: {
        id: "program.build-observer",
        language: "javascript",
        packageManager: "node",
        entrypoint: source.path,
        nodes: [],
        edges: [],
        files: [source, test],
        build: { command: process.execPath, args: ["--check", source.path], cwd: "." },
        test: { command: process.execPath, args: [test.path], cwd: "." }
      }
    } as unknown as ConstructGraph;
    const adapter = new NodeBuildTestAdapter({ runtime: { tempRoot } } as ScceRuntimeConfig);

    const result = await adapter.executeProgram({
      episodeId: "episode.build-observer" as EpisodeId,
      construct,
      faultInjection: "unbalanced-brace"
    });

    expect(result.passed).toBe(false);
    expect(result.build.code).not.toBe(0);
    expect(result.test.code).toBeNull();
    expect(result.repairAttempted).toBe(false);
    expect(result.repairApplied).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.artifacts.find(item => item.path === source.path)?.content).not.toBe(source.content);
  });

  it("executes each graph-bound command from its declared workspace cwd", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "scce-build-cwd-"));
    roots.push(tempRoot);
    const source = artifact("app/src/program.mjs", "export function value() { return 7; }\n", "source");
    const test = artifact("app/test/program.test.mjs", "import { value } from '../src/program.mjs';\nif (value() !== 7) process.exit(9);\n", "test");
    const construct = {
      id: "construct.build-cwd",
      artifacts: [source, test],
      program: {
        id: "program.build-cwd",
        language: "javascript",
        packageManager: "node",
        entrypoint: source.path,
        nodes: [],
        edges: [],
        files: [source, test],
        build: { command: process.execPath, args: ["--check", "app/src/program.mjs"], cwd: "" },
        test: { command: process.execPath, args: ["test/program.test.mjs"], cwd: "app" }
      }
    } as unknown as ConstructGraph;
    const adapter = new NodeBuildTestAdapter({ runtime: { tempRoot } } as ScceRuntimeConfig);

    const result = await adapter.executeProgram({
      episodeId: "episode.build-cwd" as EpisodeId,
      construct
    });

    expect(result.passed).toBe(true);
    expect(result.build.code).toBe(0);
    expect(result.test.code).toBe(0);
  });

  it("retries only after the kernel binds, selects, and materializes the observed failure", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "scce-build-replan-"));
    roots.push(tempRoot);
    const hasher = createHasher();
    const source = artifact("src/program.mjs", "export function value() { return 1; }\n", "source");
    const test = artifact("test/program.test.mjs", "import '../src/program.mjs';\n", "test");
    const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
      id: "program.build-replan",
      language: "javascript",
      packageManager: "node",
      entrypoint: source.path,
      nodes: [source, test].map(file => ({ id: `artifact:${file.path}`, kind: `artifact:${file.role}`, label: file.path, metadata: { contentHash: file.contentHash } })),
      edges: [],
      files: [source, test],
      build: { command: process.execPath, args: ["--check", source.path], cwd: "." },
      test: { command: process.execPath, args: [test.path], cwd: "." }
    };
    const hydration = createProgramHydrationContract({
      program: graphWithoutHydration,
      sourcePlanId: "owner.program.plan",
      ownerRequirementIds: ["owner.requirement.value"]
    });
    const program: ProgramGraph = {
      ...graphWithoutHydration,
      hydration,
      nodes: [...graphWithoutHydration.nodes, { id: "program-hydration", kind: "program_hydration_contract", label: hydration.schema, metadata: hydrationSummary(hydration) }],
      edges: [{ source: "owner.program.plan", target: "program-hydration", relation: "hydrates_as", weight: 1 }]
    };
    const construct = { id: "construct.build-replan", artifacts: program.files, program } as unknown as ConstructGraph;
    const adapter = new NodeBuildTestAdapter({ runtime: { tempRoot } } as ScceRuntimeConfig);

    const failed = await adapter.executeProgram({
      episodeId: "episode.build-replan" as EpisodeId,
      construct,
      faultInjection: "unbalanced-brace"
    });
    const transition = planObservedProgramRepairTransition({
      program,
      build: failed,
      requestText: "owner.program.request",
      activeRequirementIds: ["owner.requirement.value"],
      hasher
    });

    expect(transition.selection.selectedPatchSetId).toBeTruthy();
    expect(transition.selection.failureObservationId).toBe(transition.failureObservationId);
    expect(transition.selection.activeRequirementIds).toEqual(["owner.requirement.value"]);
    expect(transition.repairedProgram).toBeDefined();
    expect(transition.changedPaths).toEqual([source.path]);

    const repairedProgram = transition.repairedProgram!;
    const repaired = await adapter.executeProgram({
      episodeId: "episode.build-replan" as EpisodeId,
      construct: { ...construct, id: "construct.build-replan.selected", program: repairedProgram, artifacts: repairedProgram.files } as unknown as ConstructGraph
    });
    expect(repaired.passed).toBe(true);
    expect(repaired.attempts).toHaveLength(1);

    const unselected = planObservedProgramRepairTransition({
      program,
      build: failed,
      requestText: "owner.program.request",
      activeRequirementIds: [],
      hasher
    });
    expect(unselected.repairedProgram).toBeUndefined();
    expect(unselected.selection.rejectionReasonIds).toContain("repair.selection.active_requirement_missing");
  });
});

function artifact(path: string, content: string, role: FileArtifact["role"]): FileArtifact {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return {
    artifactId: `artifact.${digest.slice(0, 24)}` as FileArtifact["artifactId"],
    path,
    mediaType: "text/javascript",
    content,
    contentHash: `sha256_${digest}` as FileArtifact["contentHash"],
    role
  };
}

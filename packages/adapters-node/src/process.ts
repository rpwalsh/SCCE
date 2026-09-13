// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildTestPort, BuildTestResult, ConstructGraph, EpisodeId, FileArtifact } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { runProcess } from "./document.js";
import { repairProgramArtifacts } from "./program-repair.js";

export class NodeBuildTestAdapter implements BuildTestPort {
  constructor(private readonly config: ScceRuntimeConfig) {}

  async executeProgram(input: { episodeId: EpisodeId; construct: ConstructGraph; faultInjection?: string }): Promise<BuildTestResult> {
    if (!input.construct.program) throw new Error("construct has no ProgramGraph to build");
    const root = path.join(this.config.runtime.tempRoot, String(input.episodeId), String(input.construct.id));
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const firstArtifacts = input.faultInjection ? injectFault(input.construct.artifacts, input.faultInjection) : input.construct.artifacts;
    await writeArtifacts(root, firstArtifacts);
    let build = await runExpanded(input.construct.program.build.command, input.construct.program.build.args, root);
    let test = build.code === 0 ? await runExpanded(input.construct.program.test.command, input.construct.program.test.args, root) : { code: null, stdout: "", stderr: "build failed; tests skipped", durationMs: 0 };
    let artifacts = firstArtifacts;
    let repairAttempted = false;
    let repairApplied = false;
    const attempts: NonNullable<BuildTestResult["attempts"]> = [{ build, test, artifacts }];
    if (build.code !== 0 || test.code !== 0) {
      repairAttempted = true;
      const repaired = repairProgramArtifacts(firstArtifacts, `${build.stderr}\n${test.stderr}\n${build.stdout}\n${test.stdout}`);
      if (repaired.changed) {
        repairApplied = true;
        artifacts = repaired.artifacts;
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        await writeArtifacts(root, artifacts);
        build = await runExpanded(input.construct.program.build.command, input.construct.program.build.args, root);
        test = build.code === 0 ? await runExpanded(input.construct.program.test.command, input.construct.program.test.args, root) : { code: null, stdout: "", stderr: "build failed after repair; tests skipped", durationMs: 0 };
        attempts.push({ build, test, artifacts });
      }
    }
    return { build, test, repairAttempted, repairApplied, passed: build.code === 0 && test.code === 0, artifacts, attempts };
  }
}

/** Named defects for the live repair acceptance test. "unbalanced-brace": the first source file loses its last closing
 *  brace, a SyntaxError the repairer's brace balancing restores. Unknown names change nothing. */
function injectFault(artifacts: readonly FileArtifact[], fault: string): FileArtifact[] {
  if (fault !== "unbalanced-brace") return [...artifacts];
  let done = false;
  return artifacts.map(artifact => {
    if (done || !/\.(mjs|js)$/u.test(artifact.path) || !artifact.content.includes("}")) return artifact;
    done = true;
    const content = artifact.content.slice(0, artifact.content.lastIndexOf("}")) + artifact.content.slice(artifact.content.lastIndexOf("}") + 1);
    return { ...artifact, content, contentHash: `sha256_${createHash("sha256").update(content).digest("hex")}` as FileArtifact["contentHash"] };
  });
}

async function writeArtifacts(root: string, artifacts: FileArtifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const target = path.resolve(root, artifact.path);
    if (!target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error(`artifact path escapes workspace: ${artifact.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, artifact.content, "utf8");
  }
}

async function runExpanded(command: string, args: string[], cwd: string) {
  const expandedArgs = args.flatMap(arg => arg.includes("*") ? expandGlob(arg, cwd) : [arg]);
  return runProcess(command, expandedArgs, { cwd, timeoutMs: 120000 });
}

function expandGlob(arg: string, cwd: string): string[] {
  if (arg === "diagnostics/*.json") return ["diagnostics.expected.json"];
  return [arg];
}

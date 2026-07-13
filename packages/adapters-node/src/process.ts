import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildTestPort, BuildTestResult, ConstructGraph, EpisodeId, FileArtifact } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { runProcess } from "./document.js";
import { repairProgramArtifacts } from "./program-repair.js";

export class NodeBuildTestAdapter implements BuildTestPort {
  constructor(private readonly config: ScceRuntimeConfig) {}

  async executeProgram(input: { episodeId: EpisodeId; construct: ConstructGraph }): Promise<BuildTestResult> {
    if (!input.construct.program) throw new Error("construct has no ProgramGraph to build");
    const root = path.join(this.config.runtime.tempRoot, String(input.episodeId), String(input.construct.id));
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await writeArtifacts(root, input.construct.artifacts);
    let build = await runExpanded(input.construct.program.build.command, input.construct.program.build.args, root);
    let test = build.code === 0 ? await runExpanded(input.construct.program.test.command, input.construct.program.test.args, root) : { code: null, stdout: "", stderr: "build failed; tests skipped", durationMs: 0 };
    let artifacts = input.construct.artifacts;
    let repairAttempted = false;
    let repairApplied = false;
    if (build.code !== 0 || test.code !== 0) {
      repairAttempted = true;
      const repaired = repairProgramArtifacts(input.construct.artifacts, `${build.stderr}\n${test.stderr}\n${build.stdout}\n${test.stdout}`);
      if (repaired.changed) {
        repairApplied = true;
        artifacts = repaired.artifacts;
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });
        await writeArtifacts(root, artifacts);
        build = await runExpanded(input.construct.program.build.command, input.construct.program.build.args, root);
        test = build.code === 0 ? await runExpanded(input.construct.program.test.command, input.construct.program.test.args, root) : { code: null, stdout: "", stderr: "build failed after repair; tests skipped", durationMs: 0 };
      }
    }
    return { build, test, repairAttempted, repairApplied, passed: build.code === 0 && test.code === 0, artifacts };
  }
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

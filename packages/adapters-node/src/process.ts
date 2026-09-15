// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildTestPort, BuildTestResult, ConstructGraph, EpisodeId, FileArtifact } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { runProcess } from "./document.js";

export class NodeBuildTestAdapter implements BuildTestPort {
  constructor(private readonly config: ScceRuntimeConfig) {}

  async executeProgram(input: { episodeId: EpisodeId; construct: ConstructGraph; faultInjection?: string }): Promise<BuildTestResult> {
    if (!input.construct.program) throw new Error("construct has no ProgramGraph to build");
    const executionBase = path.join(this.config.runtime.tempRoot, String(input.episodeId), String(input.construct.id));
    let root: string | undefined;
    try {
      root = await withExecutionBaseLock(executionBase, async () => {
        await mkdir(executionBase, { recursive: true });
        return mkdtemp(path.join(executionBase, "run-"));
      });
      const workspace = root;
      const firstArtifacts = input.faultInjection ? injectFault(input.construct.artifacts, input.faultInjection) : input.construct.artifacts;
      await writeArtifacts(workspace, firstArtifacts);
      const build = await runExpanded(
        input.construct.program.build.command,
        input.construct.program.build.args,
        executionCwd(workspace, input.construct.program.build.cwd)
      );
      const test = build.code === 0
        ? await runExpanded(
          input.construct.program.test.command,
          input.construct.program.test.args,
          executionCwd(workspace, input.construct.program.test.cwd)
        )
        : { code: null, stdout: "", stderr: "build failed; tests skipped", durationMs: 0 };
      const testExecutionReceipt = {
        command: input.construct.program.test.command,
        args: [...input.construct.program.test.args],
        cwd: input.construct.program.test.cwd,
        status: build.code === 0 ? "executed" as const : "skipped" as const
      };
      // This port observes execution. It may diagnose a failure, but it must not
      // select or apply a transformation before the cognitive replan sees it.
      // The kernel owns failure -> candidate -> selector -> retry authority.
      const attempts: NonNullable<BuildTestResult["attempts"]> = [{ build, test, artifacts: firstArtifacts }];
      return {
        build,
        test,
        testExecutionReceipt,
        repairAttempted: false,
        repairApplied: false,
        passed: build.code === 0 && test.code === 0,
        artifacts: firstArtifacts,
        attempts
      };
    } finally {
      await withExecutionBaseLock(executionBase, async () => {
        if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
        await removeEmptyDirectory(executionBase);
        await removeEmptyDirectory(path.dirname(executionBase));
      });
    }
  }
}

const executionBaseLocks = new Map<string, Promise<void>>();

async function withExecutionBaseLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = executionBaseLocks.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  executionBaseLocks.set(directory, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (executionBaseLocks.get(directory) === queued) executionBaseLocks.delete(directory);
  }
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    // A sibling run or construct still owns this parent, or another cleanup
    // won the race. Both are normal for concurrent executions.
    // Windows can report EPERM, rather than ENOTEMPTY/ENOENT, when two
    // nonrecursive removals overlap. This cleanup is best-effort; the unique
    // run directory above is the isolation boundary and is already gone.
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") return;
    throw error;
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

function executionCwd(root: string, cwd: string): string {
  const requestedCwd = cwd === "" ? "." : cwd;
  if (requestedCwd.includes("\u0000") || path.isAbsolute(requestedCwd)) {
    throw new Error(`program command cwd must be workspace-relative: ${cwd}`);
  }
  const resolved = path.resolve(root, requestedCwd);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`program command cwd escapes workspace: ${cwd}`);
  }
  return resolved;
}

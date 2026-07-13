import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PatchTransactionPlan } from "@scce/kernel";
import type { WorkspacePatchValidationResult, WorkspacePatchValidationView } from "./workspace-patch-transaction.js";

export const STRUCTURED_PATCH_VALIDATION_POLICY_SCHEMA = "yopp.patch-validation-policy.v1" as const;
export const STRUCTURED_PATCH_VALIDATION_EVIDENCE_SCHEMA = "yopp.patch-validation-evidence.v2" as const;
export const TRUSTED_HOST_PATCH_VALIDATION_PROVIDER_ID = "trusted-host-process.v1" as const;

export interface StructuredPatchValidationCommand {
  /** Server-owned executable. It is never read from the patch request. */
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
}

export interface StructuredPatchValidationPolicy {
  readonly schemaVersion: typeof STRUCTURED_PATCH_VALIDATION_POLICY_SCHEMA;
  readonly id: string;
  readonly commands: readonly StructuredPatchValidationCommand[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxWorkspaceFiles: number;
  readonly maxWorkspaceBytes: number;
  readonly ignoredTopLevelNames?: readonly string[];
  /** Explicit environment values. Only platform process-launch variables are inherited. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface StructuredPatchValidationCommandResult {
  readonly index: number;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutHash: `sha256:${string}`;
  readonly stderrHash: `sha256:${string}`;
}

export interface StructuredPatchValidationEvidence {
  readonly schemaVersion: typeof STRUCTURED_PATCH_VALIDATION_EVIDENCE_SCHEMA;
  readonly policyId: string;
  readonly planHash: PatchTransactionPlan["planHash"];
  readonly stagedFileCount: number;
  readonly stagedByteCount: number;
  readonly execution: StructuredPatchValidationExecutionEvidence;
  readonly dependencyMaterialization?: unknown;
  readonly commands: readonly StructuredPatchValidationCommandResult[];
}

export type StructuredPatchValidationBoundary = "trusted-host" | "os-sandbox";

export interface StructuredPatchValidationExecutionEvidence {
  readonly providerId: string;
  readonly boundary: StructuredPatchValidationBoundary;
  readonly backend: string;
  /** Describes what was actually exercised, not what the adapter could do. */
  readonly verificationLevel: "local-process-executed" | "implementation-only" | "os-sandbox-executed";
  readonly executionId?: string;
  readonly backendIdentity?: Readonly<Record<string, string>>;
}

export interface StructuredPatchValidationProviderInput {
  readonly stageRoot: string;
  readonly policy: StructuredPatchValidationPolicy;
}

export interface StructuredPatchValidationProviderResult {
  readonly ok: boolean;
  readonly execution: StructuredPatchValidationExecutionEvidence;
  readonly dependencyMaterialization?: unknown;
  readonly commands: readonly StructuredPatchValidationCommandResult[];
}

/**
 * Execution provider for validation commands. A provider may claim
 * `os-sandbox` only when commands execute outside the server host's OS
 * authority. Filesystem staging and shell:false are explicitly trusted-host.
 */
export interface StructuredPatchValidationProvider {
  readonly id: string;
  readonly boundary: StructuredPatchValidationBoundary;
  /** Stable server-owned configuration identity used by approval binding. */
  readonly approvalBinding?: string;
  execute(input: StructuredPatchValidationProviderInput): Promise<StructuredPatchValidationProviderResult>;
}

export interface RunStructuredPatchValidationOptions {
  readonly workspaceRoot: string;
  readonly validationView: WorkspacePatchValidationView;
  readonly policy: StructuredPatchValidationPolicy;
  /** Defaults to the explicit trusted-host provider. */
  readonly provider?: StructuredPatchValidationProvider;
}

const GLOBAL_IGNORES = [".git", ".scce", ".yopp-validation", "coverage", "dist", "node_modules"] as const;

/**
 * Validates the transaction against a private staged copy of the workspace.
 * Commands are fixed by a server-owned policy and are spawned directly with
 * shell:false. This is filesystem staging, not an OS sandbox: command code has
 * the host authority of the server process. The stage is always removed before
 * this function returns.
 */
export async function runStructuredPatchValidation(options: RunStructuredPatchValidationOptions): Promise<WorkspacePatchValidationResult> {
  validatePolicy(options.policy);
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const stageRoot = await mkdtemp(join(tmpdir(), "scce-patch-validation-"));
  await chmod(stageRoot, 0o700);

  try {
    const copied = await copyWorkspaceSnapshot({
      sourceRoot: workspaceRoot,
      stageRoot,
      ignoredTopLevelNames: new Set(options.policy.ignoredTopLevelNames ?? []),
      maxFiles: options.policy.maxWorkspaceFiles,
      maxBytes: options.policy.maxWorkspaceBytes
    });
    await applyPlanToStage(stageRoot, options.validationView.plan, options.validationView);

    const provider = options.provider ?? trustedHostPatchValidationProvider;
    const execution = await provider.execute({ stageRoot, policy: options.policy });
    validateProviderResult(provider, execution);

    const evidence: StructuredPatchValidationEvidence = {
      schemaVersion: STRUCTURED_PATCH_VALIDATION_EVIDENCE_SCHEMA,
      policyId: options.policy.id,
      planHash: options.validationView.plan.planHash,
      stagedFileCount: copied.files,
      stagedByteCount: copied.bytes,
      execution: execution.execution,
      ...(execution.dependencyMaterialization === undefined ? {} : { dependencyMaterialization: execution.dependencyMaterialization }),
      commands: execution.commands
    };
    return deepFreeze({
      ok: execution.ok
        && execution.commands.length === options.policy.commands.length
        && execution.commands.every(command => command.code === 0 && !command.timedOut && !command.outputLimitExceeded),
      validatorId: options.policy.id,
      evidence
    });
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export const trustedHostPatchValidationProvider: StructuredPatchValidationProvider = deepFreeze({
  id: TRUSTED_HOST_PATCH_VALIDATION_PROVIDER_ID,
  boundary: "trusted-host",
  approvalBinding: "trusted-host-process.v1",
  async execute(input: StructuredPatchValidationProviderInput): Promise<StructuredPatchValidationProviderResult> {
    const commands: StructuredPatchValidationCommandResult[] = [];
    for (let index = 0; index < input.policy.commands.length; index += 1) {
      const command = input.policy.commands[index];
      if (!command) throw new Error(`validation policy command missing at index ${index}`);
      const result = await runStructuredCommand({ stageRoot: input.stageRoot, command, index, policy: input.policy });
      commands.push(result);
      if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) break;
    }
    return deepFreeze({
      ok: commands.length === input.policy.commands.length
        && commands.every(command => command.code === 0 && !command.timedOut && !command.outputLimitExceeded),
      execution: {
        providerId: TRUSTED_HOST_PATCH_VALIDATION_PROVIDER_ID,
        boundary: "trusted-host",
        backend: "node-child-process",
        verificationLevel: "local-process-executed"
      },
      commands
    });
  }
});

interface CopySnapshotOptions {
  readonly sourceRoot: string;
  readonly stageRoot: string;
  readonly ignoredTopLevelNames: ReadonlySet<string>;
  readonly maxFiles: number;
  readonly maxBytes: number;
}

async function copyWorkspaceSnapshot(options: CopySnapshotOptions): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const visit = async (sourceDirectory: string, stageDirectory: string, depth: number): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((a, b) => compareCanonical(a.name, b.name));
    for (const entry of entries) {
      if (GLOBAL_IGNORES.includes(entry.name as (typeof GLOBAL_IGNORES)[number]) || (depth === 0 && options.ignoredTopLevelNames.has(entry.name))) continue;
      const sourcePath = join(sourceDirectory, entry.name);
      const stagePath = join(stageDirectory, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`validation staging refuses symbolic links: ${relative(options.sourceRoot, sourcePath)}`);
      if (info.isDirectory()) {
        await mkdir(stagePath, { mode: info.mode & 0o777 });
        await visit(sourcePath, stagePath, depth + 1);
        continue;
      }
      if (!info.isFile()) throw new Error(`validation staging refuses non-file entry: ${relative(options.sourceRoot, sourcePath)}`);
      files += 1;
      bytes += info.size;
      if (files > options.maxFiles) throw new Error(`validation workspace exceeds policy file limit: ${options.maxFiles}`);
      if (bytes > options.maxBytes) throw new Error(`validation workspace exceeds policy byte limit: ${options.maxBytes}`);
      await copyFile(sourcePath, stagePath);
    }
  };
  await visit(options.sourceRoot, options.stageRoot, 0);
  return { files, bytes };
}

async function applyPlanToStage(stageRoot: string, plan: PatchTransactionPlan, view: WorkspacePatchValidationView): Promise<void> {
  for (const operation of plan.operations) {
    const target = resolveContained(stageRoot, operation.path, "patch path");
    if (operation.kind === "delete") {
      await rm(target, { force: true });
      continue;
    }
    const content = await view.readFile(operation.path);
    if (!content) throw new Error(`staged patch content is missing: ${operation.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: operation.kind === "create" ? "wx" : "w" });
  }
}

async function runStructuredCommand(input: {
  readonly stageRoot: string;
  readonly command: StructuredPatchValidationCommand;
  readonly index: number;
  readonly policy: StructuredPatchValidationPolicy;
}): Promise<StructuredPatchValidationCommandResult> {
  const cwdPath = resolveContained(input.stageRoot, input.command.cwd ?? ".", "validation cwd");
  const canonicalCwd = await realpath(cwdPath);
  assertContained(input.stageRoot, canonicalCwd, "validation cwd");
  const started = Date.now();

  return new Promise(resolveResult => {
    const child = spawn(input.command.executable, [...input.command.argv], {
      cwd: canonicalCwd,
      env: validationEnvironment(input.policy.environment),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    let settled = false;

    const kill = (): void => {
      if (!child.killed) child.kill("SIGKILL");
    };
    const collect = (target: Buffer[], chunk: unknown, stream: "stdout" | "stderr"): void => {
      const bytes = Buffer.from(chunk as Uint8Array);
      if (stream === "stdout") stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      const remaining = Math.max(0, input.policy.maxOutputBytes - totalBytes(target, stream === "stdout" ? stderr : stdout));
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      if (stdoutBytes + stderrBytes > input.policy.maxOutputBytes) {
        outputLimitExceeded = true;
        kill();
      }
    };
    child.stdout?.on("data", chunk => collect(stdout, chunk, "stdout"));
    child.stderr?.on("data", chunk => collect(stderr, chunk, "stderr"));
    child.on("error", error => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.policy.timeoutMs);

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = spawnError
        ? `${Buffer.concat(stderr).toString("utf8")}${Buffer.concat(stderr).length ? "\n" : ""}${spawnError.message}`
        : Buffer.concat(stderr).toString("utf8");
      resolveResult(deepFreeze({
        index: input.index,
        executable: input.command.executable,
        argv: [...input.command.argv],
        cwd: normalizeRelative(relative(input.stageRoot, canonicalCwd)) || ".",
        code,
        signal,
        timedOut,
        outputLimitExceeded,
        durationMs: Date.now() - started,
        stdout: stdoutText,
        stderr: stderrText,
        stdoutHash: hashText(stdoutText),
        stderrHash: hashText(stderrText)
      }));
    });
  });
}

function validatePolicy(policy: StructuredPatchValidationPolicy): void {
  if (policy.schemaVersion !== STRUCTURED_PATCH_VALIDATION_POLICY_SCHEMA) throw new Error(`unsupported patch validation policy schema: ${policy.schemaVersion}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(policy.id)) throw new Error("patch validation policy id is invalid");
  if (!Array.isArray(policy.commands) || policy.commands.length < 1 || policy.commands.length > 16) throw new Error("patch validation policy requires 1 through 16 commands");
  boundedInteger(policy.timeoutMs, "timeoutMs", 100, 15 * 60_000);
  boundedInteger(policy.maxOutputBytes, "maxOutputBytes", 1024, 16 * 1024 * 1024);
  boundedInteger(policy.maxWorkspaceFiles, "maxWorkspaceFiles", 1, 100_000);
  boundedInteger(policy.maxWorkspaceBytes, "maxWorkspaceBytes", 1, 4 * 1024 * 1024 * 1024);
  for (const [index, command] of policy.commands.entries()) {
    if (!command.executable || command.executable.includes("\u0000")) throw new Error(`validation command ${index} executable is invalid`);
    if (!Array.isArray(command.argv) || command.argv.length > 128 || command.argv.some((arg: unknown) => typeof arg !== "string" || arg.includes("\u0000") || arg.length > 4096)) {
      throw new Error(`validation command ${index} argv is invalid`);
    }
    resolveContained("C:\\validation-root", command.cwd ?? ".", `validation command ${index} cwd`);
  }
}

function validateProviderResult(provider: StructuredPatchValidationProvider, result: StructuredPatchValidationProviderResult): void {
  if (result.execution.providerId !== provider.id) throw new Error("patch validation provider evidence id does not match provider");
  if (result.execution.boundary !== provider.boundary) throw new Error("patch validation provider evidence boundary does not match provider");
  if (provider.boundary === "trusted-host" && result.execution.verificationLevel === "os-sandbox-executed") {
    throw new Error("trusted-host patch validation cannot report OS-sandbox execution");
  }
  if (provider.boundary === "os-sandbox" && result.execution.verificationLevel === "local-process-executed") {
    throw new Error("OS-sandbox patch validation cannot report trusted-host execution");
  }
  if (!Array.isArray(result.commands) || result.commands.length > 16) throw new Error("patch validation provider returned an invalid command result set");
}

function validationEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const inheritedNames = process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"]
    : ["PATH", "HOME", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\u0000")) throw new Error(`validation environment entry is invalid: ${name}`);
    env[name] = value;
  }
  return env;
}

function resolveContained(root: string, relativePath: string, label: string): string {
  if (!relativePath || relativePath.includes("\u0000") || isAbsolute(relativePath)) throw new Error(`${label} must be workspace relative`);
  const target = resolve(root, relativePath);
  assertContained(root, target, label);
  return target;
}

function assertContained(root: string, target: string, label: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes staged workspace`);
}

function boundedInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`patch validation ${label} must be an integer from ${min} through ${max}`);
}

function totalBytes(primary: readonly Buffer[], secondary: readonly Buffer[]): number {
  return primary.reduce((sum, item) => sum + item.length, 0) + secondary.reduce((sum, item) => sum + item.length, 0);
}

function normalizeRelative(value: string): string {
  return value.split(sep).join("/");
}

function hashText(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

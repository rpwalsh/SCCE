import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  StructuredPatchValidationCommand,
  StructuredPatchValidationCommandResult,
  StructuredPatchValidationPolicy,
  StructuredPatchValidationProvider,
  StructuredPatchValidationProviderInput,
  StructuredPatchValidationProviderResult
} from "./structured-patch-validation.js";

export const DOCKER_PATCH_VALIDATION_PROVIDER_ID = "docker-cli-sandbox.v1" as const;
export const PNPM_FROZEN_MATERIALIZATION_SCHEMA = "scce.pnpm-frozen-materialization.v1" as const;
export const PNPM_FROZEN_MATERIALIZATION_EVIDENCE_SCHEMA = "scce.pnpm-frozen-materialization-evidence.v1" as const;

export interface PnpmFrozenMaterializationPolicy {
  readonly schemaVersion: typeof PNPM_FROZEN_MATERIALIZATION_SCHEMA;
  readonly rootPackagePath: string;
  readonly lockfilePath: string;
  /** Manifests, workspace declaration, and referenced local archives only. */
  readonly inputPaths: readonly string[];
  readonly cwd?: string;
}

export interface PnpmFrozenMaterializationEvidence {
  readonly schemaVersion: typeof PNPM_FROZEN_MATERIALIZATION_EVIDENCE_SCHEMA;
  readonly packageManager: string;
  readonly lockfilePath: string;
  readonly lockfileHash: `sha256:${string}`;
  readonly inputSnapshotHash: `sha256:${string}`;
  readonly inputFileCount: number;
  readonly inputByteCount: number;
  readonly sourceOverlayDeferred: true;
  readonly network: "bridge" | "none";
  readonly containerId?: string;
  readonly command: StructuredPatchValidationCommandResult;
}

export interface DockerSandboxPatchValidationOptions {
  /** Must be content-addressed, for example registry/image@sha256:... */
  readonly image: string;
  readonly dependencyMaterialization: PnpmFrozenMaterializationPolicy;
  readonly dockerExecutable?: string;
  readonly materializationNetwork?: "bridge" | "none";
  readonly memoryBytes?: number;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  readonly tmpfsBytes?: number;
  readonly workspaceTmpfsBytes?: number;
  /** Maximum staged source bytes buffered by the host before upload. */
  readonly maxHostSnapshotBytes?: number;
  readonly maxMaterializedFiles?: number;
  readonly maxMaterializedBytes?: number;
  readonly user?: string;
}

export interface DockerSandboxRunSpec {
  readonly dockerExecutable: string;
  readonly image: string;
  readonly containerName: string;
  readonly cidFile: string;
  readonly network: "bridge" | "none";
  readonly memoryBytes: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly tmpfsBytes: number;
  readonly workspaceTmpfsBytes: number;
  readonly user: string;
}

export interface DockerSandboxExecSpec {
  readonly dockerExecutable: string;
  readonly containerName: string;
  readonly cwd: string;
  readonly command: StructuredPatchValidationCommand;
  readonly environment: Readonly<Record<string, string>>;
}

interface ValidatedDockerOptions extends Required<Omit<DockerSandboxPatchValidationOptions, "dependencyMaterialization">> {
  readonly dependencyMaterialization: PnpmFrozenMaterializationPolicy;
}

interface SnapshotFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

interface WorkspaceSnapshot {
  readonly directories: readonly string[];
  readonly files: readonly SnapshotFile[];
}

/**
 * Optional local OS-isolation provider. Docker is invoked only when this
 * server-owned provider is selected; normal build, test, cognition, and
 * storage paths do not inspect or require Docker.
 */
export function createDockerSandboxPatchValidationProvider(options: DockerSandboxPatchValidationOptions): StructuredPatchValidationProvider {
  const config = validateOptions(options);
  return Object.freeze({
    id: DOCKER_PATCH_VALIDATION_PROVIDER_ID,
    boundary: "os-sandbox" as const,
    approvalBinding: dockerApprovalBinding(config),
    async execute(input: StructuredPatchValidationProviderInput): Promise<StructuredPatchValidationProviderResult> {
      const snapshotByteLimit = Math.min(input.policy.maxWorkspaceBytes, config.maxHostSnapshotBytes);
      const snapshot = await readSnapshot(input.stageRoot, input.policy.maxWorkspaceFiles, snapshotByteLimit);
      const snapshotByteCount = snapshot.files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
      const backendIdentity = {
        ...await inspectDockerBackend(config),
        hostSnapshotFileCount: String(snapshot.files.length),
        hostSnapshotByteCount: String(snapshotByteCount)
      };
      if (config.maxMaterializedBytes + snapshotByteLimit > config.workspaceTmpfsBytes) throw new Error("Docker workspace tmpfs is smaller than the configured dependency and source byte bounds");
      const material = resolveMaterialization(snapshot, config.dependencyMaterialization);
      const controlRoot = await mkdtemp(join(tmpdir(), "scce-docker-validation-"));
      await chmod(controlRoot, 0o700);
      const stageParent = controlRoot;
      const suffix = randomBytes(10).toString("hex");
      const containerName = `scce-validation-${suffix}`;
      const cidFile = join(stageParent, `.docker-cid-${suffix}`);
      let containerId = "";

      try {
        containerId = await startSandboxContainer({ config, stageParent, containerName, cidFile, policy: input.policy });
        await streamSnapshotIntoContainer(config.dockerExecutable, material.files, [], containerName, stageParent, input.policy);
        const materialRun = await execInContainer({
          config,
          stageParent,
          containerName,
          command: {
            executable: "corepack",
            argv: ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--config.ignore-pnpmfile=true", "--config.verify-store-integrity=true"],
            cwd: config.dependencyMaterialization.cwd ?? "."
          },
          index: -1,
          policy: input.policy,
          environment: { CI: "1", COREPACK_ENABLE_PROJECT_SPEC: "1", COREPACK_HOME: "/workspace/.scce-corepack", HOME: "/tmp" }
        });
        const dependencyMaterialization: PnpmFrozenMaterializationEvidence = deepFreeze({
          schemaVersion: PNPM_FROZEN_MATERIALIZATION_EVIDENCE_SCHEMA,
          packageManager: material.packageManager,
          lockfilePath: config.dependencyMaterialization.lockfilePath,
          lockfileHash: hashBytes(material.lockfile.bytes),
          inputSnapshotHash: hashSnapshot(material.files),
          inputFileCount: material.files.length,
          inputByteCount: material.files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
          sourceOverlayDeferred: true,
          network: config.materializationNetwork,
          containerId,
          command: materialRun
        });
        if (!commandPassed(materialRun)) {
          return deepFreeze({
            ok: false,
            execution: executionEvidence(config, backendIdentity, [], false),
            dependencyMaterialization,
            commands: []
          });
        }

        await verifyContainerTree({
          config,
          stageParent,
          containerName,
          policy: input.policy,
          maxFiles: config.maxMaterializedFiles,
          maxBytes: config.maxMaterializedBytes
        });
        await disconnectValidationNetwork(config, stageParent, containerName, input.policy);
        await streamSnapshotIntoContainer(config.dockerExecutable, snapshot.files, snapshot.directories, containerName, stageParent, input.policy);
        await verifyContainerTree({
          config,
          stageParent,
          containerName,
          policy: input.policy,
          maxFiles: config.maxMaterializedFiles + input.policy.maxWorkspaceFiles,
          maxBytes: config.maxMaterializedBytes + input.policy.maxWorkspaceBytes
        });
        const commands: StructuredPatchValidationCommandResult[] = [];
        for (let index = 0; index < input.policy.commands.length; index += 1) {
          const command = input.policy.commands[index];
          if (!command) throw new Error(`Docker validation policy command missing at index ${index}`);
          const run = await execInContainer({
            config,
            stageParent,
            containerName,
            command,
            index,
            policy: input.policy,
            environment: {
              ...(input.policy.environment ?? {}),
              COREPACK_HOME: "/workspace/.scce-corepack",
              HOME: "/tmp"
            }
          });
          commands.push(run);
          if (!commandPassed(run)) break;
        }
        const sourceIsolationObserved = commands.length > 0 && Boolean(containerId);
        return deepFreeze({
          ok: sourceIsolationObserved
            && commands.length === input.policy.commands.length
            && commands.every(commandPassed),
          execution: executionEvidence(config, backendIdentity, containerId ? [containerId] : [], sourceIsolationObserved),
          dependencyMaterialization,
          commands
        });
      } finally {
        await removeContainer(config.dockerExecutable, containerName);
        await rm(cidFile, { force: true });
        await rm(controlRoot, { recursive: true, force: true });
      }
    }
  });
}

/** Pure invocation builder used by normal tests; it does not contact Docker. */
export function buildDockerSandboxRunInvocation(spec: DockerSandboxRunSpec): { executable: string; argv: readonly string[] } {
  if (spec.network !== "none" && spec.network !== "bridge") throw new Error("Docker sandbox network is invalid");
  const [uid, gid] = spec.user.split(":");
  const argv = [
    "run",
    "--detach",
    "--rm",
    "--name", spec.containerName,
    "--cidfile", spec.cidFile,
    "--network", spec.network,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(spec.pidsLimit),
    "--memory", String(spec.memoryBytes),
    "--cpus", String(spec.cpus),
    "--user", spec.user,
    "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${spec.tmpfsBytes}`,
    "--tmpfs", `/workspace:rw,nosuid,nodev,size=${spec.workspaceTmpfsBytes},mode=1777,uid=${uid},gid=${gid}`,
    spec.image,
    "node", "-e", "setInterval(()=>{},2147483647)"
  ];
  return { executable: spec.dockerExecutable, argv };
}

export function buildDockerSandboxExecInvocation(spec: DockerSandboxExecSpec): { executable: string; argv: readonly string[] } {
  const argv = ["exec", "--workdir", remoteCwd(spec.cwd)];
  for (const [name, value] of Object.entries(spec.environment).sort(([left], [right]) => compareCanonical(left, right))) {
    validateEnvironment(name, value);
    argv.push("--env", `${name}=${value}`);
  }
  argv.push(spec.containerName, spec.command.executable, ...spec.command.argv);
  return { executable: spec.dockerExecutable, argv };
}

async function startSandboxContainer(input: {
  readonly config: ValidatedDockerOptions;
  readonly stageParent: string;
  readonly containerName: string;
  readonly cidFile: string;
  readonly policy: StructuredPatchValidationPolicy;
}): Promise<string> {
  const invocation = buildDockerSandboxRunInvocation({
    dockerExecutable: input.config.dockerExecutable,
    image: input.config.image,
    containerName: input.containerName,
    cidFile: input.cidFile,
    network: input.config.materializationNetwork,
    memoryBytes: input.config.memoryBytes,
    cpus: input.config.cpus,
    pidsLimit: input.config.pidsLimit,
    tmpfsBytes: input.config.tmpfsBytes,
    workspaceTmpfsBytes: input.config.workspaceTmpfsBytes,
    user: input.config.user
  });
  const result = await runBoundedProcess({
    executable: invocation.executable,
    argv: invocation.argv,
    cwd: input.stageParent,
    timeoutMs: Math.min(input.policy.timeoutMs, 60_000),
    maxOutputBytes: input.policy.maxOutputBytes,
    cleanup: () => removeContainer(input.config.dockerExecutable, input.containerName)
  });
  if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) throw new Error(`Docker sandbox container failed to start: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  const containerId = await readFile(input.cidFile, "utf8").then(value => value.trim()).catch(() => "");
  if (!/^[0-9a-f]{12,64}$/u.test(containerId)) throw new Error("Docker sandbox did not produce a valid container id");
  return containerId;
}

async function execInContainer(input: {
  readonly config: ValidatedDockerOptions;
  readonly stageParent: string;
  readonly containerName: string;
  readonly command: StructuredPatchValidationCommand;
  readonly index: number;
  readonly policy: StructuredPatchValidationPolicy;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<StructuredPatchValidationCommandResult> {
  const invocation = buildDockerSandboxExecInvocation({
    dockerExecutable: input.config.dockerExecutable,
    containerName: input.containerName,
    cwd: input.command.cwd ?? ".",
    command: input.command,
    environment: input.environment
  });
  const result = await runBoundedProcess({
    executable: invocation.executable,
    argv: invocation.argv,
    cwd: input.stageParent,
    timeoutMs: input.policy.timeoutMs,
    maxOutputBytes: input.policy.maxOutputBytes,
    cleanup: () => removeContainer(input.config.dockerExecutable, input.containerName)
  });
  return deepFreeze({
    index: input.index,
    executable: input.command.executable,
    argv: [...input.command.argv],
    cwd: input.command.cwd ?? ".",
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutHash: hashText(result.stdout),
    stderrHash: hashText(result.stderr)
  });
}

async function streamSnapshotIntoContainer(
  dockerExecutable: string,
  files: readonly SnapshotFile[],
  directories: readonly string[],
  containerName: string,
  cwd: string,
  policy: StructuredPatchValidationPolicy
): Promise<void> {
  const receiver = [
    "const fs=require('node:fs'),p=require('node:path'),root='/workspace';let b=Buffer.alloc(0),cur=null,ended=false,inputEnded=false,pending=0,failed=false;",
    "const fail=e=>{if(failed)return;failed=true;process.stderr.write(String(e&&e.message||e));process.exitCode=1;process.stdin.destroy();};",
    "const target=r=>{if(typeof r!=='string'||!r||p.isAbsolute(r)||r.includes('\\\\'))throw new Error('invalid upload path');const n=p.posix.normalize(r);if(n!==r||n.split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('invalid upload path');const t=p.resolve(root,...r.split('/')),q=p.relative(root,t);if(q==='..'||q.startsWith('..'+p.sep)||p.isAbsolute(q))throw new Error('upload path escaped');return t;};",
    "const done=()=>{if(inputEnded&&ended&&!cur&&pending===0&&!failed)process.exitCode=0;};",
    "const pump=()=>{try{while(!failed){if(cur){if(!b.length)return;const n=Math.min(cur.left,b.length),part=b.subarray(0,n);b=b.subarray(n);cur.left-=n;if(!cur.out.write(part)){process.stdin.pause();cur.out.once('drain',()=>{process.stdin.resume();pump();});return;}if(cur.left===0){const out=cur.out;cur=null;pending++;out.end(()=>{pending--;done();});}continue;}const i=b.indexOf(10);if(i<0){if(b.length>1048576)throw new Error('upload header too large');return;}const h=JSON.parse(b.subarray(0,i).toString('utf8'));b=b.subarray(i+1);if(h.end===true){ended=true;if(b.length)throw new Error('bytes after upload end');done();return;}const t=target(h.path);if(h.directory===true){fs.mkdirSync(t,{recursive:true,mode:448});continue;}if(!Number.isSafeInteger(h.size)||h.size<0||!Number.isSafeInteger(h.mode))throw new Error('invalid upload file header');fs.mkdirSync(p.dirname(t),{recursive:true,mode:448});cur={left:h.size,out:fs.createWriteStream(t,{flags:'w',mode:h.mode&511})};if(cur.left===0){const out=cur.out;cur=null;pending++;out.end(()=>{pending--;done();});}}}catch(e){fail(e);}};",
    "process.stdin.on('data',x=>{if(ended)return fail(new Error('bytes after upload end'));b=b.length?Buffer.concat([b,x]):x;pump();});process.stdin.on('end',()=>{inputEnded=true;if(!ended||cur)return fail(new Error('truncated upload'));done();});process.stdin.on('error',fail);"
  ].join("");
  const chunks: Uint8Array[] = [];
  for (const directory of directories) chunks.push(Buffer.from(`${JSON.stringify({ path: directory, directory: true })}\n`, "utf8"));
  for (const file of files) {
    chunks.push(Buffer.from(`${JSON.stringify({ path: file.path, size: file.bytes.byteLength, mode: file.mode })}\n`, "utf8"));
    if (file.bytes.byteLength) chunks.push(file.bytes);
  }
  chunks.push(Buffer.from(`${JSON.stringify({ end: true })}\n`, "utf8"));
  const result = await runBoundedProcess({
    executable: dockerExecutable,
    argv: ["exec", "--interactive", "--workdir", "/workspace", containerName, "node", "-e", receiver],
    cwd,
    timeoutMs: policy.timeoutMs,
    maxOutputBytes: policy.maxOutputBytes,
    cleanup: () => removeContainer(dockerExecutable, containerName),
    inputChunks: chunks
  });
  if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) throw new Error(`Docker sandbox file upload failed: ${result.stderr.trim() || "unknown error"}`);
}

async function verifyContainerTree(input: {
  readonly config: ValidatedDockerOptions;
  readonly stageParent: string;
  readonly containerName: string;
  readonly policy: StructuredPatchValidationPolicy;
  readonly maxFiles: number;
  readonly maxBytes: number;
}): Promise<void> {
  const script = [
    "const fs=require('node:fs'),p=require('node:path');",
    "const root='/workspace',maxFiles=Number(process.argv[1]),maxBytes=Number(process.argv[2]);let files=0,bytes=0;",
    "const inside=t=>{const r=p.relative(root,t);return r===''||(!r.startsWith('..'+p.sep)&&r!=='..'&&!p.isAbsolute(r));};",
    "const visit=d=>{for(const n of fs.readdirSync(d)){const f=p.join(d,n),s=fs.lstatSync(f);if(s.isSymbolicLink()){const t=p.resolve(p.dirname(f),fs.readlinkSync(f));if(!inside(t))throw new Error('escaping symlink: '+p.relative(root,f));files++;}else if(s.isDirectory())visit(f);else if(s.isFile()){files++;bytes+=s.size;}else throw new Error('unsupported entry: '+p.relative(root,f));if(files>maxFiles||bytes>maxBytes)throw new Error('tree bound exceeded');}};",
    "visit(root);process.stdout.write(JSON.stringify({files,bytes}));"
  ].join("");
  const result = await execInContainer({
    config: input.config,
    stageParent: input.stageParent,
    containerName: input.containerName,
    command: { executable: "node", argv: ["-e", script, String(input.maxFiles), String(input.maxBytes)], cwd: "." },
    index: -2,
    policy: input.policy,
    environment: { HOME: "/tmp" }
  });
  if (!commandPassed(result)) throw new Error(`Docker sandbox tree verification failed: ${result.stderr.trim() || "unknown error"}`);
  let tree: unknown;
  try { tree = JSON.parse(result.stdout); } catch { throw new Error("Docker sandbox tree verification returned invalid evidence"); }
  if (!isRecord(tree) || !Number.isSafeInteger(tree.files) || !Number.isSafeInteger(tree.bytes) || Number(tree.files) > input.maxFiles || Number(tree.bytes) > input.maxBytes) throw new Error("Docker sandbox tree verification exceeded configured bounds");
}

async function disconnectValidationNetwork(
  config: ValidatedDockerOptions,
  stageParent: string,
  containerName: string,
  policy: StructuredPatchValidationPolicy
): Promise<void> {
  if (config.materializationNetwork === "bridge") {
    const disconnected = await runBoundedProcess({
      executable: config.dockerExecutable,
      argv: ["network", "disconnect", "bridge", containerName],
      cwd: stageParent,
      timeoutMs: Math.min(policy.timeoutMs, 30_000),
      maxOutputBytes: policy.maxOutputBytes,
      cleanup: () => removeContainer(config.dockerExecutable, containerName)
    });
    if (disconnected.code !== 0) throw new Error(`Docker sandbox network disconnect failed: ${disconnected.stderr.trim() || "unknown error"}`);
  }
  const inspected = await runMetadataCommand(config.dockerExecutable, ["inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName]);
  if (inspected.code !== 0) throw new Error(`Docker sandbox network inspection failed: ${inspected.stderr.trim() || "unknown error"}`);
  let networks: unknown;
  try { networks = JSON.parse(inspected.stdout); } catch { throw new Error("Docker sandbox network inspection returned invalid evidence"); }
  if (!isRecord(networks) || Object.keys(networks).some(name => name !== "none")) throw new Error("Docker sandbox validation network is not disabled");
}

async function runBoundedProcess(input: {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly cleanup?: () => Promise<void>;
  readonly inputChunks?: readonly Uint8Array[];
}): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const started = Date.now();
  return new Promise(resolveResult => {
    const child = spawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      env: dockerCliEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: [input.inputChunks ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    let cleaning: Promise<void> | undefined;
    const cleanup = (): void => {
      cleaning ??= input.cleanup?.().catch(() => undefined) ?? Promise.resolve();
    };
    const stop = (): void => {
      if (!child.killed) child.kill("SIGKILL");
      cleanup();
    };
    const collect = (target: Buffer[], chunk: unknown): void => {
      const bytes = Buffer.from(chunk as Uint8Array);
      const remaining = Math.max(0, input.maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      outputBytes += bytes.length;
      if (outputBytes > input.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        stop();
      }
    };
    child.stdout?.on("data", chunk => collect(stdout, chunk));
    child.stderr?.on("data", chunk => collect(stderr, chunk));
    child.stdin?.on("error", error => {
      if (!spawnError) spawnError = error;
    });
    child.on("error", error => { spawnError = error; });
    if (input.inputChunks && child.stdin) {
      void writeInputChunks(child.stdin, input.inputChunks).catch(error => {
        if (!spawnError) spawnError = error instanceof Error ? error : new Error(String(error));
        stop();
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, input.timeoutMs);
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await (cleaning ?? Promise.resolve());
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const baseStderr = Buffer.concat(stderr).toString("utf8");
      const stderrText = spawnError ? `${baseStderr}${baseStderr ? "\n" : ""}${spawnError.message}` : baseStderr;
      resolveResult({
        code,
        signal,
        timedOut,
        outputLimitExceeded,
        durationMs: Date.now() - started,
        stdout: stdoutText,
        stderr: stderrText
      });
    });
  });
}

async function inspectDockerBackend(config: ValidatedDockerOptions): Promise<Record<string, string>> {
  const version = await runMetadataCommand(config.dockerExecutable, ["version", "--format", "{{.Server.Version}}"]);
  if (version.code !== 0 || !version.stdout.trim()) throw new Error(`Docker server is unavailable: ${version.stderr.trim() || "version command failed"}`);
  const image = await runMetadataCommand(config.dockerExecutable, ["image", "inspect", "--format", "{{.Id}}", config.image]);
  if (image.code !== 0 || !/^sha256:[0-9a-f]{64}$/u.test(image.stdout.trim())) throw new Error(`pinned Docker validation image is unavailable: ${image.stderr.trim() || config.image}`);
  const security = await runMetadataCommand(config.dockerExecutable, ["info", "--format", "{{json .SecurityOptions}}"]);
  if (security.code !== 0) throw new Error(`Docker security options are unavailable: ${security.stderr.trim() || "info command failed"}`);
  return {
    engineVersion: version.stdout.trim(),
    imageReference: config.image,
    imageId: image.stdout.trim(),
    validationNetwork: "none",
    materializationNetwork: config.materializationNetwork,
    memoryBytes: String(config.memoryBytes),
    cpus: String(config.cpus),
    pidsLimit: String(config.pidsLimit),
    tmpfsBytes: String(config.tmpfsBytes),
    workspaceTmpfsBytes: String(config.workspaceTmpfsBytes),
    maxHostSnapshotBytes: String(config.maxHostSnapshotBytes),
    maxMaterializedFiles: String(config.maxMaterializedFiles),
    maxMaterializedBytes: String(config.maxMaterializedBytes),
    daemonSecurityOptions: security.stdout.trim(),
    daemonTrust: "operator-managed-not-attested"
  };
}

async function writeInputChunks(stream: NodeJS.WritableStream, chunks: readonly Uint8Array[]): Promise<void> {
  for (const chunk of chunks) {
    if ((stream as NodeJS.WritableStream & { readonly destroyed?: boolean }).destroyed) throw new Error("Docker sandbox input stream closed before upload completed");
    if (stream.write(chunk)) continue;
    await new Promise<void>((resolveDrain, rejectDrain) => {
      const onDrain = (): void => { cleanup(); resolveDrain(); };
      const onError = (error: Error): void => { cleanup(); rejectDrain(error); };
      const cleanup = (): void => {
        stream.removeListener("drain", onDrain);
        stream.removeListener("error", onError);
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
    });
  }
  stream.end();
}

async function runMetadataCommand(executable: string, argv: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runBoundedProcess({
    executable,
    argv,
    cwd: process.cwd(),
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

async function removeContainer(dockerExecutable: string, containerName: string): Promise<void> {
  await new Promise<void>(resolveDone => {
    const child = spawn(dockerExecutable, ["rm", "--force", containerName], {
      env: dockerCliEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("error", () => undefined);
    child.on("close", () => {
      clearTimeout(timer);
      resolveDone();
    });
  });
}

async function readSnapshot(root: string, maxFiles: number, maxBytes: number): Promise<WorkspaceSnapshot> {
  const files: SnapshotFile[] = [];
  const directories: string[] = [];
  let bytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonical(left.name, right.name));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`Docker validation refuses staged symbolic link: ${path}`);
      if (info.isDirectory()) {
        directories.push(path);
        await visit(absolutePath, path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Docker validation refuses staged non-file entry: ${path}`);
      if (files.length >= maxFiles) throw new Error(`Docker validation exceeds policy file limit: ${maxFiles}`);
      bytes += info.size;
      if (bytes > maxBytes) throw new Error(`Docker validation exceeds host snapshot byte limit: ${maxBytes}`);
      files.push({ path, bytes: await readFile(absolutePath), mode: info.mode & 0o777 });
    }
  };
  await visit(resolve(root), "");
  return { directories, files };
}

function resolveMaterialization(snapshot: WorkspaceSnapshot, policy: PnpmFrozenMaterializationPolicy): {
  readonly files: readonly SnapshotFile[];
  readonly lockfile: SnapshotFile;
  readonly packageManager: string;
} {
  const byPath = new Map(snapshot.files.map(file => [file.path, file]));
  const paths = policy.inputPaths.map(path => validateRelativePath(path, "dependency materialization input"));
  if (new Set(paths).size !== paths.length) throw new Error("dependency materialization input paths must be unique");
  const rootPackagePath = validateRelativePath(policy.rootPackagePath, "root package path");
  const lockfilePath = validateRelativePath(policy.lockfilePath, "lockfile path");
  if (rootPackagePath !== "package.json") throw new Error("dependency root package path must be package.json");
  if (lockfilePath !== "pnpm-lock.yaml") throw new Error("dependency lockfile path must be pnpm-lock.yaml");
  if (!paths.includes(rootPackagePath) || !paths.includes(lockfilePath)) throw new Error("dependency inputs must include the root package and lockfile");
  const files = paths.map(path => {
    const file = byPath.get(path);
    if (!file) throw new Error(`dependency materialization input is missing: ${path}`);
    return file;
  });
  const rootPackage = byPath.get(rootPackagePath);
  const lockfile = byPath.get(lockfilePath);
  if (!rootPackage || !lockfile) throw new Error("dependency materialization contract is incomplete");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rootPackage.bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`root package manifest is invalid JSON: ${errorMessage(error)}`);
  }
  const packageManager = isRecord(parsed) ? parsed.packageManager : undefined;
  if (typeof packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageManager)) throw new Error("dependency materialization requires an exact pnpm packageManager version");
  if (lockfile.bytes.byteLength === 0) throw new Error("dependency materialization lockfile is empty");
  const lockfileText = Buffer.from(lockfile.bytes).toString("utf8");
  for (const path of paths) {
    if (path === rootPackagePath || path === lockfilePath || path === "pnpm-workspace.yaml" || path.endsWith("/package.json")) continue;
    if (!/\.(?:tgz|tar|tar\.gz|zip)$/iu.test(path)) throw new Error(`dependency materialization input is not an allowed manifest or archive: ${path}`);
    if (!lockfileText.includes(path)) throw new Error(`dependency archive is not referenced by the lockfile: ${path}`);
  }
  return { files, lockfile, packageManager };
}

function validateOptions(options: DockerSandboxPatchValidationOptions): ValidatedDockerOptions {
  if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(options.image)) throw new Error("Docker validation image must use a lowercase sha256 digest");
  if (options.dependencyMaterialization.schemaVersion !== PNPM_FROZEN_MATERIALIZATION_SCHEMA) throw new Error("unsupported pnpm materialization schema");
  if (options.dependencyMaterialization.inputPaths.length < 2 || options.dependencyMaterialization.inputPaths.length > 512) throw new Error("dependency materialization requires 2 through 512 input files");
  validateRelativePath(options.dependencyMaterialization.cwd ?? ".", "dependency materialization cwd", true);
  const dockerExecutable = options.dockerExecutable?.trim() || "docker";
  if (dockerExecutable.includes("\u0000")) throw new Error("Docker executable is invalid");
  const materializationNetwork = options.materializationNetwork ?? "bridge";
  const memoryBytes = boundedInteger(options.memoryBytes ?? 4 * 1024 * 1024 * 1024, "memoryBytes", 128 * 1024 * 1024, 32 * 1024 * 1024 * 1024);
  const cpus = boundedNumber(options.cpus ?? 2, "cpus", 0.1, 32);
  const pidsLimit = boundedInteger(options.pidsLimit ?? 512, "pidsLimit", 16, 4096);
  const tmpfsBytes = boundedInteger(options.tmpfsBytes ?? 256 * 1024 * 1024, "tmpfsBytes", 16 * 1024 * 1024, 4 * 1024 * 1024 * 1024);
  const workspaceTmpfsBytes = boundedInteger(options.workspaceTmpfsBytes ?? 3 * 1024 * 1024 * 1024, "workspaceTmpfsBytes", 64 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
  const maxHostSnapshotBytes = boundedInteger(options.maxHostSnapshotBytes ?? 256 * 1024 * 1024, "maxHostSnapshotBytes", 1, 1024 * 1024 * 1024);
  const maxMaterializedFiles = boundedInteger(options.maxMaterializedFiles ?? 250_000, "maxMaterializedFiles", 1, 1_000_000);
  const maxMaterializedBytes = boundedInteger(options.maxMaterializedBytes ?? 1024 * 1024 * 1024, "maxMaterializedBytes", 1, 8 * 1024 * 1024 * 1024);
  if (workspaceTmpfsBytes + tmpfsBytes > memoryBytes) throw new Error("Docker validation tmpfs bounds must fit inside the container memory bound");
  const user = options.user?.trim() || "1000:1000";
  if (!/^\d{1,10}:\d{1,10}$/u.test(user)) throw new Error("Docker validation user must be numeric uid:gid");
  return { ...options, dockerExecutable, materializationNetwork, memoryBytes, cpus, pidsLimit, tmpfsBytes, workspaceTmpfsBytes, maxHostSnapshotBytes, maxMaterializedFiles, maxMaterializedBytes, user };
}

function executionEvidence(
  config: ValidatedDockerOptions,
  backendIdentity: Record<string, string>,
  containerIds: readonly string[],
  sourceIsolationObserved: boolean
) {
  return {
    providerId: DOCKER_PATCH_VALIDATION_PROVIDER_ID,
    boundary: "os-sandbox" as const,
    backend: "docker-cli",
    verificationLevel: sourceIsolationObserved ? "os-sandbox-executed" as const : "implementation-only" as const,
    ...(sourceIsolationObserved && containerIds[0] ? { executionId: containerIds[0] } : {}),
    backendIdentity: { ...backendIdentity, configuredUser: config.user }
  };
}

function remoteCwd(value: string): string {
  const normalized = validateRelativePath(value, "Docker validation cwd", true);
  return normalized === "." ? "/workspace" : `/workspace/${normalized}`;
}

function validateRelativePath(value: string, label: string, allowDot = false): string {
  if (typeof value !== "string" || value.includes("\u0000") || isAbsolute(value)) throw new Error(`${label} must be workspace relative`);
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (allowDot && (normalized === "" || normalized === ".")) return ".";
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`${label} must be a normalized workspace path`);
  return normalized;
}

function validateEnvironment(name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\u0000")) throw new Error(`Docker validation environment entry is invalid: ${name}`);
}

function dockerCliEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "DOCKER_HOST", "DOCKER_CONTEXT"]
    : ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}

function hashSnapshot(files: readonly SnapshotFile[]): `sha256:${string}` {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => compareCanonical(left.path, right.path))) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(file.bytes.byteLength));
    hash.update(file.path).update("\0").update(length).update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function dockerApprovalBinding(config: ValidatedDockerOptions): `sha256:${string}` {
  return hashText(JSON.stringify({
    providerId: DOCKER_PATCH_VALIDATION_PROVIDER_ID,
    image: config.image,
    dockerExecutable: config.dockerExecutable,
    materializationNetwork: config.materializationNetwork,
    memoryBytes: config.memoryBytes,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    tmpfsBytes: config.tmpfsBytes,
    workspaceTmpfsBytes: config.workspaceTmpfsBytes,
    maxHostSnapshotBytes: config.maxHostSnapshotBytes,
    maxMaterializedFiles: config.maxMaterializedFiles,
    maxMaterializedBytes: config.maxMaterializedBytes,
    user: config.user,
    dependencyMaterialization: config.dependencyMaterialization
  }));
}

function hashBytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashText(value: string): `sha256:${string}` {
  return hashBytes(Buffer.from(value, "utf8"));
}

function commandPassed(command: StructuredPatchValidationCommandResult): boolean {
  return command.code === 0 && !command.timedOut && !command.outputLimitExceeded;
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Docker validation ${label} must be an integer from ${min} through ${max}`);
  return value;
}

function boundedNumber(value: number, label: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Docker validation ${label} must be from ${min} through ${max}`);
  return value;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

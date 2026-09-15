// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ScceStorage } from "@scce/kernel";
import { trainOssCorpus, type OssCorpusTrainOptions, type OssCorpusTrainReport, type OssRepositoryProvenance } from "./oss-corpus.js";
import { publicNetworkAcquisitionEnabled } from "./config.js";

const execFileAsync = promisify(execFile);

export interface GithubOssAcquisitionBounds {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  includePaths?: readonly string[];
  excludePaths?: readonly string[];
}

export interface GithubOssSnapshotFile {
  path: string;
  byteLength: number;
  contentHash: string;
}

export interface GithubOssAcquisitionOptions {
  storage: ScceStorage;
  remoteUrl: string;
  commitSha: string;
  bounds?: Partial<GithubOssAcquisitionBounds>;
  training?: Partial<Omit<OssCorpusTrainOptions, "storage" | "rootPath" | "repositoryProvenance" | "sourceUriBase" | "maxFiles" | "maxFileBytes" | "maxDepth">>;
  gitExecutable?: string;
  /** Test/infrastructure seam. The production default uses only the git commands in this module. */
  materializeSnapshot?: (input: { rootPath: string; remoteUrl: string; commitSha: string; hooksPath: string; bounds: GithubOssAcquisitionBounds }) => Promise<void>;
  /** Test/infrastructure seam; production delegates directly to trainOssCorpus. */
  trainCorpus?: (input: OssCorpusTrainOptions) => Promise<OssCorpusTrainReport>;
}

export interface GithubOssAcquisitionReport {
  schema: "scce.githubOssAcquisition.v1";
  remoteUrl: string;
  commitSha: string;
  bounds: GithubOssAcquisitionBounds;
  files: GithubOssSnapshotFile[];
  totalBytes: number;
  provenance: OssRepositoryProvenance;
  training: OssCorpusTrainReport;
}

const DEFAULT_BOUNDS: GithubOssAcquisitionBounds = {
  maxFiles: 2000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 50_000_000,
  maxDepth: 12
};

/** Accept only a public HTTPS GitHub repository URL; credentials, local protocols, and path tricks are rejected. */
export function validateGithubPublicRepositoryUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("github OSS acquisition requires a public https://github.com/<owner>/<repo> URL");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("repository URL must not contain credentials, query parameters, or fragments");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error("repository URL contains invalid path escaping");
  }
  const match = decodedPath.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/u);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || /[\\\0]/u.test(decodedPath) || owner.includes("..") || repo.includes("..")) throw new Error("repository URL must identify exactly one public GitHub repository");
  return `https://github.com/${owner}/${repo}.git`;
}

export function validateGithubCommitSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("OSS repository acquisition requires a 40-character commit SHA");
  return sha;
}

export async function acquireAndTrainGithubOssRepository(input: GithubOssAcquisitionOptions): Promise<GithubOssAcquisitionReport> {
  if (!publicNetworkAcquisitionEnabled()) {
    throw new Error("public GitHub acquisition refused: set SCCE_ALLOW_AUTOMATIC_WEB=1 to enable network acquisition");
  }
  const remoteUrl = validateGithubPublicRepositoryUrl(input.remoteUrl);
  const commitSha = validateGithubCommitSha(input.commitSha);
  const bounds = normalizeBounds(input.bounds);
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "scce-github-oss-"));
  const gitDir = await mkdtemp(path.join(os.tmpdir(), "scce-github-oss-objects-"));
  const hooksPath = path.join(gitDir, "hooks-disabled");
  await mkdir(hooksPath, { recursive: true });
  try {
    await (input.materializeSnapshot ?? createGitSnapshotMaterializer(input.gitExecutable))( { rootPath, remoteUrl, commitSha, hooksPath, bounds } );
    const inventory = await inventorySnapshot(rootPath, bounds);
    await pruneSnapshotToInventory(rootPath, new Set(inventory.files.map(file => file.path)));
    const snapshotHash = createHash("sha256")
      .update(inventory.files.map(file => `${file.path}\u0000${file.contentHash}`).join("\n"), "utf8")
      .digest("hex");
    const provenance: OssRepositoryProvenance = {
      remoteUrl,
      commitSha,
      snapshotHash,
      fileHashes: Object.fromEntries(inventory.files.map(file => [file.path, file.contentHash]))
    };
    const trainingInput: OssCorpusTrainOptions = {
      ...(input.training ?? {}),
      storage: input.storage,
      rootPath,
      maxFiles: bounds.maxFiles,
      maxFileBytes: bounds.maxFileBytes,
      maxDepth: bounds.maxDepth,
      repositoryProvenance: provenance,
      sourceUriBase: `${remoteUrl.replace(/\.git$/u, "")}/tree/${commitSha}`
    };
    const training = await (input.trainCorpus ?? trainOssCorpus)(trainingInput);
    return {
      schema: "scce.githubOssAcquisition.v1",
      remoteUrl,
      commitSha,
      bounds,
      files: inventory.files,
      totalBytes: inventory.totalBytes,
      provenance,
      training
    };
  } finally {
    await rm(rootPath, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
  }
}

function normalizeBounds(input: Partial<GithubOssAcquisitionBounds> | undefined): GithubOssAcquisitionBounds {
  const merged = { ...DEFAULT_BOUNDS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(merged)) {
    if (name === "includePaths" || name === "excludePaths") continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  if (merged.maxFiles === 0 || merged.maxFileBytes === 0 || merged.maxTotalBytes === 0) throw new Error("repository acquisition bounds must allow at least one byte/file");
  return {
    maxFiles: merged.maxFiles,
    maxFileBytes: merged.maxFileBytes,
    maxTotalBytes: merged.maxTotalBytes,
    maxDepth: merged.maxDepth,
    ...(merged.includePaths ? { includePaths: merged.includePaths.map(normalizeRelativeBound) } : {}),
    ...(merged.excludePaths ? { excludePaths: merged.excludePaths.map(normalizeRelativeBound) } : {})
  };
}

async function inventorySnapshot(rootPath: string, bounds: GithubOssAcquisitionBounds): Promise<{ files: GithubOssSnapshotFile[]; totalBytes: number }> {
  const root = path.resolve(rootPath);
  const files: GithubOssSnapshotFile[] = [];
  let totalBytes = 0;
  const excludes = new Set([".git", ".hooks-disabled", ...(bounds.excludePaths ?? [])]);
  async function visit(relativeDirectory: string, depth: number): Promise<void> {
    const absoluteDirectory = path.resolve(root, relativeDirectory);
    assertInside(root, absoluteDirectory);
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      const relative = normalizeRelative(path.posix.join(relativeDirectory.replace(/\\/gu, "/"), entry.name));
      if (entry.isDirectory() && (entry.name === ".git" || entry.name === ".scce" || entry.name === ".hooks-disabled")) continue;
      if (excludes.has(relative) || [...excludes].some(item => relative.startsWith(`${item}/`))) continue;
      assertSafeRelative(relative);
      const absolute = path.resolve(root, relative);
      assertInside(root, absolute);
      if (entry.isSymbolicLink()) throw new Error(`repository snapshot contains unsupported symlink: ${relative}`);
      if (entry.isDirectory()) {
        if (depth + 1 > bounds.maxDepth) throw new Error(`repository snapshot exceeds maxDepth at ${relative}`);
        await visit(relative, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesInclude(relative, bounds.includePaths)) continue;
      if (files.length >= bounds.maxFiles) throw new Error(`repository snapshot exceeds maxFiles ${bounds.maxFiles}`);
      const info = await lstat(absolute);
      if (info.size > bounds.maxFileBytes) throw new Error(`repository file ${relative} exceeds maxFileBytes ${bounds.maxFileBytes}`);
      totalBytes += info.size;
      if (totalBytes > bounds.maxTotalBytes) throw new Error(`repository snapshot exceeds maxTotalBytes ${bounds.maxTotalBytes}`);
      const bytes = await readFile(absolute);
      files.push({ path: relative, byteLength: bytes.byteLength, contentHash: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  await visit("", 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, totalBytes };
}

async function pruneSnapshotToInventory(rootPath: string, admitted: ReadonlySet<string>): Promise<void> {
  const root = path.resolve(rootPath);
  async function visit(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = path.resolve(root, relativeDirectory);
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      const relative = normalizeRelative(path.posix.join(relativeDirectory.replace(/\\/gu, "/"), entry.name));
      const absolute = path.resolve(root, relative);
      assertInside(root, absolute);
      if (entry.isDirectory()) {
        await visit(relative);
        const remaining = await readdir(absolute);
        if (!remaining.length) await rm(absolute, { recursive: false, force: true });
      } else if (!entry.isFile() || !admitted.has(relative)) {
        await rm(absolute, { recursive: false, force: true });
      }
    }
  }
  await visit("");
}

function createGitSnapshotMaterializer(gitExecutable = "git") {
  return async (input: { rootPath: string; remoteUrl: string; commitSha: string; hooksPath: string; bounds: GithubOssAcquisitionBounds }): Promise<void> => {
    // The caller creates an adjacent object-store directory, and passes its hooks path. Resolve it rather than
    // deriving a second temporary name so cleanup always targets exactly the directory created by this run.
    const objectStore = path.dirname(input.hooksPath);
    const globalConfig = path.join(objectStore, "empty-global-config");
    await writeFile(globalConfig, "", "utf8");
    const gitEnvironment = isolatedGitEnvironment(globalConfig);
    const git = async (args: string[]) => {
      const result = await execFileAsync(gitExecutable, ["--git-dir", objectStore, "-c", `core.hooksPath=${input.hooksPath}`, "-c", "protocol.file.allow=never", "-c", "credential.helper=", "-c", "core.fsmonitor=false", ...args], {
        cwd: objectStore,
        shell: false,
        windowsHide: true,
        env: gitEnvironment,
        maxBuffer: 4_000_000
      });
      return result.stdout;
    };
    await git(["init", "--bare", "--quiet"]);
    await git(["remote", "add", "origin", input.remoteUrl]);
    await git(["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", input.commitSha]);
    const checkedOut = (await git(["rev-parse", `${input.commitSha}^{commit}`])).trim().toLowerCase();
    if (checkedOut !== input.commitSha) throw new Error(`pinned fetch resolved to ${checkedOut}, expected ${input.commitSha}`);
    const listing = await git(["ls-tree", "-r", "-z", "--full-tree", input.commitSha]);
    const entries = listing.split("\0").filter(Boolean);
    let admittedFiles = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      const metadata = separator >= 0 ? entry.slice(0, separator).split(" ") : [];
      const relative = separator >= 0 ? normalizeRelative(entry.slice(separator + 1)) : "";
      const mode = metadata[0];
      const kind = metadata[1];
      const objectId = metadata[2];
      if (!relative || !mode || !kind || !objectId || !/^[0-9a-f]{40}$/u.test(objectId) || kind !== "blob" || (mode !== "100644" && mode !== "100755")) {
        throw new Error(`repository snapshot contains unsupported tree entry: ${relative || entry.slice(0, 120)}`);
      }
      assertSafeRelative(relative);
      if (!matchesInclude(relative, input.bounds.includePaths) || matchesExclude(relative, input.bounds.excludePaths)) continue;
      const depth = relative.split("/").length - 1;
      if (depth > input.bounds.maxDepth) throw new Error(`repository snapshot exceeds maxDepth at ${relative}`);
      if (++admittedFiles > input.bounds.maxFiles) throw new Error(`repository snapshot exceeds maxFiles ${input.bounds.maxFiles}`);
      const size = Number((await git(["cat-file", "-s", objectId])).trim());
      if (!Number.isSafeInteger(size) || size > input.bounds.maxFileBytes) throw new Error(`repository file ${relative} exceeds maxFileBytes ${input.bounds.maxFileBytes}`);
      totalBytes += size;
      if (totalBytes > input.bounds.maxTotalBytes) throw new Error(`repository snapshot exceeds maxTotalBytes ${input.bounds.maxTotalBytes}`);
      const blobResult = await execFileAsync(gitExecutable, ["--git-dir", objectStore, "-c", "protocol.file.allow=never", "-c", "credential.helper=", "-c", "core.fsmonitor=false", "cat-file", "blob", objectId], {
        cwd: objectStore,
        shell: false,
        windowsHide: true,
        env: gitEnvironment,
        maxBuffer: Math.max(1_048_576, input.bounds.maxFileBytes + 1),
        encoding: "buffer"
      }) as unknown as { stdout: Buffer };
      const absolute = path.resolve(input.rootPath, relative);
      assertInside(path.resolve(input.rootPath), absolute);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, blobResult.stdout);
    }
  };
}

function matchesInclude(relative: string, includePaths: readonly string[] | undefined): boolean {
  return !includePaths?.length || includePaths.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
}

function matchesExclude(relative: string, excludePaths: readonly string[] | undefined): boolean {
  return Boolean(excludePaths?.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`)));
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function normalizeRelativeBound(value: string): string {
  const normalized = normalizeRelative(value.trim()).replace(/\/+$/u, "");
  assertSafeRelative(normalized);
  return normalized;
}

function assertSafeRelative(value: string): void {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || /^[a-z]:/iu.test(value) || value.split("/").some(part => part === "..")) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  if (process.platform === "win32" && value.split("/").some(unsafeWindowsPathPart)) {
    throw new Error(`unsafe Windows repository path: ${value}`);
  }
}

function unsafeWindowsPathPart(part: string): boolean {
  if (!part || /[<>:"|?*]/u.test(part) || /[ .]$/u.test(part)) return true;
  const stem = part.split(".", 1)[0]!.toLocaleLowerCase();
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(stem);
}

/** Git honors several environment variables before command-line policy. Remove
 * every config/helper injection seam while preserving ordinary HTTPS proxy and
 * certificate settings needed to reach a public repository. */
function isolatedGitEnvironment(globalConfig: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/u.test(key)
      || ["GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND",
        "GIT_ASKPASS", "SSH_ASKPASS"].includes(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = globalConfig;
  return env;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`repository path escapes snapshot root: ${target}`);
}

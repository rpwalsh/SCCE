#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync as fsStatSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POSTGRES_IMAGE = "pgvector/pgvector:0.8.3-pg16-bookworm@sha256:131dcf7ff6a900545df8e7e092c270aa8c6db2f2c818e408cb45ec21316b74e6";
const DEFAULT_OUTPUT = "artifacts/container/container-record.json";
const CONFIG_CONTAINER_PATH = "/scce-record/config.json";
const IMAGE_INSPECT_FORMAT = [
  "{",
  "\"id\":{{json .Id}}",
  ",\"repoDigests\":{{json .RepoDigests}}",
  ",\"revision\":{{with (index .Config `Labels`)}}{{json (index . `org.opencontainers.image.revision`)}}{{else}}null{{end}}",
  ",\"baseDigest\":{{with (index .Config `Labels`)}}{{json (index . `org.opencontainers.image.base.digest`)}}{{else}}null{{end}}",
  ",\"baseName\":{{with (index .Config `Labels`)}}{{json (index . `org.opencontainers.image.base.name`)}}{{else}}null{{end}}",
  "}"
].join("");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write("Usage: node tools/container-record.mjs --image=<local-tag> [--postgres-image=<pin>] [--config=<json>] [--brain-manifest=<path>] [--output=<json>]\n");
  process.exit(0);
}

const image = requireValue(args.image, "--image");
const postgresImage = args["postgres-image"] ?? DEFAULT_POSTGRES_IMAGE;
const outputPath = path.resolve(args.output ?? DEFAULT_OUTPUT);
const configPath = args.config === undefined ? null : resolveFilePath(args.config, "--config");
const brainManifestPath = args["brain-manifest"] === undefined ? null : resolveFilePath(args["brain-manifest"], "--brain-manifest");

const gitIdentity = readGitIdentity();
const dockerEngine = runDocker(["version", "--format", "{{.Server.Version}}"]).trim();
const applicationImage = inspectImage(image);
const databaseImage = inspectImage(postgresImage);
const applicationRuntime = readContainerNode(applicationImage.id, configPath);
const postgresVersion = readPostgresVersion(databaseImage.id);
const configuration = configPath === null ? null : await hashFile(configPath);
const brain = brainManifestPath === null ? null : await hashFile(brainManifestPath);
const adjacentLocal = configPath === null ? null : adjacentLocalConfig(configPath);

const record = {
  schema: "scce.container_environment_record.v1",
  kind: "environment-record",
  recordKind: "environment",
  qualification: false,
  executedQualityGates: [],
  generatedAt: new Date().toISOString(),
  source: gitIdentity,
  docker: { engineServerVersion: dockerEngine },
  application: {
    reference: image,
    imageContentId: applicationImage.id,
    registryDigests: applicationImage.repoDigests,
    requestedRegistryDigest: registryDigestFromReference(image),
    revisionLabel: applicationImage.revision,
    baseImageDigest: applicationImage.baseDigest,
    baseImageName: applicationImage.baseName,
    runtime: applicationRuntime
  },
  postgres: {
    reference: postgresImage,
    imageContentId: databaseImage.id,
    registryDigests: databaseImage.repoDigests,
    requestedRegistryDigest: registryDigestFromReference(postgresImage),
    revisionLabel: databaseImage.revision,
    baseImageDigest: databaseImage.baseDigest,
    baseImageName: databaseImage.baseName,
    version: postgresVersion
  },
  configuration: configuration === null ? null : {
    ...configuration,
    mountedContainerPath: CONFIG_CONTAINER_PATH,
    exactFileOnly: true,
    adjacentLocalOverlay: adjacentLocal
  },
  brain: brain === null ? null : brain
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${outputPath}\n`);

function parseArgs(argv) {
  const result = {};
  for (const argument of argv) {
    if (argument === "--help") {
      result.help = true;
      continue;
    }
    if (!argument.startsWith("--") || !argument.includes("=")) throw new Error(`Expected --name=value argument: ${argument}`);
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (!["image", "postgres-image", "config", "brain-manifest", "output"].includes(name)) throw new Error(`Unknown argument: --${name}`);
    if (value.length === 0) throw new Error(`Argument --${name} cannot be empty`);
    if (result[name] !== undefined) throw new Error(`Argument --${name} was supplied more than once`);
    result[name] = value;
  }
  return result;
}

function requireValue(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name}=... is required`);
  return value;
}

function resolveFilePath(value, name) {
  const resolved = path.resolve(requireValue(value, name));
  const info = fsStatSync(resolved);
  if (!info.isFile()) throw new Error(`${name} must name a regular file: ${resolved}`);
  return resolved;
}

function runDocker(argv) {
  const result = spawnSync("docker", argv, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 128 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`docker ${argv.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function inspectImage(reference) {
  const raw = runDocker(["image", "inspect", "--format", IMAGE_INSPECT_FORMAT, reference]).trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`docker image inspect returned malformed metadata for ${reference}`); }
  if (typeof parsed.id !== "string" || !parsed.id.startsWith("sha256:")) throw new Error(`docker image inspect returned no content ID for ${reference}`);
  return {
    id: parsed.id,
    repoDigests: Array.isArray(parsed.repoDigests) ? parsed.repoDigests.filter(value => typeof value === "string") : [],
    revision: typeof parsed.revision === "string" && parsed.revision.length > 0 ? parsed.revision : null,
    baseDigest: (typeof parsed.baseDigest === "string" && parsed.baseDigest.length > 0 ? parsed.baseDigest : registryDigestFromReference(typeof parsed.baseName === "string" ? parsed.baseName : "")),
    baseName: typeof parsed.baseName === "string" && parsed.baseName.length > 0 ? parsed.baseName : null
  };
}

function readContainerNode(reference, configPath) {
  const code = "const fs=require('node:fs'); const p=process.argv[1]||null; process.stdout.write(JSON.stringify({node:process.versions.node,icu:process.versions.icu,arch:process.arch,platform:process.platform,configMounted:p===null?null:fs.statSync(p).isFile()}));";
  const argv = ["run", "--rm", "--network", "none", "--entrypoint", "node"];
  if (configPath !== null) argv.push("-v", `${configPath}:${CONFIG_CONTAINER_PATH}:ro`);
  argv.push(reference, "-e", code);
  if (configPath !== null) argv.push(CONFIG_CONTAINER_PATH);
  const raw = runDocker(argv).trim();
  try { return JSON.parse(raw); } catch { throw new Error(`container node probe returned malformed metadata for ${reference}`); }
}

function readPostgresVersion(reference) {
  return runDocker(["run", "--rm", "--network", "none", "--entrypoint", "postgres", reference, "--version"]).trim();
}

async function hashFile(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Cannot hash non-file: ${filePath}`);
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
    byteLength += chunk.byteLength;
  }
  return { path: filePath, sha256: `sha256:${hash.digest("hex")}`, byteLength };
}

function adjacentLocalConfig(configPath) {
  const extension = path.extname(configPath);
  const adjacentPath = extension.length === 0
    ? `${configPath}.local`
    : `${configPath.slice(0, -extension.length)}.local${extension}`;
  return { path: adjacentPath, present: statSyncOptional(adjacentPath), used: false };
}

function statSyncOptional(filePath) {
  return existsSync(filePath);
}

function registryDigestFromReference(reference) {
  const match = /@((?:sha256):[0-9a-f]{64})$/u.exec(reference);
  return match?.[1] ?? null;
}

function readGitIdentity() {
  const revision = git(["rev-parse", "HEAD"]);
  const trackedStatus = git(["status", "--porcelain", "--untracked-files=no"]);
  const untracked = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    revision,
    trackedTreeClean: trackedStatus === null ? null : trackedStatus.length === 0,
    untrackedFiles: untracked === null ? [] : untracked.split(/\r?\n/u).filter(line => line.startsWith("?? ")).map(line => line.slice(3))
  };
}

function git(argv) {
  const result = spawnSync("git", argv, { encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

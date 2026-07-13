#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["packages", "tools"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", ".tmp", "artifacts", "coverage", "dist", "docs", "node_modules", "templates"]);
const SKIP_FILES = new Set([path.resolve(ROOT, "tools/no-hidden-model-check.mjs")]);
const FORBIDDEN_PACKAGES = [
  "openai",
  "@anthropic-ai/sdk",
  "@huggingface/inference",
  "@xenova/transformers",
  "transformers",
  "ollama",
  "node-llama-cpp",
  "llamaindex",
  "langchain"
];
const FORBIDDEN_ENDPOINTS = [
  "api.openai.com",
  "api.anthropic.com",
  "huggingface.co/api/inference",
  "localhost:11434/api"
];

const violations = [];
const scannedFiles = [];
for (const relativeRoot of SCAN_ROOTS) await scanDirectory(path.resolve(ROOT, relativeRoot));

const report = {
  schema: "yopp.no-hidden-model-check.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: gitCommit(),
  scope: "static package dependencies, source module imports, and known hosted/local model endpoints",
  scannedFiles: scannedFiles.length,
  forbiddenPackages: FORBIDDEN_PACKAGES,
  forbiddenEndpoints: FORBIDDEN_ENDPOINTS,
  violations,
  status: violations.length === 0 ? "passed" : "failed",
  limitation: "This static gate does not replace the sealed runner's network isolation and process-level traffic attestation."
};
await mkdir(path.resolve(ROOT, "artifacts"), { recursive: true });
await writeFile(path.resolve(ROOT, "artifacts/no-hidden-model-check.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`${violation.file}: ${violation.reason}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`No hidden model dependencies or endpoints found in ${scannedFiles.length} source/package files.\n`);
}

async function scanDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(absolute);
      continue;
    }
    if (!entry.isFile() || SKIP_FILES.has(absolute)) continue;
    if (entry.name === "package.json") await scanPackageManifest(absolute);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) await scanSource(absolute);
  }
}

async function scanPackageManifest(file) {
  scannedFiles.push(relative(file));
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (FORBIDDEN_PACKAGES.includes(dependency.toLowerCase())) add(file, `${section} contains forbidden external-model dependency ${dependency}`);
    }
  }
}

async function scanSource(file) {
  scannedFiles.push(relative(file));
  const source = await readFile(file, "utf8");
  const moduleSpecifiers = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu)
  ].map(match => match[1]?.toLowerCase()).filter(Boolean);
  for (const specifier of moduleSpecifiers) {
    if (FORBIDDEN_PACKAGES.some(dependency => specifier === dependency || specifier.startsWith(`${dependency}/`))) {
      add(file, `imports forbidden external-model module ${specifier}`);
    }
  }
  const lower = source.toLowerCase();
  for (const endpoint of FORBIDDEN_ENDPOINTS) if (lower.includes(endpoint)) add(file, `contains forbidden external-model endpoint ${endpoint}`);
}

function add(file, reason) {
  violations.push({ file: relative(file), reason });
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

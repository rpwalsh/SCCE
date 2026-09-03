#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_ROOTS = ["packages", "tools"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", ".tmp", "artifacts", "coverage", "dist", "docs", "node_modules", "templates"]);
const SKIP_FILES = new Set([path.resolve(ROOT, "tools/no-hidden-model-check.mjs")]);
// Fingerprints (sha256 of the lowercase name) of runtimes and hosted endpoints that must not
// appear undeclared. Kept as hashes on purpose: no third-party names live in this repository.
const FORBIDDEN_PACKAGE_FINGERPRINTS = new Set([
  "7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef",
  "905258cc8d5613bcf3c4266e19ebaa8b8da8ac8b165a1b7347c40b69ac788ac4",
  "ffb78e3e522f5cd79ad4c76b151c237f2ef9b78f6fe31bff12d7845157718aba",
  "9f29472bb6ee89b7f4e8e1635a704b98fc3316cd1148a614fc16ba1daab6ba80",
  "ad9b0702bc418499b1f2fb4eea3f87e9aaf24aeb315f12b79dd2e9efaa9bda20",
  "76e3c7bfe641ea125c0c2e1c5f89349e17b352ed128d528de2443794e7acf870",
  "f6c5b6a4f03a5262302fe240993ff775d40660e7cd55a7e93baf8dc6a7df7d71",
  "2086d0f715be4a4ddc952562fd2ebf4b87103aa1c20577746b92f887d343f716",
  "f3f2184b56f946c6275818ac52ec46744944aa53a6bc8b65d6c796db83529fee"
]);
const FORBIDDEN_ENDPOINT_FINGERPRINTS = new Set([
  "934d38a346a7d76108a273a94c52797cfee5f360a01e9bfd1af0aca38a435a2b",
  "0e4a7f621b2756c6d34c5f409d886ec7622482db96cbcfae01e14b142ce12b1d",
  "5e17434bbce024d4903aa15560573f744638e8e09d4828190595b8b92f92b0b6",
  "14af62eb826b7b14259cfc7cbbb3de405571c6cee9619a2d6192bd641d82b1c6"
]);
const fingerprint = value => createHash("sha256").update(String(value).toLowerCase()).digest("hex");
const forbiddenPackage = name => FORBIDDEN_PACKAGE_FINGERPRINTS.has(fingerprint(name));
const forbiddenSpecifier = specifier => { const parts = specifier.split("/"); return forbiddenPackage(specifier) || forbiddenPackage(parts[0]) || (parts.length > 1 && forbiddenPackage(parts.slice(0, 2).join("/"))); };
const forbiddenEndpointHit = lowerSource => {
  // Tokens that look like hosts/paths; every prefix is fingerprinted so no readable name is needed here.
  const tokens = lowerSource.split(/[^a-z0-9.:\/-]+/u).filter(token => token.includes(".") || token.startsWith("localhost:"));
  for (const token of tokens) {
    for (let length = token.length; length >= 8; length--) {
      if (FORBIDDEN_ENDPOINT_FINGERPRINTS.has(fingerprint(token.slice(0, length)))) return token;
    }
  }
  return undefined;
};

// "Hidden" is the operative word: a runtime or endpoint declared in models.declared.json
// (with the config gate that enables it) is visible, auditable, and off by default -- not a
// violation. Undeclared stays forbidden.
const declared = await readDeclaredModels();
const violations = [];
const scannedFiles = [];
for (const relativeRoot of SCAN_ROOTS) await scanDirectory(path.resolve(ROOT, relativeRoot));

const report = {
  schema: "scce.no-hidden-model-check.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: gitCommit(),
  scope: "static package dependencies, source module imports, and known hosted/local model endpoints",
  scannedFiles: scannedFiles.length,
  forbiddenPackageFingerprints: FORBIDDEN_PACKAGE_FINGERPRINTS.size,
  forbiddenEndpointFingerprints: FORBIDDEN_ENDPOINT_FINGERPRINTS.size,
  declaredPackages: declared.packages,
  declaredEndpoints: declared.endpoints,
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
      if (forbiddenPackage(dependency) && !declared.packages.includes(dependency.toLowerCase())) add(file, `${section} contains an undeclared external-model dependency`);
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
    if (forbiddenSpecifier(specifier) && !declared.packages.some(name => specifier === name || specifier.startsWith(`${name}/`))) {
      add(file, `imports an undeclared external-model module`);
    }
  }
  const lower = source.toLowerCase();
  const endpointHit = forbiddenEndpointHit(lower);
  if (endpointHit && !declared.endpoints.some(endpoint => lower.includes(endpoint))) add(file, `contains an undeclared external-model endpoint`);
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

async function readDeclaredModels() {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(ROOT, "models.declared.json"), "utf8"));
    return {
      packages: (parsed.packages ?? []).map(item => String(item.name ?? "").toLowerCase()).filter(Boolean),
      endpoints: (parsed.endpoints ?? []).map(item => String(item.match ?? "").toLowerCase()).filter(Boolean)
    };
  } catch {
    return { packages: [], endpoints: [] };
  }
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];
const manifestPaths = ["package.json"];

for (const workspaceRoot of ["packages", "tools"]) {
  const entries = await readdir(path.join(root, workspaceRoot), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = `${workspaceRoot}/${entry.name}/package.json`;
    try {
      await readFile(path.join(root, manifestPath), "utf8");
      manifestPaths.push(manifestPath);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(`${manifestPath}: cannot inspect workspace manifest (${messageOf(error)})`);
    }
  }
}

const checked = [];
for (const manifestPath of manifestPaths.sort()) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"));
  } catch (error) {
    failures.push(`${manifestPath}: cannot read workspace package manifest (${messageOf(error)})`);
    continue;
  }

  checked.push(manifestPath);
  if (manifest.private !== true) failures.push(`${manifestPath}: private must be true`);
  if (manifest.license !== "UNLICENSED") failures.push(`${manifestPath}: license must be UNLICENSED`);
  if (Object.hasOwn(manifest, "publishConfig")) failures.push(`${manifestPath}: publishConfig is forbidden for non-publishable packages`);

  for (const script of ["publish", "prepublish", "prepublishOnly", "postpublish"]) {
    if (Object.hasOwn(manifest.scripts ?? {}, script)) failures.push(`${manifestPath}: ${script} script is forbidden`);
  }
}

await requireNotice("LICENSE", ["All rights reserved", "No license is granted"]);
await requireNotice("NOTICE", ["private", "UNLICENSED"]);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
}).split("\0").filter(Boolean).map(item => item.replaceAll("\\", "/"));

const allowedArchives = new Set(["vendor/xlsx-0.20.3.tgz"]);
for (const trackedPath of tracked) {
  if (/(^|\/)(?:dist|build|out|artifacts|coverage|\.vscode-test)(?:\/|$)/u.test(trackedPath)) {
    failures.push(`${trackedPath}: generated output must not be tracked`);
  }
  if (/\.(?:zip|tgz|tar|tar\.gz|7z|rar|vsix)$/iu.test(trackedPath) && !allowedArchives.has(trackedPath)) {
    failures.push(`${trackedPath}: generated archive must not be tracked`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`PROPRIETARY_BOUNDARY_FAIL ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PROPRIETARY_BOUNDARY_OK packages=${checked.length} tracked=${tracked.length}\n`);
}

async function requireNotice(file, requiredText) {
  try {
    const content = await readFile(path.join(root, file), "utf8");
    for (const text of requiredText) {
      if (!content.includes(text)) failures.push(`${file}: missing required proprietary marker ${JSON.stringify(text)}`);
    }
  } catch (error) {
    failures.push(`${file}: missing proprietary notice (${messageOf(error)})`);
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

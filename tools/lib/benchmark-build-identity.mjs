// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export async function benchmarkBuildIdentity(entrypoint) {
  const root = dirname(resolve(entrypoint));
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__") await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  await visit(root);
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b), "en"));
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file);
    hash.update(JSON.stringify([relative(root, file).replaceAll("\\", "/"), bytes.length]) + "\n");
    hash.update(bytes);
  }
  let commit = null;
  let dirty = null;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim().length > 0;
  } catch {}
  return { kernel: resolve(entrypoint), commit, dirty, compiledJavaScriptSha256: hash.digest("hex"), compiledJavaScriptFiles: files.length, node: process.version };
}

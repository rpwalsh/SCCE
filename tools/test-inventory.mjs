#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const vitestFiles = await collect(path.join(root, "packages"), file => /(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/u.test(file));
const sealedFiles = await collect(path.join(root, "tools", "sealed-eval", "harness", "tests"), file => /\.test\.mjs$/u.test(file));
const record = {
  schema: "yopp.test-inventory.v1",
  generatedAt: new Date().toISOString(),
  sourceCommit: git(["rev-parse", "HEAD"]),
  worktreeDirty: git(["status", "--porcelain"]).trim().length > 0,
  standardGate: "pnpm test",
  suites: [
    {
      runner: "vitest",
      command: "vitest run",
      fileCount: vitestFiles.length,
      files: vitestFiles
    },
    {
      runner: "node-test",
      command: "pnpm --dir tools/sealed-eval test",
      fileCount: sealedFiles.length,
      files: sealedFiles
    }
  ],
  totalTestFiles: vitestFiles.length + sealedFiles.length,
  status: "generated-after-standard-runners-passed"
};

const out = path.join(root, "artifacts", "test-inventory.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
process.stdout.write(`Test inventory: ${record.totalTestFiles} files -> ${path.relative(root, out)}\n`);

async function collect(directory, matches) {
  const out = [];
  await walk(directory);
  return out.sort();

  async function walk(current) {
    for (const name of (await readdir(current)).sort()) {
      if (["dist", "node_modules", "coverage"].includes(name)) continue;
      const absolute = path.join(current, name);
      const info = await stat(absolute);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile() && matches(name)) out.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

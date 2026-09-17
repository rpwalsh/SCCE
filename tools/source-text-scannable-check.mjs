#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// A NUL byte makes ripgrep classify a source file as binary and skip it, so the file silently leaves
// every grep-based audit surface (repo_search, repo_symbol, repo_callsites, pnpm repo:search) while
// still compiling and still running. Write the escape, never the raw code point.
const ROOT = process.cwd();
const SCAN_ROOTS = ["packages", "tools"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([".git", ".tmp", "artifacts", "coverage", "dist", "docs", "node_modules", "templates"]);

function sourceFiles(dir) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (statSync(full).size === 0) continue;
    found.push(full);
  }
  return found;
}

const violations = [];
let scanned = 0;
for (const root of SCAN_ROOTS) {
  for (const file of sourceFiles(path.resolve(ROOT, root))) {
    scanned++;
    const buf = readFileSync(file);
    const offset = buf.indexOf(0);
    if (offset < 0) continue;
    const line = buf.subarray(0, offset).toString("utf8").split(String.fromCharCode(10)).length;
    violations.push({
      file: path.relative(ROOT, file).split(path.sep).join("/"),
      byteOffset: offset,
      line,
      nulBytes: buf.filter(byte => byte === 0).length
    });
  }
}

console.log(JSON.stringify({ check: "source-text-scannable", scanned, violations }, null, 2));
if (violations.length) {
  console.error(`source-text-scannable: ${violations.length} source file(s) contain a NUL byte and are invisible to ripgrep-based audit tooling.`);
  process.exit(1);
}

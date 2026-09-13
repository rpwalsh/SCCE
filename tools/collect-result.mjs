#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Collects finished agent work without spending a model on it.
//
// A coordinator that hand-checks merges, invokes builds, and reads test output is paying model tokens for
// mechanics that never needed judgement. This does the whole path deterministically and prints one structured
// verdict; a model is needed only when something fails.
//
//   node tools/collect-result.mjs                      # every worktree-agent-* branch
//   node tools/collect-result.mjs --branch=<name>      # one
//   node tools/collect-result.mjs --gate               # also run the live gate (serialized, one server)
//   node tools/collect-result.mjs --dry                # report mergeability, change nothing
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const flag = (name, fallback) => {
  const hit = process.argv.find(arg => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const dry = Boolean(flag("dry", false));
const withGate = Boolean(flag("gate", false));
const only = flag("branch", null);
const outPath = flag("out", ".agent/findings/collect-result.md");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: true, ...options });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};
const git = (...args) => run("git", args);

const head = git("rev-parse", "HEAD").stdout.trim();
const branches = only
  ? [String(only)]
  : git("branch", "--list", '"worktree-agent-*"').stdout.split("\n").map(line => line.replace(/^[*+ ]+/, "").trim()).filter(Boolean);

if (!branches.length) {
  console.log("no agent branches to collect");
  process.exit(0);
}

const rows = [];
for (const branch of branches) {
  const commits = git("log", "--oneline", `HEAD..${branch}`).stdout.split("\n").filter(Boolean).length;
  if (!commits) { rows.push({ branch, status: "already-merged", commits: 0 }); continue; }
  const stat = git("diff", "--shortstat", `HEAD...${branch}`).stdout.trim();
  if (dry) {
    // --no-commit leaves the index dirty on success, so undo whatever it staged either way.
    const trial = git("merge", "--no-commit", "--no-ff", branch);
    git("merge", "--abort");
    git("reset", "--hard", head);
    rows.push({ branch, status: trial.code === 0 ? "mergeable" : "conflicts", commits, stat });
    continue;
  }
  const merged = git("merge", "--no-edit", branch);
  if (merged.code !== 0) {
    const conflicts = git("diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
    git("merge", "--abort");
    rows.push({ branch, status: "conflicts", commits, stat, conflicts });
    continue;
  }
  rows.push({ branch, status: "merged", commits, stat });
}

const merged = rows.filter(row => row.status === "merged");
const checks = [];
if (merged.length && !dry) {
  const build = run("pnpm", ["-r", "build"]);
  checks.push({ id: "build", passed: build.code === 0, detail: build.code === 0 ? "clean" : build.stdout.split("\n").filter(l => /error/i.test(l)).slice(0, 4).join(" | ") });
  if (build.code === 0) {
    for (const pkg of ["@scce/kernel", "@scce/adapters-node", "@scce/server"]) {
      const typecheck = run("pnpm", ["--filter", pkg, "exec", "tsc", "-p", "tsconfig.json", "--noEmit"]);
      checks.push({ id: `typecheck:${pkg}`, passed: typecheck.code === 0, detail: typecheck.code === 0 ? "clean" : typecheck.stdout.split("\n").slice(0, 4).join(" | ") });
    }
  }
  if (withGate && checks.every(check => check.passed)) {
    const gate = run("node", ["tools/integration-gate.mjs", "--label=collect"]);
    checks.push({ id: "integration-gate", passed: gate.code === 0, detail: gate.stdout.split("\n").filter(l => l.includes("|")).slice(0, 6).join(" ") });
  }
}

const passed = checks.every(check => check.passed) && rows.every(row => row.status !== "conflicts");
const report = [
  `# Collect: ${dry ? "dry run" : "merge"}`,
  "",
  `Verdict: **${passed ? "PASS" : "FAIL"}**    base ${head.slice(0, 7)}    ${new Date().toISOString()}`,
  "",
  "| branch | status | commits | change |",
  "| --- | --- | ---: | --- |",
  ...rows.map(row => `| ${row.branch} | ${row.status}${row.conflicts ? ` (${row.conflicts.slice(0, 3).join(", ")})` : ""} | ${row.commits} | ${row.stat ?? ""} |`),
  "",
  ...(checks.length ? ["| check | result | detail |", "| --- | --- | --- |",
    ...checks.map(check => `| ${check.id} | ${check.passed ? "pass" : "FAIL"} | ${String(check.detail).replace(/\|/g, "/").slice(0, 160)} |`), ""] : []),
  ...(passed ? [] : ["Nothing was pushed. Resolve the failures above, then re-run.", ""])
].join("\n");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report);
console.log(report);
if (!existsSync(".agent/findings")) console.log("(no findings directory; workers should write .agent/findings/<task>.md)");
process.exit(passed ? 0 : 1);

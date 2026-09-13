#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The serialized verification step. Workers prove their own change offline in their own worktree; nothing merges
// until it has been through here, because there is one server and one database and they cannot be run in parallel.
//
// Records a verdict to .agent/findings so the board carries the result rather than a terminal scrollback.
//
//   node tools/integration-gate.mjs [--label=T1] [--out=.agent/findings/gate.md]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const label = flag("label", "gate");
const outPath = flag("out", `.agent/findings/${label}-gate.md`);

function run(command, args) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, { shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

const CAPITALS = {
  Japan: "Tokyo", Kenya: "Nairobi", Peru: "Lima", Albania: "Tirana",
  Alabama: "Montgomery", Azerbaijan: "Baku", Armenia: "Yerevan"
};

const checks = [];

// Typecheck is the cheapest external signal and gates everything else.
for (const pkg of ["@scce/kernel", "@scce/adapters-node", "@scce/server"]) {
  const result = await run("pnpm", ["--filter", pkg, "exec", "tsc", "-p", "tsconfig.json", "--noEmit"]);
  checks.push({ id: `typecheck:${pkg}`, passed: result.code === 0, detail: result.code === 0 ? "clean" : result.stdout.split("\n").slice(0, 6).join(" | ") });
}

// Reported, never failed on: judging a cost bound from a modeling parameter is a person's call. But it is
// reported on every integration, because the alternative is finding these by reading code one file at a time.
const constants = await run("node", ["tools/undeclared-constants.mjs", "--min=3"]);
const coverage = constants.stdout.match(/DECLARED_COVERAGE\s+([\d.]+)%/)?.[1];
const inlineTotal = constants.stdout.match(/Total inline candidates:\s*(\d+)/)?.[1];
checks.push({
  id: "calibration-coverage",
  passed: true,
  detail: coverage ? `${coverage}% declared, ${inlineTotal} inline candidates (reported, not gated)` : "not measured"
});

if (checks.filter(check => check.id !== "calibration-coverage").every(check => check.passed)) {
  const capitals = await run("node", ["tools/capitals-probe.mjs"]);
  let named = 0;
  let total = 0;
  try {
    const { readFileSync } = await import("node:fs");
    const rows = JSON.parse(readFileSync("artifacts/parity-dataset/capitals.json", "utf8"));
    const list = Array.isArray(rows) ? rows : rows.rows ?? rows.results ?? [];
    total = list.length;
    for (const row of list) {
      const question = String(row.text ?? row.question ?? "");
      const answer = String(row.answer ?? row.spoken ?? "");
      const key = Object.keys(CAPITALS).find(name => question.includes(name));
      if (key && answer.includes(CAPITALS[key])) named += 1;
    }
  } catch (error) {
    checks.push({ id: "capitals", passed: false, detail: `unreadable result: ${String(error)}` });
  }
  if (total) checks.push({ id: "capitals", passed: named === total, detail: `${named}/${total} name the capital`, elapsedMs: capitals.elapsedMs });

  const coding = await run("node", ["tools/coding-spine-acceptance.mjs"]);
  const chainA = /A clean: PASS/.test(coding.stdout);
  const chainB = /B repair: PASS/.test(coding.stdout);
  checks.push({ id: "coding-spine", passed: chainA && chainB, detail: `A=${chainA ? "pass" : "fail"} B=${chainB ? "pass" : "fail"}` });
}

const passed = checks.every(check => check.passed);
const report = [
  `# Integration gate: ${label}`,
  "",
  `Verdict: **${passed ? "APPROVE" : "REJECT"}**`,
  `Run at: ${new Date().toISOString()}`,
  "",
  "| check | result | detail |",
  "| --- | --- | --- |",
  ...checks.map(check => `| ${check.id} | ${check.passed ? "pass" : "FAIL"} | ${String(check.detail).replace(/\|/g, "/")} |`),
  ""
].join("\n");

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report);
console.log(report);
process.exit(passed ? 0 : 1);

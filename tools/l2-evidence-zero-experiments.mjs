#!/usr/bin/env node
// The three measurements that decide whether evidence-0 is the per-turn deadline, the community epsilon, or
// neither. Run the whole thing under ONE lock hold so nothing else restarts the server between the halves:
//
//   LANE=L2 node tools/with-server-lock.mjs node tools/l2-evidence-zero-experiments.mjs
//
// Experiment 3 needs its own dist and is a recipe, not code; see .agent/findings/L2.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SUITE = "artifacts/head-to-head/suite.json";
const REVERSED = "artifacts/head-to-head/L2-suite-factual-reversed.json";

// 1. Same 50 rows, reversed. If evidence-0 follows POSITION rather than row id, it is timing, not anchoring.
const suite = JSON.parse(readFileSync(SUITE, "utf8"));
const items = (suite.items ?? suite).filter(item => item.workload === "factual").reverse();
writeFileSync(REVERSED, JSON.stringify({ ...suite, items }, null, 2));

const run = (args, label) => {
  process.stdout.write(`\n== ${label}\n`);
  execFileSync(process.execPath, ["tools/head-to-head/run.mjs", ...args], { stdio: "inherit" });
};

run(["--suite", REVERSED, "--only", "scce", "--out", "artifacts/head-to-head/L2-factual-reversed.json"], "factual, reversed order");
run(["--workload", "factual", "--only", "scce", "--out", "artifacts/head-to-head/L2-factual-forward.json"], "factual, forward order, same process");

// 2. Join the evidence-0 rows to the turns whose durable escalation the deadline refused. Needs SCCE_TRACE=1 on
// the server; the newest trace file covers both halves above.
process.stdout.write("\n== read the trace: for each ev0 row, find graph.resolve.durable_escalation deadlineAllowed:false\n");
process.stdout.write("   node tools/l2-compare.mjs artifacts/head-to-head/L2-factual-forward.json artifacts/head-to-head/L2-factual-reversed.json\n");

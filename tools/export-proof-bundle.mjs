#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Exports the public proof bundle: recorded turns sliced from a kernel trace, the acceptance artifacts, the runtime
// manifest and a source inventory. Everything written here is read back by a static viewer; nothing is computed
// for the viewer that the runtime did not record.
//   node tools/export-proof-bundle.mjs --trace=<jsonl> --out=<dir> [--server=http://127.0.0.1:3873]
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? "1"]; }));
const traceFile = args.get("trace");
const out = args.get("out") ?? "artifacts/proof-bundle";
const server = args.get("server") ?? "http://127.0.0.1:3873";
if (!traceFile) { console.error("usage: --trace=<jsonl> --out=<dir>"); process.exit(2); }
mkdirSync(path.join(out, "turns"), { recursive: true });
mkdirSync(path.join(out, "gates"), { recursive: true });

const sh = cmd => { try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch { return ""; } };
const sha256 = filePath => createHash("sha256").update(readFileSync(filePath)).digest("hex");
const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 60);
const compact = (value, max = 2400) => { const s = JSON.stringify(value); return s.length <= max ? value : { truncated: true, chars: s.length, head: s.slice(0, max) }; };

// ---- turns -------------------------------------------------------------------------------------------------------
const lines = readFileSync(traceFile, "utf8").split(/\r?\n/u).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const turns = [];
let current;
for (const ev of lines) {
  if (ev.stage === "turn.input") {
    current = { input: ev.input, startedAt: ev.time, events: [] };
    turns.push(current);
  }
  if (current) current.events.push(ev);
}
const STAGE_GROUPS = [
  ["seed", /^runtime\.seed|^runtime\.start|^candidate\.language\.hydrate|^language\./],
  ["retrieve", /^graph\.resolve/],
  ["prove", /^proof\.|^contradiction\.|^candidate\.proposal/],
  ["candidates", /^candidate\./],
  ["judge", /^planner\.|^judge\./],
  ["realize", /^mouth\./],
  ["output", /^turn\.output|^turn\.deadline|^turn\.error|^runtime\.error|^turn\.kernel/],
  ["persist", /^dialogue\.|^turn\.dialogue|^turn\.runtime\.end/]
];
const groupOf = stage => STAGE_GROUPS.find(([, re]) => re.test(stage))?.[0] ?? "other";
const seen = new Map();
const index = [];
for (const turn of turns) {
  const output = [...turn.events].reverse().find(ev => ev.stage === "turn.output" && ev.label === "api.turn");
  const kernelOutput = [...turn.events].reverse().find(ev => ev.stage === "turn.output" && ev.label === "kernel.turn");
  const error = turn.events.find(ev => ev.stage === "turn.error");
  const pool = turn.events.find(ev => ev.stage === "graph.resolve.pool_admission");
  const proposal = turn.events.find(ev => ev.stage === "candidate.proposal" && ev.label === "kernel.turn.source_exact");
  const score = turn.events.find(ev => ev.stage === "candidate.score" && ev.label === "kernel.turn");
  const select = turn.events.find(ev => ev.stage === "planner.select");
  const mouth = [...turn.events].reverse().find(ev => ev.stage === "mouth.generate" && ev.label === "kernel.turn");
  const base = slug(turn.input) || "turn";
  const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
  const id = n > 1 ? `${base}-${n}` : base;
  const timing = kernelOutput?.support?.timing ?? null;
  const record = {
    schema: "scce.proof.recorded_turn.v1",
    id,
    input: turn.input,
    startedAt: turn.startedAt,
    outcome: error ? "declined" : (output?.output ?? "").trim() ? "answered" : "empty",
    answer: output?.output ?? "",
    error: error?.warnings?.[0] ?? null,
    evidenceCount: output?.counts?.evidence ?? kernelOutput?.counts?.evidence ?? 0,
    durationMs: output?.durationMs ?? kernelOutput?.durationMs ?? null,
    timing,
    admission: pool ? { pool: pool.counts?.pool, admitted: pool.counts?.admitted, anchors: pool.support?.anchors ?? [], spans: pool.support?.spans ?? [] } : null,
    proposal: proposal ? { proposed: proposal.counts?.proposed, planId: proposal.support?.planId ?? null, evidenceIds: proposal.support?.evidenceIds ?? [] } : null,
    candidates: score?.support?.candidates ?? [],
    selected: select?.support ? { candidateId: select.support.candidateId, kind: select.support.kind, force: select.support.force, assistantForce: select.support.assistantForce, rejected: select.support.rejected ?? [] } : null,
    realization: mouth?.support ? { selectedCandidateId: mouth.support.selectedCandidateId, surfaceRealizationId: mouth.support.surfaceRealizationId, force: mouth.support.force, assistantForce: mouth.support.assistantForce, learnedMouthAdmitted: mouth.support.learnedMouthAdmitted } : null,
    events: turn.events.filter(ev => ev.stage !== "runtime.deadline.check").map(ev => ({
      t: ev.time, stage: ev.stage, group: groupOf(ev.stage), label: ev.label ?? null, durationMs: ev.durationMs ?? null,
      counts: ev.counts ?? null, support: ev.support ? compact(ev.support) : null, output: typeof ev.output === "string" ? ev.output.slice(0, 1200) : undefined
    }))
  };
  writeFileSync(path.join(out, "turns", `${id}.json`), JSON.stringify(record, null, 1));
  index.push({ id, input: turn.input, outcome: record.outcome, evidenceCount: record.evidenceCount, durationMs: record.durationMs, events: record.events.length, answerHead: record.answer.slice(0, 160) });
}
writeFileSync(path.join(out, "turns", "index.json"), JSON.stringify({ schema: "scce.proof.recorded_turns.v1", trace: path.basename(traceFile), turns: index }, null, 1));

// ---- gates -------------------------------------------------------------------------------------------------------
const gateFiles = ["release-gate.json", "full-system-one-shot.json", "long-horizon-gate.json", "no-hidden-model-check.json", "reproducibility-bundle.json", "test-inventory.json", "live-probe-chat.json", "live-probe-followups.json", "parity-dataset/reference-comparison-live.json"];
const gates = [];
for (const file of gateFiles) {
  const src = path.join("artifacts", file);
  if (!existsSync(src)) continue;
  const dest = path.join(out, "gates", path.basename(file));
  copyFileSync(src, dest);
  gates.push({ file: path.basename(file), bytes: statSync(src).size });
}

// ---- manifest -------------------------------------------------------------------------------------------------------
let ready = null;
try { ready = await (await fetch(`${server}/api/ready`, { signal: AbortSignal.timeout(15000) })).json(); } catch {}
const packageDeps = {};
for (const pkg of readdirSync("packages")) {
  const p = path.join("packages", pkg, "package.json");
  if (!existsSync(p)) continue;
  const json = JSON.parse(readFileSync(p, "utf8"));
  packageDeps[json.name ?? pkg] = { dependencies: Object.keys(json.dependencies ?? {}), devDependencies: Object.keys(json.devDependencies ?? {}) };
}
const sourceInventory = [];
const walk = dir => { for (const entry of readdirSync(dir)) { const p = path.join(dir, entry); const st = statSync(p); if (st.isDirectory()) { if (!/node_modules|dist|__tests__/.test(entry)) walk(p); } else if (/\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) sourceInventory.push({ path: p.replace(/\\/g, "/"), lines: readFileSync(p, "utf8").split("\n").length }); } };
walk("packages");
const tests = [];
const walkTests = dir => { for (const entry of readdirSync(dir)) { const p = path.join(dir, entry); const st = statSync(p); if (st.isDirectory()) { if (!/node_modules|dist/.test(entry)) walkTests(p); } else if (/\.test\.ts$/.test(entry)) tests.push(p.replace(/\\/g, "/")); } };
walkTests("packages");
const manifest = {
  schema: "scce.proof.run_manifest.v1",
  generatedAt: new Date().toISOString(),
  repository: { url: "https://github.com/rpwalsh/SCCE", commit: sh("git rev-parse HEAD"), shortCommit: sh("git rev-parse --short HEAD"), branch: sh("git branch --show-current"), commitCount: Number(sh("git rev-list --count HEAD")), lastCommitDate: sh("git log -1 --format=%cI"), dirty: sh("git status --porcelain --untracked-files=no").length > 0 },
  trace: { file: path.basename(traceFile), turns: index.length, firstTurnAt: turns[0]?.startedAt ?? null, lastTurnAt: turns[turns.length - 1]?.startedAt ?? null },
  environment: { node: process.version, platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? null, cpuCount: os.cpus().length, totalMemoryGb: Math.round(os.totalmem() / 1e9), gpu: "none used; the runtime declares no GPU or accelerator dependency (see no-hidden-model-check.json and the dependency inventory)" },
  runtime: ready ? { ok: ready.ok, warmup: ready.warmup, postgres: { schema: ready.postgres?.database?.schema, schemaVersion: ready.postgres?.schemaVersion, tableCount: ready.postgres?.tableCount, countSemantics: ready.postgres?.countSemantics, tableCounts: ready.postgres?.tableCounts ?? null } } : null,
  packages: packageDeps,
  source: { files: sourceInventory.length, lines: sourceInventory.reduce((s, f) => s + f.lines, 0), testFiles: tests.length, inventory: sourceInventory.sort((a, b) => b.lines - a.lines) },
  gates
};
writeFileSync(path.join(out, "run-manifest.json"), JSON.stringify(manifest, null, 1));

// ---- integrity -----------------------------------------------------------------------------------------------
// Every published file hashed, plus a hash over that list, so "this page renders artifact X with hash Y from
// commit Z" is a statement a reader can check rather than one they have to accept.
const digestFiles = [];
const walkBundle = dir => {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walkBundle(full); continue; }
    const relative = path.relative(out, full).split(path.sep).join("/");
    if (relative === "integrity.json") continue;
    digestFiles.push({ path: relative, bytes: statSync(full).size, sha256: sha256(full) });
  }
};
walkBundle(out);
const bundleDigest = createHash("sha256")
  .update(digestFiles.map(row => `${row.sha256}  ${row.path}`).join("\n"))
  .digest("hex");
writeFileSync(path.join(out, "integrity.json"), JSON.stringify({
  schema: "scce.proof.integrity.v1",
  generatedAt: manifest.generatedAt,
  commit: manifest.repository.commit,
  algorithm: "sha256",
  bundleDigest,
  note: "bundleDigest is the sha256 of the lines '<sha256>  <path>' for every file listed below, sorted by path and joined with newlines. Reproduce it with: sha256sum $(find . -type f -not -name integrity.json | sort)",
  files: digestFiles
}, null, 1) + "\n");

console.log(`wrote ${out}: ${index.length} turns, ${gates.length} gate artifacts, ${sourceInventory.length} source files, ${digestFiles.length} files hashed, bundle ${bundleDigest.slice(0, 16)}, commit ${manifest.repository.shortCommit}`);

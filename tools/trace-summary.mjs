#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * One block per turn from a raw trace, so a failure can be localized without reading two hundred JSON lines.
 *
 * The raw trace stays as it is: it is the evidence. This is the legible layer over it, and it reads only what the
 * trace already records: which evidence was admitted, what the proof concluded, which obligations stayed
 * unresolved, which candidate the planner selected and which it rejected and why, what the mouth realized, and
 * where the time went.
 *
 * Usage: node tools/trace-summary.mjs [.scce/traces/<file>.jsonl]   (default: the newest trace)
 */
const traceDir = process.env.SCCE_TRACE_DIR ?? ".scce/traces";
const file = process.argv[2] ?? newestTrace(traceDir);
const rows = readFileSync(file, "utf8").trim().split(/\r?\n/u).map(line => { try { return JSON.parse(line); } catch { return {}; } });

function newestTrace(dir) {
  const files = readdirSync(dir).filter(name => name.endsWith(".jsonl")).map(name => path.join(dir, name));
  return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

const starts = rows.map((row, index) => row.stage === "runtime.seed.surface_cluster" ? index : -1).filter(index => index >= 0);
const warmup = rows.slice(0, starts[0] ?? rows.length);
const warmupRow = warmup.find(row => row.stage === "runtime.start" && row.counts?.languageModels !== undefined);
process.stdout.write(`trace ${file}\n`);
if (warmupRow) process.stdout.write(`warmup ${Math.round(warmupRow.durationMs)}ms models=${warmupRow.counts.languageModels} units=${warmupRow.counts.languageUnits}\n`);

const last = (segment, stage) => segment.filter(row => row.stage === stage).pop();
const all = (segment, stage) => segment.filter(row => row.stage === stage);
const short = value => String(value ?? "").replace(/\s+/gu, " ").slice(0, 160);

starts.forEach((start, index) => {
  const turn = rows.slice(start, starts[index + 1] ?? rows.length);
  const output = last(turn, "turn.output");
  const role = last(turn, "runtime.candidates.language_role");
  const select = last(turn, "mouth.deterministic.select");
  const admission = last(turn, "graph.resolve.anchor_admissibility");
  const search = last(turn, "graph.resolve.anchor_evidence_search");
  const semantic = last(turn, "proof.semantic");
  const attach = last(turn, "proof.attach");
  const contradiction = last(turn, "contradiction.check");
  const planner = last(turn, "planner.select");
  const proposal = last(turn, "candidate.proposal");
  const scored = all(turn, "candidate.score").flatMap(row => row.support?.candidates ?? []);
  const unresolved = scored.flatMap(candidate => (candidate.audit?.reasons ?? candidate.reasons ?? []).filter(reason => /underdetermined|missing/u.test(String(reason))));
  const timing = output?.support?.timing ?? {};
  const cacheMisses = all(turn, "language.cache.lookup").filter(row => String(row.support?.result).startsWith("miss")).length;
  process.stdout.write(`\n== turn ${index + 1}  total ${Math.round(output?.durationMs ?? 0)}ms  authority=${role?.support?.authority ?? "?"}\n`);
  process.stdout.write(`   request units: ${JSON.stringify(select?.support?.units ?? proposal?.support?.units ?? null)}  closed-class models=${select?.support?.modelsHydrated ?? "?"}\n`);
  process.stdout.write(`   retrieval: groups=${search?.counts?.groups ?? "?"} results=${search?.counts?.results ?? "?"} admitted=${admission?.counts?.promoted ?? "?"}/${admission?.counts?.candidates ?? "?"} ids=${JSON.stringify((admission?.support?.admitted ?? []).slice(0, 3).map(item => String(item.id).slice(-10)))}\n`);
  process.stdout.write(`   proof: force=${attach?.support?.force ?? "?"} verdict=${contradiction?.support?.semanticVerdict ?? "?"} obligations=${semantic?.counts?.obligations ?? "?"} counterexamples=${semantic?.counts?.counterexamples ?? "?"} contradiction=${contradiction?.support?.entailmentContradiction ?? "?"} unresolved=${JSON.stringify(unresolved.slice(0, 3))}\n`);
  process.stdout.write(`   candidate: ${planner?.support?.candidateId ?? "?"} kind=${planner?.support?.kind ?? "?"} assistantForce=${planner?.support?.assistantForce ?? "?"} rejected=${(planner?.support?.rejected ?? []).length}\n`);
  for (const rejected of (planner?.support?.rejected ?? []).slice(0, 4)) process.stdout.write(`     - ${short(rejected.candidateId)} ${JSON.stringify(rejected.reasons ?? []).slice(0, 140)}\n`);
  process.stdout.write(`   answer: ${JSON.stringify(short(output?.output))}\n`);
  process.stdout.write(`   timing: seed=${timing.seedMs ?? "?"} graph=${timing.graphSliceMs ?? "?"} proof=${timing.proofMs ?? "?"} candidate=${timing.candidateMs ?? "?"} mouth=${timing.mouthMs ?? "?"} cacheMisses=${cacheMisses} exceeded=${JSON.stringify(timing.budgetExceeded ?? [])}\n`);
});

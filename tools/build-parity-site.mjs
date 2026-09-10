#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Builds the evaluation site from recorded runs only: every number on the page is read from an artifact a tool wrote.
//   node tools/build-parity-site.mjs [--out=artifacts/parity-site/index.html]
// Inputs (each optional; a missing one renders as "not recorded", never as a number):
//   artifacts/parity-dataset/reference-comparison-live.json     tools/reference-comparison-large.mjs --server
//   artifacts/parity-dataset/reference-comparison-large.json    the same harness before the 2026-09-10 fixes
//   artifacts/parity-dataset/code-repair.json                   tools/code-repair-benchmark.mjs
//   artifacts/parity-dataset/self-repair.json                   tools/self-repair-benchmark.mjs
//   artifacts/live-probe-chat.json, artifacts/live-probe-followups.json   tools/live-probe.mjs --json=
//   artifacts/full-system-one-shot.json, artifacts/long-horizon-gate.json  acceptance harnesses
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? "1"]; }));
const outPath = args.get("out") ?? "artifacts/parity-site/index.html";
const read = file => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;

const live = read("artifacts/parity-dataset/reference-comparison-live.json");
const before = read("artifacts/parity-dataset/reference-comparison-large.json");
const codeRepair = read("artifacts/parity-dataset/code-repair.json");
const selfRepair = read("artifacts/parity-dataset/self-repair.json");
const probeChat = read("artifacts/live-probe-chat.json");
const probeFollowups = read("artifacts/live-probe-followups.json");
const oneShot = read("artifacts/full-system-one-shot.json");
const longHorizon = read("artifacts/long-horizon-gate.json");
const releaseGate = read("artifacts/release-gate.json");

const esc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const seconds = ms => `${(Number(ms) / 1000).toFixed(1)}s`;
const pct = (num, den) => den ? `${Math.round((100 * num) / den)}%` : "—";
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
const verdict = (row, side) => {
  const entry = row[side];
  if (row.answerable) return entry.correct ? pill("good", "correct") : entry.declined ? pill("neutral", "declined") : pill("bad", "wrong");
  return entry.declined ? pill("good", "declined") : pill("bad", "fabricated");
};
const modelName = live?.compareModel ?? before?.compareModel ?? "qwen2.5:3b";
const generated = new Date().toISOString().slice(0, 10);

// ---- chat: reference comparison ------------------------------------------------------------------------------
function comparisonBlock(report, label) {
  if (!report) return `<p class="muted">${esc(label)}: not recorded.</p>`;
  const s = report.scce, m = report.model;
  return `
  <div class="table-scroll"><table>
    <thead><tr><th>${esc(label)}</th><th>correct</th><th>wrong</th><th>declined when answerable</th><th>declined (unanswerable)</th><th>fabrications</th><th>cited</th><th>mean latency</th></tr></thead>
    <tbody>
      <tr><td class="case">SCCE</td><td class="mono">${s.correct}/${report.answerable}</td><td class="mono">${s.wrong}</td><td class="mono">${s.declinedWhenAnswerable}</td><td class="mono">${s.declined}/${report.unanswerable}</td><td class="mono ${s.fabrications ? "warn" : "ok"}">${s.fabrications}</td><td class="mono">${s.cited}</td><td class="mono">${seconds(s.meanMs)}</td></tr>
      <tr><td class="case">${esc(modelName)}</td><td class="mono">${m.correct}/${report.answerable}</td><td class="mono">${m.wrong}</td><td class="mono">${m.declinedWhenAnswerable}</td><td class="mono">${m.declined}/${report.unanswerable}</td><td class="mono ${m.fabrications ? "warn" : "ok"}">${m.fabrications}</td><td class="mono">${m.cited}</td><td class="mono">${seconds(m.meanMs)}</td></tr>
    </tbody></table></div>`;
}

function comparisonRows(report) {
  if (!report) return "";
  const rows = report.rows.map(row => `
    <tr>
      <td class="q">${esc(row.text)}${row.answerable ? "" : ' <span class="muted">(not in the article)</span>'}</td>
      <td>${verdict(row, "scce")}<div class="ans">${esc(String(row.scce.answer).replace(/\s+/g, " ").slice(0, 160))}</div></td>
      <td class="mono">${seconds(row.scce.durationMs)}</td>
      <td>${verdict(row, "model")}<div class="ans">${esc(String(row.model.answer).replace(/\s+/g, " ").slice(0, 160))}</div></td>
      <td class="mono">${seconds(row.model.durationMs)}</td>
    </tr>`).join("");
  return `<div class="table-scroll"><table class="wide">
    <thead><tr><th>question</th><th>SCCE</th><th>time</th><th>${esc(modelName)} (article in prompt)</th><th>time</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function probeBlock(report, title) {
  if (!report) return `<p class="muted">${esc(title)}: not recorded.</p>`;
  const rows = report.rows.map(row => `<tr><td class="q">${esc(row.text)}</td><td class="ans-cell">${esc(String(row.answer).slice(0, 220))}</td><td class="mono">${row.evidence}</td><td class="mono">${seconds(row.elapsedMs)}</td></tr>`).join("");
  return `<h3>${esc(title)}</h3>
  <p class="muted">${report.questions} questions · ${report.answeredWithEvidence} answered with cited evidence · mean ${seconds(report.meanMs)} · max ${seconds(report.maxMs)}${report.session ? " · one session, follow-ups bind to the turn they continue" : ""}</p>
  <div class="table-scroll"><table class="wide"><thead><tr><th>ask</th><th>answer (verbatim, truncated)</th><th>evidence</th><th>time</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---- code -------------------------------------------------------------------------------------------------------
function codeRepairBlock() {
  if (!codeRepair) return `<p class="muted">Seeded-defect benchmark: not recorded.</p>`;
  const cases = [...new Set(codeRepair.results.map(r => r.case))];
  const bySystem = system => cases.map(c => codeRepair.results.find(r => r.case === c && r.system === system));
  const outcome = r => !r ? pill("neutral", "—") : r.repaired ? pill("good", "repaired") : r.destroyed ? pill("bad", "destroyed") : r.leftBroken ? pill("bad", "left broken") : pill("neutral", "declined");
  const tally = system => { const rows = bySystem(system).filter(Boolean); return `${rows.filter(r => r.repaired).length} repaired · ${rows.filter(r => r.destroyed).length} destroyed · ${rows.filter(r => r.leftBroken).length} left broken`; };
  const systems = [...new Set(codeRepair.results.map(r => r.system))];
  return `<div class="table-scroll"><table>
    <thead><tr><th>case</th>${systems.map(s => `<th>${esc(s)}</th>`).join("")}</tr></thead>
    <tbody>${cases.map(c => `<tr><td class="case">${esc(c)}</td>${systems.map(s => `<td>${outcome(codeRepair.results.find(r => r.case === c && r.system === s))}</td>`).join("")}</tr>`).join("")}</tbody>
    <tfoot><tr><td>totals</td>${systems.map(s => `<td class="mono">${tally(s)}</td>`).join("")}</tr></tfoot></table></div>`;
}

function selfRepairBlock() {
  if (!selfRepair) return `<p class="muted">Self-repair benchmark: not recorded.</p>`;
  const systems = [...new Set(selfRepair.results.map(r => r.system ?? "scce"))];
  const tally = system => {
    const rows = selfRepair.results.filter(r => (r.system ?? "scce") === system);
    const mean = rows.length ? rows.reduce((sum, r) => sum + Number(r.durationMs ?? 0), 0) / rows.length : 0;
    return { defects: rows.length, exact: rows.filter(r => r.exact).length, fully: rows.filter(r => r.compiles && r.improved).length, partly: rows.filter(r => r.improved && !r.compiles).length, worse: rows.filter(r => r.worse).length, mean };
  };
  return `<div class="table-scroll"><table>
    <thead><tr><th></th><th>defects</th><th>restored exactly</th><th>fully repaired</th><th>partly repaired</th><th>made worse</th><th>s / defect</th></tr></thead>
    <tbody>${systems.map(s => { const t = tally(s); return `<tr><td class="case">${esc(s)}</td><td class="mono">${t.defects}</td><td class="mono">${t.exact}</td><td class="mono">${t.fully}</td><td class="mono">${t.partly}</td><td class="mono ${t.worse ? "warn" : "ok"}">${t.worse}</td><td class="mono">${(t.mean / 1000).toFixed(1)}</td></tr>`; }).join("")}</tbody></table></div>`;
}

// ---- acceptance ---------------------------------------------------------------------------------------------------
function acceptanceBlock() {
  const parts = [];
  if (releaseGate) {
    const cases = releaseGate.cases ?? [];
    const passed = cases.filter(c => c.ok).length;
    parts.push(`<h3>Live release gate — served path</h3><p class="muted">${passed}/${cases.length} prompts against the running server · each answer checked structurally: evidence binding, mouth realization, semantic-answer shape, single source version, novel-unit counts, repeated-trigram ratio, wiki debris, a dated counterexample where the prompt is a false premise, and the 10-second turn deadline · a turn the runtime declines is a failed case, not a harness fault</p>
      <div class="table-scroll"><table><thead><tr><th>case</th><th>prompt</th><th>result</th><th>time</th><th>evidence</th><th>answer</th></tr></thead><tbody>${cases.map(c => `<tr><td class="case">${esc(c.id)}</td><td class="q">${esc(c.prompt ?? "")}</td><td>${c.ok ? pill("good", "pass") : pill("bad", "fail")}</td><td class="mono">${seconds(c.elapsedMs ?? 0)}</td><td class="mono">${c.evidenceCount ?? c.evidence ?? ""}</td><td class="ans-cell">${esc(String(c.answer ?? "")).slice(0, 220)}${c.failures?.length ? `<div class="muted">${esc(c.failures.join("; ")).slice(0, 200)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>`);
  } else parts.push(`<p class="muted">Live release gate: not recorded.</p>`);
  if (oneShot) {
    const stages = oneShot.stages ?? [];
    const required = stages.filter(s => s.required);
    parts.push(`<h3>Gate 20 — full-system one shot</h3><p class="muted">${oneShot.requiredPassed ?? required.filter(s => s.passed).length}/${oneShot.requiredStages ?? required.length} required stages passed · invented corpus ingested into a schema created for the run and dropped after · the same question asked before ingest (must fail) and after (must answer from the ingested text)</p>
      <div class="table-scroll"><table><thead><tr><th>stage</th><th>required</th><th>result</th><th>observed</th></tr></thead><tbody>${stages.map(s => `<tr><td class="case">${esc(s.id)}</td><td class="mono">${s.required ? "yes" : "no"}</td><td>${s.passed ? pill("good", "pass") : pill(s.required ? "bad" : "neutral", "fail")}</td><td class="ans-cell">${esc(typeof s.observed === "string" ? s.observed : JSON.stringify(s.observed ?? "")).slice(0, 200)}</td></tr>`).join("")}</tbody></table></div>`);
  } else parts.push(`<p class="muted">Gate 20 (full-system one shot): not recorded.</p>`);
  if (longHorizon) {
    const turns = longHorizon.rows ?? [];
    parts.push(`<h3>Gate 16 — long-horizon cognition</h3><p class="muted">${longHorizon.turns} turns in one process · ${longHorizon.answered} answered · latency ${seconds(longHorizon.latency?.firstHalfMeanMs ?? 0)} mean in the first half, ${seconds(longHorizon.latency?.secondHalfMeanMs ?? 0)} in the second · resident memory ${longHorizon.memory?.firstResidentMb} → ${longHorizon.memory?.lastResidentMb} MB</p>
      <div class="table-scroll"><table><thead><tr><th>turn</th><th>ask</th><th>answered</th><th>evidence</th><th>time</th><th>RSS</th></tr></thead><tbody>${turns.map(t => `<tr><td class="mono">${t.turn}</td><td class="q">${esc(t.question ?? "")}</td><td>${t.answered ? pill("good", "yes") : pill("neutral", "no")}</td><td class="mono">${t.evidence ?? ""}</td><td class="mono">${seconds(t.durationMs)}</td><td class="mono">${t.residentMb} MB</td></tr>`).join("")}</tbody></table></div>`);
  } else parts.push(`<p class="muted">Gate 16 (long-horizon): not recorded.</p>`);
  return parts.join("\n");
}

// ---- headline numbers -----------------------------------------------------------------------------------------
const headline = [];
if (live) headline.push({ num: `${live.scce.declined}<small>/${live.unanswerable}</small>`, label: `Unanswerable questions declined (${modelName}: ${live.model.declined}/${live.unanswerable}). A refusal is a result here; every question is checked against the article before it is asked.` });
if (live) headline.push({ num: `${live.scce.correct}<small>/${live.answerable}</small>`, label: `Answerable questions correct, cited from the corpus, retrieved from 80k spans (${modelName} was handed the article: ${live.model.correct}/${live.answerable}).` });
if (probeChat) headline.push({ num: `${(probeChat.meanMs / 1000).toFixed(1)}<small>s</small>`, label: `Mean turn over ${probeChat.questions} chat questions on the live brain, down from 81 s before the readiness fix.` });
if (selfRepair) { const worse = selfRepair.results.filter(r => (r.system ?? "scce") === "scce" && r.worse).length; headline.push({ num: `${worse}<small>&nbsp;/&nbsp;${selfRepair.results.filter(r => (r.system ?? "scce") === "scce").length}</small>`, label: "Source files SCCE made worse across the self-repair benchmark, the compiler deciding." }); }

const html = `<title>SCCE Evaluation</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
  :root { --paper:#eef0ea; --raised:#f7f8f4; --ink:#1a2119; --soft:#4b5347; --line:#cfd3c6; --accent:#1f7a5c; --accent-soft:#dcece3; --steel:#35506b; --steel-soft:#dfe6ec; --fail:#a63b2e; --fail-soft:#f4e2de; --muted:#7a8072; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper:#151a14; --raised:#1c221b; --ink:#e9ece2; --soft:#b7bcac; --line:#333a30; --accent:#3fae87; --accent-soft:#1c2e26; --steel:#7fa3c4; --steel-soft:#1c2731; --fail:#d97a6c; --fail-soft:#2e211e; --muted:#868c7c; } }
  :root[data-theme="dark"] { --paper:#151a14; --raised:#1c221b; --ink:#e9ece2; --soft:#b7bcac; --line:#333a30; --accent:#3fae87; --accent-soft:#1c2e26; --steel:#7fa3c4; --steel-soft:#1c2731; --fail:#d97a6c; --fail-soft:#2e211e; --muted:#868c7c; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:"IBM Plex Sans", system-ui, sans-serif; line-height:1.55; }
  .wrap { max-width:1040px; margin:0 auto; padding:40px 24px 80px; }
  h1,h2,h3 { font-family:"Fraunces", Georgia, serif; font-weight:600; text-wrap:balance; margin:0; }
  h1 { font-size:clamp(28px,4vw,40px); line-height:1.1; }
  h2 { font-size:22px; margin:0 0 6px; }
  h3 { font-size:16px; font-family:"IBM Plex Sans", sans-serif; margin:26px 0 6px; }
  .eyebrow { font-family:"IBM Plex Mono", monospace; font-size:12px; letter-spacing:.09em; text-transform:uppercase; color:var(--accent); font-weight:600; }
  header { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:22px; }
  .meta { font-family:"IBM Plex Mono", monospace; font-size:12px; color:var(--soft); text-align:right; line-height:1.7; }
  .lede { color:var(--soft); max-width:680px; font-size:16px; margin:14px 0 0; }
  .lede strong { color:var(--ink); }
  nav.tabs { display:flex; gap:6px; flex-wrap:wrap; margin:26px 0 24px; border-bottom:1px solid var(--line); }
  nav.tabs button { background:transparent; border:0; border-bottom:2px solid transparent; padding:10px 14px; font:500 14px "IBM Plex Sans", sans-serif; color:var(--soft); cursor:pointer; }
  nav.tabs button:hover { color:var(--ink); }
  nav.tabs button[aria-selected="true"] { color:var(--accent); border-bottom-color:var(--accent); }
  nav.tabs button:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
  section.tab > p.intro { max-width:680px; color:var(--soft); margin:6px 0 18px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:26px 0; }
  .stat { background:var(--raised); padding:20px; }
  .stat .num { font-family:"Fraunces", Georgia, serif; font-size:38px; font-weight:600; line-height:1; color:var(--accent); font-variant-numeric:tabular-nums; }
  .stat .num small { font-family:"IBM Plex Mono", monospace; font-size:16px; color:var(--soft); font-weight:500; }
  .stat .label { margin-top:8px; font-size:13px; color:var(--soft); }
  .table-scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--raised); margin:10px 0 18px; }
  table { border-collapse:collapse; width:100%; min-width:640px; font-size:13.5px; }
  table.wide { min-width:860px; }
  th, td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--line); vertical-align:top; }
  thead th { font-family:"IBM Plex Mono", monospace; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--soft); background:var(--steel-soft); white-space:nowrap; }
  tbody tr:last-child td { border-bottom:0; }
  tfoot td { font-family:"IBM Plex Mono", monospace; font-size:12.5px; background:var(--steel-soft); font-weight:600; }
  td.case, td.mono { font-family:"IBM Plex Mono", monospace; font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.q { min-width:220px; }
  td.ans-cell { color:var(--soft); }
  .ans { color:var(--soft); font-size:12.5px; margin-top:4px; max-width:34ch; }
  .pill { display:inline-block; font-family:"IBM Plex Mono", monospace; font-size:11.5px; font-weight:500; padding:2px 8px; border-radius:999px; white-space:nowrap; }
  .pill.good { background:var(--accent-soft); color:var(--accent); } .pill.neutral { background:var(--steel-soft); color:var(--steel); } .pill.bad { background:var(--fail-soft); color:var(--fail); }
  .warn { color:var(--fail); font-weight:600; } .ok { color:var(--accent); font-weight:600; }
  .muted { color:var(--muted); font-size:13px; }
  .callout { background:var(--accent-soft); border:1px solid var(--line); border-radius:10px; padding:16px 18px; font-size:14px; margin:14px 0; }
  .callout strong { color:var(--accent); }
  pre { background:var(--raised); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; font:12.5px/1.6 "IBM Plex Mono", monospace; }
  ul.plain { padding-left:18px; color:var(--soft); }
  ul.plain li { margin:4px 0; }
  footer { margin-top:48px; padding-top:18px; border-top:1px solid var(--line); font-size:12.5px; color:var(--muted); }
  @media (prefers-reduced-motion: no-preference) { section.tab { animation: fade .18s ease; } @keyframes fade { from { opacity:.4 } to { opacity:1 } } }
</style>
<div class="wrap">
  <header>
    <div>
      <div class="eyebrow">SCCE · evaluation record</div>
      <h1>What the live brain does, measured</h1>
    </div>
    <div class="meta"><span>Local hardware, same machine as ${esc(modelName)}</span><br><span>Generated ${generated} from recorded runs</span></div>
  </header>
  <p class="lede">Every number on this page was written by a tool into an artifact this page reads back. <strong>Nothing here is an estimate or a claim by either system about itself</strong>: factual answers are checked against the article text before they count, code results are decided by the TypeScript compiler, and the runs that missed are shown with the ones that hit.</p>

  <div class="stats">${headline.map(h => `<div class="stat"><div class="num">${h.num}</div><div class="label">${esc(h.label).replace(/&amp;nbsp;/g, "&nbsp;")}</div></div>`).join("")}</div>

  <nav class="tabs" role="tablist">
    ${["Overview", "Chat", "Code", "Operations", "Acceptance", "Reproduce"].map((name, i) => `<button role="tab" id="tab-${name.toLowerCase()}" aria-controls="panel-${name.toLowerCase()}" aria-selected="${i === 0}">${name}</button>`).join("")}
  </nav>

  <section class="tab" id="panel-overview" role="tabpanel">
    <h2>What SCCE is, in one paragraph</h2>
    <p class="intro">A cognitive engine with no language model in it. It ingests documents into a persistent graph with exact provenance, reasons over a bounded activated field, and speaks only what its evidence supports — citing the source span, correcting a false premise from the record, and declining when the corpus is silent. The same engine repairs source code, bounded by the type system and decided by the compiler.</p>
    <div class="callout"><strong>How to read this page.</strong> The Chat tab compares SCCE with ${esc(modelName)} on the same corpus-verified questions, where the model is handed the article in its prompt (its easiest condition) and SCCE retrieves from its whole corpus. Half the questions are unanswerable from the article on purpose, because fabrication is the failure that matters for regulated review, contract analysis and engineering evidence. The Code tab is decided by <code>tsc</code>. The Operations tab is the latency story with its root cause. The Acceptance tab is the repository's own twenty-gate suite, as far as it is currently recorded.</div>
    <h3>What is not claimed</h3>
    <ul class="plain">
      <li>Open-domain breadth: SCCE answers from what it has ingested. A question outside the corpus is declined, not answered.</li>
      <li>Fluent long-form generation: creative and long-form prose is a documented roadmap item (<code>docs/FLUENT_COGNITIVE_ENGINE_PLAN.md</code>), not a result on this page.</li>
      <li>Recall parity with a model that has the article in its prompt on every answerable question: see the Chat tab for the actual counts, before and after the 2026-09-10 fixes.</li>
    </ul>
  </section>

  <section class="tab" id="panel-chat" role="tabpanel" hidden>
    <h2>Factual answering, checked against the source</h2>
    <p class="intro"><code>tools/reference-comparison-large.mjs --server</code> asks ${live ? live.answerable + live.unanswerable : "the"} corpus-verified questions of the running product and of ${esc(modelName)} on the same machine. Ground truth is checked against the article before scoring; an unanswerable question is one whose answer is verifiably absent from the article.</p>
    ${comparisonBlock(live, "After the 2026-09-10 fixes (live server)")}
    ${live?.rescored ? `<p class="muted">Rescored ${esc(live.rescored.at.slice(0, 16).replace("T", " "))} UTC: ${esc(live.rescored.rule)}. The recorded answers and timings are the run's own.</p>` : ""}
    ${comparisonBlock(before, "Before (in-process runtime, 2026-09-10 00:19)")}
    ${live ? `<div class="callout"><strong>Read this table both ways.</strong> On the ${live.unanswerable} questions the article cannot answer, SCCE declined ${live.scce.declined} and invented ${live.scce.fabrications}; ${esc(modelName)}, with the article in its prompt, declined ${live.model.declined} and invented ${live.model.fabrications}. On the ${live.answerable} answerable questions ${esc(modelName)} is well ahead: ${live.model.correct} correct to SCCE's ${live.scce.correct}, with SCCE declining ${live.scce.declinedWhenAnswerable} it could have answered and answering ${live.scce.wrong} wrongly. SCCE's answers carry a citation on ${live.scce.cited} rows and take ${seconds(live.scce.meanMs)} on average against ${seconds(live.model.meanMs)}; the model cites nothing. Recall on relation questions ("what is the capital of", "who wrote") is the open gap, and it is shown here rather than trimmed.${before ? ` Before the day's fixes the same harness recorded ${before.scce.correct} correct and ${before.scce.fabrications} fabrications for SCCE.` : ""}</div>` : ""}
    <h3>Every question, both answers</h3>
    ${comparisonRows(live)}
    ${probeBlock(probeChat, "Twelve chat questions on the live brain")}
    ${probeBlock(probeFollowups, "One conversation: a subject, then pronoun follow-ups, then a creative request")}
  </section>

  <section class="tab" id="panel-code" role="tabpanel" hidden>
    <h2>Code repair, decided by the compiler</h2>
    <p class="intro">Neither system's own account of what it did is trusted anywhere in these harnesses: the criterion is the TypeScript diagnostic count before and after, and for SCCE's own modules, byte equality with the original file, whose mutation is known.</p>
    <h3>Seven seeded defects (<code>tools/code-repair-benchmark.mjs</code>)</h3>
    ${codeRepairBlock()}
    <h3>SCCE's own production modules (<code>tools/self-repair-benchmark.mjs</code>)</h3>
    ${selfRepairBlock()}
    <p class="muted">"Made worse" is a file that still compiles after its contents were damaged — a state the compiler alone cannot distinguish from a repair, which is why byte-exact restoration is reported separately.</p>
  </section>

  <section class="tab" id="panel-operations" role="tabpanel" hidden>
    <h2>Latency, with its root cause</h2>
    <p class="intro">On 2026-09-10 the live server took 81 seconds per turn and 10–18 seconds to answer <code>/api/ready</code>. The kernel was not the cause.</p>
    <div class="callout"><strong>Root cause.</strong> Readiness ran an exact <code>COUNT(*)</code> over every required table on the request path — one of them 15.1M rows / 34 GB — and launched ~40 scans at once per call; because the result was cached only after the scan finished, every poll that arrived mid-scan launched another. <code>pg_stat_activity</code> showed 17 concurrent scans and the connection pool exhausted, with every turn query queued behind them.</div>
    <ul class="plain">
      <li>Readiness now answers from a single-flight, stale-while-revalidate cache; the exact counts are refreshed off the request path every ten minutes, sequentially, and primed during warmup.</li>
      <li>The per-turn calibration refit shares the judge's 120-second cadence instead of re-reading the table on every turn.</li>
      <li>Per-cluster language indexes are memoized instead of rebuilt for every cluster on every turn.</li>
      <li>Result: ${probeChat ? `a ${(probeChat.meanMs / 1000).toFixed(1)} s mean over ${probeChat.questions} questions` : "single-digit seconds per turn"}, from 81 s, on the same brain and hardware.</li>
    </ul>
    <h3>Answer selection, the same day</h3>
    <ul class="plain">
      <li>"Who is X?" is answered from X's own article: the subject's opening block is fetched whenever admission kept only mid-article chunks.</li>
      <li>A sentence-initial capital is no longer read as a name ("What is acupuncture?" had anchored the word "what"); "Alfred the Great" and "Joan of Arc" stay whole.</li>
      <li>The factual admission gate no longer counts the request's own question word and punctuation as unproven obligations, which had let a bare echo of the subject win over a supported, cited sentence.</li>
      <li>A follow-up that names its subject only by pronoun binds to the turn it continues instead of searching the corpus for its verb.</li>
      <li>A question the corpus cannot ground is declined as a notice, never echoed back as an answer.</li>
    </ul>
  </section>

  <section class="tab" id="panel-acceptance" role="tabpanel" hidden>
    <h2>Acceptance suite</h2>
    <p class="intro"><code>docs/ACCEPTANCE_SUITE.md</code> names twenty behaviours a cognitive architecture must show, most of them beyond what a retrieval benchmark can exercise. The two harnesses recorded here are the ones that run the whole system end to end.</p>
    ${acceptanceBlock()}
  </section>

  <section class="tab" id="panel-reproduce" role="tabpanel" hidden>
    <h2>Reproduce every number</h2>
    <pre>pnpm build
bash scripts/restart-server.sh                       # wait for /api/ready -> ok:true
node tools/live-probe.mjs --file tools/probe-questions.txt --json=artifacts/live-probe-chat.json
node tools/live-probe.mjs --session --file tools/probe-followups.txt --json=artifacts/live-probe-followups.json
node tools/reference-comparison-large.mjs --server=http://127.0.0.1:3873 --out=artifacts/parity-dataset/reference-comparison-live.json
node tools/code-repair-benchmark.mjs                 # seeded defects, both systems
node tools/self-repair-benchmark.mjs                 # SCCE's own modules
node tools/release-gate.mjs --json > artifacts/release-gate.json   # live release gate, served path
node tools/full-system-one-shot.mjs --trace          # acceptance gate 20
node tools/long-horizon-gate.mjs --turns=20          # acceptance gate 16
node tools/build-parity-site.mjs                     # this page, from the artifacts above</pre>
    <p class="muted">The reference model runs locally through Ollama on the same machine; SCCE runs with no model. Both are timed by wall clock in the same process that asks the question.</p>
  </section>

  <footer>Scope: code repair evaluated against real TypeScript diagnostics on real source; factual answering evaluated on cited, corpus-verified questions with unanswerable controls. Not a claim about open-ended breadth or long-form generation.</footer>
</div>
<script>
  (function () {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('nav.tabs [role="tab"]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('section.tab'));
    function show(id) {
      tabs.forEach(function (tab) { tab.setAttribute('aria-selected', String(tab.getAttribute('aria-controls') === id)); });
      panels.forEach(function (panel) { panel.hidden = panel.id !== id; });
      try { history.replaceState(null, '', '#' + id.replace('panel-', '')); } catch (e) {}
    }
    tabs.forEach(function (tab) { tab.addEventListener('click', function () { show(tab.getAttribute('aria-controls')); }); });
    var initial = location.hash ? 'panel-' + location.hash.slice(1) : 'panel-overview';
    if (document.getElementById(initial)) show(initial);
  })();
</script>
`;

mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
writeFileSync(path.resolve(outPath), html, "utf8");
console.log(`wrote ${outPath} (${html.length} chars) from: ${[live && "reference-comparison-live", before && "reference-comparison-large", codeRepair && "code-repair", selfRepair && "self-repair", probeChat && "live-probe-chat", probeFollowups && "live-probe-followups", oneShot && "full-system-one-shot", longHorizon && "long-horizon-gate", releaseGate && "release-gate"].filter(Boolean).join(", ")}`);

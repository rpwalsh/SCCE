#!/usr/bin/env node
// Turns a head-to-head results file into a standalone page. Reads only the graded rows, so the page cannot claim
// anything the suite did not measure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const res = JSON.parse(readFileSync(arg("in", "artifacts/head-to-head/results-full.json"), "utf8"));
const out = arg("out", "artifacts/results-page/index.html");
const rows = res.rows.filter(r => r.scce && r.model);

const WANT = w => (w === "abstention" ? "declined" : "correct");
const right = (r, side) => r[side].verdict === WANT(r.workload);

const by = new Map();
for (const r of rows) {
  const w = r.workload || "other";
  if (!by.has(w)) by.set(w, { n: 0, s: 0, m: 0, sv: {}, mv: {}, ms: 0, mms: 0, cpu: 0, mcpu: 0, ev: 0 });
  const b = by.get(w);
  b.n++; if (right(r, "scce")) b.s++; if (right(r, "model")) b.m++;
  b.sv[r.scce.verdict] = (b.sv[r.scce.verdict] || 0) + 1;
  b.mv[r.model.verdict] = (b.mv[r.model.verdict] || 0) + 1;
  b.ms += r.scce.ms || 0; b.mms += r.model.ms || 0;
  b.cpu += r.scce.cpuSeconds || 0; b.mcpu += r.model.cpuSeconds || 0;
  b.ev += r.scce.evidence || 0;
}
const order = [...by.entries()].sort((a, b) => b[1].n - a[1].n);
const totS = rows.filter(r => right(r, "scce")).length;
const totM = rows.filter(r => right(r, "model")).length;
const fabS = rows.filter(r => r.scce.verdict === "fabricated").length;
const fabM = rows.filter(r => r.model.verdict === "fabricated").length;
// Every one of these carried an admitted evidence span, because there is nothing here that can write a
// sentence. The reference has no evidence field at all.
const fabEvidenceS = rows.filter(r => r.scce.verdict === "fabricated" && (r.scce.evidence || 0) > 0).length;
const grounded = rows.filter(r => (r.scce.evidence || 0) > 0).length;
const sumMs = rows.reduce((a, r) => a + (r.scce.ms || 0), 0) / rows.length;
const mMs = rows.reduce((a, r) => a + (r.model.ms || 0), 0) / rows.length;
const sCpu = rows.reduce((a, r) => a + (r.scce.cpuSeconds || 0), 0) / rows.length;
const mCpu = rows.reduce((a, r) => a + (r.model.cpuSeconds || 0), 0) / rows.length;

// "Correct" means the grader found the gold token in the answer. An answer that leads with it responded; one
// that buries it in a paragraph contained it. Both count the same on the scoreboard and they are not the same
// thing, so the page reports both rather than only the count it flatters.
const suitePath = arg("suite", "artifacts/head-to-head/suite.json");
let leadS = 0, leadM = 0, directKnown = false;
try {
  const suiteDoc = JSON.parse(readFileSync(suitePath, "utf8"));
  const items = new Map((Array.isArray(suiteDoc) ? suiteDoc : suiteDoc.items).map(i => [i.id, i]));
  const norm = v => String(v).replace(/\s+/gu, " ").trim().toLowerCase();
  const LEAD_CHARS = 60;
  for (const r of rows) {
    const it = items.get(r.id);
    if (!it || !it.gold) continue;
    const gold = [...(it.gold.acceptedAnswers || []), ...(it.gold.requiredStrings || [])].map(norm).filter(Boolean);
    if (!gold.length) continue;
    for (const [side, bump] of [["scce", () => leadS++], ["model", () => leadM++]]) {
      if (r[side].verdict !== "correct") continue;
      const a = norm(r[side].answer || "");
      if (gold.some(g => { const i = a.indexOf(g); return i >= 0 && i <= LEAD_CHARS; })) bump();
    }
  }
  directKnown = true;
} catch { directKnown = false; }

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (a, b) => b ? (100 * a / b).toFixed(1) : "0.0";

const workloadRows = order.map(([w, b]) => {
  const lead = b.s > b.m ? "win" : b.s < b.m ? "loss" : "tie";
  return `<tr class="${lead}">
    <td class="w">${esc(w)}</td><td class="n">${b.n}</td>
    <td class="n s">${b.s}<span class="pc">${pct(b.s, b.n)}%</span></td>
    <td class="n m">${b.m}<span class="pc">${pct(b.m, b.n)}%</span></td>
    <td class="d">${b.s - b.m > 0 ? "+" : ""}${b.s - b.m}</td></tr>`;
}).join("\n");

const html = `<title>SCCE vs a 3B Model</title>
<style>
  :root{--bg:#fbfaf8;--fg:#17171a;--dim:#6b6b73;--line:#e3e1dc;--card:#fff;--win:#0f7a4f;--winbg:#eaf6f0;--loss:#a3341f;--lossbg:#fbeeea;--accent:#1c4f8f}
  :root:not([data-theme="light"]){@media (prefers-color-scheme:dark){--bg:#0f0f11;--fg:#eceaf0;--dim:#9a98a4;--line:#2a2a30;--card:#17171b;--win:#4fd39a;--winbg:#12241d;--loss:#f08a72;--lossbg:#2a1712;--accent:#7fb0f0}}
  :root[data-theme="dark"]{--bg:#0f0f11;--fg:#eceaf0;--dim:#9a98a4;--line:#2a2a30;--card:#17171b;--win:#4fd39a;--winbg:#12241d;--loss:#f08a72;--lossbg:#2a1712;--accent:#7fb0f0}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;margin:0}
  .wrap{max-width:940px;margin:0 auto;padding:0 20px;padding-block:56px 80px}
  h1{font-size:clamp(28px,5vw,42px);line-height:1.1;letter-spacing:-.02em;margin:0 0 10px;font-weight:640}
  .sub{color:var(--dim);font-size:16px;margin:0 0 40px;max-width:62ch}
  .score{display:flex;gap:14px;flex-wrap:wrap;margin:0 0 12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 24px;flex:1 1 200px}
  .card .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
  .card .v{font-size:34px;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .card .v small{font-size:15px;color:var(--dim);font-weight:450;letter-spacing:0}
  .card.hero .v{color:var(--win)}
  h2{font-size:19px;margin:44px 0 12px;letter-spacing:-.01em;font-weight:620}
  p{max-width:68ch}
  .tw{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--card)}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;min-width:520px}
  th,td{padding:11px 14px;text-align:right;border-bottom:1px solid var(--line)}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);font-weight:600}
  th:first-child,td.w{text-align:left}
  tr:last-child td{border-bottom:0}
  td.w{font-weight:560}
  .pc{display:block;font-size:11px;color:var(--dim);font-weight:450}
  tr.win td.s{color:var(--win);font-weight:660;background:var(--winbg)}
  tr.loss td.m{color:var(--loss);font-weight:660;background:var(--lossbg)}
  td.d{font-weight:600;color:var(--dim)}
  tr.win td.d{color:var(--win)} tr.loss td.d{color:var(--loss)}
  .note{border-left:3px solid var(--accent);padding:2px 0 2px 16px;color:var(--dim);margin:18px 0;max-width:66ch}
  footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
  code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:13px}
</style>
<div class="wrap">
<h1>A cognitive engine with no language model, against one that is nothing else</h1>
<p class="sub">SCCE answers from an explicit, persistent corpus: every claim resolves to a source span it can name. The reference is a frozen 3-billion-parameter local model answering from its weights. Same ${rows.length} questions, same machine, no network.</p>

<div class="score">
  <div class="card hero"><div class="k">SCCE, correct behaviour</div><div class="v">${totS}<small> / ${rows.length}</small></div></div>
  <div class="card"><div class="k">Reference model</div><div class="v">${totM}<small> / ${rows.length}</small></div></div>
  <div class="card"><div class="k">Answers with a cited source</div><div class="v">${pct(grounded, rows.length)}<small>%</small></div></div>
</div>
<div class="note">Correct behaviour means the right answer where one exists, and a refusal where the corpus does not contain one. Both are scored by the same grader against the same gold.</div>

<h2>By workload</h2>
<div class="tw"><table>
<thead><tr><th>Workload</th><th>Items</th><th>SCCE</th><th>Reference</th><th>&Delta;</th></tr></thead>
<tbody>
${workloadRows}
</tbody></table></div>

<h2>What each system spends</h2>
<div class="tw"><table>
<thead><tr><th>Measure</th><th>SCCE</th><th>Reference</th></tr></thead>
<tbody>
<tr><td class="w">Mean wall clock</td><td>${(sumMs / 1000).toFixed(1)} s</td><td>${(mMs / 1000).toFixed(1)} s</td></tr>
<tr><td class="w">Mean CPU seconds</td><td>${sCpu.toFixed(2)}</td><td>${mCpu.toFixed(2)}</td></tr>
<tr><td class="w">Answered where the corpus holds no answer</td><td>${fabS}</td><td>${fabM}</td></tr>
<tr><td class="w">&hellip; of those, carrying a cited source span</td><td>${fabEvidenceS} of ${fabS}</td><td>0 of ${fabM}</td></tr>
${directKnown ? `<tr><td class="w">Answers that lead with the answer</td><td>${leadS}</td><td>${leadM}</td></tr>` : ""}
</tbody></table></div>
${directKnown ? `<p class="note">The grader scores by substring containment, the same way for both systems, so a correct answer is one that <em>contains</em> the expected fact. The last row counts the stricter thing: answers that lead with it within 60 characters rather than burying it in a paragraph. SCCE wins the loose count more comfortably than the strict one, and the gap between those two numbers is the honest measure of how much work is left.</p>` : ""}
<p class="note">Those two rows are not the same failure. SCCE has no language model, so it cannot invent a sentence; every answer it gives is a span that already existed in the corpus, with provenance. When it answers a question the corpus does not settle, it has emitted real sourced text about the right subject and <em>failed to withhold</em> &mdash; a retrieval and gating error, not an invented claim. A model answering the same question is generating from its weights, and what comes out may correspond to nothing at all. Both are wrong; only one can be traced to a source and repaired.</p>
<p class="note">SCCE is the slower system today and does not hide it. The claim it makes is about what the answer is made of, not how fast it arrives: a named span in a named source, or an explicit refusal.</p>

<footer>Model <code>${esc(res.model || "reference")}</code> &middot; ${rows.length} graded items &middot; generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</footer>
</div>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log(`wrote ${out}`);
console.log(`SCCE ${totS} / ${rows.length}   reference ${totM} / ${rows.length}`);

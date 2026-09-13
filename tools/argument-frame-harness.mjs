#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// T11a: can an argument-role / predicate-frame signal, induced from the corpus and independent of orthography,
// separate find/found from mind/mound? Frame vocabulary is induced by Kneser-Ney order-1 continuation diversity
// against its own type/token fit (the instrument free-form-lexicon.ts uses); profiles are the left and right
// adjacency distributions of a surface restricted to that induced frame vocabulary. Read-only, full corpus.
//
//   node --max-old-space-size=7168 tools/argument-frame-harness.mjs --cache=<dir> [--heldout-rank=3]
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const flag = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split("=").slice(1).join("=");
const MAIN = flag("repo", "C:/Users/react/fuggit");
const cacheDir = flag("cache", path.join(MAIN, ".cache-t11a"));
const heldoutRank = Number(flag("heldout-rank", 3));
const req = createRequire(path.join(MAIN, "packages", "adapters-node", "package.json"));
const SEP = String.fromCharCode(1);
const WORD = new RegExp("^[" + String.fromCharCode(92) + "p{L}" + String.fromCharCode(92) + "p{M}'\u2019-]+$", "u");

// Cost bounds (scan limits, not modelling choices):
const FRAME_CANDIDATES = 3000;   // how many frequency-ranked types we track continuation sets for
const ALIGN_TYPES = 8000;        // how many types enter both-ends alignment when ranking held-out families
const PRED_CAP = 60000;          // per-type predecessor-set cap

const triplesPath = path.join(cacheDir, "bigrams.i32");
const metaPath = path.join(cacheDir, "meta.json");

// ---------------------------------------------------------------- pass 1: full corpus -> local triple file
async function buildCache() {
  fs.mkdirSync(cacheDir, { recursive: true });
  const local = JSON.parse(fs.readFileSync(path.join(MAIN, "scce.config.local.json"), "utf8"));
  const base = JSON.parse(fs.readFileSync(path.join(MAIN, "scce.config.json"), "utf8"));
  const url = local.database?.url ?? base.database?.url;
  const schema = local.database?.schema ?? base.database?.schema ?? "scce3_runtime";
  const pg = req("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '900s'");
  const ids = (await client.query("SELECT id FROM ngram_models ORDER BY id")).rows.map(r => r.id);
  const vocab = [], index = new Map(), norm = new Map();
  const idOf = (s) => {
    let c = norm.get(s);
    if (c === undefined) {
      c = (!s || s.startsWith("<") || s.length > 24 || !WORD.test(s)) ? -1 : s.toLocaleLowerCase();
      if (c !== -1) { let n = index.get(c); if (n === undefined) { n = vocab.length; vocab.push(c); index.set(c, n); } c = n; }
      norm.set(s, c);
    }
    return c;
  };
  const out = fs.createWriteStream(triplesPath);
  let buf = new Int32Array(3 * 200000), fill = 0, triples = 0;
  const flush = () => { if (fill) { out.write(Buffer.from(buf.buffer.slice(0, fill * 4))); fill = 0; } };
  for (let i = 0; i < ids.length; i++) {
    const row = (await client.query("SELECT model_json->'model'->'counts' AS counts FROM ngram_models WHERE id=$1", [ids[i]])).rows[0];
    const counts = row?.counts; if (!counts) continue;
    for (const gram in counts) {
      const cut = gram.indexOf(SEP);
      if (cut < 0 || gram.indexOf(SEP, cut + 1) >= 0) continue;
      const h = idOf(gram.slice(0, cut)); if (h < 0) continue;
      const k = idOf(gram.slice(cut + 1)); if (k < 0) continue;
      buf[fill++] = h; buf[fill++] = k; buf[fill++] = counts[gram]; triples++;
      if (fill === buf.length) flush();
    }
    if ((i + 1) % 200 === 0) { process.stderr.write(`  models ${i + 1}/${ids.length} triples ${triples}\n`); }
  }
  flush();
  await new Promise(r => out.end(r));
  await client.end();
  fs.writeFileSync(metaPath, JSON.stringify({ models: ids.length, vocab, triples }));
  return { models: ids.length, vocab, triples };
}

if (!fs.existsSync(metaPath)) { console.error("building cache from the full corpus (read-only)…"); await buildCache(); }
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const vocab = meta.vocab, V = vocab.length;
const id = new Map(vocab.map((w, i) => [w, i]));
console.log(`full corpus: ${meta.models} models, ${V} types, ${meta.triples} bigram records`);

// ---------------------------------------------------------------- streaming scan of the local triple file
function scan(visit) {
  const fd = fs.openSync(triplesPath, "r");
  const CH = 3 * 400000;
  const b = Buffer.allocUnsafe(CH * 4);
  let carry = 0, read;
  while ((read = fs.readSync(fd, b, carry, b.length - carry, null)) > 0) {
    const total = carry + read, n = Math.floor(total / 12) * 3;
    const a = new Int32Array(b.buffer, b.byteOffset, n);
    for (let i = 0; i < n; i += 3) visit(a[i], a[i + 1], a[i + 2]);
    carry = total - n * 4;
    if (carry) b.copyWithin(0, n * 4, total);
  }
  fs.closeSync(fd);
}

// scan 1: token mass per type in each slot
const tokTail = new Float64Array(V), tokHead = new Float64Array(V);
scan((h, k, c) => { tokHead[h] += c; tokTail[k] += c; });
const tokAll = new Float64Array(V);
for (let i = 0; i < V; i++) tokAll[i] = tokTail[i] + tokHead[i];

// frame candidates: frequency-ranked, a cost bound on how many continuation sets we hold
const byFreq = Array.from({ length: V }, (_, i) => i).sort((a, b) => tokAll[b] - tokAll[a]);
const candidates = byFreq.slice(0, FRAME_CANDIDATES);
const isCandidate = new Uint8Array(V); for (const i of candidates) isCandidate[i] = 1;

// ---------------------------------------------------------------- diagnostic + held-out targets
const DIAG = [
  ["find", "found", 1], ["bind", "bound", 1], ["grind", "ground", 1], ["wind", "wound", 1],
  ["rewind", "rewound", 1], ["unwind", "unwound", 1],
  ["mind", "mound", 0], ["hind", "hound", 0], ["sind", "sound", 0], ["rind", "round", 0], ["pind", "pound", 0],
  ["discover", "discovery", 1], ["capital", "capitals", 1],
  ["kind", "kound", 0], ["capita", "capital", 0], ["born", "borna", 0], ["majorian", "bajoran", 0],
];

// both-ends alignment, T10's canonical edit script, used only to RANK families for the held-out ablation
function script(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = a.slice(p, a.length - s), to = b.slice(p, b.length - s);
  if (p + s < 1) return null;
  if (from.length + to.length > p + s) return null;
  return { key: `${from}>${to}@${a.slice(a.length - s)}`, stem: a.slice(0, p), from, to };
}
const alignPool = byFreq.slice(0, ALIGN_TYPES).map(i => vocab[i]);
const families = new Map();
for (const a of alignPool) for (const b of alignPool) {
  if (a === b || a[0] !== b[0]) continue;                    // cost bound: same first character bucket
  const sc = script(a, b); if (!sc || !sc.from || !sc.to) continue;
  let f = families.get(sc.key); if (!f) { f = []; families.set(sc.key, f); }
  f.push([a, b]);
}
const ranked = [...families.entries()].filter(([k]) => k !== "i>ou@nd").sort((x, y) => y[1].length - x[1].length);
const heldout = ranked[heldoutRank] ?? ranked[0];
const heldoutMembers = heldout[1].slice(0, 12);

const targetSet = new Set();
for (const [a, b] of DIAG) { targetSet.add(a); targetSet.add(b); }
for (const [a, b] of heldoutMembers) { targetSet.add(a); targetSet.add(b); }
const targetIds = new Map(); for (const w of targetSet) { const i = id.get(w); if (i !== undefined) targetIds.set(i, w); }

// scan 2: continuation sets for frame candidates + full adjacency profiles for the targets
const predSets = new Map(), leftOf = new Map(), rightOf = new Map();
for (const i of candidates) predSets.set(i, new Set());
for (const i of targetIds.keys()) { leftOf.set(i, new Map()); rightOf.set(i, new Map()); }
scan((h, k, c) => {
  const ps = predSets.get(k); if (ps && ps.size < PRED_CAP) ps.add(h);
  const L = leftOf.get(k); if (L) L.set(h, (L.get(h) || 0) + c);
  const R = rightOf.get(h); if (R) R.set(k, (R.get(k) || 0) + c);
});

// ---------------------------------------------------------------- induced frame vocabulary
// deriveClosedClassWords's instrument, unchanged: rank by how many DISTINCT histories a word continues, take the
// top `limit`. Production's limit is 96; the harness sweeps it so no single number decides the result.
const byCont = candidates.slice().sort((a, b) => predSets.get(b).size - predSets.get(a).size);
let frame = new Set();
const setFrame = (k) => { frame = new Set(byCont.slice(0, k)); };
setFrame(Number(flag("frame", 96)));

// ---------------------------------------------------------------- the frame statistic
function profile(m) {
  const p = new Map(); let tot = 0;
  if (!m) return { p, tot };
  for (const [w, c] of m) if (frame.has(w)) { p.set(w, c); tot += c; }
  for (const [w, c] of p) p.set(w, c / tot);
  return { p, tot };
}
const bc = (a, b) => { let s = 0; for (const [w, x] of a.p) { const y = b.p.get(w); if (y) s += Math.sqrt(x * y); } return s; };

function pairStat(u, v) {
  const iu = id.get(u), iv = id.get(v);
  if (iu === undefined || iv === undefined) return { ok: false, why: (iu === undefined ? u : v) + " UNSEEN" };
  const Lu = profile(leftOf.get(iu)), Lv = profile(leftOf.get(iv));
  const Ru = profile(rightOf.get(iu)), Rv = profile(rightOf.get(iv));
  const right = bc(Ru, Rv), left = bc(Lu, Lv);
  return { ok: true, tu: tokTail[iu] + tokHead[iu], tv: tokTail[iv] + tokHead[iv], fL: Lu.tot, fL2: Lv.tot, fR: Ru.tot, fR2: Rv.tot, right, left, S: right - left };
}

// background: frequency-matched random pairs give S a scale, so "high" is measured not asserted
const bgPicks = [], bgLeft = new Map(), bgRight = new Map();
{
  const pool = byFreq.slice(0, 4000);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const need = new Set();
  for (let i = 0; i < 600; i++) { const a = pool[Math.floor(rnd() * pool.length)], b = pool[Math.floor(rnd() * pool.length)]; if (a !== b) { bgPicks.push([a, b]); need.add(a); need.add(b); } }
  for (const i of need) { bgLeft.set(i, new Map()); bgRight.set(i, new Map()); }
  scan((h, k, c) => { const L = bgLeft.get(k); if (L) L.set(h, (L.get(h) || 0) + c); const R = bgRight.get(h); if (R) R.set(k, (R.get(k) || 0) + c); });
}
function background() {
  const out = [];
  for (const [a, b] of bgPicks) {
    const Lu = profile(bgLeft.get(a)), Lv = profile(bgLeft.get(b)), Ru = profile(bgRight.get(a)), Rv = profile(bgRight.get(b));
    if (Lu.tot < 50 || Lv.tot < 50 || Ru.tot < 50 || Rv.tot < 50) continue;
    out.push(bc(Ru, Rv) - bc(Lu, Lv));
  }
  const mu = out.reduce((s, x) => s + x, 0) / out.length;
  const sd = Math.sqrt(out.reduce((s, x) => s + (x - mu) ** 2, 0) / out.length);
  return { mu, sd, n: out.length };
}
let bg = background();

function line(a, b, want) {
  const r = pairStat(a, b);
  const name = `${a}/${b}`.padEnd(21);
  if (!r.ok) return `${name} ${want ? "+" : "-"}   ${r.why}`;
  const z = (r.S - bg.mu) / bg.sd;
  return `${name} ${want ? "+" : "-"}  t=${String(Math.round(r.tu)).padStart(6)}/${String(Math.round(r.tv)).padEnd(6)} frameL=${String(Math.round(r.fL)).padStart(5)}/${String(Math.round(r.fL2)).padEnd(5)} frameR=${String(Math.round(r.fR)).padStart(5)}/${String(Math.round(r.fR2)).padEnd(5)} right=${r.right.toFixed(3)} left=${r.left.toFixed(3)} S=${r.S >= 0 ? "+" : ""}${r.S.toFixed(3)} z=${z >= 0 ? "+" : ""}${z.toFixed(2)}`;
}

function report() {
  console.log(`\n########## frame vocabulary = top ${frame.size} by continuation count (${[...frame].slice(0, 14).map(i => vocab[i]).join(" ")} …)`);
  bg = background();
  console.log(`background S over ${bg.n} frequency-matched random pairs: mean ${bg.mu.toFixed(4)} sd ${bg.sd.toFixed(4)}`);
  console.log("=== the eleven-member i>ou@nd transformation (6 true, 5 false) ===");
  for (const [a, b, w] of DIAG.slice(0, 11)) console.log(line(a, b, w));
  console.log("=== the rest of the required diagnostic set ===");
  for (const [a, b, w] of DIAG.slice(11)) console.log(line(a, b, w));
  verdict();
}
function verdict() {
  const eleven = DIAG.slice(0, 11).map(([a, b, w]) => ({ a, b, w, r: pairStat(a, b) })).filter(x => x.r.ok);
  const pos = eleven.filter(x => x.w).map(x => x.r.S), neg = eleven.filter(x => !x.w).map(x => x.r.S);
  let auc = 0; for (const p of pos) for (const q of neg) auc += p > q ? 1 : p === q ? 0.5 : 0;
  auc /= (pos.length * neg.length);
  const lo = Math.min(...pos), hi = Math.max(...neg);
  console.log(`VERDICT  decidable ${eleven.length}/11  true S in [${lo.toFixed(3)}, ${Math.max(...pos).toFixed(3)}]  false S in [${Math.min(...neg).toFixed(3)}, ${hi.toFixed(3)}]  AUROC ${auc.toFixed(3)}  ${lo > hi ? "SEPARATES" : "DOES NOT SEPARATE"}`);
  // also on the four members with enough frame mass on both sides to be measurable at all
  const solid = eleven.filter(x => Math.min(x.r.fL, x.r.fL2, x.r.fR, x.r.fR2) >= 50);
  const sp = solid.filter(x => x.w).map(x => x.r.S), sn = solid.filter(x => !x.w).map(x => x.r.S);
  if (sp.length && sn.length) {
    let a2 = 0; for (const p of sp) for (const q of sn) a2 += p > q ? 1 : p === q ? 0.5 : 0;
    console.log(`         restricted to the ${solid.length} members with >=50 frame tokens in every slot: AUROC ${(a2 / (sp.length * sn.length)).toFixed(3)} (${sp.length} true, ${sn.length} false)`);
  }
}
for (const k of [48, 96, 192, 384]) { setFrame(k); report(); }
setFrame(96);

// ---------------------------------------------------------------- shuffled-family ablation, held-out family
console.log(`\n=== held-out family (rank ${heldoutRank} by member count, never inspected while developing): ${heldout[0]}, ${heldout[1].length} members ===`);
let seed = 98765; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const aSide = heldoutMembers.map(m => m[0]), bSide = heldoutMembers.map(m => m[1]);
const shuffled = bSide.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
let trueWins = 0, cmp = 0;
for (let i = 0; i < heldoutMembers.length; i++) {
  if (shuffled[i] === bSide[i]) continue;
  const t = pairStat(aSide[i], bSide[i]), s = pairStat(aSide[i], shuffled[i]);
  if (!t.ok || !s.ok) continue;
  cmp++; if (t.S > s.S) trueWins++;
  console.log(`  ${aSide[i]}/${bSide[i]} S=${t.S >= 0 ? "+" : ""}${t.S.toFixed(3)}   shuffled ${aSide[i]}/${shuffled[i]} S=${s.S >= 0 ? "+" : ""}${s.S.toFixed(3)}   ${t.S > s.S ? "TRUE" : "SHUFFLED"}`);
}
console.log(`  true pool beats shuffled on ${trueWins}/${cmp} held-out members`);


#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// T10: induce morphological paradigms from the corpus and report a relation with its basis attached, not a boolean.
// Canonical edit families (both-ends alignment) -> family population against a character-model null -> MDL over the
// eligible population -> role-conditioned contextual correspondence, with NO-FAMILY and SHUFFLED-FAMILY ablations.
// Read-only: one SELECT of model JSON. The mechanism is induced over the WHOLE vocabulary and frozen before the
// diagnostic pairs are scored; the diagnostic set is a diagnostic, never the objective.
//
//   node --max-old-space-size=7168 tools/paradigm-induction-harness.mjs [--budget-mb=48] [--cache=file] [--mode=aggregate] [--json=out.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNgramModelReader } from "./lib/ngram-model-reader.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const budgetBytes = Math.max(1, Number(flag("budget-mb", 48))) * 1024 * 1024;
const cachePath = flag("cache", "");
const mode = flag("mode", "report");
const jsonOut = flag("json", "");
const SEP = "";
const WORD = new RegExp("^[\p{L}\p{M}'’-]+$", "u");

async function loadFromDatabase() {
  const reader = await openNgramModelReader();
  const models = [];
  try {
    const records = await reader.storage.languageMemory.listNgramModels({ limit: 1_000_000, maxTotalJsonBytes: budgetBytes });
    for (const record of records) {
      const model = reader.materialize(record);
      if (model) models.push(model.counts);
    }
  } finally { await reader.close(); }
  const ids2 = new Map(), vocabList = [], norm = new Map();
  const idOf = (symbol) => {
    let cached = norm.get(symbol);
    if (cached === undefined) {
      cached = (!symbol || symbol.startsWith("<") || symbol.length > 24 || !WORD.test(symbol)) ? -1 : symbol.toLocaleLowerCase();
      if (cached !== -1) { let n = ids2.get(cached); if (n === undefined) { n = vocabList.length; vocabList.push(cached); ids2.set(cached, n); } cached = n; }
      norm.set(symbol, cached);
    }
    return cached;
  };
  const pairs = new Map();
  for (const counts of models) for (const gram in counts) {
    const cut = gram.indexOf(SEP);
    if (cut < 0 || gram.indexOf(SEP, cut + 1) >= 0) continue;
    const h = idOf(gram.slice(0, cut)); if (h < 0) continue;
    const k = idOf(gram.slice(cut + 1)); if (k < 0) continue;
    const key = h + "|" + k;
    pairs.set(key, (pairs.get(key) || 0) + counts[gram]);
  }
  const flatArr = new Array(pairs.size * 3); let i = 0;
  for (const [key, count] of pairs) { const bar = key.indexOf("|"); flatArr[i++] = +key.slice(0, bar); flatArr[i++] = +key.slice(bar + 1); flatArr[i++] = count; }
  return { models: models.length, vocab: vocabList, flat: flatArr };
}

const cache = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : await loadFromDatabase();
if (cachePath && !fs.existsSync(cachePath)) fs.writeFileSync(cachePath, JSON.stringify(cache));
const vocab = cache.vocab, flat = cache.flat;
console.log(`models ${cache.models} under a ${(budgetBytes / 1048576).toFixed(0)}MB budget`);
// ---------- corpus structure ----------
const tok = new Map();            // tokens with this surface as the bigram key
const leftCtx = new Map();        // surface -> Map(previous word -> count)
const background = new Map();     // corpus-wide distribution over previous words
let backgroundTotal = 0;
for (let i = 0; i < flat.length; i += 3) {
  const h = vocab[flat[i]], k = vocab[flat[i + 1]], c = flat[i + 2];
  tok.set(k, (tok.get(k) || 0) + c);
  let m = leftCtx.get(k); if (!m) { m = new Map(); leftCtx.set(k, m); }
  m.set(h, (m.get(h) || 0) + c);
  background.set(h, (background.get(h) || 0) + c);
  backgroundTotal += c;
}
const V = new Set(vocab);

// ---------- T6's independent-form question, reproduced so this composes with it ----------
const rows = [];
for (const [w, m] of leftCtx) { const t = tok.get(w) || 0; if (t >= 2) rows.push([w, t, m.size]); }
let sx = 0, sy = 0, sxx = 0, sxy = 0;
for (const r of rows) { const x = Math.log(r[1]), y = Math.log(r[2]); sx += x; sy += y; sxx += x * x; sxy += x * y; }
const nFit = rows.length;
const slope = (nFit * sxy - sx * sy) / (nFit * sxx - sx * sx);
const intercept = (sy - slope * sx) / nFit;
let sq = 0; for (const r of rows) { const e = Math.log(r[2]) - (intercept + slope * Math.log(r[1])); sq += e * e; }
const sigma = Math.sqrt(sq / nFit);
const fitted = new Map(rows.map(r => [r[0], r]));
const mills = z => (z >= 0 ? 1 : Math.exp(-(z * z) / 2) / (Math.abs(z) * Math.sqrt(2 * Math.PI)));
function freeForm(w) {
  const r = fitted.get(w); if (!r) return "unknown";
  const expected = intercept + slope * Math.log(r[1]);
  if (nFit * mills(-expected / sigma) >= 1) return "unknown";
  return nFit * mills((Math.log(r[2]) - expected) / sigma) < 1 ? "bound" : "free";
}

// ---------- character model over the TYPE inventory, for the null and for MDL ----------
// Interpolated absolute discounting, order 3. Discount from the corpus's own n1/n2 (Ney): no set constant.
const ORDER = 3;  // cost bound: context length for the string-existence null model
const END = "\u0000";
const ctxCount = new Map(), nextCount = new Map(), distinctNext = new Map();
let n1 = 0, n2 = 0;
for (const w of vocab) {
  const s = w + END;
  for (let i = 0; i < s.length; i++) {
    for (let o = 0; o <= ORDER; o++) {
      if (i - o < 0) continue;
      const ctx = s.slice(i - o, i), key = ctx + "" + s[i];
      ctxCount.set(ctx, (ctxCount.get(ctx) || 0) + 1);
      const before = nextCount.get(key) || 0;
      nextCount.set(key, before + 1);
      if (before === 0) distinctNext.set(ctx, (distinctNext.get(ctx) || 0) + 1);
    }
  }
}
for (const c of nextCount.values()) { if (c === 1) n1++; else if (c === 2) n2++; }
const D = n1 / (n1 + 2 * n2);
const alphabet = new Set(); for (const w of vocab) for (const ch of w) alphabet.add(ch); alphabet.add(END);
const uniform = 1 / alphabet.size;
function charProb(ctx, ch) {
  let p = uniform;
  for (let o = 0; o <= ORDER; o++) {
    if (ctx.length < o) break;
    const c = ctx.slice(ctx.length - o), total = ctxCount.get(c) || 0;
    if (!total) break;
    const cnt = nextCount.get(c + "" + ch) || 0;
    const lambda = (D * (distinctNext.get(c) || 0)) / total;
    p = Math.max(cnt - D, 0) / total + lambda * p;
  }
  return p;
}
const bitsCache = new Map();
function bits(str) {                       // description length of a string as itself
  let b = bitsCache.get(str);
  if (b !== undefined) return b;
  const s = str + END; b = 0;
  for (let i = 0; i < s.length; i++) b += -Math.log2(charProb(s.slice(Math.max(0, i - ORDER), i), s[i]));
  bitsCache.set(str, b); return b;
}
const etCache = new Map();
const expectedTypes = s => { let v = etCache.get(s); if (v === undefined) { v = Math.min(0.999999, vocab.length * Math.pow(2, -bits(s))); etCache.set(s, v); } return v; };

// ---------- 1. canonical edit families: minimum edit script aligned from both ends ----------
function canonical(a, b) {
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = a.slice(p, a.length - s), to = b.slice(p, b.length - s);
  // Cost bound + information condition: the invariant material must be at least the alternating material,
  // otherwise there is no context for the alternation and the "rule" is just the two strings.
  if (p + s < 1 || from.length + to.length > p + s) return null;
  return { stem: a.slice(0, p), from, to, rc: a.slice(a.length - s) };
}
function orient(a, b) { return a.length !== b.length ? (a.length < b.length ? [a, b] : [b, a]) : (a < b ? [a, b] : [b, a]); }

const families = new Map();  // key -> {from,to,rc, stems:Set}
function offer(a, b) {
  const [x, y] = orient(a, b);
  const c = canonical(x, y); if (!c) return;
  const key = c.from + ">" + c.to + "@" + c.rc;
  let f = families.get(key); if (!f) { f = { from: c.from, to: c.to, rc: c.rc, stems: new Set() }; families.set(key, f); }
  f.stems.add(c.stem);
}
// Pass A, prefix buckets: catches alternations with no shared suffix. Only splits where the stem is at least
// half the word can satisfy the information condition, which bounds the work.
const byPrefix = new Map();
for (const w of vocab) for (let j = Math.ceil(w.length / 2); j < w.length; j++) {
  const k = w.slice(0, j); let a = byPrefix.get(k); if (!a) { a = []; byPrefix.set(k, a); } a.push(w);
}
for (const list of byPrefix.values()) if (list.length > 1 && list.length <= 4000)
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) offer(list[i], list[j]);
// Pass B, first/last character buckets: catches alternations with shared material on both sides.
const byEnds = new Map();
for (const w of vocab) { const k = w[0] + "" + w[w.length - 1]; let a = byEnds.get(k); if (!a) { a = []; byEnds.set(k, a); } a.push(w); }
for (const list of byEnds.values()) if (list.length > 1 && list.length <= 4000)
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) offer(list[i], list[j]);

// ---------- 2 + 3. population against a null, and MDL over the eligible population ----------
const bySuffix = new Map();   // every word indexed by each of its terminal substrings, for the eligible sets
for (const w of vocab) for (let j = 0; j < w.length; j++) {
  const k = w.slice(j); let a = bySuffix.get(k); if (!a) { a = []; bySuffix.set(k, a); } a.push(w);
}
function evaluate(f, membersOverride) {
  const tail = f.from + f.rc;
  const eligible = (tail === "" ? vocab : (bySuffix.get(tail) || [])).filter(w => w.length > tail.length);
  if (!eligible.length) return null;
  const realized = [], nulls = [];
  for (const w of eligible) {
    const stem = w.slice(0, w.length - tail.length);
    const target = stem + f.to + f.rc;
    nulls.push(expectedTypes(target));
    if (V.has(target) && target !== w) realized.push(stem);
  }
  const members = membersOverride || realized;
  const memberSet = new Set(members);
  const R = members.length, A = eligible.length, phat = R / A;
  let logBF = 0;
  for (let i = 0; i < eligible.length; i++) {
    const stem = eligible[i].slice(0, eligible[i].length - tail.length);
    const y = memberSet.has(stem) ? 1 : 0, p = nulls[i];
    if (phat > 0 && y) logBF += Math.log(phat / p);
    if (phat < 1 && !y) logBF += Math.log((1 - phat) / (1 - p));
  }
  logBF -= 0.5 * Math.log(Math.max(A, 1));                       // one fitted rate
  const H = phat <= 0 || phat >= 1 ? 0 : -(phat * Math.log2(phat) + (1 - phat) * Math.log2(1 - phat));
  let independentBits = 0;
  for (const stem of members) independentBits += bits(stem + f.to + f.rc);
  const modelBits = bits(f.from) + bits(f.to) + bits(f.rc) + A * H + 0.5 * Math.log2(Math.max(A, 1));
  return { A, R, phat, logBF, independentBits, modelBits, gainBits: independentBits - modelBits, members, eligible, tail };
}

// ---------- 4. role-conditioned context correspondence, leave-one-out ----------
function profile(w) { return leftCtx.get(w) || new Map(); }
function pooled(stems, suffix, skip) {
  const pool = new Map(); let n = 0;
  for (const stem of stems) {
    if (stem === skip) continue;
    const w = stem + suffix, m = profile(w), t = tok.get(w) || 0;
    if (!t || !m.size) continue;
    n++;
    for (const [c, v] of m) pool.set(c, (pool.get(c) || 0) + v / t);   // per-lexeme shape, not per-lexeme mass
  }
  return { pool, n };
}
// Dirichlet with the corpus background as base measure and a single pseudo-observation: the weakest proper prior.
function lift(obs, pool, poolMass) {
  let score = 0, total = 0;
  for (const [c, v] of obs) {
    const pb = (background.get(c) || 0) / backgroundTotal;
    if (!(pb > 0)) continue;
    const pp = ((pool.get(c) || 0) + pb) / (poolMass + 1);
    score += v * Math.log2(pp / pb); total += v;
  }
  return total ? score / total : 0;
}
function correspondence(f, members, stem) {
  const fromSide = pooled(members, f.from + f.rc, stem), toSide = pooled(members, f.to + f.rc, stem);
  if (fromSide.n < 1 || toSide.n < 1) return null;
  const massF = [...fromSide.pool.values()].reduce((a, b) => a + b, 0);
  const massT = [...toSide.pool.values()].reduce((a, b) => a + b, 0);
  const x = profile(stem + f.from + f.rc), y = profile(stem + f.to + f.rc);
  const ownFrom = lift(x, fromSide.pool, massF), crossFrom = lift(x, toSide.pool, massT);
  const ownTo = lift(y, toSide.pool, massT), crossTo = lift(y, fromSide.pool, massF);
  return { role: (ownFrom - crossFrom) + (ownTo - crossTo), ownFrom, crossFrom, ownTo, crossTo, pooledFrom: fromSide.n, pooledTo: toSide.n };
}

// ---------- the learned object ----------
const evaluated = new Map();
for (const [key, f] of families) {
  if (f.stems.size < 2) continue;   // cost bound: a population of one is evaluated only on demand, in verdict()
  const e = evaluate(f);
  if (e) evaluated.set(key, { f, e });
}
const accepted = [...evaluated.entries()].filter(([, v]) => v.e.gainBits > 0 && v.e.logBF > 0);

console.log(`evaluated families ${evaluated.size}`);
console.log(`vocab ${vocab.length} types, bigram types ${flat.length / 3}, free-form fit ${nFit} forms  log k = ${intercept.toFixed(3)} + ${slope.toFixed(3)} log t, sd ${sigma.toFixed(3)}`);
console.log(`char model order ${ORDER}, discount D = ${D.toFixed(4)}, alphabet ${alphabet.size}`);
console.log(`transformations induced ${families.size}; MDL+null accepted ${accepted.length}`);
const sizes = accepted.map(([, v]) => v.e.R).sort((a, b) => b - a);
console.log(`accepted family sizes: max ${sizes[0]}, median ${sizes[Math.floor(sizes.length / 2)]}, singletons ${sizes.filter(s => s === 1).length}`);
const nonAffix = accepted.filter(([, v]) => v.f.from.length > 0 && v.f.to.length > 0).sort((a, b) => b[1].e.R - a[1].e.R);
console.log(`accepted with BOTH sides non-empty (true alternations, not affixation): ${nonAffix.length}`);
if (mode === "aggregate") process.exit(0);

// ---------- verdicts ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function verdict(a, b) {
  const [x, y] = orient(a.toLowerCase(), b.toLowerCase());
  const c = canonical(x, y);
  if (!c) return { kind: "unknown", basis: { reason: "no canonical edit script under the information condition" } };
  const key = c.from + ">" + c.to + "@" + c.rc;
  let hit = evaluated.get(key);
  if (!hit && families.has(key)) { const f2 = families.get(key); const e2 = evaluate(f2); if (e2) hit = { f: f2, e: e2 }; }
  const ff = { left: freeForm(x), right: freeForm(y) };
  if (!V.has(x) || !V.has(y)) return { kind: "unknown", basis: { transformation: key, reason: "surface unseen in the corpus", ff } };
  if (!hit) return { kind: "unknown", basis: { transformation: key, reason: "transformation not induced" } };
  const { f, e } = hit;
  const full = correspondence(f, e.members, c.stem);
  const solo = evaluate(f, [c.stem]);
  const shuffled = (() => {
    const r = rng(1234567), pool = e.eligible.map(w => w.slice(0, w.length - e.tail.length)).filter(s => s !== c.stem);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    return correspondence(f, [c.stem, ...pool.slice(0, Math.max(0, e.members.length - 1))], c.stem);
  })();
  const populationOk = e.gainBits > 0 && e.logBF > 0;
  const independentOk = ff.left === "free" && ff.right === "free";
  let kind = "unknown";
  if (!independentOk) kind = "independent-form";
  else if (populationOk && full && full.role > 0) kind = f.from && f.to ? "inflectional" : "derivational";
  else if (populationOk && full && full.role <= 0) kind = "independent-form";
  return {
    kind,
    basis: {
      transformation: { leftContext: "*", from: f.from, to: f.to, rightContext: f.rc },
      members: e.R, eligible: e.A, nullLikelihood: e.phat, logBF: e.logBF,
      modelBits: e.modelBits, independentBits: e.independentBits, gainBits: e.gainBits,
      freeForm: ff,
      FULL: full ? { role: full.role, ownFrom: full.ownFrom, crossFrom: full.crossFrom, ownTo: full.ownTo, crossTo: full.crossTo, pooled: [full.pooledFrom, full.pooledTo] } : null,
      NO_FAMILY: solo ? { logBF: solo.logBF, gainBits: solo.gainBits, role: null } : null,
      SHUFFLED: shuffled ? { role: shuffled.role } : null
    }
  };
}

const REQUIRED = [["find", "found", "+"], ["bind", "bound", "+"], ["grind", "ground", "+"], ["wind", "wound", "+"],
  ["discover", "discovery", "+"], ["capital", "capitals", "+"], ["mind", "mound", "-"], ["kind", "kound", "-"],
  ["capita", "capital", "-"], ["born", "borna", "-"], ["majorian", "bajoran", "-"]];
const out = { required: [], heldOut: [] };
console.log("\npair                 want kind               members/elig  logBF     gainBits  role(FULL)  role(SHUF)  noFamily(logBF/gain)  freeForm");
for (const [a, b, want] of REQUIRED) {
  const v = verdict(a, b);
  const s = v.basis;
  const matched = v.kind === "inflectional" || v.kind === "derivational";
  const ok = (want === "+") === matched;
  out.required.push({ pair: [a, b], want, ...v, pass: ok });
  const t = s.transformation ? `${s.transformation.from || "0"}>${s.transformation.to || "0"}@${s.transformation.rightContext || "0"}` : "-";
  console.log(`${(a + "/" + b).padEnd(20)} ${want}    ${v.kind.padEnd(18)} ${String(s.members ?? "-").padStart(5)}/${String(s.eligible ?? "-").padEnd(6)} ${(s.logBF ?? NaN).toFixed(2).padStart(9)} ${(s.gainBits ?? NaN).toFixed(1).padStart(9)} ${(s.FULL ? s.FULL.role.toFixed(3) : "  n/a").padStart(11)} ${(s.SHUFFLED ? s.SHUFFLED.role.toFixed(3) : "  n/a").padStart(11)} ${(s.NO_FAMILY ? s.NO_FAMILY.logBF.toFixed(1) + "/" + s.NO_FAMILY.gainBits.toFixed(1) : "n/a").padStart(21)}  ${s.freeForm ? s.freeForm.left + "/" + s.freeForm.right : ""} [T=${t}] ${ok ? "" : "  <== MISS"}`);
}
// Held-out family: chosen by rank, never inspected while the mechanism was being written.
const targetKeys = new Set(REQUIRED.map(([a, b]) => { const [x, y] = orient(a, b); const c = canonical(x, y); return c ? c.from + ">" + c.to + "@" + c.rc : ""; }));
const heldOut = nonAffix.filter(([k]) => !targetKeys.has(k))[1];
if (heldOut) {
  const [key, v] = heldOut;
  console.log(`\nheld-out family ${key}: ${v.e.R} members of ${v.e.A} eligible, logBF ${v.e.logBF.toFixed(1)}, gain ${v.e.gainBits.toFixed(1)} bits`);
  for (const stem of v.e.members.slice(0, 12)) {
    const r = verdict(stem + v.f.from + v.f.rc, stem + v.f.to + v.f.rc);
    out.heldOut.push({ pair: [stem + v.f.from + v.f.rc, stem + v.f.to + v.f.rc], ...r });
    console.log(`  ${(stem + v.f.from + v.f.rc + "/" + stem + v.f.to + v.f.rc).padEnd(28)} ${r.kind.padEnd(18)} role ${(r.basis.FULL ? r.basis.FULL.role.toFixed(3) : "n/a").padStart(8)}  shuffled ${(r.basis.SHUFFLED ? r.basis.SHUFFLED.role.toFixed(3) : "n/a").padStart(8)}`);
  }
}
const misses = out.required.filter(r => !r.pass);
console.log(`\nrequired set: ${out.required.length - misses.length}/${out.required.length} decided as required`);
if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(out, null, 2));

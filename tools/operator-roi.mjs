#!/usr/bin/env node
// Per-operator ROI from .scce/traces: uncertainty removed vs compute consumed. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = new Map(process.argv.slice(2).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), 'true'] : [a.slice(2, i), a.slice(i + 1)];
}));
const dir = args.get('traces') || path.join(process.cwd(), '.scce', 'traces');
const fileLimit = Number(args.get('files') || 0);
const jsonOut = args.get('json');

// Each entry: how to read one operator invocation's hypothesis set before and after.
// `before`/`after` name count keys the operator itself already writes. `ids` names a
// support array of hypothesis identifiers, used for the basis-overlap test.
const OPERATORS = [
  // 'graph.resolve' is FIVE operators sharing one stage, separated only by label. Keying on stage alone
  // merges a 3.4 s/turn slice with a 5.5 ms PowerWalk and hides both.
  { id: 'graph.slice', stage: 'graph.resolve', label: 'kernel.turn.graph_slice', before: null, after: 'evidence', phase: 'graphSliceMs' },
  { id: 'graph.semantic_retrieval', stage: 'graph.resolve', label: 'kernel.turn.semantic_retrieval', before: 'candidates', after: 'evidence', phase: 'graphSliceMs' },
  { id: 'graph.powerwalk', stage: 'graph.resolve', label: 'kernel.turn.powerwalk', before: null, after: 'nodes', phase: 'graphSliceMs' },
  { id: 'graph.hot_neighborhood', stage: 'graph.resolve', label: 'kernel.hot_neighborhood', before: null, after: 'evidence', bytes: 'bytes', phase: 'graphSliceMs' },
  { id: 'graph.resolve.turn', stage: 'graph.resolve', label: 'kernel.turn', before: null, after: 'evidence', phase: 'graphSliceMs' },
  { id: 'graph.query_features', stage: 'graph.resolve.query_features', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.session_projection', stage: 'graph.resolve.session_projection', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.anchor_evidence_search', stage: 'graph.resolve.anchor_evidence_search', beforeSupport: 'gathered', afterSupport: 'afterProseFilter', phase: 'graphSliceMs' },
  { id: 'graph.anchor_admissibility', stage: 'graph.resolve.anchor_admissibility', before: 'candidates', after: 'admitted', idsSupport: 'pool', phase: 'graphSliceMs' },
  { id: 'graph.anchor_evidence', stage: 'graph.resolve.anchor_evidence', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.anchor_slice', stage: 'graph.resolve.anchor_slice', before: null, after: 'nodes', phase: 'graphSliceMs' },
  { id: 'graph.pool_admission', stage: 'graph.resolve.pool_admission', before: 'pool', after: 'admitted', idsSupport: 'spans', phase: 'graphSliceMs' },
  { id: 'graph.community_admission', stage: 'graph.resolve.community_admission', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.durable_escalation', stage: 'graph.resolve.durable_escalation', before: null, after: 'evidence', phase: 'graphSliceMs' },
  { id: 'graph.near_duplicate_fast_path', stage: 'graph.resolve.near_duplicate_fast_path', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.opening_block', stage: 'graph.resolve.opening_block', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'graph.discourse_bound', stage: 'graph.resolve.discourse_bound', before: null, after: null, phase: 'graphSliceMs' },
  { id: 'language.hydrate', stage: 'language.hydrate.built', before: null, after: null, durationCount: 'elapsedMs', phase: 'seedMs' },
  { id: 'support_candidates', stage: 'turn.support_candidates', before: 'admissible', after: 'candidates', phase: 'candidateMs' },
  { id: 'candidate.proposal', stage: 'candidate.proposal', before: null, after: 'proposed', idsSupport: 'evidenceIds', phase: 'candidateMs' },
  { id: 'candidate.quotation_recall', stage: 'candidate.proposal.quotation_recall', before: null, after: null, phase: 'candidateMs' },
  { id: 'proof.entailment', stage: 'proof.entailment', before: 'evidence', after: 'certifiedEvidence', phase: 'proofMs' },
  { id: 'proof.semantic', stage: 'proof.semantic', before: 'obligations', after: null, phase: 'proofMs' },
  { id: 'proof.ccr', stage: 'proof.ccr', before: null, after: null, phase: 'proofMs' },
  { id: 'proof.path_semiring', stage: 'proof.path_semiring', before: 'paths', after: null, phase: 'proofMs' },
  { id: 'proof.support_assessment', stage: 'proof.support_assessment', before: 'evidence', after: null, weights: 'weights', phase: 'proofMs' },
  { id: 'proof.temporal_relation', stage: 'proof.temporal_relation', before: null, after: null, phase: 'proofMs' },
  { id: 'contradiction.check', stage: 'contradiction.check', before: 'promotedEvidence', after: 'proofEvidence', phase: 'proofMs' },
  { id: 'proof.attach', stage: 'proof.attach', before: null, after: 'evidenceIds', phase: 'proofMs' },
  { id: 'candidate.selected_evidence', stage: 'candidate.selected_evidence', before: 'ranked', after: 'spans', idsSupport: 'spans', phase: 'candidateMs' },
  { id: 'candidate.proposal.admit', stage: 'candidate.proposal.admit', before: 'proposed', after: 'admitted', phase: 'candidateMs' },
  { id: 'candidate.realization_contract', stage: 'candidate.realization_contract', before: null, after: null, phase: 'candidateMs' },
  { id: 'candidate.prior.bind', stage: 'candidate.prior.bind', before: null, after: null, phase: 'candidateMs' },
  { id: 'candidate.cognitive.plan', stage: 'candidate.cognitive.plan', before: null, after: null, phase: 'candidateMs' },
  { id: 'candidate.invention.plan', stage: 'candidate.invention.plan', before: null, after: null, phase: 'candidateMs' },
  { id: 'candidate.field.generate', stage: 'candidate.field.generate', before: null, after: null, phase: 'candidateMs' },
  { id: 'candidate.score', stage: 'candidate.score', before: null, after: 'evidence', idsSupport: 'evidenceIds', phase: 'candidateMs' },
  { id: 'functional_cognition.project', stage: 'functional-cognition.project', before: null, after: null, phase: 'candidateMs' },
  { id: 'planner.select', stage: 'planner.select', before: null, after: null, rejected: 'rejected', phase: 'planningMs' },
  { id: 'mouth.deterministic.select', stage: 'mouth.deterministic.select', before: null, after: null, phase: 'mouthMs' },
  { id: 'mouth.candidate.select', stage: 'mouth.candidate.select', before: null, after: null, phase: 'mouthMs' },
  { id: 'mouth.generate', stage: 'mouth.generate', before: null, after: null, phase: 'mouthMs' },
];
const BY_STAGE = new Map();
for (const o of OPERATORS) BY_STAGE.set(o.label ? o.stage + '|' + o.label : o.stage, o);
const specFor = ev => BY_STAGE.get(ev.stage + '|' + ev.label) || BY_STAGE.get(ev.stage);

const log2 = n => (n > 0 ? Math.log2(n) : 0);
const idList = v => {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    if (typeof x === 'string') out.push(x);
    else if (x && typeof x === 'object' && typeof x.id === 'string') out.push(x.id);
  }
  return out.length ? out : null;
};
// Events abbreviate span ids inconsistently: some keep a prefix, some a suffix. Match either way.
const norm = s => s.replace(/^evidence_span\./, '');
const sameId = (a, b) => a === b || a.startsWith(b) || b.startsWith(a) || a.endsWith(b) || b.endsWith(a);

const acc = new Map();
const rec = id => {
  if (!acc.has(id)) acc.set(id, {
    id, n: 0, turns: new Set(), wallMs: 0, cpuMs: 0, bytes: 0,
    dH: 0, dHn: 0, before: 0, after: 0, setUnchanged: 0, setChanged: 0,
    basisTouching: 0, basisTestable: 0, answerChanged: 0, noDuration: 0, scoreH: 0, scoreHn: 0,
  });
  return acc.get(id);
};

const turnStats = { turns: 0, wall: 0, cpu: 0, cpuRatioN: 0, cpuRatio: 0, phase: {} };

function flushTurn(events, outEv) {
  if (!outEv) return;
  const timing = outEv.support?.timing || {};
  const ru = timing.resourceUsage || {};
  const turnWall = Number(ru.wallClockMs || timing.totalMs || outEv.durationMs || 0);
  const turnCpu = Number(ru.cpuUserMs || 0) + Number(ru.cpuSystemMs || 0);
  if (!(turnWall > 0)) return;
  turnStats.turns++; turnStats.wall += turnWall; turnStats.cpu += turnCpu;
  if (turnCpu > 0) { turnStats.cpuRatio += turnCpu / turnWall; turnStats.cpuRatioN++; }
  for (const k of ['seedMs', 'graphSliceMs', 'proofMs', 'candidateMs', 'planningMs', 'mouthMs', 'validationMs']) {
    if (typeof timing[k] === 'number') turnStats.phase[k] = (turnStats.phase[k] || 0) + timing[k];
  }
  const cpuPerWall = turnWall > 0 && turnCpu > 0 ? turnCpu / turnWall : 1;

  // The turn's final claim basis: evidence ids the answer was actually scored on.
  let basis = null;
  for (const ev of events) {
    if (ev.stage === 'candidate.score') {
      const ids = idList(ev.support?.evidenceIds) || idList(ev.support?.audit?.evidenceIds);
      if (ids) basis = new Set(ids.map(norm));
    }
  }

  for (const ev of events) {
    const spec = specFor(ev);
    if (!spec) continue;
    const r = rec(spec.id);
    r.n++; r.turns.add(outEv.traceId + '#' + turnStats.turns);
    const c = ev.counts || {}; const s = ev.support || {};

    const d = typeof ev.durationMs === 'number' ? ev.durationMs
      : (spec.durationCount && typeof c[spec.durationCount] === 'number' ? c[spec.durationCount] : null);
    if (d === null) r.noDuration++; else { r.wallMs += d; r.cpuMs += d * cpuPerWall; }
    if (spec.bytes && typeof c[spec.bytes] === 'number') r.bytes += c[spec.bytes];

    // Hypothesis-set cardinality before and after, from the operator's own counters.
    const bRaw = spec.beforeSupport ? s[spec.beforeSupport] : (spec.before ? c[spec.before] : undefined);
    const aRaw = spec.afterSupport ? s[spec.afterSupport] : (spec.after ? c[spec.after] : undefined);
    const b = typeof bRaw === 'number' ? bRaw : null;
    const a = typeof aRaw === 'number' ? aRaw : null;
    if (b !== null && a !== null) {
      r.dH += log2(b) - log2(a); r.dHn++; r.before += b; r.after += a;
      if (a === b) r.setUnchanged++; else r.setChanged++;
    } else if (spec.rejected && Array.isArray(s[spec.rejected])) {
      const rej = s[spec.rejected].length;
      r.dH += log2(rej + 1); r.dHn++; r.before += rej + 1; r.after += 1;
      if (rej === 0) r.setUnchanged++; else r.setChanged++;
    }

    // Score-distribution entropy where the operator records a weight vector.
    if (spec.weights && Array.isArray(s[spec.weights]) && s[spec.weights].length) {
      const w = s[spec.weights].map(x => Math.abs(Number(x?.weight ?? x) || 0)).filter(x => x > 0);
      const tot = w.reduce((x, y) => x + y, 0);
      if (tot > 0) { r.scoreH += -w.reduce((h, x) => h + (x / tot) * Math.log2(x / tot), 0); r.scoreHn++; }
    }

    // Did this operator's surviving set carry the final claim basis?
    const ids = spec.idsSupport ? idList(s[spec.idsSupport]) : null;
    if (ids && basis && basis.size) {
      r.basisTestable++;
      const out = new Set(ids.map(norm));
      let hit = 0; for (const x of basis) for (const y of out) if (sameId(x, y)) { hit++; break; }
      if (hit > 0) r.basisTouching++;
    }
  }
  if (args.has('anchor-skip')) flushAnchor(events, outEv, basis, cpuPerWall, lastInput);
}

// --anchor-skip: per-invocation record of the anchor evidence search, the state knowable BEFORE it,
// and whether its output reached the turn's claim basis. Read-only, same events.
const anchorRows = [];
let lastInput = '';
function flushAnchor(events, outEv, basis, cpuPerWall, inputText) {
  const has = st => events.some(e => e.stage === st);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.stage !== 'graph.resolve.anchor_evidence_search') continue;
    const s = ev.support || {}, c = ev.counts || {};
    let adm = null;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].stage === 'graph.resolve.anchor_admissibility') { adm = events[j]; break; }
      if (events[j].stage === 'graph.resolve.anchor_evidence_search') break;
    }
    const as = adm?.support || {}, ac = adm?.counts || {};
    const admittedIds = (as.admitted || []).map(x => norm(String(x?.id ?? x)));
    const poolIds = (as.pool || []).map(x => norm(String(x?.id ?? x)));
    const gatheredIds = (s.gatheredHeads || []).map(x => norm(String(x)));
    const hits = ids => Boolean(basis && basis.size && ids.some(y => [...basis].some(x => sameId(x, y))));
    anchorRows.push({
      traceId: outEv.traceId, text: inputText || '',
      ms: Number(ev.durationMs || 0), cpuMs: Number(ev.durationMs || 0) * cpuPerWall,
      groups: Number(c.groups ?? (s.anchorFeatureGroups || []).length),
      features: Number(c.features || 0),
      dropped: Number(s.droppedScaffoldingGroups || 0),
      gathered: Number(s.gathered ?? c.results ?? 0),
      afterProse: Number(s.afterProseFilter ?? c.results ?? 0),
      symGroups: (s.anchorFeatureGroups || []).filter(g => g.some(u => String(u).startsWith('anchor:sym:'))).length,
      biOnlyGroups: (s.anchorFeatureGroups || []).filter(g => g.every(u => String(u).startsWith('anchor:bi:'))).length,
      admitted: adm ? Number(ac.admitted || 0) : null,
      promoted: adm ? Number(ac.promoted || 0) : null,
      candidates: adm ? Number(ac.candidates || 0) : null,
      concept: adm ? Number(ac.concept || 0) : null,
      identityAbsent: Boolean(as.sourceIdentityBoundEvidenceAbsent),
      basisSize: basis ? basis.size : 0,
      basisHitsAdmitted: hits(admittedIds),
      basisHitsPool: hits(poolIds),
      basisHitsGathered: hits(gatheredIds),
      hotNeighborhood: has('graph.resolve.near_duplicate_fast_path'),
      openingBlock: has('graph.resolve.opening_block'),
      poolAdmitted: (() => { const p = events.find(e => e.stage === 'graph.resolve.pool_admission'); return p ? Number(p.counts?.admitted || 0) : null; })(),
    });
  }
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
const use = fileLimit > 0 ? files.slice(-fileLimit) : files;
let lineCount = 0;
for (const f of use) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
  let buf = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.stage === 'turn.input') { buf = []; lastInput = typeof ev.input === 'string' ? ev.input : ''; continue; }
    buf.push(ev);
    if (ev.stage === 'turn.output') { flushTurn(buf, ev); buf = []; }
  }
}

const rows = [...acc.values()].sort((x, y) => y.cpuMs - x.cpuMs);
const totalCpu = rows.reduce((s, r) => s + r.cpuMs, 0) || 1;
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '-');

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ turnStats: { ...turnStats, cpuRatio: turnStats.cpuRatio / (turnStats.cpuRatioN || 1) }, rows: rows.map(r => ({ ...r, turns: r.turns.size })) }, null, 2));
}

console.log(`traces=${use.length} files, ${lineCount} events, ${turnStats.turns} completed turns`);
console.log(`turn wall total ${fmt(turnStats.wall / 1000, 1)}s  cpu total ${fmt(turnStats.cpu / 1000, 1)}s  mean cpu/wall ${fmt(turnStats.cpuRatio / (turnStats.cpuRatioN || 1), 3)}`);
console.log(`phase wall totals (s): ` + Object.entries(turnStats.phase).map(([k, v]) => `${k.replace('Ms', '')}=${fmt(v / 1000, 1)}`).join(' '));
console.log('');
const H = ['operator', 'inv', 'turns', 'cpu_s', '%cpu', 'ms/inv', 'MB_hyd', 'dH_bits', 'ROI_b/s', 'nochg%', 'basis%'];
const W = [30, 6, 6, 8, 6, 8, 8, 8, 9, 7, 7];
console.log(H.map((h, i) => h.padEnd(W[i])).join(''));
console.log(W.map(w => '-'.repeat(w - 1) + ' ').join(''));
for (const r of rows) {
  const dH = r.dHn ? r.dH / r.dHn : null;
  const cpuS = r.cpuMs / 1000;
  const roi = r.dHn && cpuS > 0 ? (r.dH * (r.n / r.dHn)) / cpuS : null;
  const nochg = r.dHn ? (100 * r.setUnchanged / r.dHn) : null;
  const basis = r.basisTestable ? (100 * r.basisTouching / r.basisTestable) : null;
  console.log([
    r.id, String(r.n), String(r.turns.size), fmt(cpuS, 1), fmt(100 * r.cpuMs / totalCpu, 1),
    r.n ? fmt(r.wallMs / r.n, 1) : '-', r.bytes ? fmt(r.bytes / 1048576, 1) : '-',
    dH === null ? 'n/a' : fmt(dH, 3), roi === null ? 'n/a' : fmt(roi, 2),
    nochg === null ? 'n/a' : fmt(nochg, 0), basis === null ? 'n/a' : fmt(basis, 0),
  ].map((v, i) => String(v).padEnd(W[i])).join(''));
}
console.log('');
// Most uncertainty-removing operators emit no durationMs, so ROI is only honest at lane scale:
// all bits measured in a phase over that phase's whole wall clock.
const lanes = new Map();
for (const o of OPERATORS) {
  const r = acc.get(o.id); if (!r) continue;
  const L = lanes.get(o.phase) || { bits: 0, ops: 0, inv: 0, measured: 0 };
  if (r.dHn) { L.bits += r.dH * (r.n / r.dHn); L.measured++; }
  L.ops++; L.inv += r.n;
  lanes.set(o.phase, L);
}
console.log('LANE ROI (bits removed by every instrumented operator in the lane / lane wall seconds)');
console.log('lane            wall_s   invocations  ops  ops_measured  bits      bits/s');
for (const [ph, L] of lanes) {
  const w = (turnStats.phase[ph] || 0) / 1000;
  console.log(ph.replace('Ms','').padEnd(15) + fmt(w,0).padStart(7) + String(L.inv).padStart(13) + String(L.ops).padStart(5) + String(L.measured).padStart(14) + fmt(L.bits,0).padStart(10) + (w>0?fmt(L.bits/w,3):'-').padStart(12));
}
console.log('');
console.log('dH_bits  mean log2(|hypotheses before|) - log2(|hypotheses after|), from the counters each operator writes.');
console.log('ROI_b/s  total bits removed (scaled to all invocations) per CPU-second attributed to the operator.');
console.log('nochg%   share of measurable invocations that left the hypothesis set the same size: a sound');
console.log('         lower bound on how often the operator could not have changed anything downstream.');
console.log('basis%   share of invocations whose surviving id set contains the final claim basis (upper bound');
console.log('         on decisiveness; n/a where the operator logs no hypothesis ids).');
console.log('ms/inv   wall ms, blank where the operator emits no durationMs (cost not instrumented).');
const noDur = rows.filter(r => r.noDuration === r.n && r.n > 0).map(r => r.id);
if (noDur.length) console.log(`\nNO DURATION RECORDED (cost unmeasurable from traces): ${noDur.join(', ')}`);

if (args.has('anchor-skip')) {
  const R = anchorRows;
  const cpuTotalAll = [...acc.values()].reduce((a, r) => a + r.cpuMs, 0) || 1;
  const cpu = R.reduce((a, r) => a + r.cpuMs, 0);
  const f1 = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  console.log('\n== anchor evidence search: per-invocation ==');
  console.log(`invocations=${R.length} cpu_s=${f1(cpu / 1000)} (${f1(100 * cpu / cpuTotalAll)}% of attributable) mean_ms=${f1(R.reduce((a, r) => a + r.ms, 0) / (R.length || 1))}`);
  const admKnown = R.filter(r => r.admitted !== null);
  const basisKnown = R.filter(r => r.basisSize > 0);
  console.log(`with paired admissibility=${admKnown.length}  with non-empty claim basis=${basisKnown.length}`);
  console.log(`gathered==afterProseFilter in ${R.filter(r => r.gathered === r.afterProse).length}/${R.length} (this is what T12's 100%% no-change measured: the code-span filter, NOT the search)`);
  const hist = {};
  for (const r of admKnown) { const k = r.admitted === 0 ? 'admitted=0' : r.basisHitsAdmitted ? 'admitted>0 & reached basis' : 'admitted>0 & basis untouched'; hist[k] = (hist[k] || 0) + 1; }
  console.log('outcome: ' + Object.entries(hist).map(([k, v]) => `${k}=${v}`).join('  '));
  // Outcome under test: "this invocation could not have improved the proof" = nothing it admitted reached the claim basis.
  const useful = r => r.admitted > 0 && r.basisHitsAdmitted;
  const P = {
    'A groups==0': r => r.groups === 0,
    'B no symbol group (symGroups==0)': r => r.symGroups === 0,
    'C groups==0 OR symGroups==0': r => r.groups === 0 || r.symGroups === 0,
    'D repeat request text (seen earlier)': null,
    'E gathered==0': r => r.gathered === 0,
    'F afterProse==0': r => r.afterProse === 0,
    'G features<=1': r => r.features <= 1,
    'H droppedScaffoldingGroups>0': r => r.dropped > 0,
  };
  const seen = new Set(); const repeat = new Map();
  for (const r of R) { const k = r.text.trim().toLowerCase(); repeat.set(r, seen.has(k)); seen.add(k); }
  P['D repeat request text (seen earlier)'] = r => repeat.get(r);
  const scope = admKnown.filter(r => r.basisSize > 0);
  console.log(`\nconfusion over ${scope.length} invocations that have BOTH a paired admissibility event and a non-empty claim basis`);
  console.log('precondition'.padEnd(38) + 'pred_skip  true_skip  FALSE_SKIP  cpu_s_saved  %cpu_sys  precision');
  for (const [name, fn] of Object.entries(P)) {
    const sel = scope.filter(fn);
    const bad = sel.filter(useful);
    const saved = sel.reduce((a, r) => a + r.cpuMs, 0) / 1000;
    console.log(name.padEnd(38) + String(sel.length).padEnd(11) + String(sel.length - bad.length).padEnd(11) + String(bad.length).padEnd(12) + f1(saved).padEnd(13) + f1(100 * saved * 1000 / cpuTotalAll).padEnd(10) + (sel.length ? f1(100 * (sel.length - bad.length) / sel.length) + '%' : '-'));
  }
  const u = scope.filter(useful);
  console.log(`\nbase rate: useful (admitted evidence reached the claim basis) = ${u.length}/${scope.length} = ${f1(100 * u.length / (scope.length || 1))}%  cpu_s=${f1(u.reduce((a, r) => a + r.cpuMs, 0) / 1000)}`);
  const nu = scope.filter(r => !useful(r));
  console.log(`not useful = ${nu.length}  cpu_s=${f1(nu.reduce((a, r) => a + r.cpuMs, 0) / 1000)} (${f1(100 * nu.reduce((a, r) => a + r.cpuMs, 0) / cpuTotalAll)}% of attributable CPU)`);
  console.log(`of the not-useful: admitted=0 in ${nu.filter(r => r.admitted === 0).length}, identityAbsent in ${nu.filter(r => r.identityAbsent).length}, gathered=0 in ${nu.filter(r => r.gathered === 0).length}`);
  if (args.get('anchor-json')) fs.writeFileSync(args.get('anchor-json'), JSON.stringify(R, null, 1));
}

if (args.has('anchor-skip')) {
  const R = anchorRows;
  const f1 = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  const cpuTotalAll = [...acc.values()].reduce((a, r) => a + r.cpuMs, 0) || 1;
  // Is the search a pure function of the request? Group identical request texts and ask whether the
  // gathered/admitted cardinalities are stable. Stability is the precondition a memo would need.
  const byText = new Map();
  for (const r of R) { const k = r.text.trim().toLowerCase(); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(r); }
  const groups = [...byText.values()].filter(g => g.length > 1);
  const stable = groups.filter(g => g.every(r => r.gathered === g[0].gathered && r.admitted === g[0].admitted));
  const repeatCpu = groups.reduce((a, g) => a + g.slice(1).reduce((b, r) => b + r.cpuMs, 0), 0);
  console.log('REPEATSn'.replace('n',''));
  console.log(`distinct request texts=${byText.size}  texts asked more than once=${groups.length}  repeat invocations=${R.length - byText.size}`);
  console.log(`repeat-invocation cpu=${f1(repeatCpu / 1000)}s = ${f1(100 * repeatCpu / cpuTotalAll)}% of attributable CPU`);
  console.log(`repeat groups with IDENTICAL gathered AND admitted counts across every repeat: ${stable.length}/${groups.length}`);
  const unstable = groups.filter(g => !stable.includes(g)).slice(0, 5);
  for (const g of unstable) console.log(`  unstable: ${JSON.stringify(g[0].text).slice(0, 54)} gathered=[${g.map(r => r.gathered).join(',')}] admitted=[${g.map(r => r.admitted).join(',')}]`);
  // Turns that produced no claim basis at all: how much did the search cost them?
  const noBasis = R.filter(r => r.basisSize === 0);
  console.log(`invocations on turns with NO claim basis: ${noBasis.length}  cpu=${f1(noBasis.reduce((a, r) => a + r.cpuMs, 0) / 1000)}s (${f1(100 * noBasis.reduce((a, r) => a + r.cpuMs, 0) / cpuTotalAll)}%)  of those, admitted>0 in ${noBasis.filter(r => r.admitted > 0).length}`);
  const byGroups = new Map();
  for (const r of R) { const k = Math.min(r.groups, 6); if (!byGroups.has(k)) byGroups.set(k, []); byGroups.get(k).push(r); }
  console.log('ms per invocation by anchor-group count: ' + [...byGroups.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${f1(v.reduce((a, r) => a + r.ms, 0) / v.length)}ms(n=${v.length})`).join(' '));
}

if (args.has('anchor-skip')) {
  const f1 = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  const cpuTotalAll = [...acc.values()].reduce((a, r) => a + r.cpuMs, 0) || 1;
  // Same process (one traceId = one server run, so one in-memory slice cache and one corpus state):
  // a second identical request there is the only repeat whose result is identical BY CONSTRUCTION.
  const perTrace = new Map();
  let sameProcRepeats = 0, sameProcCpu = 0, sameProcIdentical = 0, sameProcDiffer = 0;
  for (const r of anchorRows) {
    const k = r.traceId + '|' + r.text.trim().toLowerCase();
    if (perTrace.has(k)) {
      sameProcRepeats++; sameProcCpu += r.cpuMs;
      const first = perTrace.get(k);
      if (first.gathered === r.gathered && first.admitted === r.admitted) sameProcIdentical++; else sameProcDiffer++;
    } else perTrace.set(k, r);
  }
  console.log(`same-process repeat invocations of an identical request: ${sameProcRepeats}  cpu=${f1(sameProcCpu / 1000)}s (${f1(100 * sameProcCpu / cpuTotalAll)}% of attributable)`);
  console.log(`  of those, identical gathered+admitted as the first: ${sameProcIdentical}  differing: ${sameProcDiffer}`);
  // Oracle ceiling: skip every invocation whose admitted evidence never reached a claim basis.
  const oracle = anchorRows.filter(r => !(r.admitted > 0 && r.basisHitsAdmitted));
  console.log(`ORACLE ceiling (not achievable, needs the future): skip ${oracle.length}/${anchorRows.length} invocations = ${f1(oracle.reduce((a, r) => a + r.cpuMs, 0) / 1000)}s = ${f1(100 * oracle.reduce((a, r) => a + r.cpuMs, 0) / cpuTotalAll)}% of attributable CPU`);
}

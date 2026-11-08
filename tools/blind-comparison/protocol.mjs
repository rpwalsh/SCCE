import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify, sha256Text } from '../sealed-eval/harness/lib/util.mjs';
import { validateProcessPolicy } from './process-resources.mjs';

export const hash = value => sha256Text(stableStringify(value));
export const canonical = stableStringify;
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export async function writeJson(file, value) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex')}.pending`;
  await writeFile(temp, `${canonical(value)}\n`, { flag: 'wx' });
  try { await link(temp, file); } finally { await unlink(temp); }
}
export async function fileHash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
export async function* jsonLines(file, maxBytes) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: Math.min(maxBytes, 65536) })) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > maxBytes) throw new Error('JSONL row exceeds frozen byte budget');
      const line = pending.subarray(0, end).toString('utf8').trim();
      pending = pending.subarray(end + 1);
      if (line) yield JSON.parse(line);
    }
    if (pending.length > maxBytes) throw new Error('JSONL row exceeds frozen byte budget');
  }
  if (pending.length) yield JSON.parse(pending.toString('utf8'));
}
export function signed(body) { return { ...body, digest: hash(body) }; }
export function verified(value, expected) {
  const { digest, ...body } = value;
  if (digest !== hash(body) || (expected && digest !== expected)) throw new Error('Commitment mismatch');
  return body;
}
function keys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(`Invalid ${label} fields`);
}
function positive(n) { return Number.isSafeInteger(n) && n > 0; }
export function cellKey(v) { return canonical([v.category, v.language, v.grading]); }
export function validatePlan(plan) {
  if (plan.schema !== 'scce.blind-plan.v1' || !['rehearsal', 'heldout'].includes(plan.purpose)) throw new Error('Invalid comparison purpose');
  if (!Array.isArray(plan.cells) || !plan.cells.length || new Set(plan.cells.map(cellKey)).size !== plan.cells.length) throw new Error('Preregister unique coverage cells');
  for (const cell of plan.cells) if (!cell.category || !cell.language || !['semantic', 'native', 'human'].includes(cell.grading) || !positive(cell.count)) throw new Error('Invalid coverage cell');
  if (!plan.budgets || !['timeMs', 'outputBytes', 'caseBytes', 'artifactBytes', 'maxSteps'].every(k => positive(plan.budgets[k]))) throw new Error('Explicit positive shared budgets required');
  if (!plan.isolation || !['trusted-host', 'external-sandbox'].includes(plan.isolation.mode) || !plan.isolation.provider || !plan.isolation.limitations || !plan.isolation.attestationArtifact) throw new Error('Bind isolation provider, attestation and limitations');
  if (!Array.isArray(plan.artifacts) || !plan.artifacts.length || new Set(plan.artifacts.map(v => v.id)).size !== plan.artifacts.length) throw new Error('Pin all implementation, corpus, scorer and provider artifacts');
  const ids = new Set(plan.artifacts.map(v => v.id));
  for (const role of ['implementation', 'corpus', 'scorer', 'isolation']) if (!plan.artifacts.some(v => v.role === role)) throw new Error(`Missing ${role} pin`);
  if (!ids.has(plan.isolation.attestationArtifact)) throw new Error('Unpinned attestation');
  if (!Array.isArray(plan.systems) || plan.systems.length !== 2 || new Set(plan.systems.map(s => s.id)).size !== 2) throw new Error('Exactly two distinct systems required');
  for (const s of plan.systems) {
    if (!s.id || !s.adapterArtifact || !ids.has(s.adapterArtifact) || !s.identity || !Array.isArray(s.argv) || !s.argv.length || !s.argv.every(v => typeof v === 'string') || !Array.isArray(s.environmentKeys)) throw new Error('Invalid pinned system adapter');
    if (!Array.isArray(s.capabilities) || !s.preparation || !s.resourceIdentity || !s.environmentKeys.every(k => typeof k === 'string')) throw new Error('Declare capabilities, corpus preparation and resource identity');
    const adapter = plan.artifacts.find(a => a.id === s.adapterArtifact);
    if (!path.isAbsolute(adapter.path) || !s.argv.includes(adapter.path)) throw new Error('Command must invoke the pinned absolute adapter path');
  }
  if (plan.isolation.processMeasurement) {
    const policy = validateProcessPolicy(plan.isolation.processMeasurement);
    if (canonical(Object.keys(policy.systems).sort()) !== canonical(plan.systems.map(system => system.id).sort())) throw new Error('Process policy must declare both registered systems');
    if (!plan.artifacts.some(artifact => artifact.id === 'process-policy' && artifact.role === 'isolation')
      || !plan.artifacts.some(artifact => artifact.id === 'process-measurement-provider' && artifact.role === 'implementation')) throw new Error('Pin process policy and measurement provider before selection');
  }
  if (!Array.isArray(plan.judges) || !plan.judges.length || new Set(plan.judges).size !== plan.judges.length || plan.judges.some(j => typeof j !== 'string' || plan.systems.some(s => s.id === j))) throw new Error('Register independent human judges');
  if (plan.purpose === 'heldout') {
    if (!plan.artifacts.some(a => a.role === 'model') || !/^[a-f0-9]{64}$/u.test(plan.systems[1].expectedModelDigest ?? '') || plan.systems[1].identity.model !== 'qwen2.5:3b') throw new Error('Heldout comparison requires the pinned local Qwen model manifest and digest');
    const corpus = plan.artifacts.filter(a => a.role === 'corpus').map(a => a.id).sort();
    for (const s of plan.systems) {
      if (canonical(s.preparation.publicCorpusArtifacts?.slice().sort()) !== canonical(corpus) || !ids.has(s.preparation.receiptArtifact)) throw new Error('Both systems must attest access to every identical pinned public corpus');
    }
    const coverage = plan.artifacts.find(a => a.id === plan.coverageInventoryArtifact);
    if (!coverage || coverage.role !== 'coverage') throw new Error('Pin the independent required task/language inventory');
  }
  if (!plan.acceptance || !positive(plan.acceptance.minimumPairsPerCell) || !(plan.acceptance.maxLossesPerCell === 0) || plan.acceptance.requireStrictWinPerCell !== true || !(plan.acceptance.maximumOneSidedPPerCell > 0 && plan.acceptance.maximumOneSidedPPerCell < 0.5)) throw new Error('Preregister conservative cell gate and significance threshold');
}
export async function freeze(planFile, out) {
  const plan = await readJson(planFile);
  validatePlan(plan);
  const base = path.dirname(path.resolve(planFile));
  const artifacts = [];
  for (const a of plan.artifacts) artifacts.push({ ...a, path: path.resolve(base, a.path), sha256: await fileHash(path.resolve(base, a.path)) });
  if (plan.isolation.processMeasurement && canonical(await readJson(artifacts.find(artifact => artifact.id === 'process-policy').path)) !== canonical(plan.isolation.processMeasurement)) throw new Error('Process policy artifact differs from frozen plan');
  if (plan.purpose === 'heldout') await checkCoverage({ ...plan, artifacts });
  const value = signed({ schema: 'scce.blind-freeze.v1', plan: { ...plan, artifacts }, createdAt: new Date().toISOString() });
  await writeJson(out, value);
  return value;
}
export async function checkFreeze(file, expected) {
  const value = await readJson(file);
  verified(value, expected);
  validatePlan(value.plan);
  for (const a of value.plan.artifacts) if (await fileHash(a.path) !== a.sha256) throw new Error(`Changed pinned artifact: ${a.id}`);
  if (value.plan.purpose === 'heldout') await checkCoverage(value.plan);
  return value;
}
export function validateCase(row, plan) {
  keys(row, ['id', 'category', 'language', 'grading', 'public', 'private'], 'case');
  if (!row.id || !plan.cells.some(c => cellKey(c) === cellKey(row))) throw new Error('Case outside preregistered coverage');
  keys(row.public, ['steps', 'outputContract'], 'public case');
  if (typeof row.public.outputContract !== 'string') throw new Error('Public output contract must be text without private metadata fields');
  if (!Array.isArray(row.public.steps) || !row.public.steps.length || row.public.steps.length > plan.budgets.maxSteps) throw new Error('Invalid steps');
  for (const step of row.public.steps) {
    keys(step, ['prompt', 'sources', 'files'], 'public step');
    if (typeof step.prompt !== 'string' || !Array.isArray(step.sources) || !step.files || typeof step.files !== 'object' || Array.isArray(step.files)) throw new Error('Explicit public prompt, sources and files required');
    for (const s of step.sources) {
      keys(s, ['id', 'text'], 'public source');
      if (typeof s.id !== 'string' || typeof s.text !== 'string') throw new Error('Invalid source');
    }
    for (const [name, text] of Object.entries(step.files)) if (!safeRelative(name) || typeof text !== 'string') throw new Error('Unsafe public file');
  }
  if (!row.private || row.private.kind !== row.grading) throw new Error('Private grader must match preregistration');
  if (row.grading === 'semantic' && (!Array.isArray(row.private.expected) || row.private.expected.length !== row.public.steps.length)) throw new Error('Exact semantic result required for every step');
  if (row.grading === 'human' && (!Array.isArray(row.private.dimensions) || !row.private.dimensions.length || !row.private.rubric)) throw new Error('Private human rubric required');
  if (row.grading === 'native' && (!Array.isArray(row.private.argv) || !row.private.argv.length || !Array.isArray(row.private.files) || !row.private.files.length)) throw new Error('Pinned native checks required');
}
export function safeRelative(name) {
  return typeof name === 'string' && name.length > 0 && !path.isAbsolute(name) && !/[:\\\0]/u.test(name) && name.split('/').every(v => v !== '..' && v !== '.' && v.length && !/[. ]$/u.test(v));
}
async function checkCoverage(plan) {
  const inventory = await readJson(plan.artifacts.find(a => a.id === plan.coverageInventoryArtifact).path);
  if (!Array.isArray(inventory.cells) || !inventory.cells.length || new Set(inventory.cells.map(cellKey)).size !== inventory.cells.length) throw new Error('Invalid independent coverage inventory');
  for (const cell of inventory.cells) if (!plan.cells.some(c => cellKey(c) === cellKey(cell))) throw new Error(`Missing required coverage cell: ${cellKey(cell)}`);
}
export async function seal({ freezeFile, freezeDigest, poolFile, seedFile, outDir }) {
  if (!freezeDigest) throw new Error('Custodian must supply independently recorded freeze digest');
  const frozen = await checkFreeze(freezeFile, freezeDigest);
  const seed = (await readFile(seedFile, 'utf8')).trim();
  if (!seed) throw new Error('Custodian seed required after freeze');
  const plan = frozen.plan;
  const selected = new Map(plan.cells.map(c => [cellKey(c), []]));
  let previousId = '';
  for await (const row of jsonLines(poolFile, plan.budgets.caseBytes)) {
    validateCase(row, plan);
    if (typeof row.id !== 'string' || row.id <= previousId) throw new Error('Pool IDs must be unique and sorted lexicographically');
    previousId = row.id;
    const key = cellKey(row);
    const cell = plan.cells.find(c => cellKey(c) === key);
    const rows = selected.get(key);
    rows.push({ rank: hash([seed, row.id]), row });
    rows.sort((a, b) => a.rank.localeCompare(b.rank));
    if (rows.length > cell.count) rows.pop();
  }
  const publicCases = [], privateCases = [];
  for (const cell of plan.cells) {
    const rows = selected.get(cellKey(cell));
    if (rows.length < cell.count) throw new Error(`Insufficient heldout pool: ${cellKey(cell)}`);
    for (const { row } of rows) {
      const packet = { id: row.id, category: row.category, language: row.language, grading: row.grading, ...row.public };
      const checks = [];
      for (const f of row.private.files ?? []) {
        if (!safeRelative(f.target) || f.target === 'submission.json' || checks.some(c => c.target.toLowerCase() === f.target.toLowerCase())) throw new Error('Unsafe or duplicate validator target');
        const source = path.resolve(path.dirname(path.resolve(poolFile)), f.path);
        checks.push({ target: f.target, path: source, sha256: await fileHash(source) });
      }
      const privateCase = { ...row, private: { ...row.private, files: checks }, packetHash: hash(packet) };
      publicCases.push({ id: row.id, digest: hash(packet), privateDigest: hash(privateCase) });
      privateCases.push(privateCase);
      await writeJson(path.join(outDir, 'public', 'cases', `${hash(row.id)}.json`), packet);
    }
  }
  const body = { schema: 'scce.blind-bundle.v1', freezeDigest, purpose: plan.purpose, plan, poolDigest: await fileHash(poolFile), seedCommitment: hash(seed), cases: publicCases };
  const bundle = signed(body);
  await writeJson(path.join(outDir, 'public', 'bundle.json'), bundle);
  await writeJson(path.join(outDir, 'private', 'key.json'), signed({ schema: 'scce.blind-key.v1', bundleDigest: bundle.digest, seed, poolFile: path.resolve(poolFile), cases: privateCases }));
  return bundle;
}
export async function checkBundle(bundleFile, expected) {
  if (!expected) throw new Error('Independently recorded bundle digest required');
  const bundle = await readJson(bundleFile);
  verified(bundle, expected);
  validatePlan(bundle.plan);
  for (const a of bundle.plan.artifacts) if (await fileHash(a.path) !== a.sha256) throw new Error(`Changed pinned artifact: ${a.id}`);
  if (bundle.plan.purpose === 'heldout') await checkCoverage(bundle.plan);
  return bundle;
}
export async function packetFor(bundleFile, entry, budget) {
  const file = path.join(path.dirname(bundleFile), 'cases', `${hash(entry.id)}.json`);
  const handle = await open(file);
  try { if ((await handle.stat()).size > budget) throw new Error('Oversized public case'); } finally { await handle.close(); }
  const packet = await readJson(file);
  if (hash(packet) !== entry.digest) throw new Error('Public case changed');
  return packet;
}

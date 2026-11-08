import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, hash, fileHash, signed, verified, readJson, writeJson, checkBundle, packetFor, cellKey, safeRelative } from './protocol.mjs';
import { readReceipt, verifyRun, checkCheckpoint, execute, materializeFiles } from './runner.mjs';

async function loadCustody(options) {
  const bundle = await checkBundle(options.bundleFile, options.bundleDigest);
  await verifyRun(bundle, options.bundleFile, options.out);
  await checkCheckpoint(options.checkpointFile, options.checkpointDigest, bundle, options.out);
  const key = await readJson(options.keyFile);
  verified(key);
  if (key.bundleDigest !== bundle.digest || hash(key.seed) !== bundle.seedCommitment || await fileHash(key.poolFile) !== bundle.poolDigest) throw new Error('Private custody changed');
  if (key.cases.length !== bundle.cases.length) throw new Error('Private case count changed');
  for (const entry of bundle.cases) {
    const row = key.cases.find(v => v.id === entry.id);
    if (!row || hash(row) !== entry.privateDigest || row.packetHash !== entry.digest) throw new Error('Private gold or rubric changed');
    for (const f of row.private.files ?? []) if (await fileHash(f.path) !== f.sha256) throw new Error('Private native validator changed');
  }
  return { bundle, key };
}
function orderFor(bundle, key, id) { return parseInt(hash([key.seed, 'ballot-order', id]).slice(0, 8), 16) % 2 ? [1, 0] : [0, 1]; }
function ballotId(bundle, id) { return hash([bundle.digest, 'ballot', id]); }
export async function blind(options) {
  const { bundle, key } = await loadCustody(options);
  const ballots = [];
  for (const entry of bundle.cases) {
    const row = key.cases.find(v => v.id === entry.id);
    if (row.grading !== 'human') continue;
    const packet = await packetFor(options.bundleFile, entry, bundle.plan.budgets.caseBytes);
    const responses = [];
    for (const side of orderFor(bundle, key, row.id)) {
      const r = await readReceipt(options.out, row.id, bundle.plan.systems[side].id);
      responses.push(r?.status === 'ok' ? r.outputs.map(v => v.response) : null);
    }
    const ballot = { ballotId: ballotId(bundle, row.id), category: row.category, language: row.language, public: packet, rubric: row.private.rubric, dimensions: row.private.dimensions, A: responses[0], B: responses[1] };
    await writeJson(path.join(options.ballotsDir, `${ballot.ballotId}.json`), ballot);
    ballots.push(ballot.ballotId);
  }
  await writeJson(path.join(options.ballotsDir, 'index.json'), { schema: 'scce.blind-ballots.v1', bundleDigest: bundle.digest, ballots });
  return { ballots: ballots.length };
}
async function nativeCheck(row, packet, receipt, options, budgets) {
  const root = path.resolve(options.out, 'private-checks');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, `${hash([row.id, receipt.systemId, receipt.digest])}-`));
  const files = materializeFiles(packet.steps, receipt.outputs);
  const targets = new Set(row.private.files.map(f => f.target));
  for (const [name, text] of Object.entries(files)) {
    if (!safeRelative(name) || targets.has(name) || name === 'submission.json') return { pass: false, reason: 'validator-collision' };
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  for (const f of row.private.files) {
    await mkdir(path.dirname(path.join(dir, f.target)), { recursive: true });
    await writeFile(path.join(dir, f.target), await readFile(f.path));
  }
  await writeFile(path.join(dir, 'submission.json'), canonical(receipt.outputs.map(v => v.response)));
  const argv = row.private.argv.map(v => v === '{node}' ? process.execPath : v);
  const result = await execute(argv, { cwd: dir, input: '', timeMs: budgets.timeMs, outputBytes: budgets.outputBytes });
  return { pass: result.code === 0 && !result.failure, reason: result.failure ?? (result.code === 0 ? null : 'native-check-failed'), exitCode: result.code, transcriptHash: hash([result.stdout, result.stderr]) };
}
export function semanticCheck(expected, outputs) {
  if (outputs.length !== expected.length) return { pass: false, reason: 'incomplete-steps' };
  for (let i = 0; i < expected.length; i++) {
    let actual;
    try { actual = JSON.parse(outputs[i].response.answer); } catch { return { pass: false, reason: 'invalid-semantic-json' }; }
    if (canonical(actual) !== canonical(expected[i])) return { pass: false, reason: 'semantic-contract-mismatch', step: i };
  }
  return { pass: true, reason: null };
}
function validateRating(r, row, plan) {
  if (!r.judgeId || !plan.judges?.includes(r.judgeId) || r.humanAttestation !== true || !['A', 'B', 'tie'].includes(r.preference) || !r.rationale) throw new Error('Independent human ballot required');
  for (const side of ['A', 'B']) for (const dimension of row.private.dimensions) if (!Number.isInteger(r.scores?.[side]?.[dimension]) || r.scores[side][dimension] < 0 || r.scores[side][dimension] > 4) throw new Error('Incomplete rubric scores');
}
export async function grade(options) {
  const { bundle, key } = await loadCustody(options);
  let ratings = [], ratingsDigest = null;
  if (options.ratingsFile) {
    ratingsDigest = await fileHash(options.ratingsFile);
    if (!options.ratingsDigest || ratingsDigest !== options.ratingsDigest) throw new Error('Independent ratings digest required');
    ratings = await readJson(options.ratingsFile);
    if (!Array.isArray(ratings) || new Set(ratings.map(r => r.ballotId)).size !== ratings.length) throw new Error('Duplicate or malformed ballots');
    const eligible = new Set(key.cases.filter(r => r.grading === 'human').map(r => ballotId(bundle, r.id)));
    if (ratings.some(r => !eligible.has(r.ballotId))) throw new Error('Unknown ballot');
  }
  const cells = bundle.plan.cells.map(c => ({ ...c, pairs: 0, wins: 0, ties: 0, losses: 0, missing: 0, errors: 0, ungraded: 0, cases: [] }));
  for (const entry of bundle.cases) {
    const row = key.cases.find(v => v.id === entry.id);
    const cell = cells.find(c => cellKey(c) === cellKey(row));
    const packet = await packetFor(options.bundleFile, entry, bundle.plan.budgets.caseBytes);
    const receipts = [];
    for (const system of bundle.plan.systems) receipts.push(await readReceipt(options.out, row.id, system.id));
    let outcome, details = [];
    if (receipts.some(r => !r)) outcome = 'missing';
    else if (receipts.some(r => r.status !== 'ok')) outcome = 'errors';
    else if (row.grading === 'human') {
      const rating = ratings.find(r => r.ballotId === ballotId(bundle, row.id));
      if (!rating) outcome = 'ungraded';
      else {
        validateRating(rating, row, bundle.plan);
        const order = orderFor(bundle, key, row.id);
        const winner = rating.preference === 'tie' ? null : order[rating.preference === 'A' ? 0 : 1];
        outcome = winner === null ? 'ties' : winner === 0 ? 'wins' : 'losses';
        details = [{ judgeId: rating.judgeId, ballotId: rating.ballotId, preference: rating.preference, scores: rating.scores, rationale: rating.rationale }];
      }
    } else {
      for (const r of receipts) {
        try { details.push(row.grading === 'semantic' ? semanticCheck(row.private.expected, r.outputs) : await nativeCheck(row, packet, r, options, bundle.plan.budgets)); }
        catch (e) { details.push({ pass: false, infrastructureError: true, reason: e.message }); }
      }
      outcome = details.some(v => v.infrastructureError) ? 'errors' : details[0].pass === details[1].pass ? 'ties' : details[0].pass ? 'wins' : 'losses';
    }
    cell[outcome]++;
    if (['wins', 'ties', 'losses'].includes(outcome)) cell.pairs++;
    cell.cases.push({ id: row.id, outcome, details, systemErrors: receipts.map(r => r?.error ?? null) });
  }
  for (const cell of cells) {
    const decisive = cell.wins + cell.losses;
    cell.signTestOneSidedP = decisive ? binomialTail(cell.wins, decisive) : 1;
    cell.passesPreregisteredGate = !cell.missing && !cell.errors && !cell.ungraded && !cell.losses && cell.wins > 0 && cell.pairs >= bundle.plan.acceptance.minimumPairsPerCell && cell.signTestOneSidedP <= bundle.plan.acceptance.maximumOneSidedPPerCell;
  }
  const eligible = bundle.purpose === 'heldout' && cells.every(c => c.passesPreregisteredGate);
  const report = signed({ schema: 'scce.blind-report.v1', bundleDigest: bundle.digest, checkpointDigest: options.checkpointDigest, ratingsDigest, purpose: bundle.purpose, systems: bundle.plan.systems.map(s => ({ id: s.id, identity: s.identity })), isolation: bundle.plan.isolation, testedScopeOnly: true, comparativeGatePassed: eligible, claim: eligible ? 'Preregistered finite-scope gate passed; inspect every cell and confidence before interpreting.' : 'No superiority established.', cells });
  await writeJson(options.reportFile, report);
  return report;
}
function binomialTail(wins, n) {
  let logTerm = -n * Math.log(2), sum = 0;
  for (let i = 0; i <= n; i++) { if (i >= wins) sum += Math.exp(logTerm); logTerm += Math.log(n - i) - Math.log(i + 1); }
  return sum;
}

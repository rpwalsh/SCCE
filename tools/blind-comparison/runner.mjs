import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile, open, access } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { counterbalancedOrder } from '../head-to-head/measure.mjs';
import { hash, canonical, checkBundle, packetFor, signed, verified, readJson, writeJson, safeRelative, jsonLines } from './protocol.mjs';

export function scrubEnvironment(keys = []) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', ...keys]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
export function materializeFiles(steps, outputs) {
  const files = Object.create(null);
  for (let index = 0; index < steps.length; index++) {
    Object.assign(files, steps[index].files);
    if (outputs[index]) Object.assign(files, outputs[index].response.artifacts);
  }
  return files;
}
export async function execute(argv, { cwd, input, timeMs, outputBytes, environmentKeys = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: scrubEnvironment(environmentKeys), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    function stop(reason) {
      failure ??= reason;
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      else child.kill('SIGKILL');
    }
    const timer = setTimeout(() => stop('time-budget'), timeMs);
    function consume(kind, chunk) {
      bytes += chunk.length;
      if (bytes > outputBytes) return stop('output-budget');
      if (kind === 'stdout') stdout += decoders.stdout.write(chunk); else stderr += decoders.stderr.write(chunk);
    }
    child.stdout.on('data', c => consume('stdout', c));
    child.stderr.on('data', c => consume('stderr', c));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); resolve({ code, stdout, stderr, bytes, failure }); });
    child.stdin.end(input);
  });
}
async function putFiles(dir, files, budget) {
  let bytes = 0;
  for (const [name, text] of Object.entries(files)) {
    if (!safeRelative(name) || typeof text !== 'string') throw new Error('Unsafe artifact');
    bytes += Buffer.byteLength(text);
    if (bytes > budget) throw new Error('artifact-budget');
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, { flag: 'wx' });
  }
}
export function receiptName(caseId, systemId) { return `${hash([caseId, systemId])}.json`; }
export async function readReceipt(out, caseId, systemId) {
  const file = path.join(out, 'receipts', receiptName(caseId, systemId));
  try { const receipt = await readJson(file); verified(receipt); return receipt; } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export async function checkJournal(out, bundleDigest, shard) {
  const journal = path.join(out, `journal-${shard}.jsonl`);
  let previous = bundleDigest;
  const digests = new Map();
  let exists = true;
  try { await access(journal); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  if (exists) {
    for await (const event of jsonLines(journal, 65536)) {
      verified(event);
      if (event.previous !== previous || event.bundleDigest !== bundleDigest) throw new Error('Journal chain changed');
      previous = event.digest;
      if (digests.has(event.receipt)) throw new Error('Duplicate journal receipt');
      digests.set(event.receipt, event.receiptDigest);
      const receipt = await readJson(path.join(out, 'receipts', event.receipt));
      verified(receipt, event.receiptDigest);
    }
  }
  return { previous, digests, journal };
}
function assertReceipt(receipt, bundle, packet, system) {
  if (receipt.bundleDigest !== bundle.digest || receipt.caseId !== packet.id || receipt.systemId !== system.id || receipt.packetHash !== hash(packet) || receipt.budgetsHash !== hash(bundle.plan.budgets) || receipt.systemHash !== hash(system)) throw new Error('Asymmetric or foreign receipt');
  if (receipt.status === 'ok' && receipt.outputs.length !== packet.steps.length) throw new Error('Incomplete accepted output');
  for (let stepIndex = 0; stepIndex < receipt.outputs.length; stepIndex++) {
    const shared = { schema: 'scce.blind-input.v1', caseId: packet.id, category: packet.category, language: packet.language, outputContract: packet.outputContract, steps: packet.steps.slice(0, stepIndex + 1), budgets: bundle.plan.budgets, isolation: bundle.plan.isolation };
    if (receipt.outputs[stepIndex].publicInputHash !== hash(shared)) throw new Error('Recorded public context changed');
  }
}
export async function collect({ bundleFile, bundleDigest, out, shardIndex = 0, shardCount = 1 }) {
  if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount) || shardCount <= 0 || shardIndex < 0 || shardIndex >= shardCount) throw new Error('Invalid shard');
  const bundle = await checkBundle(bundleFile, bundleDigest);
  const { plan } = bundle;
  await mkdir(out, { recursive: true });
  const runIdentity = signed({ bundleDigest, shardCount });
  try { await writeJson(path.join(out, 'run.json'), runIdentity); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (canonical(await readJson(path.join(out, 'run.json'))) !== canonical(runIdentity)) throw new Error('Run or shard count changed');
  }
  const lock = await open(path.join(out, `shard-${shardIndex}.lock`), 'wx');
  try {
    const state = await checkJournal(out, bundleDigest, shardIndex);
    for (let index = shardIndex; index < bundle.cases.length; index += shardCount) {
      const packet = await packetFor(bundleFile, bundle.cases[index], plan.budgets.caseBytes);
      for (const system of counterbalancedOrder(index, plan.systems)) {
        const name = receiptName(packet.id, system.id);
        const prior = await readReceipt(out, packet.id, system.id);
        if (prior) assertReceipt(prior, bundle, packet, system);
        if (state.digests.has(name)) {
          if (!prior || state.digests.get(name) !== prior.digest) throw new Error('Receipt missing or changed');
          continue;
        }
        let receipt = prior;
        if (!receipt) {
          const started = performance.now();
          const outputs = [];
          let status = 'ok', error = null, outputBytes = 0, submittedArtifactBytes = 0;
          const workspace = path.resolve(out, 'work', hash([packet.id, system.id, Date.now(), Math.random()]));
          await mkdir(workspace, { recursive: true });
          try {
            if (!system.capabilities.includes(packet.category)) throw new Error('unsupported-category');
            for (let stepIndex = 0; stepIndex < packet.steps.length; stepIndex++) {
              const publicSteps = packet.steps.slice(0, stepIndex + 1);
              const remaining = Math.floor(plan.budgets.timeMs - (performance.now() - started));
              if (remaining <= 0) throw new Error('time-budget');
              const stepDir = path.join(workspace, String(stepIndex));
              await mkdir(stepDir);
              const files = materializeFiles(publicSteps, outputs);
              await putFiles(stepDir, files, plan.budgets.artifactBytes);
              const shared = { schema: 'scce.blind-input.v1', caseId: packet.id, category: packet.category, language: packet.language, outputContract: packet.outputContract, steps: publicSteps, budgets: plan.budgets, isolation: plan.isolation };
              const input = { ...shared, history: outputs.map(o => o.response) };
              const executionRemaining = Math.floor(plan.budgets.timeMs - (performance.now() - started));
              if (executionRemaining <= 0 || outputBytes >= plan.budgets.outputBytes) throw new Error('case-budget');
              const result = await execute(system.argv, { cwd: stepDir, input: `${canonical(input)}\n`, timeMs: executionRemaining, outputBytes: plan.budgets.outputBytes - outputBytes, environmentKeys: system.environmentKeys });
              outputBytes += result.bytes;
              if (result.failure || result.code !== 0) throw new Error(result.failure ?? 'adapter-exit');
              const lines = result.stdout.trim().split(/\r?\n/u);
              if (lines.length !== 1) throw new Error('Adapter must return exactly one JSON object');
              const response = JSON.parse(lines[0]);
              if (!response || typeof response.answer !== 'string' || !['ok', 'unsupported', 'error'].includes(response.status)) throw new Error('Invalid adapter response');
              if (response.status !== 'ok') throw new Error(response.status);
              if (system.expectedModelDigest && response.identity?.modelDigest !== system.expectedModelDigest) throw new Error('Model identity changed');
              const artifacts = response.artifacts ?? {};
              if (typeof artifacts !== 'object' || Array.isArray(artifacts)) throw new Error('Invalid artifact map');
              for (const value of Object.values(artifacts)) {
                if (typeof value !== 'string') throw new Error('Invalid artifact text');
                submittedArtifactBytes += Buffer.byteLength(value);
              }
              if (submittedArtifactBytes > plan.budgets.artifactBytes) throw new Error('artifact-budget');
              if (Object.keys(artifacts).length) await putFiles(path.join(stepDir, 'submitted'), artifacts, plan.budgets.artifactBytes);
              outputs.push({ publicInputHash: hash(shared), response: { status: 'ok', answer: response.answer, artifacts }, identity: response.identity ?? null });
              if (performance.now() - started > plan.budgets.timeMs) throw new Error('time-budget');
            }
          } catch (e) { status = 'error'; error = e.message; }
          receipt = signed({ schema: 'scce.blind-receipt.v1', bundleDigest, caseId: packet.id, systemId: system.id, packetHash: hash(packet), budgetsHash: hash(plan.budgets), systemHash: hash(system), status, error, outputs, elapsedMs: performance.now() - started, measured: { outputBytes, submittedArtifactBytes } });
          await writeJson(path.join(out, 'receipts', name), receipt);
        }
        const event = signed({ bundleDigest, previous: state.previous, receipt: name, receiptDigest: receipt.digest });
        await appendFile(state.journal, `${canonical(event)}\n`);
        state.previous = event.digest;
        state.digests.set(name, receipt.digest);
      }
    }
    return { bundleDigest, shardIndex, shardCount, journalHead: state.previous, receipts: state.digests.size };
  } finally {
    await lock.close();
    const { unlink } = await import('node:fs/promises');
    await unlink(path.join(out, `shard-${shardIndex}.lock`));
  }
}
export async function verifyRun(bundle, bundleFile, out) {
  const run = await readJson(path.join(out, 'run.json'));
  verified(run);
  if (run.bundleDigest !== bundle.digest) throw new Error('Run identity changed');
  const logged = new Map();
  for (let shard = 0; shard < run.shardCount; shard++) {
    const state = await checkJournal(out, bundle.digest, shard);
    for (const pair of state.digests) { if (logged.has(pair[0])) throw new Error('Cross-shard duplicate'); logged.set(...pair); }
  }
  for (const entry of bundle.cases) {
    const packet = await packetFor(bundleFile, entry, bundle.plan.budgets.caseBytes);
    const receipts = [];
    for (const system of bundle.plan.systems) {
      const receipt = await readReceipt(out, packet.id, system.id);
      if (receipt) {
        assertReceipt(receipt, bundle, packet, system);
        if (logged.get(receiptName(packet.id, system.id)) !== receipt.digest) throw new Error('Receipt not committed in journal');
      }
      receipts.push(receipt);
    }
    if (receipts.every(r => r?.status === 'ok')) {
      if (canonical(receipts[0].outputs.map(v => v.publicInputHash)) !== canonical(receipts[1].outputs.map(v => v.publicInputHash))) throw new Error('Unequal public context');
    }
  }
}
export async function checkpoint({ bundleFile, bundleDigest, out, checkpointFile }) {
  const bundle = await checkBundle(bundleFile, bundleDigest);
  await verifyRun(bundle, bundleFile, out);
  const run = await readJson(path.join(out, 'run.json'));
  const heads = [];
  for (let shard = 0; shard < run.shardCount; shard++) heads.push((await checkJournal(out, bundleDigest, shard)).previous);
  const value = signed({ schema: 'scce.blind-checkpoint.v1', bundleDigest, heads });
  await writeJson(checkpointFile, value);
  return value;
}
export async function checkCheckpoint(file, expected, bundle, out) {
  if (!expected) throw new Error('Independent collection checkpoint digest required');
  const value = await readJson(file);
  verified(value, expected);
  if (value.bundleDigest !== bundle.digest) throw new Error('Wrong checkpoint bundle');
  const run = await readJson(path.join(out, 'run.json'));
  if (value.heads.length !== run.shardCount) throw new Error('Checkpoint shard mismatch');
  for (let shard = 0; shard < run.shardCount; shard++) if ((await checkJournal(out, bundle.digest, shard)).previous !== value.heads[shard]) throw new Error('Collection changed since checkpoint');
}

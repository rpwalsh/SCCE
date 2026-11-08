import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { freeze, seal, writeJson } from './protocol.mjs';
import { collect, checkpoint } from './runner.mjs';
import { blind, grade } from './grading.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export async function smoke(out) {
  out = path.resolve(out);
  await mkdir(out, { recursive: true });
  const adapter = path.join(here, 'smoke/fixture-adapter.mjs');
  const validator = path.join(here, 'smoke/native-check.cjs');
  const categories = ['chat', 'creative', 'corpus_facts', 'code', 'agentic', 'learning_updates'];
  const cells = categories.map(category => ({ category, language: category === 'code' ? 'javascript' : 'en', grading: ['chat', 'creative'].includes(category) ? 'human' : category === 'code' ? 'native' : 'semantic', count: 1 }));
  const plan = { schema: 'scce.blind-plan.v1', purpose: 'rehearsal', cells, budgets: { timeMs: 10000, outputBytes: 65536, caseBytes: 131072, artifactBytes: 65536, maxSteps: 3 }, isolation: { mode: 'trusted-host', provider: 'Node child processes on the operator host', attestationArtifact: 'isolation', limitations: 'No OS file, network, descendant-process, CPU or memory sandbox. Rehearsal only.' }, artifacts: [
    { id: 'implementation', role: 'implementation', path: path.join(here, 'runner.mjs') },
    { id: 'protocol', role: 'implementation', path: path.join(here, 'protocol.mjs') },
    { id: 'scorer', role: 'scorer', path: path.join(here, 'grading.mjs') },
    { id: 'corpus', role: 'corpus', path: adapter },
    { id: 'adapter', role: 'adapter', path: adapter },
    { id: 'node', role: 'implementation', path: process.execPath },
    { id: 'isolation', role: 'isolation', path: path.join(here, 'README.md') }
  ], systems: ['candidate-fixture', 'reference-fixture'].map((id, i) => ({ id, adapterArtifact: 'adapter', argv: [process.execPath, adapter, ...(i ? ['--fault'] : [])], environmentKeys: [], identity: 'Deterministic rehearsal fixture; neither SCCE nor Qwen', preparation: 'Identical public packets only', resourceIdentity: 'Same operator Node binary and host', capabilities: categories })), judges: ['independent-judge'], acceptance: { minimumPairsPerCell: 1, maxLossesPerCell: 0, requireStrictWinPerCell: true, maximumOneSidedPPerCell: 0.05 } };
  const pool = cells.map(cell => {
    const steps = cell.category === 'code' ? [{ prompt: 'Repair addition in module.cjs, preserving its interface. Return the complete changed file.', sources: [], files: { 'module.cjs': 'module.exports = (a, b) => a - b;\n' } }]
      : ['chat', 'creative'].includes(cell.category) ? [{ prompt: cell.category === 'chat' ? 'Explain a practical way to keep a shared project organized.' : 'Write a short scene about two neighbors sharing a lost umbrella.', sources: [], files: {} }]
      : [{ prompt: 'station', sources: [{ id: 'public-log', text: '{"station":"Larch"}' }], files: {} }, { prompt: cell.category === 'learning_updates' ? 'station' : 'unknown-station', sources: cell.category === 'learning_updates' ? [{ id: 'public-correction', text: '{"station":"Birch"}' }] : [], files: {} }];
    const secret = cell.grading === 'native' ? { kind: 'native', argv: ['{node}', 'private-check.cjs'], files: [{ path: validator, target: 'private-check.cjs' }] }
      : cell.grading === 'human' ? { kind: 'human', dimensions: ['task_fulfillment', 'coherence', 'specificity'], rubric: 'Independently rate each dimension 0 (absent) to 4 (fully achieved), then choose the better complete response or tie. For creative work assess narrative coherence and concrete detail; for chat assess useful, accurate advice. Do not infer system identity.' }
      : { kind: 'semantic', expected: [{ value: 'Larch', supported: true }, cell.category === 'learning_updates' ? { value: 'Birch', supported: true } : { value: null, supported: false }] };
    return { id: cell.category, ...cell, count: undefined, public: { steps, outputContract: cell.grading === 'semantic' ? 'Exact JSON object with value and supported; null/false when not in public data.' : cell.grading === 'native' ? 'Return JSON answer and artifacts with complete module.cjs.' : 'Plain text.' }, private: secret };
  }).sort((a, b) => a.id.localeCompare(b.id));
  await writeJson(path.join(out, 'plan.json'), plan);
  await writeFile(path.join(out, 'pool.jsonl'), pool.map(v => JSON.stringify(v)).join('\n') + '\n', { flag: 'wx' });
  await writeFile(path.join(out, 'seed.txt'), 'Rehearsal seed, intentionally public; never used as blind evidence.\n', { flag: 'wx' });
  const frozen = await freeze(path.join(out, 'plan.json'), path.join(out, 'freeze.json'));
  const bundle = await seal({ freezeFile: path.join(out, 'freeze.json'), freezeDigest: frozen.digest, poolFile: path.join(out, 'pool.jsonl'), seedFile: path.join(out, 'seed.txt'), outDir: path.join(out, 'sealed') });
  const options = { bundleFile: path.join(out, 'sealed/public/bundle.json'), bundleDigest: bundle.digest, out: path.join(out, 'run'), keyFile: path.join(out, 'sealed/private/key.json'), checkpointFile: path.join(out, 'checkpoint.json'), ballotsDir: path.join(out, 'ballots'), reportFile: path.join(out, 'report.json') };
  await collect(options);
  options.checkpointDigest = (await checkpoint(options)).digest;
  await blind(options);
  const report = await grade(options);
  return { ...options, reportDigest: report.digest, comparativeGatePassed: report.comparativeGatePassed };
}

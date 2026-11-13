#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, cp, readdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { argsMap } from '../sealed-eval/harness/lib/util.mjs';
import { canonical, hash, readJson, writeJson, signed, verified, freeze, seal, checkFreeze, fileHash } from './protocol.mjs';
import { collect, checkpoint, execute, readReceipt } from './runner.mjs';
import { blind, grade } from './grading.mjs';
import { discoverCampaign, discoverConfig, implementationFiles, REPOSITORY_ROOT } from './campaign-discovery.mjs';
import { admitReference } from './campaign-reference-admission.mjs';
import { verifyCandidateFinalization } from './candidate-finalization.mjs';
import { resolveProcessPolicy } from './process-resources.mjs';
import { defaultInventory, coverageGaps, createDefaultPool, CATEGORY_GROUPS } from './providers/default/cases.mjs';
import { loadRetainedCorpus, createRetainedPool } from './providers/retained-cases.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const providerDir = path.join(here, 'providers', 'default');
export function campaignOptions(overrides = {}) {
  const diagnostic = overrides.diagnostic === true;
  const options = { diagnostic, count: overrides.retainedCorpusFile ? 5 : diagnostic ? 2 : 12, attempts: 2, hiddenVectors: 12, toolCalls: 8, device: 'auto', contextTokens: 32768, outputTokens: 4096, seed: 0, budgets: { timeMs: 180000, outputBytes: 2 * 1024 * 1024, caseBytes: 4 * 1024 * 1024, artifactBytes: 2 * 1024 * 1024, maxSteps: 4 }, ...overrides };
  if (options.retainedCorpusFile ? !Number.isSafeInteger(options.count) || options.count < 1 : !Number.isSafeInteger(options.count) || options.count < 2 || options.count % 2) throw new Error('Preregister a positive retained cloze count, or an even default per-cell count >=2');
  for (const key of ['attempts', 'hiddenVectors', 'toolCalls', 'contextTokens', 'outputTokens']) if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new Error(`Invalid campaign setting: ${key}`);
  for (const key of ['threads', 'maxReferenceModelBytes']) if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] < 1)) throw new Error(`Invalid campaign resource setting: ${key}`);
  return options;
}
function inside(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
export async function prepareCampaign(raw, dependencies = {}) {
  const options = campaignOptions(raw), out = path.resolve(options.out);
  if (!out || out === REPOSITORY_ROOT) throw new Error('Choose a new campaign output directory');
  await mkdir(out, { recursive: true });
  const discovery = await (dependencies.discover ?? discoverCampaign)(options);
  const candidateFinalization = verifyCandidateFinalization(discovery.finalization);
  const processPolicy = options.processPolicyFile ? await (dependencies.processPolicy ?? resolveProcessPolicy)(await readJson(options.processPolicyFile)) : null;
  if (discovery.config.allowedRoots?.length && !discovery.config.allowedRoots.some(root => inside(root, out))) throw new Error('Public output must be inside a configured allowed workspace root for native product routes');
  const capabilities = await readJson(path.join(providerDir, 'capabilities.json'));
  const admittedFiles = [...(options.admittedManifests ?? [])];
  const automaticInventory = path.join(REPOSITORY_ROOT, '.tmp', 'admitted-language-inventory.json');
  if (!admittedFiles.length) try { await access(automaticInventory); admittedFiles.push(automaticInventory); } catch {}
  const admitted = [];
  for (const file of admittedFiles) admitted.push(await readJson(file));
  const retainedCorpus = options.retainedCorpusFile ? await loadRetainedCorpus(options.retainedCorpusFile) : undefined;
  const inventory = retainedCorpus?.inventory ?? defaultInventory(capabilities, admitted), gaps = retainedCorpus ? [] : coverageGaps(inventory, discovery.tools);
  if (gaps.length && !options.diagnostic) {
    await writeJson(path.join(out, 'coverage-blockers.json'), signed({ inventory, gaps, claim: 'Not evaluated; missing providers/toolchains block the campaign. Diagnostic mode retains blocking cells and never establishes superiority.' }));
    throw new Error(`Missing coverage blocks heldout collection. See ${path.join(out, 'coverage-blockers.json')}`);
  }
  const settings = { schema: 'scce.blind-default-settings.v1', ...(retainedCorpus ? { retainedCorpusFile: retainedCorpus.manifestFile } : {}), count: options.count, attempts: options.attempts, hiddenVectors: options.hiddenVectors, toolCalls: options.toolCalls, budgets: options.budgets, allowMissingCoverage: options.diagnostic, inventory, tools: discovery.tools };
  const publicPins = path.join(out, 'preparation');
  await mkdir(publicPins, { recursive: true });
  await writeJson(path.join(publicPins, 'discovery.json'), discovery.publicSnapshot);
  await writeJson(path.join(publicPins, 'candidate-finalization.json'), signed({ schema: 'scce.blind-candidate-finalization.v1',
    receipt: candidateFinalization.receipt, finalizationDigest: candidateFinalization.digest }));
  if (processPolicy) await writeJson(path.join(publicPins, 'process-policy.json'), processPolicy);
  await writeJson(path.join(publicPins, 'model.json'), discovery.model);
  await writeJson(path.join(publicPins, 'inventory.json'), inventory);
  await writeJson(path.join(publicPins, 'settings.json'), settings);
  await writeJson(path.join(publicPins, 'coverage.json'), { gaps, sourceCoverage: inventory.admittedSourceCoverage, taskCapability: 'Unproven until this campaign is privately validated and human work independently judged.' });
  await writeJson(path.join(publicPins, 'empty-reference-corpus.json'), { documents: [] });
  const referenceAdmission = await (dependencies.admission ?? admitReference)({ emptyCorpusFile: path.join(publicPins, 'empty-reference-corpus.json'), modelDigest: discovery.model.digest, runtimeVersion: discovery.publicSnapshot.referenceRuntime?.version, contextTokens: options.contextTokens, outputTokens: options.outputTokens, threads: discovery.publicSnapshot.hardwarePolicy.threads, device: options.device, seed: options.seed, maxReferenceModelBytes: options.maxReferenceModelBytes, budgets: options.budgets });
  verified(referenceAdmission);
  if (referenceAdmission.admitted !== true || referenceAdmission.modelDigest !== discovery.model.digest) throw new Error('Reference admission did not bind the discovered model');
  await writeJson(path.join(publicPins, 'reference-admission.json'), referenceAdmission);
  const admittedSnapshots = [];
  for (let i = 0; i < admitted.length; i++) { const file = path.join(publicPins, `admitted-public-${i}.json`); await writeJson(file, admitted[i]); admittedSnapshots.push(file); }
  const custodyStatement = { mode: options.seedFile ? 'operator-supplied-external-seed' : 'automated-custodian-on-trusted-operator-host', independence: 'No independent-custodian attestation is invented. Use a separate custodian and independently record commitments for true independent custody.', factoryHash: await fileHash(path.join(providerDir, 'cases.mjs')), seedTiming: 'Generate/read seed only after freeze succeeds and all pinned artifacts verify.' };
  await writeJson(path.join(publicPins, 'custody.json'), custodyStatement);
  const publicPreparation = { publicInputs: 'Identical concrete case sources, files, specifications and public check policy are sealed after factory freeze and delivered to both systems.', candidate: retainedCorpus ? 'Read-only canonical source/hash/promoted-evidence verification then ordinary factual turn; no ingestion. Coverage is retained-source cloze only.' : 'Official current-step source/workspace ingestion then ordinary production route; prior corpus is declared by admitted public inventories, not inferred from script identity.', reference: 'Same ordered public inputs in context plus the same bounded workspace/public-check tools.', limitations: 'No claim of equal latent pretraining, source-admission audit completeness or hard resource containment is fabricated.' };
  await writeJson(path.join(publicPins, 'candidate-preparation.json'), publicPreparation);
  await writeJson(path.join(publicPins, 'reference-preparation.json'), publicPreparation);
  const sourceFiles = await (dependencies.files ?? implementationFiles)();
  const artifacts = sourceFiles.map((file, i) => ({ id: `implementation-${i}`, role: 'implementation', path: file }));
  const add = (id, role, file) => { artifacts.push({ id, role, path: path.resolve(file) }); };
  add('candidate-adapter', 'adapter', path.join(here, 'adapters/scce-native.mjs'));
  add('reference-adapter', 'adapter', path.join(here, 'adapters/reference-native.mjs'));
  add('declared-reference-runner', 'implementation', path.join(REPOSITORY_ROOT, 'tools/sealed-eval/harness/adapters/reference-ollama.mjs'));
  add('reference-admission-code', 'implementation', path.join(here, 'campaign-reference-admission.mjs'));
  add('reference-admission', 'preparation', path.join(publicPins, 'reference-admission.json'));
  add('scorer', 'scorer', path.join(here, 'grading.mjs'));
  add('public-authored-source-declaration', 'corpus', path.join(providerDir, 'PRIVATE-CUSTODY.md'));
  if (retainedCorpus) {
    add('retained-source-manifest', 'corpus', retainedCorpus.manifestFile);
    for (const [index, document] of retainedCorpus.documents.entries()) add(`retained-source-${index}`, 'corpus', document.file);
  }
  add('capabilities', 'coverage', path.join(providerDir, 'capabilities.json'));
  add('inventory', 'coverage', path.join(publicPins, 'inventory.json'));
  add('settings', 'implementation', path.join(publicPins, 'settings.json'));
  add('empty-reference-corpus', 'corpus', path.join(publicPins, 'empty-reference-corpus.json'));
  add('coverage-receipt', 'coverage', path.join(publicPins, 'coverage.json'));
  add('custody-policy', 'implementation', path.join(publicPins, 'custody.json'));
  add('model', 'model', path.join(publicPins, 'model.json'));
  add('isolation', 'isolation', path.join(publicPins, 'discovery.json'));
  add('candidate-preparation', 'preparation', path.join(publicPins, 'candidate-preparation.json'));
  add('candidate-finalization', 'preparation', path.join(publicPins, 'candidate-finalization.json'));
  if (processPolicy) {
    add('process-policy', 'isolation', path.join(publicPins, 'process-policy.json'));
    add('process-measurement-provider', 'implementation', path.join(here, 'process-resources.mjs'));
  }
  add('reference-preparation', 'preparation', path.join(publicPins, 'reference-preparation.json'));
  for (const [i, file] of admittedSnapshots.entries()) add(`admitted-public-manifest-${i}`, 'corpus', file);
  for (const [language, tool] of Object.entries(discovery.tools)) if (tool.available) {
    if (tool.path) add(`tool-${language}`, 'tool', tool.path);
    if (tool.compilerPath) add(`compiler-${language}`, 'tool', tool.compilerPath);
  }
  const corpusIds = artifacts.filter(a => a.role === 'corpus').map(a => a.id);
  const referenceRunner = path.join(REPOSITORY_ROOT, 'tools/sealed-eval/harness/adapters/reference-ollama.mjs');
  const runnerArgs = ['--corpus-manifest', path.join(publicPins, 'empty-reference-corpus.json'), '--model', 'qwen2.5:3b', '--num-ctx', String(options.contextTokens), '--num-predict', String(options.outputTokens), '--threads', String(discovery.publicSnapshot.hardwarePolicy.threads), '--device', options.device, '--seed', String(options.seed), '--request-timeout-ms', String(options.budgets.timeMs)];
  const nonce = randomBytes(16).toString('hex');
  const categories = [...new Set(inventory.cells.map(c => c.category))];
  const candidateArgv = [process.execPath, path.join(here, 'adapters/scce-native.mjs'), '--server', discovery.config.server, '--run-id', nonce, '--cli', path.join(REPOSITORY_ROOT, 'packages/cli/dist/index.js'), '--config', discovery.config.configFile, '--schema', discovery.config.schema];
  const plan = { schema: 'scce.blind-plan.v1', purpose: options.diagnostic ? 'rehearsal' : 'heldout', cells: inventory.cells.map(c => ({ ...c, count: options.count })), categoryGroups: CATEGORY_GROUPS, budgets: options.budgets, coverageInventoryArtifact: 'inventory', isolation: { mode: 'trusted-host', provider: 'Shared bounded public workspace/check broker plus existing native SCCE routes; operating-system containment requires independent provider attestation.', attestationArtifact: 'isolation', limitations: discovery.publicSnapshot.limitations }, artifacts, systems: [
    { id: 'scce', adapterArtifact: 'candidate-adapter', argv: candidateArgv, environmentKeys: ['SCCE_API_BEARER_TOKEN'], identity: { implementationFileListHash: hash(sourceFiles), initialReadiness: discovery.publicSnapshot.candidate.readinessHash }, preparation: { publicCorpusArtifacts: corpusIds, receiptArtifact: 'candidate-preparation' }, resourceIdentity: discovery.publicSnapshot.hardwarePolicy, capabilities: categories },
    { id: 'local-reference', adapterArtifact: 'reference-adapter', argv: [process.execPath, path.join(here, 'adapters/reference-native.mjs'), '--runner', referenceRunner, '--runner-args', canonical(runnerArgs), '--model-digest', discovery.model.digest], environmentKeys: [], identity: { model: 'qwen2.5:3b', digest: discovery.model.digest, admissionDigest: referenceAdmission.digest }, expectedModelDigest: discovery.model.digest, preparation: { publicCorpusArtifacts: corpusIds, receiptArtifact: 'reference-preparation' }, resourceIdentity: { ...discovery.publicSnapshot.hardwarePolicy, reportedModelAllocationAtAdmission: referenceAdmission.reportedResidency }, capabilities: categories }
  ], judges: options.judges ?? ['independent-judge'], acceptance: { minimumPairsPerCell: options.diagnostic ? 1 : options.count, maxLossesPerCell: 0, requireStrictWinPerCell: true, maximumOneSidedPPerCell: 0.05 } };
  if (processPolicy) {
    plan.isolation.processMeasurement = processPolicy;
    for (const system of plan.systems) system.resourceIdentity = { ...system.resourceIdentity,
      processMeasurement: { provider: processPolicy.provider, policyArtifact: 'process-policy', sharedDaemons: processPolicy.systems[system.id]?.sharedDaemons ?? [], rssBudgetBytes: processPolicy.rssBudgetBytes } };
  }
  const planFile = path.join(out, 'plan.json'), freezeFile = path.join(out, 'freeze.json');
  await writeJson(planFile, plan);
  const frozen = await freeze(planFile, freezeFile);
  if (frozen.plan.artifacts.find(a => a.id === 'declared-reference-runner')?.sha256 !== referenceAdmission.runner.sha256) throw new Error('Reference runner changed after admission and before freeze');
  const prepared = signed({ schema: 'scce.blind-default-prepared.v1', out, freezeFile, freezeDigest: frozen.digest, settingsFile: path.join(publicPins, 'settings.json'), nonce, custody: custodyStatement, gaps });
  await writeJson(path.join(out, 'prepared.json'), prepared);
  return { prepared, token: discovery.config.token };
}
export async function custodianCampaign({ preparedFile, freezeDigest, privateRoot, seedFile }) {
  const prepared = await readJson(preparedFile);
  verified(prepared);
  const frozen = await checkFreeze(prepared.freezeFile, freezeDigest);
  if (prepared.freezeDigest !== frozen.digest || path.resolve(prepared.out, 'prepared.json') !== path.resolve(preparedFile)) throw new Error('Prepared campaign identity changed');
  const settingsFile = frozen.plan.artifacts.find(a => a.id === 'settings')?.path;
  if (!settingsFile || path.resolve(prepared.settingsFile) !== settingsFile) throw new Error('Custodian settings are not the frozen settings artifact');
  const settings = await readJson(settingsFile);
  if (inside(prepared.out, privateRoot) || inside(REPOSITORY_ROOT, privateRoot)) throw new Error('Custodian root must stay outside the public output and repository ingestion root');
  await mkdir(privateRoot, { recursive: true });
  const seed = seedFile ? (await readFile(seedFile, 'utf8')).trim() : randomBytes(32).toString('hex');
  const privateSeed = path.join(privateRoot, 'selection-seed.txt');
  await writeFile(privateSeed, `${seed}\n`, { flag: 'wx' });
  if (settings.retainedCorpusFile && path.resolve(settings.retainedCorpusFile) !== frozen.plan.artifacts.find(artifact => artifact.id === 'retained-source-manifest')?.path) throw new Error('Retained corpus is not the frozen public artifact');
  const pool = await (settings.retainedCorpusFile ? createRetainedPool : createDefaultPool)({ ...settings, privateRoot, seed });
  const bundle = await seal({ freezeFile: prepared.freezeFile, freezeDigest: frozen.digest, poolFile: pool.poolFile, seedFile: privateSeed, outDir: path.join(privateRoot, 'sealed') });
  return signed({ schema: 'scce.blind-default-custody.v1', freezeDigest: frozen.digest, bundleDigest: bundle.digest, publicBundleRoot: path.join(privateRoot, 'sealed/public'), privateKeyFile: path.join(privateRoot, 'sealed/private/key.json'), privateRoot: path.resolve(privateRoot), custodyMode: seedFile ? 'operator-supplied-external-seed' : 'automated-custodian-on-trusted-operator-host', independentCustodianAttested: false, cases: pool.cases, familyCountsHash: hash(pool.familyCounts) });
}
async function receiptsOnlyCopy(source, target) {
  await mkdir(target, { recursive: true });
  for (const name of await readdir(source)) if (name === 'run.json' || name.startsWith('journal-') && name.endsWith('.jsonl') || name === 'receipts') await cp(path.join(source, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
}
export async function finishCampaign({ preparedFile, custodyFile, ratingsFile, ratingsDigest, checkpointFile, checkpointDigest }) {
  const prepared = await readJson(preparedFile), custody = await readJson(custodyFile);
  verified(prepared); verified(custody);
  const bundleFile = path.join(prepared.out, 'public/bundle.json');
  const privateRun = await mkdtemp(path.join(custody.privateRoot, 'graded-run-'));
  await receiptsOnlyCopy(path.join(prepared.out, 'run'), privateRun);
  const options = { bundleFile, bundleDigest: custody.bundleDigest, out: privateRun, keyFile: custody.privateKeyFile, checkpointFile, checkpointDigest };
  const ballotsDir = path.join(prepared.out, `ballots-${hash(checkpointDigest).slice(0, 12)}`);
  try { await blind({ ...options, ballotsDir }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const reportFile = path.join(privateRun, 'report.json');
  const report = await grade({ ...options, ratingsFile, ratingsDigest, reportFile });
  const key = await readJson(custody.privateKeyFile), families = {};
  for (const cell of report.cells) for (const result of cell.cases) {
    const row = key.cases.find(r => r.id === result.id), family = row.private.family ?? 'unspecified';
    const group = canonical([cell.category, cell.language, family, row.private.requestLocale ?? null]);
    families[group] ??= { category: cell.category, language: cell.language, family, requestLocale: row.private.requestLocale ?? null, wins: 0, ties: 0, losses: 0, missing: 0, errors: 0, ungraded: 0 };
    families[group][result.outcome]++;
  }
  const final = signed({ schema: 'scce.blind-default-campaign-report.v1', report, familyBreakdown: Object.values(families), custody: { mode: custody.custodyMode, independentCustodianAttested: false }, coverageGaps: prepared.gaps, naturalScriptIdentitiesAreNotLocales: true, categoryGroups: CATEGORY_GROUPS, untestedScope: ['Tasks outside this preregistered case factory', 'Undeclared source languages/identities', 'Other tool capabilities, arbitrary applications and deployment', 'Creative/chat quality until independent human ballots are supplied', 'Hard CPU/RAM/GPU/network equality without external containment attestation'], ballotsDir, rawReportDigest: report.digest });
  const finalFile = path.join(prepared.out, `report-${hash([checkpointDigest, ratingsDigest ?? null]).slice(0, 12)}.json`);
  await writeJson(finalFile, final);
  return { reportFile: finalFile, reportDigest: final.digest, comparativeGatePassed: report.comparativeGatePassed, ballotsDir, coverageGaps: prepared.gaps };
}
export async function runCampaign(options) {
  options = campaignOptions(options);
  const { prepared, token } = await prepareCampaign(options);
  process.stderr.write(`${canonical({ stage: 'frozen', freezeDigest: prepared.freezeDigest })}\n`);
  const privateRoot = options.privateRoot ? path.resolve(options.privateRoot) : await mkdtemp(path.join(os.tmpdir(), 'scce-blind-custodian-'));
  const custodyFile = path.join(prepared.out, 'custody.json');
  const result = await execute([process.execPath, fileURLToPath(import.meta.url), 'custodian', '--prepared', path.join(prepared.out, 'prepared.json'), '--freeze-digest', prepared.freezeDigest, '--private-root', privateRoot, ...(options.seedFile ? ['--seed-file', path.resolve(options.seedFile)] : [])], { cwd: REPOSITORY_ROOT, input: '', timeMs: options.budgets.timeMs, outputBytes: options.budgets.outputBytes });
  if (result.code !== 0 || result.failure) throw new Error(`Custodian failed before collection: ${result.stderr}`);
  const custody = JSON.parse(result.stdout);
  verified(custody);
  await writeJson(custodyFile, custody);
  await cp(custody.publicBundleRoot, path.join(prepared.out, 'public'), { recursive: true, errorOnExist: true, force: false });
  process.stderr.write(`${canonical({ stage: 'sealed', bundleDigest: custody.bundleDigest, cases: custody.cases, custody: custody.custodyMode })}\n`);
  return collectPrepared({ prepared, custody, custodyFile, token, options });
}
async function collectPrepared({ prepared, custody, custodyFile, token, options }) {
  process.stderr.write(`${canonical({ stage: 'collecting', shardIndex: options.shardIndex ?? 0, shardCount: options.shardCount ?? 1 })}\n`);
  const oldToken = process.env.SCCE_API_BEARER_TOKEN;
  try {
    if (token) process.env.SCCE_API_BEARER_TOKEN = token;
    await collect({ bundleFile: path.join(prepared.out, 'public/bundle.json'), bundleDigest: custody.bundleDigest, out: path.join(prepared.out, 'run'), shardIndex: options.shardIndex ?? 0, shardCount: options.shardCount ?? 1 });
  } finally { if (oldToken === undefined) delete process.env.SCCE_API_BEARER_TOKEN; else process.env.SCCE_API_BEARER_TOKEN = oldToken; }
  let checkpointFile = path.join(prepared.out, 'checkpoint.json');
  try { await access(checkpointFile); checkpointFile = path.join(prepared.out, `checkpoint-resume-${randomBytes(8).toString('hex')}.json`); } catch {}
  const point = await checkpoint({ bundleFile: path.join(prepared.out, 'public/bundle.json'), bundleDigest: custody.bundleDigest, out: path.join(prepared.out, 'run'), checkpointFile });
  process.stderr.write(`${canonical({ stage: 'checkpointed', checkpointDigest: point.digest })}\n`);
  return { freezeDigest: prepared.freezeDigest, bundleDigest: custody.bundleDigest, checkpointFile, checkpointDigest: point.digest, ...await finishCampaign({ preparedFile: path.join(prepared.out, 'prepared.json'), custodyFile, checkpointFile, checkpointDigest: point.digest }) };
}
export async function resumeCampaign(options) {
  const out = path.resolve(options.out), prepared = await readJson(path.join(out, 'prepared.json')), custodyFile = path.join(out, 'custody.json'), custody = await readJson(custodyFile);
  verified(prepared); verified(custody);
  const frozen = await checkFreeze(prepared.freezeFile, prepared.freezeDigest);
  const candidate = frozen.plan.systems[0], configIndex = candidate.argv.indexOf('--config');
  if (configIndex < 0) throw new Error('No frozen candidate config binding');
  const config = await discoverConfig(candidate.argv[configIndex + 1]);
  return collectPrepared({ prepared, custody, custodyFile, token: config.token, options });
}
async function main() {
  const command = process.argv[2], args = argsMap(process.argv.slice(3));
  if (!['run', 'resume', 'prepare', 'custodian', 'finish'].includes(command)) throw new Error('Commands: run --out NEW_DIR [--diagnostic]; resume --out EXISTING_DIR; prepare; custodian; finish. See CAMPAIGN.md.');
  if (args.has('require-pass') && !['run', 'resume', 'finish'].includes(command)) throw new Error('--require-pass applies only to run, resume or finish');
  const need = key => { if (!args.get(key)) throw new Error(`Missing --${key}`); return args.get(key); };
  let result;
  if (command === 'custodian') result = await custodianCampaign({ preparedFile: need('prepared'), freezeDigest: need('freeze-digest'), privateRoot: need('private-root'), seedFile: args.get('seed-file') });
  else if (command === 'finish') result = await finishCampaign({ preparedFile: need('prepared'), custodyFile: need('custody'), checkpointFile: need('checkpoint'), checkpointDigest: need('checkpoint-digest'), ratingsFile: args.get('ratings'), ratingsDigest: args.get('ratings-digest') });
  else if (command === 'resume') result = await resumeCampaign({ out: need('out'), shardCount: Number(args.get('shard-count') ?? 1), shardIndex: Number(args.get('shard-index') ?? 0) });
  else {
    const resourceOptions = Object.fromEntries([['threads', 'threads'], ['max-reference-model-bytes', 'maxReferenceModelBytes'], ['context-tokens', 'contextTokens'], ['output-tokens', 'outputTokens']].filter(([flag]) => args.has(flag)).map(([flag, name]) => [name, Number(args.get(flag))]));
    const options = campaignOptions({ out: need('out'), diagnostic: args.has('diagnostic'), configFile: args.get('config'), retainedCorpusFile: args.get('retained-corpus'), processPolicyFile: args.get('process-policy'), admittedManifests: args.has('admitted-public-manifest') ? [args.get('admitted-public-manifest')] : [], seedFile: args.get('seed-file'), privateRoot: args.get('private-root'), ...(args.has('count') ? { count: Number(args.get('count')) } : {}), ...(args.has('device') ? { device: args.get('device') } : {}), ...resourceOptions, ...(args.has('shard-count') ? { shardCount: Number(args.get('shard-count')), shardIndex: Number(args.get('shard-index') ?? 0) } : {}) });
    result = command === 'run' ? await runCampaign(options) : (await prepareCampaign(options)).prepared;
  }
  process.stdout.write(`${canonical(result)}\n`);
  if (args.has('require-pass') && result.comparativeGatePassed !== true) {
    process.stderr.write('Required comparative gate did not pass; the verified report remains available.\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });

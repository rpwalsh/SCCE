import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { retainedSourceBindings } from './retained-sources.mjs';
import path from 'node:path';
import { canonical, hash, safeRelative } from '../protocol.mjs';
import { execute } from '../runner.mjs';
import { sha256Text } from '../../sealed-eval/harness/lib/util.mjs';

export function publicContextReceipt(input) {
  return { publicContextHash: hash({ steps: input.steps, outputContract: input.outputContract }), publicSourceRevisions: input.steps.flatMap((step, stepIndex) => step.sources.map(source => ({ stepIndex, id: source.id, sha256: sha256Text(source.text) }))) };
}

export function nativeContract(input) {
  let contract;
  try { contract = JSON.parse(input.outputContract); } catch { throw new Error('Native adapter requires a public JSON task contract'); }
  const fields = ['schema', 'operation', 'maxPublicAttempts', 'writablePaths', 'publicChecks', 'approvals', 'targetPaths', 'validationPolicyId', 'validationChecks', 'validationPolicy', 'programMode', 'sourceAdmission', 'sourceTrust', 'sourceMediaTypes', 'responseInstruction', 'requestedAuthority', 'executiveGoal', 'requiredCapabilityIds', 'answerMode', 'toolPolicy', 'prepareWorkspace', 'coverageBlocker', 'allowNewFiles', 'nativeValidationPermission', 'retainedSources'];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) || Object.keys(contract).some(k => !fields.includes(k))) throw new Error('Unknown public native contract field');
  if (contract.schema !== 'scce.blind-native-task.v1' || !['turn', 'code_repair', 'code_generation', 'learning_update', 'tool_use'].includes(contract.operation)) throw new Error('Invalid native task operation');
  if (!Number.isSafeInteger(contract.maxPublicAttempts) || contract.maxPublicAttempts < 1 || !Array.isArray(contract.writablePaths) || contract.writablePaths.some(p => !safeRelative(p)) || new Set(contract.writablePaths).size !== contract.writablePaths.length) throw new Error('Declare public attempts and exact writable paths');
  if (!Array.isArray(contract.publicChecks) || contract.publicChecks.some(c => !Array.isArray(c.argv) || !c.argv.length || c.argv.some(a => typeof a !== 'string'))) throw new Error('Invalid shared public checks');
  if (!Array.isArray(contract.approvals) || contract.approvals.some(c => !['workspace.patch.apply', 'workspace.code', 'process.build_test'].includes(c))) throw new Error('Declare exact permitted local approvals');
  if (contract.operation === 'code_repair' && (!Array.isArray(contract.targetPaths) || contract.targetPaths.length !== 1 || !contract.writablePaths.includes(contract.targetPaths[0]) || !contract.validationPolicy)) throw new Error('Repair requires one writable target and a public validation policy');
  if (['code_repair', 'code_generation'].includes(contract.operation) && !contract.publicChecks.length) throw new Error('Code comparison requires shared public native checks');
  if (contract.operation === 'code_repair') {
    const policy = contract.validationPolicy;
    const commands = policy.commands?.map(c => [c.executable, ...c.argv]);
    const checks = contract.publicChecks.map(c => c.argv.map(a => a === '{node}' ? process.execPath : a));
    if (policy.schemaVersion !== 'scce.patch-validation-policy.v1' || canonical(commands) !== canonical(checks)) throw new Error('SCCE policy and reference public checks must be identical');
    if (policy.timeoutMs > input.budgets.timeMs || policy.maxOutputBytes > input.budgets.outputBytes) throw new Error('Native policy exceeds shared public budgets');
    if (policy.commands.some(c => c.cwd && c.cwd !== '.') || Object.keys(policy.environment ?? {}).length) throw new Error('Public checks require common cwd and scrubbed environment');
  }
  if (contract.operation === 'code_generation' && contract.programMode !== 'verified_artifacts' && (!contract.validationPolicyId || !Array.isArray(contract.targetPaths) || !Array.isArray(contract.validationChecks))) throw new Error('Workspace generation requires registered public policy and requested paths');
  if (contract.programMode !== undefined && !['verified_artifacts', 'workspace_plan'].includes(contract.programMode)) throw new Error('Invalid explicit program mode');
  if (contract.operation === 'tool_use' && contract.executiveGoal && contract.maxPublicAttempts !== 1) throw new Error('Explicit executive goals execute once');
  if (contract.toolPolicy && (!Number.isSafeInteger(contract.toolPolicy.maxCalls) || contract.toolPolicy.maxCalls < 1 || !Array.isArray(contract.toolPolicy.tools) || contract.toolPolicy.tools.some(t => !['workspace.read', 'workspace.write', 'public.check'].includes(t)))) throw new Error('Invalid shared bounded workspace tool policy');
  if (contract.answerMode !== undefined && (contract.answerMode !== 'answer_or_abstain' || !['turn', 'learning_update'].includes(contract.operation) || contract.requestedAuthority !== 'factual')) throw new Error('Answer-or-abstain requires an explicit factual turn contract');
  if (input.category === 'math_reasoning' && (contract.operation !== 'turn' || contract.requestedAuthority !== undefined || contract.answerMode !== undefined
    || contract.publicChecks.length || contract.writablePaths.length || contract.approvals.length || input.steps.some(step => step.sources.length || Object.keys(step.files).length))) throw new Error('Arithmetic comparison requires an ordinary source-free turn');
  retainedSourceBindings(input, contract);
  contract.publicReadonlyFiles = Object.fromEntries(input.steps.flatMap(step => Object.entries(step.files)).filter(([name]) => !contract.writablePaths.includes(name)));
  return contract;
}
export function parseAnswerOrAbstain(answer) {
  const value = JSON.parse(answer);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'answer,status' || !(value.status === 'answered' && typeof value.answer === 'string' || value.status === 'abstained' && value.answer === null)) throw new Error('Invalid public answer-or-abstain response');
  return value;
}
export function typedFactualAbstention(result) {
  const detail = result.body?.detail;
  const absent = value => value === undefined || value === null || value === '';
  return result.status === 422 && detail?.schema === 'scce.runtime.withheld_surface.v1'
    && (detail.requestedAuthority === undefined || detail.requestedAuthority === 'factual')
    && ['withheld.no_admitted_evidence', 'withheld.surface_refused'].includes(detail.reasonId)
    && absent(result.body.answer) && absent(detail.answer);
}
export function currentPrompt(input, contract) {
  return [input.steps.at(-1).prompt, contract.responseInstruction].filter(v => typeof v === 'string' && v.length).join('\n');
}
export function failure(reason, trace = [], identity = {}) {
  return { status: 'ok', answer: '', artifacts: {}, identity: { ...identity, productOutcome: 'failed', reason, trace } };
}
export async function containedFile(root, name) {
  if (!safeRelative(name)) throw new Error('Unsafe artifact path');
  let cursor = root;
  for (const part of name.split('/')) {
    cursor = path.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic link in public workspace'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return path.join(root, name);
}
export async function validateArtifacts(artifacts, contract, budget) {
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) throw new Error('Expected artifact map');
  let bytes = 0;
  for (const [name, text] of Object.entries(artifacts)) {
    const readonly = Object.hasOwn(contract.publicReadonlyFiles ?? {}, name);
    const unchanged = readonly && text === contract.publicReadonlyFiles[name];
    if (!(contract.writablePaths.includes(name) || unchanged || contract.allowNewFiles === true && !readonly) || !safeRelative(name) || typeof text !== 'string') throw new Error('Artifact outside public writable scope');
    bytes += Buffer.byteLength(text);
  }
  if (bytes > budget) throw new Error('Artifact byte budget exceeded');
}
export async function applyArtifacts(root, artifacts, contract, budget) {
  await validateArtifacts(artifacts, contract, budget);
  for (const [name, text] of Object.entries(artifacts)) {
    const target = await containedFile(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}
export async function publicFilesGuard(input, contract, root) {
  const names = new Set(input.steps.flatMap(s => Object.keys(s.files)).filter(n => !contract.writablePaths.includes(n)));
  const snapshots = new Map();
  for (const name of names) snapshots.set(name, hash(await readFile(await containedFile(root, name), 'utf8')));
  return async () => {
    for (const [name, before] of snapshots) if (hash(await readFile(await containedFile(root, name), 'utf8')) !== before) throw new Error(`Protected public file changed: ${name}`);
  };
}
export async function runPublicChecks(contract, input, { cwd, executeCommand = execute, remainingMs }) {
  const receipts = [];
  let outputRemaining = input.budgets.outputBytes;
  for (const command of contract.publicChecks) {
    const argv = command.argv.map(a => a === '{node}' ? process.execPath : a);
    const timeMs = remainingMs();
    if (timeMs <= 0 || outputRemaining <= 0) return { passed: false, receipts, reason: 'public-check-budget' };
    const result = await executeCommand(argv, { cwd, input: '', timeMs, outputBytes: outputRemaining });
    outputRemaining -= result.bytes ?? Buffer.byteLength(result.stdout + result.stderr);
    receipts.push({ argv, code: result.code, failure: result.failure ?? null, stdout: result.stdout, stderr: result.stderr });
    if (result.code !== 0 || result.failure) return { passed: false, receipts, reason: 'public-check-failed' };
  }
  return { passed: true, receipts, reason: null };
}
export function parseReferenceArtifacts(answer) {
  let decoded;
  try { decoded = JSON.parse(answer); } catch { throw new Error('Reference did not return the declared machine JSON'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || typeof decoded.answer !== 'string' || !decoded.artifacts || Object.keys(decoded).some(k => !['answer', 'artifacts', 'executiveGoal'].includes(k))) throw new Error('Invalid reference machine response');
  return decoded;
}

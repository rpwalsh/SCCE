import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from './runner.mjs';
import { canonical, hash, signed, fileHash } from './protocol.mjs';
import { sha256Text } from '../sealed-eval/harness/lib/util.mjs';
import { validateReferenceRunner } from './adapters/reference-runner-config.mjs';

const runnerPath = fileURLToPath(new URL('../sealed-eval/harness/adapters/reference-ollama.mjs', import.meta.url));
const overflowContext = 1024;
const overflowBytes = 48000;
function requireValue(condition, message) { if (!condition) throw new Error(`Reference admission failed: ${message}`); }
function errorRecord(value) {
  while (value && typeof value === 'object' && !Array.isArray(value) && value.error !== undefined && value.type === undefined) {
    value = value.error;
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function checkMetadata(metadata, expected, contextTokens, outputTokens) {
  requireValue(metadata?.model === 'qwen2.5:3b' && metadata.digest === expected.modelDigest, 'model identity changed');
  requireValue(typeof metadata.ollamaVersion === 'string' && metadata.ollamaVersion.length > 0 && (!expected.runtimeVersion || metadata.ollamaVersion === expected.runtimeVersion), 'runtime identity changed or is absent');
  requireValue(metadata.contextPolicy?.truncate === false && metadata.contextPolicy?.shift === false, 'no-truncation/no-shift controls were not requested');
  requireValue(metadata.requestedDevice === expected.device, 'device request changed');
  const options = new Map(Object.entries(metadata.options ?? {}).map(([name, value]) => [`--${name.replaceAll('_', '-')}`, value]));
  for (const [flag, value] of [['--num-ctx', contextTokens], ['--num-predict', outputTokens], ['--num-thread', expected.threads], ['--seed', expected.seed]]) requireValue(options.get(flag) === value, `requested resource option changed: ${flag}`);
  return metadata.ollamaVersion;
}
export async function admitReference(options, dependencies = {}) {
  const executeCommand = dependencies.executeCommand ?? execute;
  const entropy = dependencies.randomBytes ?? randomBytes;
  const started = performance.now(), originalRunnerHash = await fileHash(runnerPath);
  const expected = { modelDigest: options.modelDigest, runtimeVersion: options.runtimeVersion, device: options.device, threads: options.threads, seed: options.seed };
  async function probe(question, contextTokens, outputTokens) {
    const args = ['--corpus-manifest', options.emptyCorpusFile, '--model', 'qwen2.5:3b', '--num-ctx', String(contextTokens), '--num-predict', String(outputTokens), '--threads', String(options.threads), '--device', options.device, '--seed', String(options.seed), '--request-timeout-ms', String(options.budgets.timeMs)];
    await validateReferenceRunner(runnerPath, args);
    const result = await executeCommand([process.execPath, runnerPath, ...args, '--mode', 'closed_book', '--answer-style', 'natural'], { cwd: path.dirname(options.emptyCorpusFile), input: `${canonical(question)}\n`, timeMs: options.budgets.timeMs, outputBytes: options.budgets.outputBytes });
    requireValue(result.code === 0 && !result.failure, 'declared runner did not complete');
    const lines = result.stdout.trim().split(/\r?\n/u);
    requireValue(lines.length === 1, 'declared runner returned an invalid receipt');
    const response = JSON.parse(lines[0]);
    const version = checkMetadata(response.metadata, expected, contextTokens, outputTokens);
    return { response, version, rawReceiptSha256: sha256Text(result.stdout) };
  }
  const bytes = entropy(overflowBytes);
  const overflowPrompt = Array.from(bytes, value => String.fromCharCode(33 + value % 94)).join('');
  const rejected = await probe({ prompt: overflowPrompt }, overflowContext, 1);
  const metadata = rejected.response.metadata, error = errorRecord(metadata.generationError);
  requireValue(rejected.response.status === 'error' && metadata.generationHttpStatus === 400, 'overlong input was not rejected with HTTP400');
  requireValue(error?.type === 'exceed_context_size_error' && error.code === 400 && error.n_ctx === overflowContext && Number.isSafeInteger(error.n_prompt_tokens) && error.n_prompt_tokens > overflowContext, 'overflow rejection lacks exact machine context/token evidence');
  requireValue(/^[a-f0-9]{64}$/u.test(metadata.generationErrorSha256 ?? ''), 'overflow error byte hash is absent');
  const nonce = entropy(16).toString('hex');
  const schema = { type: 'object', properties: { admitted: { const: true }, nonce: { const: nonce } }, required: ['admitted', 'nonce'], additionalProperties: false };
  const sanity = await probe({ prompt: 'Reply only with the plain text word UNSTRUCTURED. Do not emit a JSON object.', format: schema }, options.contextTokens, options.outputTokens);
  requireValue(sanity.response.status === 'ok', 'native structured sanity did not succeed');
  requireValue(sanity.version === rejected.version, 'runtime changed between admission probes');
  requireValue(sanity.response.metadata.outputFormat === 'json_schema' && sanity.response.metadata.outputSchemaSha256 === hash(schema), 'native schema identity was not acknowledged');
  let answer;
  try { answer = JSON.parse(sanity.response.answer); } catch { throw new Error('Reference admission failed: native schema was ignored'); }
  requireValue(canonical(answer) === canonical({ admitted: true, nonce }), 'native schema was ignored or altered');
  const inference = sanity.response.metadata.inference, residency = sanity.response.metadata.residency;
  requireValue(inference?.done_reason === 'stop' && Number.isSafeInteger(inference.prompt_eval_count) && inference.prompt_eval_count > 0 && Number.isSafeInteger(inference.eval_count) && inference.eval_count > 0 && inference.eval_count <= options.outputTokens, 'sanity inference accounting is incomplete or exhausted');
  requireValue(residency?.digest === options.modelDigest && Number.isSafeInteger(residency.size) && residency.size > 0 && Number.isSafeInteger(residency.size_vram) && residency.size_vram >= 0 && residency.size_vram <= residency.size && residency.context_length === options.contextTokens, 'restored residency/model/context accounting is invalid');
  requireValue(options.device !== 'cpu' || residency.size_vram === 0, 'CPU admission used GPU allocation');
  requireValue(options.device !== 'gpu' || residency.size_vram > 0, 'GPU admission fell back to CPU');
  requireValue(!options.maxReferenceModelBytes || residency.size <= options.maxReferenceModelBytes, 'reported model allocation exceeds the preregistered bound');
  requireValue(await fileHash(runnerPath) === originalRunnerHash, 'declared runner changed during admission');
  return signed({ schema: 'scce.blind-reference-admission.v1', admitted: true, runner: { path: runnerPath, sha256: originalRunnerHash }, model: 'qwen2.5:3b', modelDigest: options.modelDigest, runtimeVersion: sanity.version, elapsedMs: performance.now() - started, requested: { contextTokens: options.contextTokens, outputTokens: options.outputTokens, threads: options.threads, device: options.device, seed: options.seed }, contextPolicy: { truncate: false, shift: false, overflowRejectionVerified: true }, overflow: { inputBytes: Buffer.byteLength(overflowPrompt), inputSha256: sha256Text(overflowPrompt), requestedContextTokens: overflowContext, requestedOutputTokens: 1, httpStatus: 400, errorCode: error.code, errorType: error.type, reportedPromptTokens: error.n_prompt_tokens, reportedContextTokens: error.n_ctx, rawErrorSha256: metadata.generationErrorSha256, rawRunnerReceiptSha256: rejected.rawReceiptSha256 }, nativeSchema: { sha256: hash(schema), answerSha256: hash(answer), rawRunnerReceiptSha256: sanity.rawReceiptSha256, inference: { doneReason: inference.done_reason, promptTokens: inference.prompt_eval_count, outputTokens: inference.eval_count } }, reportedResidency: { modelBytes: residency.size, vramBytes: residency.size_vram, contextTokens: residency.context_length, observedDevice: residency.observedDevice, allocationCeilingBytes: options.maxReferenceModelBytes ?? residency.size, ceilingScope: 'Validated Ollama-reported model allocation at admission only; not an OS/process memory quota.', processRssBytes: null, totalProductRamBytes: null } });
}

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argsMap } from '../../sealed-eval/harness/lib/util.mjs';
import { readJson } from '../protocol.mjs';

/** Reject unverifiable/truncated successes; the admitted runner already rejects overlong input. */
export function referenceContextIssue(receipt, argv) {
  if (receipt.status !== 'ok') return undefined;
  const args = argsMap(argv), contextTokens = Number(args.get('num-ctx')), outputTokens = Number(args.get('num-predict'));
  const inference = receipt.metadata?.inference, residency = receipt.metadata?.residency;
  let reason;
  if (receipt.metadata?.contextPolicy?.truncate !== false || receipt.metadata?.contextPolicy?.shift !== false) reason = 'no_truncation_policy_missing';
  else if (inference?.done_reason !== 'stop') reason = 'incomplete_generation';
  else if (!Number.isSafeInteger(inference.prompt_eval_count) || inference.prompt_eval_count < 1
    || !Number.isSafeInteger(inference.eval_count) || inference.eval_count < 1) reason = 'missing_token_accounting';
  else if (!Number.isSafeInteger(contextTokens) || !Number.isSafeInteger(outputTokens)
    || residency?.context_length !== contextTokens) reason = 'context_allocation_changed';
  else if (inference.eval_count > outputTokens || inference.prompt_eval_count + inference.eval_count > contextTokens) reason = 'context_or_output_budget_exceeded';
  return reason ? { schema: 'scce.blind-reference-context-invalid.v1', reason, contextTokens, outputTokens } : undefined;
}

export async function validateReferenceRunner(runner, argv) {
  const declared = fileURLToPath(new URL('../../sealed-eval/harness/adapters/reference-ollama.mjs', import.meta.url));
  if (await realpath(runner) !== await realpath(declared)) throw new Error('Native comparison must use the existing declared reference runner');
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('Reference options must be an argument vector');
  const args = argsMap(argv);
  if (args.has('mode') || args.has('answer-style')) throw new Error('Reference mode is fixed to public-packet context without side retrieval');
  if (args.has('format') || args.has('format-schema')) throw new Error('Mixed campaign format is selected per request from the public task contract, not a global format option');
  for (const key of ['corpus-manifest', 'model', 'num-ctx', 'num-predict', 'threads', 'device', 'seed', 'request-timeout-ms']) if (!args.has(key)) throw new Error(`Pin explicit reference option: ${key}`);
  if (args.get('model') !== 'qwen2.5:3b') throw new Error('Reference must be the requested local model');
  const corpus = await readJson(args.get('corpus-manifest'));
  if (Object.keys(corpus).some(k => k !== 'documents') || !Array.isArray(corpus.documents) || corpus.documents.length) throw new Error('Reference receives sources from the shared packet; its separate corpus must be empty');
}

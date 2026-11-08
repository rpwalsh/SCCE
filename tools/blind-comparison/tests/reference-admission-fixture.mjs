import { argsMap } from '../../sealed-eval/harness/lib/util.mjs';
import { canonical, hash } from '../protocol.mjs';

export function admissionExecutor(variant = 'accepted') {
  const calls = [];
  const executeCommand = async (argv, options) => {
    const args = argsMap(argv.slice(2)), question = JSON.parse(options.input);
    calls.push({ argv, question });
    const context = Number(args.get('num-ctx'));
    const apiOptions = Object.fromEntries([['num-ctx', context], ['num-predict', Number(args.get('num-predict'))], ['num-thread', Number(args.get('threads'))], ['seed', Number(args.get('seed'))]].map(([key, value]) => [key.replaceAll('-', '_'), value]));
    const metadata = { answerStyle:args.get('answer-style'),model: 'qwen2.5:3b', digest: variant === 'model-changed' ? 'b'.repeat(64) : 'a'.repeat(64), ollamaVersion: variant === 'runtime-changed' && context !== 1024 ? 'different-runtime' : '0.32.5', requestedDevice: args.get('device'), options: apiOptions, contextPolicy: { truncate: false, shift: false }, outputFormat: question.format ? 'json_schema' : 'text', ...(question.format ? { outputSchemaSha256: hash(question.format) } : {}) };
    if(variant==='wrong-interface')metadata.answerStyle='natural';
    let response;
    if (context === 1024) {
      const machine = { error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 42341, n_ctx: 1024, message: 'RAW_ERROR_PRIVATE_CANARY_NO_PUBLIC_RECEIPT' } };
      const envelope = { error: JSON.stringify(machine) };
      metadata.generationHttpStatus = 400;
      metadata.generationError = envelope;
      metadata.generationErrorSha256 = hash(envelope);
      response = { status: 'error', answer: '', metadata };
      if (variant === 'ignored-overflow') response.status = 'ok';
      if (variant === 'untyped-error') metadata.generationError = { error: 'Some context error in unstructured prose.' };
      if (variant === 'wrong-context') metadata.generationError = { error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 42341, n_ctx: 2048 } };
      if (variant === 'small-token-count') metadata.generationError = { error: { code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 512, n_ctx: 1024 } };
      if (variant === 'missing-error-hash') delete metadata.generationErrorSha256;
    } else {
      metadata.inference = { done_reason: variant === 'length-exhausted' ? 'length' : 'stop', prompt_eval_count: 39, eval_count: 20 };
      metadata.residency = { digest: metadata.digest, size: 3368466512, size_vram: 0, context_length: context, observedDevice: 'cpu' };
      response = { status: 'ok', answer: canonical({ admitted: true, nonce: question.format.properties.nonce.const }), metadata };
      if (variant === 'ignored-schema') response.answer = 'UNSTRUCTURED';
      if (variant === 'schema-digest-mismatch') metadata.outputSchemaSha256 = 'f'.repeat(64);
      if (variant === 'residency-context-mismatch') metadata.residency.context_length = 1024;
      if (variant === 'missing-residency') delete metadata.residency;
    }
    if (variant === 'missing-controls') delete metadata.contextPolicy;
    return { code: variant === 'runner-exit' ? 1 : 0, stdout: `${canonical(response)}\n`, stderr: '', bytes: canonical(response).length };
  };
  executeCommand.calls = calls;
  return executeCommand;
}

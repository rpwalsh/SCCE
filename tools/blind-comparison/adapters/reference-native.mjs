import { argsMap, required } from '../../sealed-eval/harness/lib/util.mjs';
import { execute } from '../runner.mjs';
import { sha256Text } from '../../sealed-eval/harness/lib/util.mjs';
import { readInput } from './text-input.mjs';
import { runReferenceNative } from './reference-native-lib.mjs';
import { validateReferenceRunner, referenceContextIssue } from './reference-runner-config.mjs';
const args = argsMap();
try {
  const input = await readInput(), runner = required(args, 'runner'), runnerArgs = JSON.parse(required(args, 'runner-args'));
  await validateReferenceRunner(runner, runnerArgs);
  const response = await runReferenceNative(input, { expectedModelDigest: required(args, 'model-digest') }, { ask: async (prompt, { remainingMs, format }) => {
    const result = await execute([process.execPath, runner, ...runnerArgs, '--mode', 'closed_book', '--answer-style', 'task'], { cwd: process.cwd(), input: `${JSON.stringify({ prompt, ...(format ? { format } : {}) })}\n`, timeMs: remainingMs, outputBytes: input.budgets.outputBytes });
    if (result.code !== 0 || result.failure) throw new Error('Declared reference process failed');
    const decoded = JSON.parse(result.stdout.trim());
    const contextIssue = referenceContextIssue(decoded, runnerArgs);
    return { status: contextIssue ? 'error' : decoded.status, answer: contextIssue ? '' : decoded.answer ?? '', modelDigest: decoded.metadata?.digest, inference: { ...decoded.metadata, ...(contextIssue ? { contextIssue } : {}) }, rawResponseHash: sha256Text(result.stdout) };
  } });
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (e) { process.stdout.write(`${JSON.stringify({ status: 'error', answer: '', identity: { adapterError: e.message } })}\n`); }

import { argsMap, required } from '../../sealed-eval/harness/lib/util.mjs';
import { createScceMeasurementClient } from '../../head-to-head/scce-client.mjs';
import { renderInput, readInput } from './text-input.mjs';
const input = await readInput();
if (['code', 'agentic', 'learning_updates'].includes(input.category)) {
  process.stdout.write(`${JSON.stringify({ status: 'unsupported', answer: '' })}\n`);
} else {
  const args = argsMap();
  const client = await createScceMeasurementClient({ serverUrl: required(args, 'server'), requestTimeoutMs: input.budgets.timeMs });
  const result = await client.ask(renderInput(input));
  process.stdout.write(`${JSON.stringify({ status: result.transportError ? 'error' : 'ok', answer: result.answer ?? '', identity: { httpStatus: result.httpStatus } })}\n`);
}

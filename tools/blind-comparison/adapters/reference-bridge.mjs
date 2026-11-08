import { argsMap, required } from '../../sealed-eval/harness/lib/util.mjs';
import { execute } from '../runner.mjs';
import { renderInput, readInput } from './text-input.mjs';
const args = argsMap();
const input = await readInput();
const runner = required(args, 'runner');
const runnerArgs = JSON.parse(required(args, 'runner-args'));
if (!Array.isArray(runnerArgs) || runnerArgs.includes('--mode') && runnerArgs[runnerArgs.indexOf('--mode') + 1] !== 'closed_book') throw new Error('Bridge requires public packet only; no side-specific retrieval');
const result = await execute([process.execPath, runner, ...runnerArgs, '--mode', 'closed_book', '--answer-style', 'natural'], { cwd: process.cwd(), input: `${JSON.stringify({ prompt: renderInput(input) })}\n`, timeMs: input.budgets.timeMs, outputBytes: input.budgets.outputBytes });
if (result.code !== 0 || result.failure) throw new Error('Declared reference runner failed');
const response = JSON.parse(result.stdout.trim());
if (response.status === 'error') throw new Error('Declared reference returned error');
let answer = response.answer ?? '', artifacts = {};
try { const decoded = JSON.parse(answer); if (typeof decoded.answer === 'string' && decoded.artifacts) { answer = decoded.answer; artifacts = decoded.artifacts; } } catch {}
process.stdout.write(`${JSON.stringify({ status: 'ok', answer, artifacts, identity: { modelDigest: response.metadata?.digest, runtime: response.metadata } })}\n`);

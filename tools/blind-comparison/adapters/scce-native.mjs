import path from 'node:path';
import { argsMap, required } from '../../sealed-eval/harness/lib/util.mjs';
import { readInput } from './text-input.mjs';
import { runScceNative } from './scce-native-lib.mjs';
const args = argsMap();
try {
  const response = await runScceNative(await readInput(), { server: required(args, 'server'), runId: required(args, 'run-id'), token: process.env.SCCE_API_BEARER_TOKEN, cliPath: args.has('cli') ? path.resolve(args.get('cli')) : undefined, configPath: args.has('config') ? path.resolve(args.get('config')) : undefined, cliSchema: args.get('schema'), cliEnvironmentKeys: JSON.parse(args.get('cli-environment-keys') ?? '[]') });
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (e) { process.stdout.write(`${JSON.stringify({ status: 'error', answer: '', identity: { adapterError: e.message } })}\n`); }

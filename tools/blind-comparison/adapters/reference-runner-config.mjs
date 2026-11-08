import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argsMap } from '../../sealed-eval/harness/lib/util.mjs';
import { readJson } from '../protocol.mjs';

export async function validateReferenceRunner(runner, argv) {
  const declared = fileURLToPath(new URL('../../sealed-eval/harness/adapters/reference-ollama.mjs', import.meta.url));
  if (await realpath(runner) !== await realpath(declared)) throw new Error('Native comparison must use the existing declared reference runner');
  if (!Array.isArray(argv) || argv.some(a => typeof a !== 'string')) throw new Error('Reference options must be an argument vector');
  const args = argsMap(argv);
  if (args.has('mode') || args.has('answer-style')) throw new Error('Reference mode is fixed to public-packet context without side retrieval');
  for (const key of ['corpus-manifest', 'model', 'num-ctx', 'num-predict', 'threads', 'device', 'seed', 'request-timeout-ms']) if (!args.has(key)) throw new Error(`Pin explicit reference option: ${key}`);
  if (args.get('model') !== 'qwen2.5:3b') throw new Error('Reference must be the requested local model');
  const corpus = await readJson(args.get('corpus-manifest'));
  if (Object.keys(corpus).some(k => k !== 'documents') || !Array.isArray(corpus.documents) || corpus.documents.length) throw new Error('Reference receives sources from the shared packet; its separate corpus must be empty');
}

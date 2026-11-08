import { readInput } from '../adapters/text-input.mjs';
const input = await readInput();
let answer = 'A short, coherent rehearsal response.', artifacts = {};
if (input.category === 'code') {
  answer = 'Updated the addition function.';
  artifacts = { 'module.cjs': 'module.exports = (a, b) => a + b;\n' };
} else if (['corpus_facts', 'agentic', 'learning_updates'].includes(input.category)) {
  const data = Object.assign({}, ...input.steps.flatMap(s => s.sources).map(s => JSON.parse(s.text)));
  const key = input.steps.at(-1).prompt;
  answer = JSON.stringify({ value: data[key] ?? null, supported: Object.hasOwn(data, key) });
}
if (process.argv.includes('--fault') && input.category === 'code') artifacts['module.cjs'] = 'module.exports = (a, b) => a - b;\n';
process.stdout.write(`${JSON.stringify({ status: 'ok', answer, artifacts })}\n`);

import { canonical } from '../protocol.mjs';
export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function renderInput(input) {
  return `Complete the current task using the supplied public sources, files and previous turns. Follow outputContract exactly. Return only the requested answer; for file edits return JSON {"answer":"...","artifacts":{"relative/path":"complete file text"}}.\n${canonical(input)}`;
}

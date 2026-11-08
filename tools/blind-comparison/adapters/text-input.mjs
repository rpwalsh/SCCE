import { canonical } from '../protocol.mjs';
export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function renderInput(input) {
  return `Complete the current task using the supplied public sources, files and previous turns. Follow outputContract exactly. Return only the requested answer; for file edits return JSON {"answer":"...","artifacts":{"relative/path":"complete file text"}}.\n${canonical(input)}`;
}

/** Semantic public inputs only; execution envelopes stay in the independently hashed receipt. */
export function renderPublicTask(input,currentRequest) {
  const parts=[`Task language: ${input.language}`,`Public output contract:\n${input.outputContract}`];
  for(const [index,step]of input.steps.entries()){
    if(index<input.steps.length-1)parts.push(`Previous user request (step ${index+1}):\n${step.prompt}`);
    for(const source of step.sources)parts.push(`Public source ${JSON.stringify(source.id)} (step ${index+1}):\n${source.text}`);
    for(const [name,content]of Object.entries(step.files))parts.push(`Public file ${JSON.stringify(name)} (step ${index+1}):\n${content}`);
    if(input.history[index]!==undefined)parts.push(`Previous assistant response (step ${index+1}):\n${canonical(input.history[index])}`);
  }
  parts.push(`Current user request:\n${currentRequest}`);
  return parts.join('\n\n');
}

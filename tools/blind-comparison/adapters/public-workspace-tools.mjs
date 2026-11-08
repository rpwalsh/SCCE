import { readFile } from 'node:fs/promises';
import { hash } from '../protocol.mjs';
import { applyArtifacts, containedFile, runPublicChecks } from './native-contract.mjs';

export function workspaceToolSession(input, contract, dependencies) {
  const { cwd, remainingMs, executeCommand } = dependencies;
  let used = 0;
  const artifacts = Object.create(null), receipts = [];
  const readable = new Set([...input.steps.flatMap(s => Object.keys(s.files)), ...contract.writablePaths]);
  return {
    artifacts, receipts, used: () => used,
    async execute(calls) {
      if (!Array.isArray(calls) || !calls.length) throw new Error('Autonomous planning requires selected public tool calls');
      let lastCheckPassed = false;
      const feedback = [];
      for (const call of calls) {
        if (++used > contract.toolPolicy.maxCalls) throw new Error('Public tool-call budget exceeded');
        if (!call || !contract.toolPolicy.tools.includes(call.tool)) throw new Error('Undeclared public tool');
        let result;
        if (call.tool === 'workspace.read') {
          if (Object.keys(call).some(k => !['tool', 'path'].includes(k)) || !readable.has(call.path)) throw new Error('Read outside public file scope');
          const content = await readFile(await containedFile(cwd, call.path), 'utf8');
          if (Buffer.byteLength(content) > input.budgets.artifactBytes) throw new Error('Public read byte budget exceeded');
          result = { content };
        } else if (call.tool === 'workspace.write') {
          if (Object.keys(call).some(k => !['tool', 'path', 'content'].includes(k))) throw new Error('Invalid public write arguments');
          await applyArtifacts(cwd, { [call.path]: call.content }, contract, input.budgets.artifactBytes);
          artifacts[call.path] = call.content;
          result = { written: call.path };
        } else if (call.tool === 'public.check') {
          if (Object.keys(call).some(k => !['tool', 'index'].includes(k)) || !Number.isSafeInteger(call.index) || !contract.publicChecks[call.index]) throw new Error('Unknown public check');
          result = await runPublicChecks({ publicChecks: [contract.publicChecks[call.index]] }, input, { cwd, remainingMs, executeCommand });
        } else throw new Error('No provider for declared public tool');
        lastCheckPassed = call.tool === 'public.check' && result.passed;
        feedback.push({ call, result });
        receipts.push({ call, resultHash: hash(result), succeeded: call.tool === 'public.check' ? result.passed : true });
      }
      return { feedback, lastCheckPassed, used };
    }
  };
}

import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { canonical, hash } from '../protocol.mjs';
import { execute } from '../runner.mjs';
import { renderInput } from './text-input.mjs';
import { nativeContract, failure, applyArtifacts, publicFilesGuard, runPublicChecks, parseReferenceArtifacts, parseAnswerOrAbstain, publicContextReceipt } from './native-contract.mjs';
import { workspaceToolSession } from './public-workspace-tools.mjs';
import { nativeResponseSchema } from './native-response-schema.mjs';

export async function executePublicGoal(goal, input, dependencies) {
  const { cwd, remainingMs, executeCommand = execute } = dependencies;
  if (goal?.schema !== 'scce.local_executive_goal.v1' || !Array.isArray(goal.tasks) || !goal.tasks.length || new Set(goal.tasks.map(t => t.id)).size !== goal.tasks.length) throw new Error('Invalid public executive goal');
  const pending = [...goal.tasks], done = new Set(), receipts = [];
  const root = await mkdtemp(path.join(cwd, '.public-executive-'));
  while (pending.length) {
    const index = pending.findIndex(t => Array.isArray(t.dependencyTaskIds) && t.dependencyTaskIds.every(id => done.has(id)));
    if (index < 0) throw new Error('Unscheduled public executive dependencies');
    const [task] = pending.splice(index, 1);
    const program = task.construct?.program;
    if (!program?.build || !program?.test || !Array.isArray(task.construct.artifacts)) throw new Error('Public executive task needs native build and test');
    const dir = path.join(root, hash(task.id));
    await mkdir(dir);
    const artifacts = Object.fromEntries(task.construct.artifacts.map(a => [a.path, a.content]));
    await applyArtifacts(dir, artifacts, { writablePaths: Object.keys(artifacts) }, input.budgets.artifactBytes);
    const checks = { publicChecks: [program.build, program.test].map(c => {
      if (c.cwd !== '.' || typeof c.command !== 'string' || !Array.isArray(c.args)) throw new Error('Public executive command must use its isolated workspace');
      return { argv: [c.command, ...c.args] };
    }) };
    const result = await runPublicChecks(checks, input, { cwd: dir, remainingMs, executeCommand });
    receipts.push({ taskId: task.id, ...result });
    if (!result.passed) return { succeeded: false, receipts };
    done.add(task.id);
  }
  return { succeeded: true, receipts };
}

export async function runReferenceNative(input, config, dependencies) {
  const result = await referenceNativeOperation(input, config, dependencies);
  Object.assign(result.identity, publicContextReceipt(input));
  return result;
}
async function referenceNativeOperation(input, config, dependencies) {
  const contract = nativeContract(input), cwd = config.cwd ?? process.cwd();
  if (contract.coverageBlocker) return { status: 'error', answer: '', artifacts: {}, identity: { coverageGap: contract.coverageBlocker } };
  const started = performance.now(), trace = [], feedback = [], submitted = Object.create(null);
  const remainingMs = () => Math.max(0, Math.floor(input.budgets.timeMs - (performance.now() - started)));
  const ensurePublicFiles = await publicFilesGuard(input, contract, cwd);
  const autonomous = contract.operation === 'tool_use' && !contract.executiveGoal && contract.toolPolicy;
  const session = autonomous ? workspaceToolSession(input, contract, { cwd, remainingMs, executeCommand: dependencies.executeCommand }) : null;
  let modelDigest;
  for (let attempt = 0; attempt < contract.maxPublicAttempts; attempt++) {
    const remainingToolCalls = session ? contract.toolPolicy.maxCalls - session.used() : undefined;
    if (session && remainingToolCalls <= 0) return failure('public_tool_call_budget_exhausted', trace, { modelDigest });
    const prompt = `${renderInput(input)}\nPublic native response protocol:\n${canonical({ requiredResponse: autonomous ? { answer: 'string', artifacts: {}, toolCalls: 'ordered calls from toolPolicy; workspace.read {tool,path}, workspace.write {tool,path,content}, public.check {tool,index}', complete: 'boolean; true only after a successful final public.check' } : contract.answerMode === 'answer_or_abstain' ? { oneOf: [{ status: 'answered', answer: 'actual answer text' }, { status: 'abstained', answer: null }] } : ['code_repair', 'code_generation', 'tool_use'].includes(contract.operation) ? { answer: 'string', artifacts: 'map of complete text files within writablePaths', ...(contract.executiveGoal ? { executiveGoal: 'the exact supplied public executiveGoal to execute' } : {}) } : 'Return the task answer exactly as requested.', publicFeedback: feedback })}`;
    const format = nativeResponseSchema(input, contract, remainingToolCalls);
    const result = await dependencies.ask(prompt, { remainingMs: remainingMs(), ...(format ? { format } : {}) });
    modelDigest ??= result.modelDigest;
    if (!result.modelDigest || result.modelDigest !== modelDigest || config.expectedModelDigest && modelDigest !== config.expectedModelDigest) throw new Error('Reference model identity changed');
    trace.push({ attempt, modelDigest, inference: result.inference ?? null, publicPromptHash: hash(prompt), rawResponse: result.answer });
    if (result.status === 'error') return failure('reference_generation_failed', trace, { modelDigest });
    if (autonomous) {
      let proposal;
      try {
        proposal = JSON.parse(result.answer);
        if (!proposal || typeof proposal.answer !== 'string' || typeof proposal.complete !== 'boolean' || !proposal.artifacts || Object.keys(proposal.artifacts).length || Object.keys(proposal).some(k => !['answer', 'artifacts', 'toolCalls', 'complete'].includes(k))) throw new Error('Invalid autonomous machine response');
        const executed = await session.execute(proposal.toolCalls);
        await ensurePublicFiles();
        feedback.push({ attempt, publicTools: executed.feedback });
        trace.push({ attempt, publicToolReceipts: session.receipts.slice() });
        if (proposal.complete && executed.lastCheckPassed) return { status: 'ok', answer: canonical({ disposition: 'succeeded' }), artifacts: session.artifacts, identity: { productOutcome: 'completed', modelDigest, trace } };
      } catch (e) { feedback.push({ attempt, publicToolFailure: e.message }); }
      continue;
    }
    if (!['code_repair', 'code_generation', 'tool_use'].includes(contract.operation)) {
      const checks = await runPublicChecks(contract, input, { cwd, remainingMs, executeCommand: dependencies.executeCommand });
      await ensurePublicFiles();
      if (!checks.passed) return failure(checks.reason, [...trace, { publicChecks: checks }], { modelDigest });
      if (contract.answerMode === 'answer_or_abstain') {
        let outcome;
        try { outcome = parseAnswerOrAbstain(result.answer); } catch { return failure('invalid_answer_or_abstain_response', trace, { modelDigest, rawResponseHash: result.rawResponseHash ?? hash(result) }); }
        return { status: 'ok', answer: canonical(outcome), artifacts: {}, identity: { productOutcome: outcome.status === 'abstained' ? 'abstained' : 'completed', modelDigest, operation: contract.operation, rawResponseHash: result.rawResponseHash ?? hash(result), machineOutcome: outcome, machineOutcomeHash: hash(outcome), trace } };
      }
      return { status: 'ok', answer: result.answer, artifacts: {}, identity: { productOutcome: 'completed', modelDigest, operation: contract.operation, rawResponseHash: result.rawResponseHash ?? hash(result), trace } };
    }
    let proposal;
    try {
      proposal = parseReferenceArtifacts(result.answer);
      await applyArtifacts(cwd, proposal.artifacts, contract, input.budgets.artifactBytes);
      Object.assign(submitted, proposal.artifacts);
      await ensurePublicFiles();
    } catch (e) { feedback.push({ attempt, parseOrScopeFailure: e.message }); continue; }
    if (contract.operation === 'tool_use') {
      if (!contract.executiveGoal || canonical(proposal.executiveGoal) !== canonical(contract.executiveGoal)) return failure('no_permitted_public_goal_selected', trace, { modelDigest });
      const executed = await executePublicGoal(proposal.executiveGoal, input, { cwd, remainingMs, executeCommand: dependencies.executeCommand });
      trace.push({ publicExecutive: executed });
      if (!executed.succeeded) return failure('executive_goal_not_succeeded', trace, { modelDigest });
      return { status: 'ok', answer: canonical({ disposition: 'succeeded' }), artifacts: submitted, identity: { productOutcome: 'completed', modelDigest, trace } };
    }
    const checks = await runPublicChecks(contract, input, { cwd, remainingMs, executeCommand: dependencies.executeCommand });
    trace.push({ attempt, publicChecks: checks });
    if (checks.passed) return { status: 'ok', answer: proposal.answer, artifacts: submitted, identity: { productOutcome: 'completed', modelDigest, trace } };
    feedback.push({ attempt, publicChecks: checks });
  }
  return failure('public_attempts_exhausted', trace, { modelDigest });
}

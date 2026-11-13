import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, hash } from '../protocol.mjs';
import { sha256Text, sha256Bytes } from '../../sealed-eval/harness/lib/util.mjs';
import { execute } from '../runner.mjs';
import { nativeProgramApprovalAllowed } from './native-program-approval.mjs';
import { verifyConfiguredRetainedSources, retainedAnswerProvenanceMatches } from './retained-sources.mjs';
import { nativeContract, currentPrompt, failure, containedFile, validateArtifacts, publicFilesGuard, runPublicChecks, typedFactualAbstention, publicContextReceipt } from './native-contract.mjs';

export async function runScceNative(input, config, dependencies = {}) {
  const result = await scceNativeOperation(input, config, dependencies);
  Object.assign(result.identity, publicContextReceipt(input));
  return result;
}
async function scceNativeOperation(input, config, dependencies) {
  const contract = nativeContract(input), cwd = config.cwd ?? process.cwd();
  if (contract.coverageBlocker) return { status: 'error', answer: '', artifacts: {}, identity: { coverageGap: contract.coverageBlocker } };
  const started = performance.now(), trace = [];
  const publicOwner = hash([config.runId ?? 'test-only-unscoped', input.caseId]);
  const remainingMs = () => Math.max(0, Math.floor(input.budgets.timeMs - (performance.now() - started)));
  const executeCommand = dependencies.executeCommand ?? execute;
  const ensurePublicFiles = await publicFilesGuard(input, contract, cwd);
  const request = dependencies.request ?? (async (route, body) => {
    const url = new URL(route, config.server);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Production bridge requires a credential-free loopback server URL');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) }, body: canonical(body), signal: AbortSignal.timeout(Math.max(1, remainingMs())) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > input.budgets.outputBytes) { await response.body.cancel().catch(() => {}); throw new Error('Product response byte budget exceeded'); }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return { status: response.status, body: JSON.parse(bytes.toString('utf8')), rawResponseHash: sha256Bytes(bytes) };
  });
  async function call(route, body, capability) {
    let result = await request(route, body);
    trace.push({ route, requestHash: hash(body), status: result.status, responseHash: hash(result.body), rawResponseHash: result.rawResponseHash ?? hash(result.body) });
    const seenApprovals=new Set();
    while (result.status === 202 && result.body?.pendingApproval) {
      const pending = result.body.pendingApproval;
      if (!capability || pending.capabilityId !== capability || !contract.approvals.includes(capability) || typeof pending.planId !== 'string') return result;
      const nativeProgram=contract.operation==='code_generation'&&capability==='process.build_test';
      if(nativeProgram&&(!nativeProgramApprovalAllowed({input,contract,pending})||seenApprovals.has(pending.fingerprint)||seenApprovals.size>=input.budgets.maxSteps)) {
        trace.push({route:'approval:refused',planId:pending.planId,reason:'public_native_validation_scope_mismatch'});return result;
      }
      if(nativeProgram)seenApprovals.add(pending.fingerprint);
      const approvalStarted=performance.now();
      const approved = await request('/api/session/approve', { planId: pending.planId });
      trace.push({ route: '/api/session/approve', capability, planId: pending.planId, fingerprint:pending.fingerprint??null, durationMs:performance.now()-approvalStarted,status: approved.status, responseHash: hash(approved.body) });
      if (approved.status !== 200) return approved;
      if(nativeProgram&&(approved.body?.approved?.planId!==pending.planId||approved.body.approved.fingerprint!==pending.fingerprint||canonical(approved.body.approved.input)!==canonical(pending.input))) {
        trace.push({route:'approval:refused',planId:pending.planId,reason:'approval_record_changed'});return {status:422,body:{reason:'approval_record_changed'}};
      }
      const retryStarted=performance.now();
      result = await request(route, body);
      trace.push({ route, requestHash: hash(body), status: result.status,durationMs:performance.now()-retryStarted,approvalRetry:true, responseHash: hash(result.body), rawResponseHash: result.rawResponseHash ?? hash(result.body) });
      if(!nativeProgram)break;
    }
    return result;
  }
  async function ingestPublicSources() {
    const sources = input.steps.at(-1).sources;
    if (!sources.length) return true;
    if (!contract.sourceAdmission || !contract.sourceTrust) throw new Error('Public sources require explicit admission and trust');
    for (const source of sources) {
      const body = { uri: `blind-public:${hash([publicOwner, source.id])}`, namespace: `blind.${publicOwner}`, content: source.text, mediaType: contract.sourceMediaTypes?.[source.id] ?? 'text/plain', sourceAdmission: contract.sourceAdmission, sourceTrust: contract.sourceTrust, metadata: { evaluationPublicSourceId: source.id, evaluationPublicSourceHash: sha256Text(source.text) } };
      const response = await call('/api/ingest', body);
      if (response.status !== 200 || !response.body?.sources || response.body?.skipped?.length) return false;
    }
    return true;
  }
  async function complete(answer, artifacts, extra = {}) {
    try { await ensurePublicFiles(); await validateArtifacts(artifacts, contract, input.budgets.artifactBytes); }
    catch (e) { return failure('product_public_scope_violation', trace, { ...extra, violation: e.message }); }
    const checks = await runPublicChecks(contract, input, { cwd, executeCommand, remainingMs });
    trace.push({ publicChecks: checks });
    if (!checks.passed) return failure(checks.reason, trace, extra);
    return { status: 'ok', answer, artifacts, identity: { ...extra, productOutcome: 'completed', operation: contract.operation, trace } };
  }
  let retainedVerification;
  if (contract.retainedSources) {
    retainedVerification = await (dependencies.verifyRetainedSources ?? verifyConfiguredRetainedSources)(input, contract, config, remainingMs());
    trace.push({ retainedSourceVerification: retainedVerification });
  } else if (!await ingestPublicSources()) return failure('public_source_ingestion_rejected', trace);
  let workspaceProgramContext;
  if (contract.prepareWorkspace === true) {
    const prepared = await call('/api/workspace/ingest', { path: cwd });
    if (prepared.status !== 200 || prepared.body?.failed > 0) return failure('public_workspace_ingestion_rejected', trace);
    const workspace = prepared.body?.workspace;
    if (!workspace?.id || !Number.isFinite(workspace.updatedAt)) return failure('public_workspace_identity_unavailable', trace);
    workspaceProgramContext = { schema: 'scce.workspace.program-context.v1', workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt };
  }
  const prompt = currentPrompt(input, contract);
  if (contract.operation === 'code_repair') {
    if (!config.cliPath || !config.configPath) throw new Error('Official CLI and config paths required for native repair');
    const control = await mkdtemp(path.join(tmpdir(), 'scce-blind-public-policy-'));
    let result;
    try {
      const policyFile = path.join(control, 'policy.json');
      await writeFile(policyFile, canonical(contract.validationPolicy));
      const argv = [process.execPath, config.cliPath, '--config', config.configPath, ...(config.cliSchema ? ['--schema', config.cliSchema] : []), 'code', `--root=${cwd}`, `--path=${contract.targetPaths[0]}`, `--attempts=${contract.maxPublicAttempts}`, `--validation-policy=${policyFile}`, prompt];
      result = await executeCommand(argv, { cwd, input: '', timeMs: remainingMs(), outputBytes: input.budgets.outputBytes, environmentKeys: config.cliEnvironmentKeys ?? [] });
    } finally { await rm(control, { recursive: true, force: true }); }
    if (result.failure) return failure('official_cli_resource_failure', [{ route: 'official-cli:code', ...result }]);
    let report;
    try { report = JSON.parse(result.stdout); } catch { return failure('official_cli_invalid_report', [{ route: 'official-cli:code', ...result }]); }
    trace.push({ route: 'official-cli:code', code: result.code, failure: result.failure, report, stderr: result.stderr });
    if (Number.isFinite(report.attempts) && report.attempts > contract.maxPublicAttempts) return failure('product_attempt_budget_exceeded', trace);
    if (report.outcome !== 'resolved' || result.code !== 0 || result.failure) return failure('code_repair_unresolved', trace);
    const paths = [...new Set((report.appliedOperations ?? []).map(o => o.path).concat(contract.targetPaths))];
    const artifacts = Object.fromEntries(await Promise.all(paths.map(async name => [name, await readFile(await containedFile(cwd, name), 'utf8')])));
    return complete('', artifacts);
  }
  const conversationId = `blind.${publicOwner}`;
  if (contract.operation === 'tool_use' && contract.executiveGoal) {
    const result = await call('/api/executive/run', contract.executiveGoal, 'process.build_test');
    if (result.status !== 200 || result.body?.disposition !== 'succeeded') return failure('executive_goal_not_succeeded', trace, { executiveDisposition: result.body?.disposition ?? null });
    return complete(canonical({ disposition: result.body.disposition }), {}, { executiveReceiptHash: hash(result.body) });
  }
  const body = { text: prompt, conversationId, ...(contract.requestedAuthority ? { requestedAuthority: contract.requestedAuthority } : {}) };
  if (contract.toolPolicy) body.metadata = { evaluationPublicWorkspace: { rootPath: cwd, toolPolicy: contract.toolPolicy, publicChecks: contract.publicChecks } };
  if (contract.operation === 'code_generation' && contract.programMode !== 'verified_artifacts') {
    const initialized = await call('/api/workspace/init', { path: cwd });
    if (initialized.status !== 200 || !initialized.body?.id || !Number.isFinite(initialized.body.updatedAt)) return failure('workspace_initialization_rejected', trace);
    body.requestedAuthority = 'program';
    body.workspaceCoding = { schemaVersion: 'scce.workspace-coding-turn-request.v1', workspaceId: initialized.body.id, expectedWorkspaceUpdatedAt: initialized.body.updatedAt, requestId: `blind.request.${hash([input.caseId, input.steps.length])}`, requestedPaths: contract.targetPaths, diagnosticCodes: [], validationPlan: { validatorId: contract.validationPolicyId, checks: contract.validationChecks } };
  } else if (contract.operation === 'code_generation') {
    body.requestedAuthority = 'program';
    if (workspaceProgramContext) body.metadata = { ...body.metadata, workspaceProgramContext };
  }
  else if (contract.operation === 'tool_use') body.requestedAuthority = 'action';
  const result = await call('/api/turn', body,contract.operation==='code_generation'&&contract.programMode==='verified_artifacts'?'process.build_test':undefined);
  if (contract.answerMode === 'answer_or_abstain' && typedFactualAbstention(result)) {
    const outcome = { status: 'abstained', answer: null };
    const completed = await complete(canonical(outcome), {}, { rawResponseHash: result.rawResponseHash ?? hash(result.body), machineOutcome: outcome, machineOutcomeHash: hash(outcome) });
    if (completed.identity.productOutcome === 'completed') completed.identity.productOutcome = 'abstained';
    return completed;
  }
  if (result.status !== 200) return failure(`turn_http_${result.status}`, trace, { readiness: result.body?.detail ?? null });
  const turn = result.body;
  if (retainedVerification && !retainedAnswerProvenanceMatches(turn, retainedVerification)) return failure('retained_source_answer_provenance_mismatch', trace);
  if (contract.operation === 'code_generation') {
    if (turn.programReadiness?.status === 'ready' && Array.isArray(turn.programArtifacts) && turn.programArtifacts.length) {
      if (turn.programReadiness.reasonId !== 'program.readiness.verified' || turn.programReadiness.artifactCount !== turn.programArtifacts.length || canonical(turn.programReadiness.artifactIds?.slice().sort()) !== canonical(turn.programArtifacts.map(a => a.artifactId).sort()) || new Set(turn.programArtifacts.map(a => a.path)).size !== turn.programArtifacts.length || turn.programArtifacts.some(a => typeof a.content !== 'string' || a.contentHash !== `sha256_${sha256Text(a.content)}`)) return failure('invalid_program_artifact_identity', trace);
      const artifacts = Object.fromEntries(turn.programArtifacts.map(a => [a.path, a.content]));
      const { applyArtifacts } = await import('./native-contract.mjs');
      try { await applyArtifacts(cwd, artifacts, contract, input.budgets.artifactBytes); }
      catch (e) { return failure('product_artifact_scope_violation', trace, { violation: e.message }); }
      return complete(turn.answer ?? '', artifacts, { programReadiness: turn.programReadiness });
    }
    if (!body.workspaceCoding) return failure('program_has_no_verified_artifacts', trace);
    const plan = turn.workspaceCoding?.plan;
    if (!plan?.operations?.length || plan.operations.some(o => o.kind === 'delete' || !contract.writablePaths.includes(o.path))) return failure('program_has_no_applicable_artifact_plan', trace, { readiness: turn.programReadiness ?? null });
    const applied = await call('/api/workspace/patch', { schemaVersion: 'scce.workspace-patch-request.v1', workspaceId: body.workspaceCoding.workspaceId, plan, validationPolicyId: contract.validationPolicyId }, 'workspace.patch.apply');
    if (applied.status !== 200 || applied.body?.receipt?.planHash !== plan.planHash || !applied.body?.receipt?.validation) return failure('program_patch_not_verified', trace);
    const artifacts = Object.fromEntries(await Promise.all(plan.operations.map(async o => [o.path, await readFile(await containedFile(cwd, o.path), 'utf8')])));
    return complete(turn.answer ?? '', artifacts, { patchReceiptHash: hash(applied.body.receipt) });
  }
  if (contract.operation === 'tool_use') {
    let resolvedTurn;
    try { const { decodeProgramArtifactWire } = await import('../../../packages/kernel/dist/program-artifact-wire.js'); resolvedTurn = decodeProgramArtifactWire(turn); }
    catch (error) { return failure('invalid_tool_artifact_reference', trace, { violation: error.message }); }
    const events = resolvedTurn.events ?? [];
    const succeeded = events.filter(e => e.typeId === 'CapabilitySucceeded');
    const failed = events.filter(e => e.typeId === 'CapabilityFailed');
    if (!succeeded.length || failed.length || contract.requiredCapabilityIds?.some(id => !succeeded.some(e => e.payload?.capabilityId === id))) return failure('no_successful_native_tool_receipt', trace);
    if (contract.toolPolicy && succeeded.length + failed.length + contract.publicChecks.length > contract.toolPolicy.maxCalls) return failure('product_tool_call_budget_exceeded', trace);
    trace.push({ capabilityEvents: succeeded });
    const executionArtifacts = resolvedTurn.buildTest?.artifacts ?? [];
    const emitted = executionArtifacts.filter(a => contract.writablePaths.includes(a.path));
    const artifacts = Object.fromEntries(emitted.map(a => [a.path, a.content]));
    if (emitted.some(a => typeof a.content !== 'string' || a.contentHash !== `sha256_${sha256Text(a.content)}`)) return failure('invalid_tool_artifact_identity', trace);
    if (emitted.length) {
      const { applyArtifacts } = await import('./native-contract.mjs');
      try { await applyArtifacts(cwd, artifacts, contract, input.budgets.artifactBytes); }
      catch { return failure('tool_artifact_outside_public_scope', trace); }
    }
    for (const name of contract.writablePaths) {
      try { artifacts[name] = await readFile(await containedFile(cwd, name), 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    trace.push({ executionArtifactIds: executionArtifacts.map(a => a.artifactId), persistedPublicPaths: Object.keys(artifacts) });
    return complete(canonical({ disposition: 'succeeded' }), artifacts, { rawAnswer: turn.answer ?? '', rawResponseHash: result.rawResponseHash ?? hash(turn) });
  }
  if (contract.answerMode === 'answer_or_abstain') {
    const outcome = { status: 'answered', answer: typeof turn.answer === 'string' ? turn.answer : '' };
    return complete(canonical(outcome), {}, { episodeId: turn.episodeId ?? null, rawResponseHash: result.rawResponseHash ?? hash(turn), machineOutcome: outcome, machineOutcomeHash: hash(outcome) });
  }
  return complete(typeof turn.answer === 'string' ? turn.answer : '', {}, { episodeId: turn.episodeId ?? null, rawResponseHash: result.rawResponseHash ?? hash(turn) });
}

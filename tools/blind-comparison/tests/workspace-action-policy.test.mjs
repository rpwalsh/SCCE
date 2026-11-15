import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hash} from '../protocol.mjs';
import {publicWorkspaceActionPolicy,publicWorkspacePolicyId,workspaceActionApprovalAllowed,workspaceCapabilityId} from '../adapters/workspace-action-policy.mjs';

test('public tool declarations resolve to canonical capabilities and pin exact checks before any proposal',async()=>{
 const input={steps:[{files:{'input.json':'[]','check.mjs':'process.exit(0);'}}],budgets:{artifactBytes:20000,timeMs:5000,outputBytes:10000}};
 const contract={writablePaths:['output.json'],toolPolicy:{tools:['filesystem.read','filesystem.write','workspace.check'],maxCalls:8},publicChecks:[{argv:['{node}','check.mjs']}]};
 const policy=await publicWorkspaceActionPolicy(input,contract);
 assert.deepEqual(policy.capabilityIds,contract.toolPolicy.tools);assert.equal(workspaceCapabilityId('workspace.read'),'filesystem.read');
 assert.equal(policy.checks[0].executable,process.execPath);assert.deepEqual(policy.checks[0].argv,['check.mjs']);assert.match(policy.checks[0].executableSha256,/^[a-f0-9]{64}$/u);
 assert.equal(publicWorkspacePolicyId(policy),`workspace_action_${hash(policy)}`);assert.deepEqual(policy.protectedFiles.map(row=>row.path),['input.json','check.mjs']);assert.equal(policy.maxCalls,8);
});

test('workspace approvals require the predeclared policy, exact workspace and concrete observed input scope',async()=>{
 const cwd=await mkdtemp(path.join(tmpdir(),'scce-workspace-approval-'));
 try{
  await writeFile(path.join(cwd,'input.json'),'[]');
  const context={schema:'scce.workspace.action-context.v1',workspaceId:'workspace.owner',expectedWorkspaceUpdatedAt:1,policyId:'workspace_action_pinned'};
  const policy={capabilityIds:['filesystem.write','workspace.check'],writablePaths:['output.json'],maxFileBytes:100,checks:[{argv:['check.mjs']}]};
  const input={workspaceContext:context,path:'output.json',content:'["fresh"]',expectedContentHash:null};
  const pending={capabilityId:'filesystem.write',input,approvalScope:{episodeId:'episode.scope',goalId:'goal.scope',taskId:'task.scope',inputRef:hash(input)}};
  const allowed=p=>workspaceActionApprovalAllowed({pending:p,context,policy,cwd});
  assert.equal(await allowed(pending),true);
  for(const altered of [{...input,path:'input.json'},{...input,workspaceContext:{...context,workspaceId:'other'}},{...input,content:'x'.repeat(101)},{...input,expectedContentHash:'sha256_stale'}])assert.equal(await allowed({...pending,input:altered,approvalScope:{...pending.approvalScope,inputRef:hash(altered)}}),false);
  assert.equal(await allowed({...pending,approvalScope:{...pending.approvalScope,inputRef:'stale'}}),false);
  await writeFile(path.join(cwd,'output.json'),'changed');assert.equal(await allowed(pending),false);
  const checkInput={workspaceContext:context,index:0};assert.equal(await allowed({capabilityId:'workspace.check',input:checkInput,approvalScope:{...pending.approvalScope,inputRef:hash(checkInput)}}),true);
 }finally{await rm(cwd,{recursive:true,force:true});}
});

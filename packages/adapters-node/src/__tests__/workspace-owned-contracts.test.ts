// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect,vi} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {readWorkspaceOwnedProgramContracts,createClock,createHasher,createIdFactory,createInMemoryDialogueMemoryStore,toJsonValue,type EvidenceSpan,type SourceVersion,type WorkspaceRecord,type WorkspaceSourceFileRecord,type WorkspaceReportRecord,type ScceStorage,type InformationLabel} from "@scce/kernel";
import { createCapabilityTestKernel as createScceKernel } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import {storageFixtureForEvaluation} from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import {createWorkspaceRuntime} from "../workspace-runtime.js";
import {createApprovalSession} from "../approval-session.js";
import {NodeBuildTestAdapter} from "../process.js";
import {NodeFileIngestAdapter} from "../files.js";
import type {NodeScceRuntime} from "../runtime.js";
import type {ScceRuntimeConfig} from "../config.js";

it("ordinary workspace ingestion publishes owned Python assertions without profiles and survives a third replay",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"scce-real-workspace-contract-"));
 try{
  await writeFile(path.join(root,"provider.py"),'_state = {}\ndef f0(key,value):\n    _state[key]=value\ndef f1(key):\n    return _state[key]\n');
  await writeFile(path.join(root,"checks.py"),'from provider import f0, f1\ndef sequence():\n    f0("a",111)\n    assert f1("a")==111\n    f0("a",222)\n    assert f1("a")==222\n');
  const clock=createClock({fixedTime:1000,stepMs:1}),hasher=createHasher(),spans:EvidenceSpan[]=[],versions:SourceVersion[]=[],blobs=new Map<string,Uint8Array>();
  const recorded=storageFixtureForEvaluation({evidence:spans,clockNow:()=>clock.now()}),storage=recorded.storage;
  storage.evidence.putSourceVersion=async row=>{const index=versions.findIndex(old=>old.sourceVersionId===row.sourceVersionId);if(index<0)versions.push(row);else versions[index]=row;};
  storage.evidence.putEvidenceSpan=async row=>{const index=spans.findIndex(old=>old.id===row.id);if(index<0)spans.push(row);else spans[index]=row;};
  storage.evidence.sourceVersionsForEvidence=async ids=>versions.filter(version=>spans.some(span=>ids.includes(span.id)&&span.sourceVersionId===version.sourceVersionId));
  storage.blobs.put=async bytes=>{const hash=`sha256_${createHash("sha256").update(bytes).digest("hex")}`;blobs.set(hash,new Uint8Array(bytes));return hash as never;};
  storage.blobs.get=async hash=>{const bytes=blobs.get(hash);if(!bytes)throw new Error("canonical source absent");return bytes;};
  const workspaces:WorkspaceRecord[]=[],files:WorkspaceSourceFileRecord[]=[],reports:WorkspaceReportRecord[]=[];
  storage.workspace={putWorkspace:async row=>{workspaces.splice(0,workspaces.length,row);},getWorkspace:async id=>workspaces.find(row=>row.id===id)??null,latestWorkspace:async()=>workspaces.at(-1)??null,
   putSourceFile:async row=>{const index=files.findIndex(old=>old.workspaceId===row.workspaceId&&old.path===row.path);if(index<0)files.push(row);else files[index]=row;},listSourceFiles:async query=>files.filter(row=>!query?.workspaceId||row.workspaceId===query.workspaceId),
   putReport:async row=>{reports.push(row);},listReports:async()=>reports} as ScceStorage["workspace"];
  storage.dialogueMemory=createInMemoryDialogueMemoryStore();
  storage.userModelClaims={putClaim:async()=>undefined,listClaims:async()=>[]};
  storage.taskResumption={putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null};
  storage.documentGeneration={putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})};
  const label:InformationLabel={tenantId:"workspace-contract-test",principals:["owner"],compartments:[],exportClass:"confidential",mergePolicy:"same_owner"};
  const config={runtime:{workspaceRoot:root,tempRoot:root,maxFileBytes:100000,maxChunkBytes:64000,allowedRoots:[root],excludedPaths:[],tools:{}},connectors:{},policy:{allowMutation:false,requireTwoPhaseCommit:true,dryRunByDefault:true,maxNetworkRequests:0,maxToolCalls:0,maxSpendCents:0,alphaRiskCeiling:0.5,encryptSecretsAtRest:true}} as unknown as ScceRuntimeConfig;
  const approvals=createApprovalSession(),ids=createIdFactory({clock,hasher,deterministicReplay:true});
  const planIdentity=vi.spyOn(ids,"semanticId");
  const adapter=new NodeFileIngestAdapter(config),kernel=createScceKernel({storage,clock,idFactory:ids,deterministicReplay:true,policy:{allowMutation:true,dryRunByDefault:false,requireTwoPhaseCommit:false,maxToolCalls:20},
   approvals,
   sourceInformationLabel:label,informationAccess:{tenantId:label.tenantId,principalId:"owner",compartments:[],maximumExportClass:"restricted"},files:{streamPath:async function*(name,options){for await(const item of adapter.streamPath(name,options))yield item.type==="file"?{...item,file:{...item.file,namespace:"custom-owner-code"}}:item;}},
   buildTest:new NodeBuildTestAdapter(config)});
  const ingest=vi.spyOn(kernel,"ingest"),publication=vi.spyOn(storage.blobs,"put"),blobRead=vi.spyOn(storage.blobs,"get");
  const runtime=createWorkspaceRuntime({runtime:{kernel,storage} as unknown as NodeScceRuntime,config});
  const first=await runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});
  expect(first.failed).toBe(0);expect(first.sourceContracts,JSON.stringify({receipt:first.sourceContracts,profiles:await storage.model.listLanguageProfiles(),versions:versions.map(row=>({id:row.sourceVersionId,uri:row.canonicalUri,hash:row.contentHash,role:row.role})),files:files.map(row=>({path:row.path,hash:row.contentHash,ids:row.evidenceIds}))})).toMatchObject({status:"compiled",contracts:1,sourceVersions:2});
  const workspace=await storage.workspace.getWorkspace(first.workspace.id),receipt=(workspace!.metadata as Record<string,unknown>).sourceContracts as {blobHash:string};
  const projection=JSON.parse(Buffer.from(await storage.blobs.get(receipt.blobHash as never)).toString("utf8"));
  expect(projection.informationLabel).toEqual(label);
  expect(projection.contracts).toHaveLength(1);expect(projection.contracts[0]).toMatchObject({sourcePath:"provider.py",cases:[{expectedResult:111},{expectedResult:222}]});
  const context={schema:"scce.workspace.program-context.v1",workspaceId:first.workspace.id,expectedWorkspaceUpdatedAt:first.workspace.updatedAt};
  const access={tenantId:label.tenantId,principalId:"owner",compartments:[],maximumExportClass:"restricted" as const};
  const read=()=>readWorkspaceOwnedProgramContracts({storage,context,informationAccess:access});
  expect(await read()).toMatchObject({status:"available",contracts:[{patternJson:{sourcePath:"provider.py"}}]});
  expect(await readWorkspaceOwnedProgramContracts({storage,context:{...context,expectedWorkspaceUpdatedAt:-1},informationAccess:access})).toMatchObject({status:"unavailable",reasonId:"workspace.contracts.stale_workspace"});
  expect(await readWorkspaceOwnedProgramContracts({storage,context,informationAccess:{...access,principalId:"foreign"}})).toMatchObject({status:"unavailable",reasonId:"workspace.contracts.owner_scope_unavailable"});
  expect(await readWorkspaceOwnedProgramContracts({storage,context,informationAccess:access,sourceVersionAllowlist:[]})).toMatchObject({status:"unavailable"});
  const saved=spans[0]!.status;spans[0]!.status="quarantined";
  expect(await read()).toMatchObject({status:"unavailable"});spans[0]!.status=saved;
  const original=blobs.get(receipt.blobHash)!;blobs.set(receipt.blobHash,new TextEncoder().encode("{}"));
  expect(await read()).toMatchObject({status:"unavailable",reasonId:"workspace.contracts.projection_hash_mismatch"});blobs.set(receipt.blobHash,original);
  const beforeUpgradeIds=versions.map(row=>row.sourceVersionId),beforeUpgradeProfiles=await storage.model.listLanguageProfiles();
  const metadata=workspace!.metadata as Record<string,unknown>,currentReceipt=metadata.sourceContracts as {componentRecipe:string};
  await storage.workspace.putWorkspace({...workspace!,metadata:toJsonValue({...metadata,sourceContracts:{...currentReceipt,componentRecipe:currentReceipt.componentRecipe.replace(/scce\.source_owned_contract_snapshot_compiler\.v\d+:/u,"scce.source_owned_contract_snapshot_compiler.v2:")}})});
  expect(await read()).toMatchObject({status:"unavailable",reasonId:"workspace.contracts.projection_unavailable"});
  ingest.mockClear();publication.mockClear();
  const upgraded=await runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});
  expect(upgraded.sourceContracts).toMatchObject({status:"compiled",contracts:1});
  expect(ingest).not.toHaveBeenCalled();expect(publication).toHaveBeenCalledTimes(1);
  expect(versions.map(row=>row.sourceVersionId)).toEqual(beforeUpgradeIds);
  expect(await storage.model.listLanguageProfiles()).toEqual(beforeUpgradeProfiles);
  context.expectedWorkspaceUpdatedAt=upgraded.workspace.updatedAt;
  const input={text:"Python f0 f1",requestedAuthority:"program" as const,metadata:{workspaceProgramContext:context}};
  const pending=await kernel.turn(input);
  expect(pending.buildTest).toBeUndefined();
  const firstPlan=approvals.snapshot().pending.find(row=>row.capabilityId==="process.build_test")!;
  expect(firstPlan.input).toMatchObject({schema:"scce.program.native_validation_approval.v1",provider:{id:"program.runtime.python-stdlib.v1"},build:{command:"python"},test:{command:"python"}});
  approvals.approve(firstPlan.planId);
  const failed=await kernel.turn(input);
  expect(failed.buildTest?.passed,JSON.stringify({pending:approvals.snapshot().pending.map(row=>({planId:row.planId,fingerprint:row.fingerprint}))})).toBe(false);
  const retryPlan=approvals.snapshot().pending.find(row=>row.capabilityId==="process.build_test")!;
  expect(retryPlan.fingerprint).not.toBe(firstPlan.fingerprint);
  approvals.approve(retryPlan.planId);
  const turn=await kernel.turn(input);
  const selectedPlans=planIdentity.mock.calls.filter(row=>row[0]==="program_plan").map(row=>row[1] as {implementation?:{phase?:string}}).filter(row=>row.implementation?.phase==="selected");
  expect(selectedPlans).toHaveLength(2);expect(selectedPlans[1]).toEqual(selectedPlans[0]);
  expect(turn.constructGraph.program?.language,JSON.stringify({construct:turn.constructGraph,build:turn.buildTest})).toBe("python");
  expect(turn.constructGraph.program!.hydration!.ownerRequirementIds).toHaveLength(2);
  expect(turn.constructGraph.program!.hydration!.ownerRequirementIds!.every(id=>id.startsWith("source_assertion."))).toBe(true);
  expect(turn.buildTest?.passed,JSON.stringify({pending:approvals.snapshot().pending.map(row=>({planId:row.planId,fingerprint:row.fingerprint})),build:turn.buildTest&&{passed:turn.buildTest.passed,build:turn.buildTest.build.code,test:turn.buildTest.test.code}})).toBe(true);
  const staleTurn=await kernel.turn({text:"Python q(1)=2; q(2)=4; q(3)=6",requestedAuthority:"program",metadata:{workspaceProgramContext:{...context,expectedWorkspaceUpdatedAt:-1}}});
  expect(staleTurn.constructGraph.program).toBeUndefined();
  expect(staleTurn.buildTest).toBeUndefined();
  expect(staleTurn.constructGraph.nodes.find(row=>row.kind==="program_emission_unavailable")?.metadata).toMatchObject({status:"unavailable",reasonIds:["program.emission.workspace_source_scope_unavailable"]});
  const profiles=await storage.model.listLanguageProfiles(),sourceIds=versions.map(row=>row.sourceVersionId);
  expect(versions.every(row=>row.namespace==="custom-owner-code")).toBe(true);
  expect(profiles).toHaveLength(0);
  ingest.mockClear();publication.mockClear();blobRead.mockClear();
  for(let replay=0;replay<2;replay++){
   const same=await runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});
   expect(same.sourceContracts).toMatchObject({status:"current",contracts:1});
  }
  expect(ingest).not.toHaveBeenCalled();expect(publication).not.toHaveBeenCalled();expect(blobRead).not.toHaveBeenCalled();
  expect((await storage.model.listLanguageProfiles()).map(row=>row.id)).toEqual(profiles.map(row=>row.id));
  expect(versions.map(row=>row.sourceVersionId)).toEqual(sourceIds);
 }finally{await rm(root,{recursive:true,force:true});}
});

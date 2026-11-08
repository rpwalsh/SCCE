// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import {createHash} from "node:crypto";
import {createScceKernel,createClock,createHasher,createIdFactory,createInMemoryDialogueMemoryStore,type EvidenceSpan,type SourceVersion,type WorkspaceRecord,type WorkspaceSourceFileRecord,type WorkspaceReportRecord,type ScceStorage,type InformationLabel} from "@scce/kernel";
import {storageFixtureForEvaluation} from "../../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import {createWorkspaceRuntime} from "../../workspace-runtime.js";
import {createApprovalSession} from "../../approval-session.js";
import {NodeBuildTestAdapter} from "../../process.js";
import {NodeFileIngestAdapter} from "../../files.js";
import type {NodeScceRuntime} from "../../runtime.js";
import type {ScceRuntimeConfig} from "../../config.js";

export function ordinaryWorkspaceProgramFixture(root:string){
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
  const config={runtime:{workspaceRoot:root,tempRoot:root,maxFileBytes:1000000,maxChunkBytes:64000,allowedRoots:[root],excludedPaths:[],tools:{}},connectors:{},policy:{allowMutation:false,requireTwoPhaseCommit:true,dryRunByDefault:true,maxNetworkRequests:0,maxToolCalls:0,maxSpendCents:0,alphaRiskCeiling:0.5,encryptSecretsAtRest:true}} as unknown as ScceRuntimeConfig;
  const approvals=createApprovalSession(),ids=createIdFactory({clock,hasher,deterministicReplay:true});
  const adapter=new NodeFileIngestAdapter(config),kernel=createScceKernel({storage,clock,idFactory:ids,deterministicReplay:true,policy:{allowMutation:true,dryRunByDefault:false,requireTwoPhaseCommit:false,maxToolCalls:20},
   approvals,
   sourceInformationLabel:label,informationAccess:{tenantId:label.tenantId,principalId:"owner",compartments:[],maximumExportClass:"restricted"},files:{streamPath:async function*(name,options){for await(const item of adapter.streamPath(name,options))yield item.type==="file"?{...item,file:{...item.file,namespace:"custom-owner-code"}}:item;}},
   buildTest:new NodeBuildTestAdapter(config)});
  const runtime=createWorkspaceRuntime({runtime:{kernel,storage} as unknown as NodeScceRuntime,config});
  return {kernel,storage,runtime,approvals,versions,spans};
}

#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash} from 'node:crypto';
import {readFile,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {createNodeRuntime,readScceRuntimeConfig,assertHydratedRuntimeReady} from '../../packages/adapters-node/dist/index.js';
const {values}=parseArgs({options:{config:{type:'string'},out:{type:'string'},cases:{type:'string',default:'tools/language-behavior-evaluation/cases.json'},limit:{type:'string'},offset:{type:'string',default:'0'},'preserve-functional-authorization':{type:'boolean',default:false},'budget-ms':{type:'string',default:'60000'}}});
if(!values.config||!values.out)throw new Error('Usage: node tools/language-behavior-evaluation/run.mjs --config=<local-config> --out=<new-json> [--limit=N] [--budget-ms=60000]');
const offset=Number(values.offset);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid offset');
const budgetMs=Number(values['budget-ms']),limit=values.limit===undefined?Infinity:Number(values.limit);
if(!Number.isSafeInteger(budgetMs)||budgetMs<1000||!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0))throw new Error('Invalid diagnostic limits');
const bytes=await readFile(values.cases),suite=JSON.parse(bytes),selected=suite.cases.slice(offset,offset+limit),casesSha256=createHash('sha256').update(bytes).digest('hex');
const base=await readScceRuntimeConfig(values.config);
const config=structuredClone(base);
config.connectors.web.enabled=false;config.connectors.web.runtimeAcquisition='disabled';
config.policy.maxNetworkRequests=0;config.policy.allowMutation=false;
if(!values['preserve-functional-authorization'])config.runtime.functionalCognitionAuthorizeCapabilities=false;
if(config.runtime.dreamCycle)config.runtime.dreamCycle.enabled=false;
const out=resolve(values.out),journal=out+'.jsonl';await mkdir(dirname(out),{recursive:true});
const report={schema:'scce.language_behavior_diagnostic.v1',startedAt:new Date().toISOString(),casesSha256,
 sourceCodeCommit:'1ac82eac41b5f33b7f58fb1dc485c7a9fa83e2e7',scope:'Available checkpoint; not Windows 29-article candidate',
 externalWebEnabled:false,externalInferenceRequested:false,canonicalApplicationWrites:'each case is rolled back',
 syntheticRequestRequirementBootstrap:config.runtime.allowSyntheticRequestRequirementBootstrap===true,
 functionalCognitionAuthorization:config.runtime.functionalCognitionAuthorizeCapabilities===true,kernelBudgetMs:budgetMs,results:[],productionReadiness:null};
await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
await writeFile(journal,JSON.stringify({type:'run.started',casesSha256,cases:selected.map(x=>x.id)})+'\n',{flag:'wx'});
const normalize=s=>String(s).normalize('NFKC').toLowerCase().trim().replace(/^["'“”‘’]+|["'“”‘’.!?]+$/gu,'').replace(/\s+/gu,' ');
const rollback=Object.freeze(new Error('intentional evaluation rollback'));
for(const item of selected){
 let runtime,result;const start=performance.now();
 try{
  runtime=createNodeRuntime(config);await runtime.relationPotential.hydrated;
  if(report.productionReadiness===null){
   try{const active=await assertHydratedRuntimeReady(runtime.storage);report.productionReadiness={passed:true,...active};}
   catch(error){report.productionReadiness={passed:false,error:String(error.message??error)};}
  }
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(new Error('Diagnostic turn timeout')),budgetMs+5000);timer.unref();
  let turn;
  try{
   await runtime.storage.transaction(async()=>{
    const t=performance.now();
    turn=await runtime.kernel.turn({text:item.prompt,metadata:{conversationId:'language-evaluation.'+item.id,
     sessionId:'language-evaluation.'+item.id,runtimePath:{hydratedRuntime:true,serverPath:false,sourceOnlySimulation:false},
     runtime:{deadline:{schema:'scce.runtime_deadline.v1',clock:'node.performance.v1',budgetMs,responseReserveMs:1000,
      startedMonotonicMs:t,deadlineMonotonicMs:t+budgetMs,computeDeadlineMonotonicMs:t+budgetMs-1000}}},
     runtimeControl:{signal:ac.signal,onProgress:p=>{if(p.phase==='answer.ready')void appendFile(journal,JSON.stringify({type:'answer.ready',id:item.id,answer:p.answer})+'\n')}}});
    throw rollback;
   });
  }catch(error){if(error!==rollback)throw error;}finally{clearTimeout(timer);}
  const answer=String(turn.answer??'');
  result={id:item.id,category:item.category,prompt:item.prompt,criterion:item.criterion,answer,
   grading:item.grading,automaticStatus:item.grading==='exact'?(item.accepted.includes(normalize(answer))?'passed':'failed'):'requires_manual_review',
   epistemicForce:turn.epistemicForce,assistantForce:turn.assistantForce,realizationAvailability:turn.realizationAvailability,
   withheld:turn.withheld,evidenceCount:turn.evidence?.length??0,evidenceIds:turn.evidence?.map(x=>x.id)??[],
   eventTypes:[...new Set(turn.events?.map(x=>x.typeId)??[])],timing:turn.timing};
 }catch(error){result={id:item.id,category:item.category,prompt:item.prompt,criterion:item.criterion,answer:'',grading:item.grading,automaticStatus:'runtime_error',error:String(error.message??error)};}
 finally{await runtime?.close();}
 result.elapsedMs=Math.round(performance.now()-start);report.results.push(result);
 await appendFile(journal,JSON.stringify({type:'case.completed',...result})+'\n');
 await writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(result));
}
report.completed=true;report.finishedAt=new Date().toISOString();
report.qualification='Direct production kernel turns against the recorded checkpoint. No training on prompts, no web, no external inference. Exact tasks use predefined accepted strings; open-ended tasks require manual rubric review. Runtime errors do not establish linguistic inability. This small diagnostic cannot establish broad English fluency or attribute any success solely to corpus learning.';
await writeFile(out,JSON.stringify(report,null,2)+'\n');

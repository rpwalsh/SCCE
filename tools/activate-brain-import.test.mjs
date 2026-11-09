// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import {test} from "node:test";
import {activateBrainImport,parseActivationArguments} from "./activate-brain-import.mjs";

function fixture(state="READY"){
  const config={database:{url:"postgresql://fixture-only@localhost/isolated",schema:"configured",ssl:false},security:{informationAccess:{tenantId:"owner",principalId:"operator",compartments:["manual-import"]}}};
  const target={importRunId:"opaque.import",brainVersion:"manual-format.v7",rootPath:"manual://source",state},calls=[];
  let closed=0,activationFailure,closeFailure;
  return {config,target,calls,get closed(){return closed;},failActivation(error){activationFailure=error;},failClose(error){closeFailure=error;},dependencies:{
    readScceRuntimeConfig:async filename=>{calls.push(["config",filename]);return config;},now:()=>1234,
    createPostgresStorageAdapter:options=>{calls.push(["storage",options]);return {
      query(){assert.fail("manual SQL must not be issued by activation tooling");},
      brainImports:{getLifecycle:async id=>{calls.push(["getLifecycle",id]);return state==="missing"?null:target;},
        active:async()=>{calls.push(["active"]);return {activeBrainVersion:"previous",activeImportRunIds:["previous-import"]};},
        activateReady:async input=>{calls.push(["activateReady",input]);if(activationFailure!==undefined)throw activationFailure;return {activeBrainVersion:target.brainVersion,activeImportRunIds:[target.importRunId]};}},
      close:async()=>{closed++;if(closeFailure!==undefined)throw closeFailure;}
    };}
  }};
}
test("preserves ordinary legacy arguments and accepts an explicit canonical runtime config",()=>{
  assert.deepEqual(parseActivationArguments(["opaque.import","--apply","--schema=scoped"]),{importRunId:"opaque.import",apply:true,schema:"scoped"});
  assert.deepEqual(parseActivationArguments(["--config","chosen.local.json","opaque.import"]),{importRunId:"opaque.import",apply:false,config:"chosen.local.json"});
  for(const args of [[],["id","second"],["id","--unknown"],["id","--schema=bad;sql"],["id","--apply","--apply"],["id","--config"]])assert.throws(()=>parseActivationArguments(args));
});
test("dry run reads exact lifecycle/active ports with zero mutations and always closes",async()=>{
  const f=fixture(),result=await activateBrainImport(parseActivationArguments(["opaque.import"]),f.dependencies);
  assert.equal(result.status,"dry_run");assert.equal(result.applied,false);assert.equal(f.closed,1);
  assert.deepEqual(f.calls.filter(([name])=>name==="getLifecycle"),[["getLifecycle","opaque.import"]]);
  assert.equal(f.calls.filter(([name])=>name==="activateReady").length,0);
});
test("apply delegates generic manual replacement only to canonical activation with owner context and schema binding",async()=>{
  const f=fixture(),result=await activateBrainImport(parseActivationArguments(["opaque.import","--apply","--schema=selected","--config=chosen.local.json"]),f.dependencies);
  assert.equal(result.status,"activated");assert.deepEqual(result.active,{activeBrainVersion:"manual-format.v7",activeImportRunIds:["opaque.import"]});
  assert.deepEqual(f.calls.find(([name])=>name==="storage"),["storage",{...f.config.database,schema:"selected",informationAccess:f.config.security.informationAccess}]);
  assert.deepEqual(f.calls.find(([name])=>name==="config"),["config","chosen.local.json"]);
  assert.deepEqual(f.calls.filter(([name])=>name==="activateReady"),[["activateReady",{importRunId:"opaque.import",brainVersion:"manual-format.v7",updatedAt:1234}]]);
  assert.equal(f.closed,1);assert.equal(JSON.stringify(result).includes(f.config.database.url),false);
});
test("already ACTIVE is idempotent while other states and missing targets cannot mutate",async()=>{
  for(const state of ["ACTIVE","IMPORTING","STOPPED","QUARANTINED","missing"]){
    const f=fixture(state),run=activateBrainImport(parseActivationArguments(["opaque.import","--apply"]),f.dependencies);
    if(state==="ACTIVE")assert.equal((await run).status,"already_active");else await assert.rejects(run,/READY|no lifecycle/);
    assert.equal(f.calls.filter(([name])=>name==="activateReady").length,0);assert.equal(f.closed,1);
  }
});
test("canonical compare-and-set or ownership failures propagate without SQL retries",async()=>{
  const f=fixture(),primary=Error("canonical activation compare-and-set failed");f.failActivation(primary);
  await assert.rejects(activateBrainImport(parseActivationArguments(["opaque.import","--apply"]),f.dependencies),error=>error===primary);
  assert.equal(f.calls.filter(([name])=>name==="activateReady").length,1);assert.equal(f.closed,1);
});
test("retains the primary failure when storage cleanup also fails",async()=>{
  const f=fixture(),primary=Error("activation failed"),cleanup={opaque:"close failed"};f.failActivation(primary);f.failClose(cleanup);
  await assert.rejects(activateBrainImport(parseActivationArguments(["opaque.import","--apply"]),f.dependencies),error=>error instanceof AggregateError&&error.errors[0]===primary&&error.errors[1]===cleanup);
  assert.equal(f.closed,1);
});
test("missing owner context or unsafe override cannot create a storage connection",async()=>{
  const missing=fixture();delete missing.config.security;
  await assert.rejects(activateBrainImport(parseActivationArguments(["opaque.import"]),missing.dependencies),/security.informationAccess/);
  assert.equal(missing.calls.filter(([name])=>name==="storage").length,0);
  const unsafe=fixture();await assert.rejects(activateBrainImport({importRunId:"opaque.import",schema:"unsafe;sql",apply:true},unsafe.dependencies),/unsafe schema/);
  assert.equal(unsafe.calls.filter(([name])=>name==="storage").length,0);
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {test} from "node:test";

test("the actual --apply CLI enters canonical activation and never issues its own lifecycle SQL",()=>{
  const preload=`
    import {registerHooks} from 'node:module';
    const config={database:{url:'postgresql://fixture-only@localhost/isolated',schema:'configured'},security:{informationAccess:{tenantId:'owner',principalId:'operator',compartments:[]}}};
    const modules={
      config:"export async function readScceRuntimeConfig(filename){if(filename!=='fixture.config.json')throw Error('wrong config binding');return "+JSON.stringify(config)+";}",
      postgres:"export function createPostgresStorageAdapter(options){if(options.schema!=='selected'||options.informationAccess?.principalId!=='operator')throw Error('wrong owner/schema binding');return {query(){throw Error('direct SQL forbidden');},brainImports:{getLifecycle:async id=>({importRunId:id,brainVersion:'manual-format',rootPath:'manual://source',state:'READY'}),active:async()=>({activeImportRunIds:['previous']}),activateReady:async input=>({activeBrainVersion:input.brainVersion,activeImportRunIds:[input.importRunId],canonicalDispatch:true})},close:async()=>{}};}",
      legacyConfig:"export function databaseUrl(){return 'postgresql://fixture-only@localhost/isolated';}export function databaseSchema(){return 'selected';}",
      pg:"module.exports={Client:class{async connect(){}async query(){throw Error('direct activation SQL bypasses canonical API');}async end(){}}}"
    };
    registerHooks({resolve(specifier,context,next){let name;
      if(specifier.endsWith('/dist/config.js'))name='config';else if(specifier.endsWith('/dist/postgres.js'))name='postgres';
      else if(specifier==='./lib/runtime-config.mjs')name='legacyConfig';else if(specifier==='pg')name='pg';
      return name?{url:'fixture:'+name,shortCircuit:true}:next(specifier,context);
    },load(url,context,next){return url.startsWith('fixture:')?{format:url==='fixture:pg'?'commonjs':'module',source:modules[url.slice(8)],shortCircuit:true}:next(url,context);}});
  `;
  const hook=`data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`;
  const result=spawnSync(process.execPath,["--import",hook,fileURLToPath(new URL("./activate-brain-import.mjs",import.meta.url)),"opaque.import","--apply","--schema=selected","--config=fixture.config.json"],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.applied,true);assert.equal(receipt.active.canonicalDispatch,true);assert.deepEqual(receipt.active.activeImportRunIds,["opaque.import"]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDefaultPool,defaultInventory} from '../providers/default/cases.mjs';
import {nativePublicDeclarations} from '../providers/default/native-fixtures.mjs';
import {nativePublicDeclarations as numericDeclarations} from '../providers/default/numeric-fixtures.mjs';

test('native public declaration context carries only actual driver ABI to the same prompt and original source packet',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'scce-public-abi-packets-'));
 try{
  const inventory=defaultInventory({formalLanguages:['go','rust'],naturalLanguages:[]});
  const tools=Object.fromEntries(['node','go','rust'].map(id=>[id,{available:true,path:process.execPath,compilerPath:process.execPath}]));
  const result=await createDefaultPool({inventory,tools,seed:'Offline fixture seed, not campaign evidence.',privateRoot:root,count:2,attempts:2,hiddenVectors:2,toolCalls:8,budgets:{timeMs:10000,outputBytes:131072,artifactBytes:131072,caseBytes:262144,maxSteps:4}});
  const rows=(await readFile(result.poolFile,'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.category.startsWith('code_'));
  assert.equal(rows.length,16);
  for(const row of rows){
   const step=row.public.steps[0],spec=step.files['specification.txt'];
   assert.ok(step.prompt.endsWith(spec));
   const fence=spec.slice(spec.indexOf('```'));
   assert.ok(fence.startsWith('```'+row.language+'\n'));
   assert.equal(fence.includes('{'),false);assert.equal(fence.includes('=>'),false);
   assert.equal(fence.includes('.insert('),false);assert.equal(fence.includes('.remove('),false);
   const contract=JSON.parse(row.public.outputContract),target=contract.targetPaths[0];
   assert.equal(Object.hasOwn(step.files,target),row.category.startsWith('code_repair'));
   if(row.language==='rust'&&row.category.endsWith('stateful')){
    assert.equal((fence.match(/&mut std::collections::HashMap<String, String>/gu)||[]).length,2);
    assert.equal((fence.match(/&std::collections::HashMap<String, String>/gu)||[]).length,1);
   }
  }
  assert.equal(nativePublicDeclarations('typescript',{write:'a',read:'b',remove:'c'}),'');
  assert.equal(numericDeclarations('python','d'),'');
 }finally{await rm(root,{recursive:true,force:true});}
});

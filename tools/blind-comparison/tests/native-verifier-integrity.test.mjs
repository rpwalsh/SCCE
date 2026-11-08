import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nativeCheck} from '../grading.mjs';
import {checkNativeVectors} from '../providers/default/native-runner.mjs';
import {scrubEnvironment} from '../runner.mjs';
import {numericFiles,numericSource} from '../providers/default/numeric-fixtures.mjs';
import {canonical} from '../protocol.mjs';
const roots=[];after(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'scce-verifier-integrity-'));roots.push(root);const custody=path.join(root,'custody');await mkdir(custody);
 const budgets={timeMs:10000,outputBytes:65536,artifactBytes:262144};
 const native=await numericFiles({language:'javascript',name:'bounded',tools:{node:{available:true,path:process.execPath},javascript:{available:true,path:process.execPath,budget:budgets}},repair:false,publicVectors:[]});
 const check=path.join(custody,'check.mjs'),vectors=path.join(custody,'vectors.json');
 await writeFile(check,"import{checkVectors}from './native-runner.mjs';await checkVectors('.sealed-vectors.json');\n");
 await writeFile(vectors,canonical([{operations:[['F',123,-17,44]],expected:['44']}]));
 const row={id:'test_authored.integrity',private:{kind:'native',protocol:'scce.native.supervised_vectors.v1',vectorTarget:'.sealed-vectors.json',argv:['{node}','.sealed-check.mjs'],files:[{path:check,target:'.sealed-check.mjs'},{path:vectors,target:'.sealed-vectors.json'}]}};
 const contract={schema:'scce.blind-native-task.v1',operation:'code_generation',maxPublicAttempts:1,writablePaths:['module.cjs'],targetPaths:['module.cjs'],publicChecks:[{argv:['{node}','public-check.mjs']}],approvals:[],programMode:'verified_artifacts',allowNewFiles:true};
 const packet={outputContract:canonical(contract),steps:[{prompt:'test authored public numeric ABI',sources:[],files:native.files}]};
 const run=artifacts=>nativeCheck(row,packet,{systemId:'test_authored',digest:'receipt',outputs:[{response:{status:'ok',answer:'',artifacts}}]},{out:path.join(root,'grade')},budgets);
 return {run,root,files:native.files};
}
test('independent grading rejects a submitted overwrite of an immutable public checker',async()=>{
 const {run}=await fixture();const result=await run({'module.cjs':'exports.bounded=()=>0;','native-runner.mjs':'export async function checkVectors(){}'});
 assert.equal(result.pass,false);assert.equal(result.reason,'immutable-public-file-modified');
});
test('submitted code cannot read expected vectors from its working directory',async()=>{
 const {run}=await fixture();const cheat="const fs=require('node:fs');exports.bounded=()=>JSON.parse(fs.readFileSync('.sealed-vectors.json','utf8'))[0].expected[0];";
 assert.equal((await run({'module.cjs':cheat})).pass,false);
 const honest="const fs=require('node:fs');if(fs.existsSync('.sealed-vectors.json')||fs.existsSync('.sealed-check.mjs')||fs.existsSync('submission.json'))throw Error('private material exposed');"+numericSource('javascript','bounded');
 const first=await run({'module.cjs':honest}),second=await run({'module.cjs':honest});
 assert.equal(first.pass,true);assert.equal(second.pass,true);assert.equal(first.transcriptHash,second.transcriptHash);
 assert.equal(typeof first.elapsedMs,'number');assert.equal(typeof first.outputBytes,'number');
});

test('compiler and all vector children share the declared cumulative output budget',async()=>{
 const {root,files}=await fixture(),cwd=path.join(root,'bounded-public');await mkdir(cwd);
 for(const [name,content]of Object.entries(files))await writeFile(path.join(cwd,name),content);
 await writeFile(path.join(cwd,'module.cjs'),"exports.bounded=()=> 'X'.repeat(64);");
 const vectors=Array.from({length:3},()=>({operations:[['F',1,0,5]],expected:['X'.repeat(64)]}));
 await assert.rejects(checkNativeVectors({vectors,cwd,environment:scrubEnvironment(),timeMs:10000,outputBytes:150}),/Native execution exceeded budget/);
});

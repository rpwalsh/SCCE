import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonical} from '../protocol.mjs';
import {nativeValidationPermission} from '../providers/default/native-validation-permission.mjs';
import {nativeProgramApprovalAllowed} from '../adapters/native-program-approval.mjs';
function fixture(){
 const tools={python:{path:'/declared/python',version:'3.14'}},target='module.py';
 const policy=nativeValidationPermission({language:'python',target,tools,protectedPaths:['driver.py','native-tools.json'],maxFiles:8,maxBytes:4096});
 const body={schema:'scce.program.native_validation_approval.v1',program:'program.owned',provider:structuredClone(policy.provider),workingDirectory:policy.workingDirectory,build:structuredClone(policy.build),test:structuredClone(policy.test),ownerRequirementIds:['source_assertion.owned'],files:[{path:target,hash:`sha256_${'a'.repeat(64)}`,byteLength:20},{path:'test/program_test.py',hash:`sha256_${'b'.repeat(64)}`,byteLength:30}]};
 const input={steps:[{files:{'native-tools.json':canonical({language:'python',target,tools})}}],budgets:{artifactBytes:4096}};
 const contract={approvals:['process.build_test'],targetPaths:[target],nativeValidationPermission:policy};
 const pending={planId:'plan.exact',capabilityId:'process.build_test',input:body};
 return {input,contract,pending};
}
function fingerprint(value){value.pending.fingerprint=createHash('sha256').update(`process.build_test\u001f${canonical(value.pending.input)}`).digest('hex');return value;}
test('native approval requires frozen commands, declared tool inventory and current protected artifact scope',()=>{
 const value=fingerprint(fixture());assert.equal(nativeProgramApprovalAllowed(value),true);
 for(const mutate of [v=>v.pending.input.build.args=['-c','arbitrary()'],v=>v.pending.input.files[0].path='../escape.py',v=>v.pending.input.files[0].path='DRIVER.py',v=>v.pending.input.provider.id='foreign',v=>v.contract.approvals=[],v=>v.pending.input.files[0].byteLength=5000,v=>v.input.steps[0].files['native-tools.json']=canonical({language:'python',target:'module.py',tools:{python:{path:'/foreign/python'}}})]){
  const changed=structuredClone(value);mutate(changed);fingerprint(changed);assert.equal(nativeProgramApprovalAllowed(changed),false);
 }
 const changed=structuredClone(value);changed.pending.input.files[0].hash=`sha256_${'c'.repeat(64)}`;
 assert.equal(nativeProgramApprovalAllowed(changed),false);fingerprint(changed);assert.equal(nativeProgramApprovalAllowed(changed),true);
});

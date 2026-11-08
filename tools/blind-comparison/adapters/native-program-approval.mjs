import {createHash} from 'node:crypto';
import {canonical,safeRelative} from '../protocol.mjs';
export function nativeProgramApprovalAllowed(value) {try{return allowed(value);}catch{return false;}}
function allowed({input,contract,pending}) {
 const policy=contract.nativeValidationPermission,body=pending?.input;
 if(!contract.approvals.includes('process.build_test')||pending?.capabilityId!=='process.build_test'||typeof pending.planId!=='string'||!pending.planId||policy?.schema!=='scce.blind-native-validation-permission.v1'||body?.schema!=='scce.program.native_validation_approval.v1')return false;
 if(!Array.isArray(policy.protectedPaths)||!Array.isArray(policy.targetPaths))return false;
 const digest=createHash('sha256').update(`process.build_test\u001f${canonical(body)}`).digest('hex');
 if(pending.fingerprint!==digest||body.workingDirectory!==policy.workingDirectory||body.workingDirectory!=='ephemeral_program_workspace'||canonical(body.provider)!==canonical(policy.provider)||canonical(body.build)!==canonical(policy.build)||canonical(body.test)!==canonical(policy.test))return false;
 let inventory;
 try{inventory=JSON.parse(input.steps.at(-1).files['native-tools.json']);}catch{return false;}
 if(inventory.language!==policy.provider.languageId||inventory.target!==contract.targetPaths[0]||canonical(inventory.tools?.[policy.toolId])!==canonical(policy.tool))return false;
 if(canonical(policy.targetPaths)!==canonical(contract.targetPaths)||!Array.isArray(body.ownerRequirementIds)||!body.ownerRequirementIds.length||body.ownerRequirementIds.some(id=>typeof id!=='string'||!id))return false;
 if(!Array.isArray(body.files)||!body.files.length||!Number.isSafeInteger(policy.maxFiles)||body.files.length>policy.maxFiles||!Number.isSafeInteger(policy.maxBytes)||policy.maxBytes>input.budgets.artifactBytes)return false;
 const paths=new Set();let bytes=0;
 for(const file of body.files){
  if(!safeRelative(file.path)||paths.has(file.path.toLowerCase())||!/^sha256_[0-9a-f]{64}$/u.test(file.hash)||!Number.isSafeInteger(file.byteLength)||file.byteLength<0||policy.protectedPaths.some(path=>path.toLowerCase()===file.path.toLowerCase())||(!policy.targetPaths.includes(file.path)&&policy.allowNewFiles!==true))return false;
  paths.add(file.path.toLowerCase());bytes+=file.byteLength;
 }
 return bytes<=policy.maxBytes&&policy.targetPaths.every(path=>paths.has(path.toLowerCase()));
}

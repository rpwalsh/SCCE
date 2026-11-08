// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,toJsonValue} from "./primitives.js";
import {compileLanguageConstructionPattern,languageConstructionRoleId} from "./language-construction-memory.js";
import {createLearnedSurfaceInterpreter} from "./learned-surface-interpretation.js";
import {searchProgramTransformations,evaluateProgramExpression,type ProgramExpression} from "./program-transformation-search.js";
import {exactComputationForExpression,exactProgramForExpression,exactQuantitiesEqual,type ExactComputationEvaluation} from "./exact-computation.js";
import type {ConversationalConstructionDocument} from "./conversational-construction-induction.js";
import type {EvidenceSpan,Hasher,ProgramBehaviorRequirement} from "./types.js";
import type {LanguagePatternRecord,LanguagePatternProjection} from "./storage.js";
import {SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA as SCHEMA,SOURCE_COMPUTATION_CONSTRUCTION_RECIPE as RECIPE,SOURCE_COMPUTATION_SOURCE_SYSTEM as SYSTEM,type SourceComputationConstruction,type SourceComputationWitness} from "./source-owned-computation.js";

interface NumberPort {slotIndex:number;startCodePoint:number;endCodePoint:number;surface:string}
interface Measured {witness:SourceComputationWitness;request:string;frame:string;ports:NumberPort[];result:number;sourceExpression:ProgramExpression;span:EvidenceSpan}
export interface AcquiredSourceComputation {pattern:LanguagePatternRecord;sourceDependencies:NonNullable<LanguagePatternProjection["sourceDependencies"]>}
export interface SourceComputationAcquisition {families:AcquiredSourceComputation[];pairs:number;rejected:readonly {bindingId:string;reason:string}[]}

/** Numeric ports are exact grammar spans; their operator and order are learned only from independent source outcomes. */
export function acquireSourceComputationConstructions(input:{documents:readonly ConversationalConstructionDocument[];hasher:Hasher;updatedAt:number}):SourceComputationAcquisition{
 const groups=new Map<string,Measured[]>();let pairs=0;
 for(const document of input.documents){
  const turns=document.transcriptTurns;if(!turns)continue;
  const turnsByIndex=new Map(turns.map(turn=>[turn.index,turn]));
  for(const reply of turns){
   if(reply.replyToTurnIndex===undefined)continue;
   const request=turnsByIndex.get(reply.replyToTurnIndex);if(!request||request.speakerId===reply.speakerId||reply.replyToTurnIndex!==reply.index-1||request.endCodePoint>reply.startCodePoint)continue;
   const spans=document.spans.filter(span=>span.status==="promoted"&&String(span.sourceVersionId)===document.sourceVersionId&&span.charStart<=request.startCodePoint&&span.charEnd>=reply.endCodePoint).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
   const span=spans[0];if(!span)continue;
   const points=[...span.text],start=request.startCodePoint-span.charStart,end=reply.endCodePoint-span.charStart;
   const requestStart=start,requestEnd=request.endCodePoint-span.charStart,replyStart=reply.startCodePoint-span.charStart;
   if(points.length!==span.charEnd-span.charStart||points.slice(start,requestEnd).join("")!==request.surface||points.slice(replyStart,end).join("")!==reply.surface)continue;
   const measured=numberFrame(request.surface),equation=equationWitness(reply.surface),answer=equation?.evaluation;
   if(!measured||measured.ports.some(port=>!Number.isSafeInteger(Number(port.surface.replace("\u2212","-")))))continue;
   if(!answer||Object.keys(answer.result.unit).length||answer.result.denominator!==1n||!Number.isSafeInteger(Number(answer.result.numerator)))continue;
   pairs++;
   const witness:SourceComputationWitness={sourceId:String(span.sourceId),sourceVersionId:document.sourceVersionId,profileId:document.profileId,evidenceId:String(span.id),contentHash:String(span.contentHash),
    request:{startCodePoint:requestStart,endCodePoint:requestEnd,surfaceDigest:input.hasher.digestHex(request.surface)},reply:{startCodePoint:replyStart,endCodePoint:end,surfaceDigest:input.hasher.digestHex(reply.surface)},
    arguments:measured.ports,resultText:answer.resultText,verificationRole:"fit"};
   const rows=groups.get(measured.frame)??[];rows.push({witness,request:request.surface,frame:measured.frame,ports:measured.ports,result:Number(answer.result.numerator),sourceExpression:equation!.expression,span});groups.set(measured.frame,rows);
  }
 }
 const families:AcquiredSourceComputation[]=[],rejected:Array<{bindingId:string;reason:string}>=[];
 for(const [frame,measured_] of [...groups].sort(([a],[b])=>a.localeCompare(b))){
  const bindingId=`request.computation.${input.hasher.digestHex(frame)}`;
  const measured=[...new Map(measured_.map(row=>[canonicalStringify([row.witness.sourceVersionId,row.witness.request]),row])).values()].sort((a,b)=>a.witness.sourceId.localeCompare(b.witness.sourceId)||a.witness.request.startCodePoint-b.witness.request.startCodePoint||a.witness.sourceVersionId.localeCompare(b.witness.sourceVersionId));
  const independent=[...new Map(measured.map(row=>[row.witness.sourceId,row])).values()];
  // Two independent fit owners and a separate source-held-out owner distinguish an induced relation from a copied example.
  if(independent.length<3){rejected.push({bindingId,reason:"independent_source_contrast_missing"});continue;}
  const heldOut=independent.at(-1)!;measured.forEach(row=>row.witness.verificationRole=row.witness.sourceId===heldOut.witness.sourceId?"held_out":"fit");
  const fit=measured.filter(row=>row.witness.verificationRole==="fit");
  if(fit[0]!.ports.some((_,index)=>new Set(fit.map(row=>row.ports[index]!.surface)).size<2)){rejected.push({bindingId,reason:"numeric_role_variation_missing"});continue;}
  const selection=selectExpression(measured,bindingId,input.hasher);
  if(!selection){rejected.push({bindingId,reason:"operator_or_order_ambiguous"});continue;}
  const owner=measured[0]!,evidence=[...new Map(measured.map(row=>[String(row.span.id),row.span])).values()];
  const compiled=compileLanguageConstructionPattern({bindingId,profileId:owner.witness.profileId,hasher:input.hasher,updatedAt:input.updatedAt,evidence,
   observations:measured.map(row=>({sourceVersionId:row.witness.sourceVersionId,evidenceId:row.witness.evidenceId,surfaceStartCodePoint:row.witness.request.startCodePoint,surfaceEndCodePoint:row.witness.request.endCodePoint,roles:row.ports}))});
  if(compiled.status!=="compiled"){rejected.push({bindingId,reason:"question_construction_unavailable"});continue;}
  const body:Omit<SourceComputationConstruction,"contentDigest">={schema:SCHEMA,componentRecipe:RECIPE,sourceSystem:SYSTEM,sourceId:owner.witness.sourceId,sourceVersionId:owner.witness.sourceVersionId,profileId:owner.witness.profileId,bindingId,inputConstruction:compiled.bundle,expression:selection,witnesses:measured.map(row=>row.witness)};
  const contentDigest=input.hasher.digestHex(canonicalStringify(body)),artifact={...body,contentDigest};
  const dependencies=new Map<string,NonNullable<LanguagePatternProjection["sourceDependencies"]>[number]>();
  for(const row of measured){const previous=dependencies.get(row.witness.sourceVersionId),ids=[...new Set([...(previous?.evidenceIds??[]),row.span.id])].sort();dependencies.set(row.witness.sourceVersionId,{sourceId:row.span.sourceId,sourceVersionId:row.span.sourceVersionId,evidenceIds:ids});}
  families.push({pattern:{id:`source.computation.construction.${contentDigest}`,profileId:body.profileId,patternKind:"semantic_role",support:measured.length,entropy:0,evidenceIds:evidence.map(span=>span.id),updatedAt:input.updatedAt,patternJson:toJsonValue(artifact)},sourceDependencies:[...dependencies.values()].sort((a,b)=>String(a.sourceVersionId).localeCompare(String(b.sourceVersionId)))});
 }
 return {families,pairs,rejected};
}

function numberFrame(surface:string):{frame:string;ports:NumberPort[]}|undefined{
 const matches=[...surface.matchAll(/(?<![\p{L}\p{N}_.])[-+\u2212]?(?:\d+(?:\.\d+)?|\.\d+)(?!(?:[\p{L}\p{N}_]|\.\d))/gu)];
 if(!matches.length)return undefined;
 const ports:NumberPort[]=[],form:Array<string|{slot:number}>=[];let previous=0;
 for(const [index,match] of matches.entries()){
  form.push(surface.slice(previous,match.index),{slot:index});
  const startCodePoint=[...surface.slice(0,match.index)].length;ports.push({slotIndex:index,startCodePoint,endCodePoint:startCodePoint+[...match[0]].length,surface:match[0]});previous=match.index!+match[0].length;
 }
 form.push(surface.slice(previous));return {frame:canonicalStringify(form),ports};
}
/** The full learned numeric form is identified before any durable body/evidence lookup. */
export function sourceComputationBindingIdForRequest(requestText:string,hasher:Hasher):string|undefined{
 const measured=numberFrame(requestText);return measured?`request.computation.${hasher.digestHex(measured.frame)}`:undefined;
}
function selectExpression(rows:readonly Measured[],bindingId:string,hasher:Hasher):ProgramExpression|undefined{
 const requirements:ProgramBehaviorRequirement[]=rows.map(row=>({id:`computation.witness.${hasher.digestHex(canonicalStringify(row.witness))}`,requestHash:hasher.digestHex(row.request),callableId:bindingId,arguments:row.ports.map(port=>Number(port.surface.replace("\u2212","-"))),expectedResult:row.result,verificationRole:row.witness.verificationRole,relationSurface:"source_dialogue_reply",sourceSpan:{charStart:0,charEnd:[...row.request].length}}));
 const fitRows=rows.filter(row=>row.witness.verificationRole==="fit");
 const align=(node:ProgramExpression,row:Measured):ProgramExpression=>{
  if(node.kind==="literal"){const ports=row.ports.filter(port=>Number(port.surface.replace("\u2212","-"))===node.value);return ports.length===1?{kind:"argument",index:ports[0]!.slotIndex}:node;}
  return node.kind==="unary"?{...node,operand:align(node.operand,row)}:node.kind==="binary"?{...node,left:align(node.left,row),right:align(node.right,row)}:node;
 };
 const costOf=(node:ProgramExpression):number=>node.kind==="binary"?1+costOf(node.left)+costOf(node.right):node.kind==="unary"?1+costOf(node.operand):1;
 const aligned=fitRows.map(row=>align(row.sourceExpression,row)).filter(expression=>fitRows.every(row=>evaluateProgramExpression(expression,row.ports.map(port=>Number(port.surface.replace("\u2212","-"))))===row.result));
 const candidates=[...searchProgramTransformations(requirements).candidates,...aligned.map(producedIr=>({producedIr,fitMeanSquaredError:0,complexity:costOf(producedIr)}))].filter(candidate=>candidate.fitMeanSquaredError===0&&numericExpression(candidate.producedIr)&&allPorts(candidate.producedIr,rows[0]!.ports.length)&&rows.filter(row=>row.witness.verificationRole==="fit").every(row=>sourceExpressionMatches(candidate.producedIr,row)));
 if(!candidates.length)return undefined;
 const cost=Math.min(...candidates.map(candidate=>candidate.complexity));
 const distinct=new Map(candidates.filter(candidate=>candidate.complexity===cost).map(candidate=>[expressionKey(candidate.producedIr),candidate.producedIr]));
 if(distinct.size!==1)return undefined;
 const expression=[...distinct.values()][0]!;
 for(const row of rows){const calculated=exactComputationForExpression(renderExpression(expression,row.ports.map(port=>port.surface))),expected=exactComputationForExpression(row.witness.resultText);if(!calculated||!expected||!exactQuantitiesEqual(calculated.result,expected.result)||!sourceExpressionMatches(expression,row))return undefined;}
 return expression;
}
/** An actual equation supplies mathematical semantics; numeric factual replies alone supply none. */
function equationWitness(surface:string):{evaluation:ExactComputationEvaluation;expression:ProgramExpression}|undefined{
 const parts=surface.trim().replace(/\.$/u,"").split("=");if(parts.length!==2)return undefined;
 const left=parts[0]!.trim(),right=parts[1]!.trim(),evaluation=exactComputationForExpression(left),expected=exactComputationForExpression(right),expression=formalProgram(left);
 if(!evaluation||!expected||!expression||!exactQuantitiesEqual(evaluation.result,expected.result)||Object.keys(evaluation.result.unit).length)return undefined;
 return {evaluation,expression};
}
function sourceExpressionMatches(expression:ProgramExpression,row:Measured):boolean{
 const substitute=(node:ProgramExpression):ProgramExpression=>node.kind==="argument"?{kind:"literal",value:Number(row.ports[node.index]!.surface.replace("\u2212","-"))}
  :node.kind==="unary"?{...node,operand:substitute(node.operand)}:node.kind==="binary"?{...node,left:substitute(node.left),right:substitute(node.right)}:node;
 return expressionKey(substitute(expression))===expressionKey(row.sourceExpression);
}
/** Witness syntax uses the same full-expression parser as the independent exact evaluator. */
function formalProgram(text:string):ProgramExpression|undefined{return exactProgramForExpression(text);}
function numericExpression(value:ProgramExpression):boolean{return value.kind==="argument"||value.kind==="literal"||value.kind==="unary"&&numericExpression(value.operand)||value.kind==="binary"&&["add","subtract","multiply","divide"].includes(value.operator)&&numericExpression(value.left)&&numericExpression(value.right);}
function allPorts(value:ProgramExpression,count:number):boolean{const found=new Set<number>();const visit=(node:ProgramExpression)=>{if(node.kind==="argument")found.add(node.index);else if(node.kind==="unary")visit(node.operand);else if(node.kind==="binary"){visit(node.left);visit(node.right);}};visit(value);return found.size===count&&[...found].every(index=>index>=0&&index<count);}
function expressionKey(value:ProgramExpression):string{
 if(value.kind==="binary"&&(value.operator==="add"||value.operator==="multiply")){
  const parts:string[]=[];const collect=(node:ProgramExpression)=>{if(node.kind==="binary"&&node.operator===value.operator){collect(node.left);collect(node.right);}else parts.push(expressionKey(node));};collect(value);return canonicalStringify([value.operator,parts.sort()]);
 }
 if(value.kind==="binary")return canonicalStringify([value.operator,expressionKey(value.left),expressionKey(value.right)]);
 if(value.kind==="unary")return canonicalStringify([value.operator,expressionKey(value.operand)]);
 return canonicalStringify(value);
}
function renderExpression(value:ProgramExpression,arguments_:readonly string[]):string{
 if(value.kind==="argument")return `(${arguments_[value.index]!.replace("\u2212","-")})`;
 if(value.kind==="literal")return `(${value.value})`;
 if(value.kind==="unary")return `(-${renderExpression(value.operand,arguments_)})`;
 if(value.kind==="binary"){const symbol=value.operator==="add"?"+":value.operator==="subtract"?"-":value.operator==="multiply"?"*":"/";return `(${renderExpression(value.left,arguments_)}${symbol}${renderExpression(value.right,arguments_)})`;}
 throw Error("Unsupported computation expression");
}

export interface VerifiedSourceComputation {readonly patternId:string;readonly artifact:SourceComputationConstruction}
const verifiedArtifacts=new WeakSet<object>(),verifiedResults=new WeakSet<object>();
function freeze<T>(value:T):T{if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export interface VerifiedSourceComputationResult {readonly evaluation:ExactComputationEvaluation;readonly patternIds:string[];readonly roleBindings:readonly NumberPort[];readonly requestDigest:string}
export function sourceComputationResultVerified(value:VerifiedSourceComputationResult|undefined,requestText:string,hasher:Hasher):boolean{
 if(!value||!verifiedResults.has(value)||value.requestDigest!==hasher.digestHex(requestText))return false;
 const exact=exactComputationForExpression(value.evaluation.expression);
 return Boolean(exact&&exactQuantitiesEqual(exact.result,value.evaluation.result)&&exact.resultText===value.evaluation.resultText&&exact.answer===value.evaluation.answer
  &&value.roleBindings.every(role=>[...requestText].slice(role.startCodePoint,role.endCodePoint).join("")===role.surface));
}
/** A full source form is a cheap necessary condition, never authority to execute its unverified body. */
export function sourceComputationPatternMatchesQuestion(pattern:LanguagePatternRecord,requestText:string):boolean{
 try{
  const artifact=pattern.patternJson as unknown as SourceComputationConstruction;
  return artifact.schema===SCHEMA&&Array.isArray(artifact.inputConstruction?.constructions)
    &&artifact.inputConstruction.constructions.some(construction=>Boolean(createLearnedSurfaceInterpreter(requestText).interpret(construction)));
 }catch{return false;}
}
/** Cold hydration replays acquisition against exact accessible source bytes; a rehashed forgery cannot license a computation. */
export function verifySourceComputationConstruction(input:{pattern:LanguagePatternRecord;evidence:readonly EvidenceSpan[];hasher:Hasher}):VerifiedSourceComputation|undefined{
 try{return verifySourceComputationUnchecked(input);}catch{return undefined;}
}
function verifySourceComputationUnchecked(input:{pattern:LanguagePatternRecord;evidence:readonly EvidenceSpan[];hasher:Hasher}):VerifiedSourceComputation|undefined{
 const artifact=input.pattern.patternJson as unknown as SourceComputationConstruction;
 if(!artifact||artifact.schema!==SCHEMA||artifact.componentRecipe!==RECIPE||artifact.sourceSystem!==SYSTEM||artifact.profileId!==input.pattern.profileId||!Array.isArray(artifact.witnesses))return undefined;
 const byId=new Map(input.evidence.filter(span=>span.status==="promoted").map(span=>[String(span.id),span])),documents:ConversationalConstructionDocument[]=[];
 for(const witness of artifact.witnesses){
  const span=byId.get(witness.evidenceId);if(!span||String(span.sourceId)!==witness.sourceId||String(span.sourceVersionId)!==witness.sourceVersionId||String(span.contentHash)!==witness.contentHash)return undefined;
  const points=[...span.text],question=points.slice(witness.request.startCodePoint,witness.request.endCodePoint).join(""),reply=points.slice(witness.reply.startCodePoint,witness.reply.endCodePoint).join("");
  if(input.hasher.digestHex(question)!==witness.request.surfaceDigest||input.hasher.digestHex(reply)!==witness.reply.surfaceDigest)return undefined;
  documents.push({sourceVersionId:witness.sourceVersionId,profileId:witness.profileId,spans:[span],transcriptTurns:[{index:0,speakerId:"source.request",surface:question,startCodePoint:span.charStart+witness.request.startCodePoint,endCodePoint:span.charStart+witness.request.endCodePoint},{index:1,speakerId:"source.reply",replyToTurnIndex:0,commitmentScope:"conversation",surface:reply,startCodePoint:span.charStart+witness.reply.startCodePoint,endCodePoint:span.charStart+witness.reply.endCodePoint}]});
 }
 try{const rebuilt=acquireSourceComputationConstructions({documents,hasher:input.hasher,updatedAt:input.pattern.updatedAt}).families.find(family=>family.pattern.id===input.pattern.id);return rebuilt&&canonicalStringify(rebuilt.pattern.patternJson)===canonicalStringify(input.pattern.patternJson)&&canonicalStringify([...rebuilt.pattern.evidenceIds].sort())===canonicalStringify([...input.pattern.evidenceIds].sort())?verifiedArtifact(input.pattern.id,artifact):undefined;}catch{return undefined;}
}
function verifiedArtifact(patternId:string,artifact:SourceComputationConstruction):VerifiedSourceComputation{const value=freeze({patternId,artifact:structuredClone(artifact)});verifiedArtifacts.add(value);return value;}
/** Only the already verified full acquired question program may bind new numeric arguments. */
export function evaluateSourceComputationRequest(input:{requestText:string;constructions:readonly VerifiedSourceComputation[];hasher:Hasher}):VerifiedSourceComputationResult|undefined{
 const found:Array<{evaluation:ExactComputationEvaluation;patternId:string;roleBindings:NumberPort[]}>=[];
 for(const verified of input.constructions){
  if(!verifiedArtifacts.has(verified))continue;
  const {patternId,artifact}=verified;
  const interpreter=createLearnedSurfaceInterpreter(input.requestText),slots=new Map<number,string>();let bindings:NumberPort[]|undefined;
  for(const construction of artifact.inputConstruction.constructions){const roles=interpreter.interpret(construction);if(!roles)continue;const current:NumberPort[]=[];let valid=true;for(const role of roles){const index=artifact.witnesses[0]!.arguments.find(port=>languageConstructionRoleId(input.hasher,artifact.bindingId,port.slotIndex)===role.roleId)?.slotIndex;if(index===undefined||!/^[-+\u2212]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(role.surface)){valid=false;break;}slots.set(index,role.surface);current.push({slotIndex:index,surface:role.surface,startCodePoint:role.startCodePoint,endCodePoint:role.endCodePoint});}if(valid&&slots.size===artifact.witnesses[0]!.arguments.length){bindings=current;break;}slots.clear();}
  if(!bindings)continue;
  const values=artifact.witnesses[0]!.arguments.map(port=>slots.get(port.slotIndex)!),evaluation=exactComputationForExpression(renderExpression(artifact.expression,values));if(evaluation)found.push({evaluation,patternId,roleBindings:bindings});
 }
 if(!found.length||new Set(found.map(row=>row.evaluation.resultText)).size!==1)return undefined;
 const result=freeze({evaluation:found[0]!.evaluation,patternIds:found.map(row=>row.patternId).sort(),roleBindings:found[0]!.roleBindings,requestDigest:input.hasher.digestHex(input.requestText)});verifiedResults.add(result);return result;
}

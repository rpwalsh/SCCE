// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,createHasher,toJsonValue} from "./primitives.js";
import {normalizeInformationLabel} from "./information-flow.js";
import {readSourceCodeFunctionConstruction,sourceCodeFunctionPatternId,type SourceCodeFunctionConstruction} from "./source-code-function-construction.js";
import {evaluateProgramExpressionBindings,expressionComplexity,expressionOperands,topLevelOperator,programTransformationScore,searchProgramTransformations,type ProgramExpression,type ProgramTransformationCandidate} from "./program-transformation-search.js";
import type {LanguagePatternRecord} from "./storage.js";
import type {EvidenceSpan,ProgramBehaviorRequirement} from "./types.js";
export interface ProgramSourcePlanningContext {readonly id:string;readonly languageId:string;readonly sourceIds:readonly string[];}
interface Provider {id:string;patternId:string;sourceVersionId:string;sourceHash:string;sourceStart:number;sourceEnd:number;evidenceIds:string[];constructionId:string;abi:NonNullable<SourceCodeFunctionConstruction["numericAbi"]>;informationLabel:unknown;construction:Pick<SourceCodeFunctionConstruction,"expression"|"bindings"|"parameters">;}
export type SourceProgramCandidate=ProgramTransformationCandidate&{readonly sourceProvider:{readonly id:string;readonly patternId:string;readonly sourceVersionId:string;readonly sourceHash:string;readonly sourceStart:number;readonly sourceEnd:number;readonly evidenceIds:readonly string[]};readonly sourceBindings:readonly ProgramExpression[]};
const contexts=new WeakMap<ProgramSourcePlanningContext,readonly Provider[]>(),hasher=createHasher();
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const hash=(value:unknown)=>hasher.digestHex(canonicalStringify(toJsonValue(value)));
function numeric(expression:ProgramExpression,available:number):boolean {
 const stack=[expression];while(stack.length){const item=stack.pop()!;
  if(item.kind==='argument'){if(!Number.isSafeInteger(item.index)||item.index<0||item.index>=available)return false;}
  else if(item.kind==='literal'){if(!Number.isFinite(item.value))return false;}
  else if(item.kind==='unary'&&item.operator==='negate')stack.push(item.operand);
  else if(item.kind==='binary'&&['add','subtract','multiply','divide','minimum','maximum'].includes(item.operator))stack.push(item.left,item.right);
  else return false;
 }return true;
}
function abiSupported(construction:SourceCodeFunctionConstruction):boolean {
 const abi=construction.numericAbi,arity=construction.parameters.length;
 if(!abi||!Array.isArray(abi.parameters)||!abi.result||abi.schema!=='scce.source_numeric_callable_abi.v1'||construction.languageId!==abi.languageId||arity<1||arity>3||abi.parameters.length!==arity)return false;
 for(const type of [...abi.parameters,abi.result])if(!Number.isSafeInteger(type.start)||!Number.isSafeInteger(type.end)||type.start<0||type.end<=type.start||type.end>construction.sourceText.length
  ||construction.sourceText.slice(type.start,type.end)!=='number'||type.textHash!==hasher.digestHex('number'))return false;
 const bindings=construction.bindings??[];
 return bindings.every((binding,index)=>numeric(binding,arity+index))&&numeric(construction.expression,arity+bindings.length);
}
/** Only current admitted source witnesses create provider handles; receipts retain identities and IR, never copied bodies. */
export function prepareProgramSourcePlanningContext(input:{languageId:string;patterns:readonly LanguagePatternRecord[];evidence:readonly EvidenceSpan[]}):ProgramSourcePlanningContext {
 const providers:Provider[]=[];
 for(const pattern of input.patterns){const row=object(pattern.patternJson);
  if(pattern.patternKind!=='source_code_function'||row.schema!=='scce.source_code_function_pattern.v1'||row.sourceSystem!=='oss_code'||row.formalLanguage!==input.languageId
   ||typeof row.sourceVersionId!=='string'||typeof row.sourceHash!=='string'||!Array.isArray(row.codeFunctionConstructions)||!pattern.informationLabel||!pattern.evidenceIds.length)continue;
  const witnesses=pattern.evidenceIds.map(id=>input.evidence.find(span=>span.id===id&&span.status==='promoted'&&span.sourceVersionId===row.sourceVersionId));
  if(witnesses.some(span=>!span?.informationLabel||canonicalStringify(normalizeInformationLabel(span.informationLabel))!==canonicalStringify(normalizeInformationLabel(pattern.informationLabel!))))continue;
  const completeSource=witnesses.find(span=>span&&span.byteStart===0&&span.charStart===0
    &&span.byteEnd===new TextEncoder().encode(span.text).byteLength&&span.charEnd===[...span.text].length
    &&span.contentHash===`sha256_${hasher.digestHex(span.text)}`&&row.sourceHash===span.contentHash);
  if(!completeSource)continue;
  for(const value of row.codeFunctionConstructions){const construction=readSourceCodeFunctionConstruction(value as never,row.sourceHash);
   if(!construction||construction.languageId!==input.languageId||!abiSupported(construction)
    ||!Number.isSafeInteger(construction.sourceStart)||!Number.isSafeInteger(construction.sourceEnd)||construction.sourceStart<0||construction.sourceEnd>completeSource.text.length
    ||pattern.id!==sourceCodeFunctionPatternId({constructionId:construction.id,profileId:pattern.profileId,sourceVersionId:row.sourceVersionId})
    ||completeSource.text.slice(construction.sourceStart,construction.sourceEnd)!==construction.sourceText)continue;
   const material={patternId:pattern.id,sourceVersionId:row.sourceVersionId,sourceHash:row.sourceHash,sourceStart:construction.sourceStart,sourceEnd:construction.sourceEnd,evidenceIds:[...pattern.evidenceIds].sort(),constructionId:construction.id,informationLabel:normalizeInformationLabel(pattern.informationLabel),abi:construction.numericAbi!,construction:{expression:construction.expression,bindings:construction.bindings??[],parameters:construction.parameters.map(parameter=>({name:parameter.name,declarationStart:parameter.declarationStart,declarationEnd:parameter.declarationEnd,references:[]}))}};
   providers.push({...structuredClone(material),id:`program.source.provider.${hash(material)}`});
  }
 }
 providers.sort((left,right)=>left.id<right.id?-1:left.id>right.id?1:0);
 const sourceIds=Object.freeze(providers.map(provider=>provider.id)),context=Object.freeze({id:`program.source.context.${hash({languageId:input.languageId,sourceIds})}`,languageId:input.languageId,sourceIds});
 contexts.set(context,providers);return context;
}
export function sourceProgramCandidateBindings(candidate:ProgramTransformationCandidate):readonly ProgramExpression[]{return (candidate as Partial<SourceProgramCandidate>).sourceBindings??[];}
export function programImplementationCandidates(requirements:readonly ProgramBehaviorRequirement[],context?:ProgramSourcePlanningContext){
 const searched=searchProgramTransformations(requirements),providers=context?contexts.get(context):[];
 if(context&&!providers)throw new Error('Unrecognized program source planning context');
 const candidates:ProgramTransformationCandidate[]=[...searched.candidates];
 for(const callableId of [...new Set(requirements.filter(row=>row.verificationRole==='fit').map(row=>row.callableId))].sort()){
  const fit=requirements.filter(row=>row.callableId===callableId&&row.verificationRole==='fit'),reservedIds=requirements.filter(row=>row.callableId===callableId&&row.verificationRole==='held_out').map(row=>row.id).sort();
  for(const provider of providers??[]){const construction=provider.construction,arity=construction.parameters.length;
   if(fit.some(row=>row.arguments.length!==arity||row.sourceContract&&(row.sourceContract.sourceHash!==provider.sourceHash||row.sourceContract.sourceVersionId!==provider.sourceVersionId)))continue;
   if(!fit.every(row=>row.arguments.every(value=>typeof value==='number'&&Number.isFinite(value))&&typeof row.expectedResult==='number'
    &&Object.is(evaluateProgramExpressionBindings(construction.expression,row.arguments,construction.bindings??[]),row.expectedResult)))continue;
   const {construction:_body,...sourceProvider}=provider;
   const complexity=expressionComplexity(construction.expression)+(construction.bindings??[]).reduce((sum,binding)=>sum+expressionComplexity(binding),0);
   const candidate:SourceProgramCandidate={id:`program.source.candidate.${hash([provider.id,callableId,fit.map(row=>row.id).sort()])}`,callableId,
    operator:topLevelOperator(construction.expression),operands:expressionOperands(construction.expression),producedIr:structuredClone(construction.expression),sourceBindings:structuredClone(construction.bindings??[]),sourceProvider,
    preconditions:[{kind:'argument_count',count:arity},...Array.from({length:arity},(_,index)=>({kind:'finite_numeric_argument' as const,index})),{kind:'finite_numeric_result'}],
    predictedFitObligationIds:fit.map(row=>row.id).sort(),heldOutObligationIds:reservedIds,score:programTransformationScore(0,complexity),fitMeanSquaredError:0,complexity,
    provenance:{kind:'fit_requirements',fitRequirementIds:fit.map(row=>row.id).sort()}};
   candidates.push(candidate);
  }
 }
 return {candidates};
}

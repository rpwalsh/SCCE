// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type {ProgramPlan} from "./program-planner.js";
import type {ProgramNativeLiteral} from "./program-native-abi.js";
import type {ProgramExpression} from "./program-transformation-search.js";
import type {NativeProgramType} from "./native-program-types.js";
import {nativeOwnerAbis,NativeProgramEmissionError,type NativeOwnerAbi} from "./native-owner-abis.js";
import {relativeNativeSourcePath} from "./native-runtime-paths.js";

type NumericType=Extract<NativeProgramType,{kind:"integer"|"float"}>;
interface Expression {source:string;type:"number"|"bool"}
const issue=(kind:string,message:string)=>new NativeProgramEmissionError(`program.emission.rust.${kind}_unsupported`,message);
const fail=(kind:string,message:string):never=>{throw issue(kind,message);};

export function hasOwnedRustScalarAbi(plan:ProgramPlan):boolean {
 return plan.ownerBehaviorRequirements.some(requirement=>requirement.sourceContract!==undefined)
  ||plan.nativeDeclarations?.some(abi=>abi.languageId==="rust"&&plan.ownerBehaviorRequirements.some(requirement=>requirement.callableId===abi.callableName))===true;
}

/** Native scalar types come only from the verified source declaration, independently of fit values. */
export function nativeRustProgram(plan:ProgramPlan,paths:{sourcePath:string;testPath:string}):{source:string;test:string}{
 if(plan.ownerStatefulBehaviorRequirements.length)throw issue("scalar_behavior","A scalar native program cannot own stateful traces");
 const abis=nativeOwnerAbis(plan,"rust"),byName=new Map(abis.map(abi=>[abi.name,abi]));
 const types=new Map(abis.map(abi=>[abi.name,numericAbi(abi)]));
 const selected=plan.ownerBehaviorImplementationPhase==="selected";
 for(const requirement of plan.ownerBehaviorRequirements){
  const type=types.get(requirement.callableId)!;
  requirement.arguments.forEach((value,index)=>literal(value,type,requirement.sourceContract?.nativeArguments?.[index]));literal(requirement.expectedResult,type,requirement.sourceContract?.nativeExpected);
  if(type.kind==="integer"&&[...(requirement.sourceContract?.nativeArguments??[]),requirement.sourceContract?.nativeExpected].some(value=>value?.kind==="value"&&value.nativeNumberKind==="float"))throw issue("integer_literal","A native integer obligation cannot be witnessed by a floating literal");
 }
 const methods=abis.map(abi=>{
  const type=types.get(abi.name)!,candidate=plan.ownerBehaviorTransformationCandidates.find(row=>row.callableId===abi.name&&plan.selectedOwnerBehaviorTransformationIds.includes(row.id));
  if(selected&&!candidate)throw issue("transformation","A native scalar callable needs its selected expression IR");
  const body=selected?expression(candidate!.producedIr,type,abi.parameters.length):{source:"_arg0",type:"number" as const};
  if(body.type!=="number")throw issue("result_type","The expression result differs from its native numeric return type");
  const guard=type.kind==="float"?abi.parameters.map((_,index)=>`assert!(_arg${index}.is_finite(), "program.argument_nonfinite");`).join("\n"):"";
  const result=type.kind==="float"?`let result=${body.source}; assert!(result.is_finite(), "program.result_nonfinite"); result`:body.source;
  return `pub fn ${name(abi.name)}(${abi.parameters.map((parameter,index)=>`_arg${index}: ${parameter.text}`).join(", ")}) -> ${abi.result.text} { ${guard} ${result} }`;
 });
 const tests=plan.ownerBehaviorRequirements.map((requirement,index)=>{
  const abi=byName.get(requirement.callableId)!,type=types.get(abi.name)!;
  const call=`program::${name(abi.name)}(${requirement.arguments.map((value,index)=>literal(value,type,requirement.sourceContract?.nativeArguments?.[index])).join(", ")})`,expected=literal(requirement.expectedResult,type,requirement.sourceContract?.nativeExpected);
  const assertion=type.kind==="integer"?`assert_eq!(actual,expected,${JSON.stringify(requirement.id)});`:`assert!(actual.is_finite() && (actual-expected).abs()<=1e-9_f64*expected.abs().max(1.0_f64),${JSON.stringify(requirement.id)});`;
  return `#[test] fn owner_requirement_${index}(){let actual=${call};let expected:${type.text}=${expected};${assertion}}`;
 });
 return {source:methods.join("\n\n")+"\n",test:`#[path=${JSON.stringify(relativeNativeSourcePath(paths.testPath,paths.sourcePath))}] mod program;\n${tests.join("\n")}`};
}
function numericAbi(abi:NativeOwnerAbi):NumericType {
 const type=abi.result;
 if(abi.stateParameter||!abi.parameters.length||type.kind!=="integer"&&type.kind!=="float"||type.kind==="integer"&&!type.bits||type.kind==="float"&&type.bits!==64)throw issue("signature","Native scalar emission requires a fixed-width integer or f64 declaration");
 if(abi.parameters.some(parameter=>parameter.kind!==type.kind||parameter.text.replace(/\s/gu,"")!==type.text.replace(/\s/gu,"")))throw issue("signature","Native scalar expressions require one source-declared numeric type without implicit casts");
 return type;
}
function name(value:string):string{
 const plain=value.startsWith("r#")?value.slice(2):value;
 if(!/^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(plain)||["_","self","Self","super","crate"].includes(plain))throw issue("callable","Invalid native callable identifier");
 return `r#${plain}`;
}
function literal(value:unknown,type:NumericType,observed?:ProgramNativeLiteral):string{
 if(typeof value!=="number"||!Number.isFinite(value))return fail("behavior_type","Native numeric literals must be finite numbers");
 if(type.kind==="integer"){
  if(!Number.isSafeInteger(value))return fail("integer_literal","An integer literal must retain exact JSON numeric identity");
  const integer=BigInt(value),bits=BigInt(type.bits!),minimum=type.signed?-(1n<<(bits-1n)):0n,maximum=(1n<<(type.signed?bits-1n:bits))-1n;
  if(integer<minimum||integer>maximum)return fail("integer_range","An integer literal is outside the declared native range");
  return `${String(value)}${type.text}`;
 }
 if(Object.is(value,-0)||observed?.kind==="value"&&observed.nativeNegativeZero)return "-0.0_f64";
 const text=String(value);return `${Number.isInteger(value)&&!/[eE]/u.test(text)?`${text}.0`:text}_f64`;
}
function expression(value:ProgramExpression,type:NumericType,arity:number):Expression{
 const render=(part:ProgramExpression)=>expression(part,type,arity);
 const numeric=(part:ProgramExpression):string=>{const result=render(part);return result.type==="number"?result.source:fail("expression_type","A numeric operation cannot consume a boolean");};
 if(value.kind==="argument")return Number.isSafeInteger(value.index)&&value.index>=0&&value.index<arity?{source:`_arg${value.index}`,type:"number"}:fail("arity","An expression argument is outside its declaration");
 if(value.kind==="literal"||value.kind==="value")return {source:literal(value.value,type),type:"number"};
 if(value.kind==="unary"){
  const operand=numeric(value.operand);
  if(type.kind==="integer"&&!type.signed)return fail("integer_operator","Unsigned integer negation is not closed over its native range");
  return {source:type.kind==="integer"?`(${operand}).checked_neg().expect("program.integer_overflow")`:`(-${operand})`,type:"number"};
 }
 if(value.kind==="binary"){
  const left=numeric(value.left),right=numeric(value.right);
  if(value.operator==="minimum"||value.operator==="maximum")return {source:`(${left}).${value.operator==="minimum"?"min":"max"}(${right})`,type:"number"};
  if(type.kind==="integer"){
   if(value.operator==="divide")return fail("integer_operator","Real-number IR division has no exact integer lowering");
   const operator=value.operator==="add"?"add":value.operator==="subtract"?"sub":"mul";
   return {source:`(${left}).checked_${operator}(${right}).expect("program.integer_overflow")`,type:"number"};
  }
  const operator=value.operator==="add"?"+":value.operator==="subtract"?"-":value.operator==="multiply"?"*":"/";
  return {source:`(${left} ${operator} ${right})`,type:"number"};
 }
 if(value.kind==="comparison"||value.kind==="equivalent"){
  const left=numeric(value.left),right=numeric(value.right),operator=value.kind==="equivalent"?"==":value.operator==="less"?"<":value.operator==="less_or_equal"?"<=":value.operator==="greater"?">":">=";
  return {source:`(${left} ${operator} ${right})`,type:"bool"};
 }
 if(value.kind==="conditional"){
  const condition=render(value.condition),yes=render(value.whenTrue),no=render(value.whenFalse);
  if(condition.type!=="bool"||yes.type!==no.type)return fail("expression_type","A conditional needs a boolean and equally typed branches");
  return {source:`(if ${condition.source} {${yes.source}} else {${no.source}})`,type:yes.type};
 }
 return fail("expression",`Native scalar lowering does not support ${value.kind}`);
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {relativeNativeSourcePath} from "./native-runtime-paths.js";
import type { JsonValue } from "./types.js";
import type { ProgramPlan } from "./program-planner.js";
import { nativeOwnerAbis, NativeProgramEmissionError, type NativeOwnerAbi } from "./native-owner-abis.js";
import type { NativeProgramType } from "./native-program-types.js";
import { nativeLiteralJson, type ProgramNativeLiteral } from "./program-native-abi.js";

export function nativeRustStatefulProgram(plan: ProgramPlan, paths:{sourcePath:string;testPath:string}): { source: string; test: string } {
  const abis = nativeOwnerAbis(plan, "rust"), byName = new Map(abis.map(abi => [abi.name, abi]));
  const selected = plan.ownerBehaviorImplementationPhase === "selected";
  const candidate = plan.ownerStatefulBehaviorTransformationCandidates.find(row => plan.selectedOwnerStatefulBehaviorTransformationIds.includes(row.id));
  if (selected && !candidate) throw issue("transformation", "Native Rust state needs its selected transition IR");
  for (const abi of abis) {
    rustName(abi.name);
    if (hasReference(abi.result)) throw issue("borrowed_result", "Owned state cannot return an unproven borrowed lifetime");
  }
  const instructions = selected ? candidate!.transitionIr.map(instruction => {
    const abi = byName.get(instruction.operationId);
    if (!abi) throw issue("operation", "A selected state operation has no native ABI");
    const name = rustString(instruction.operationId);
    if (instruction.kind === "noop") return `${name} => _NativeResult { present:false, value:None },`;
    if (abi.parameters.length <= instruction.keyArgumentIndex) throw issue("arity", "Native state key is outside declared parameters");
    const key = `args[${instruction.keyArgumentIndex}].canonical()`;
    if (instruction.kind === "associate") {
      if (abi.parameters.length <= instruction.valueArgumentIndex || abi.result.kind !== "unit") throw issue("state_result", "Association needs its declared value and unit result");
      return `${name} => { self.state.insert(${key}, args[${instruction.valueArgumentIndex}].clone()); _NativeResult { present:false,value:None } },`;
    }
    if (instruction.kind === "dissociate") return `${name} => { let value=self.state.remove(&${key}); _NativeResult {present:value.is_some(),value} },`;
    const absent = candidate!.absentValue === undefined ? "None" : `Some(${rustValue(candidate!.absentValue as JsonValue)})`;
    return `${name} => match self.state.get(&${key}) { Some(value)=>_NativeResult{present:true,value:Some(value.clone())},None=>_NativeResult{present:false,value:${absent}} },`;
  }).join("\n") : "";
  const methods = abis.map(abi => {
    const args = abi.parameters.map((type, index) => toValue(`_arg${index}`, type)).join(", ");
    const body = !selected ? rustZero(abi.result) : abi.result.kind === "unit"
      ? `{ self._invoke(${rustString(abi.name)}, vec![${args}]); }`
      : `{ let result=self._invoke(${rustString(abi.name)}, vec![${args}]); ${rustStateReturn("result", abi.result)} }`;
    const call = abi.parameters.map((_, index) => `_arg${index}`).join(", ");
    return { method: `pub fn ${rustName(abi.name)}(&mut self${abi.parameters.length ? ", " : ""}${rustParameters(abi)}) -> ${abi.result.text} { ${body} }`,
      global: `pub fn ${rustName(abi.name)}(${rustParameters(abi)}) -> ${abi.result.text} { _NATIVE_DEFAULT.get_or_init(||::std::sync::Mutex::new(create_stateful_program())).lock().expect("native state lock poisoned").${rustName(abi.name)}(${call}) }` };
  });
  const source = `${RUST_NATIVE_VALUES}
pub struct StatefulProgram { state: ::std::collections::BTreeMap<String,_NativeValue> }
pub fn create_stateful_program() -> StatefulProgram { StatefulProgram {state: ::std::collections::BTreeMap::new()} }
static _NATIVE_DEFAULT: ::std::sync::OnceLock<::std::sync::Mutex<StatefulProgram>> = ::std::sync::OnceLock::new();
impl StatefulProgram {
 fn _invoke(&mut self,operation:&str,args:Vec<_NativeValue>) -> _NativeResult {
  match operation { ${instructions} _=>panic!("operation is outside selected state IR") }
 }
 ${methods.map(row => row.method).join("\n")}
}
${methods.map(row => row.global).join("\n")}
`;
  const tests = plan.ownerStatefulBehaviorRequirements.map((requirement, index) => {
    const calls = requirement.invocations.map((invocation, i) => {
      const abi = byName.get(invocation.callableId)!;
      const observed = requirement.sourceContract?.invocations[i]?.nativeArguments;
      const call = `p.${rustName(abi.name)}(${invocation.arguments.map((value, j) => rustLiteral(value, abi.parameters[j]!, observed?.[j])).join(", ")})`;
      if (i !== requirement.invocations.length - 1) return `${call};`;
      if (abi.result.kind === "unit") throw issue("state_result", "An observed native state operation needs a result");
      return `let actual=${call}; let expected: ${abi.result.text} = ${rustLiteral(requirement.expectedResult, abi.result, requirement.sourceContract?.nativeExpected)}; assert_eq!(actual,expected,${rustString(requirement.id)});`;
    }).join("\n");
    return `#[test]\nfn owner_requirement_${index}() { let mut p=program::create_stateful_program(); ${calls} }`;
  });
  return { source, test: `#[path=${JSON.stringify(relativeNativeSourcePath(paths.testPath,paths.sourcePath))}]\nmod program;\n${tests.join("\n\n")}\n` };
}

function rustParameters(abi: NativeOwnerAbi): string { return abi.parameters.map((type, index) => `_arg${index}: ${type.text}`).join(", "); }
function rustName(name: string): string {
  const plain = name.startsWith("r#") ? name.slice(2) : name;
  if (!/^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(plain) || ["_", "self", "Self", "super", "crate"].includes(plain)) throw issue("identifier", "Invalid native Rust callable identifier");
  return `r#${plain}`;
}
function hasReference(type: NativeProgramType): boolean { return type.kind === "reference" || (type.kind === "optional" || type.kind === "sequence") && hasReference(type.element)
  || type.kind === "mapping" && (hasReference(type.key) || hasReference(type.value)); }
function issue(kind: string, message: string): NativeProgramEmissionError { return new NativeProgramEmissionError(`program.emission.rust.${kind}_unsupported`, message); }
function fail(kind: string, message: string): never { throw issue(kind, message); }
function rustString(text: string): string {
  let out = '"';
  for (const point of text) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw issue("unicode", "Rust strings require Unicode scalar values");
    out += point === '"' ? '\\"' : point === "\\" ? "\\\\" : point === "\n" ? "\\n" : point === "\r" ? "\\r" : point === "\t" ? "\\t"
      : code < 0x20 ? `\\u{${code.toString(16)}}` : point;
  }
  return `${out}"`;
}
function rustZero(type: NativeProgramType): string {
  if (type.kind === "unit") return "()";
  if (type.kind === "bool") return "false";
  if (type.kind === "integer") return "0";
  if (type.kind === "float") return "0.0";
  if (type.kind === "string" && type.text.replace(/\s/gu, "") !== "str") return "String::new()";
  if (type.kind === "optional") return "None";
  if (type.kind === "sequence" || type.kind === "mapping") return "Default::default()";
  return fail("probe_type", "The native return type has no owned probe representation");
}
function toValue(value: string, type: NativeProgramType, borrowed = false): string {
  const atom = borrowed ? `*(${value})` : value;
  if (type.kind === "reference") return toValue(value, type.element, true);
  if (type.kind === "bool") return `_NativeValue::Bool(${atom})`;
  if (type.kind === "integer") return `_NativeValue::${type.signed ? "Signed" : "Unsigned"}((${atom}) as ${type.signed ? "i128" : "u128"})`;
  if (type.kind === "float") return `_NativeValue::Float((${atom}) as f64)`;
  if (type.kind === "string") return `_NativeValue::Text((${value}).to_string())`;
  if (type.kind === "optional") return `match ${borrowed ? `(${value}).as_ref()` : value} { Some(value)=>${toValue("value", type.element, borrowed)},None=>_NativeValue::Null }`;
  if (type.kind === "sequence") return `_NativeValue::List((${value}).${borrowed ? "iter" : "into_iter"}().map(|value|${toValue("value", type.element, borrowed)}).collect())`;
  if (type.kind === "mapping" && type.key.kind === "string") return `_NativeValue::Object((${value}).${borrowed ? "iter" : "into_iter"}().map(|(key,value)|(key.to_string(),${toValue("value", type.value, borrowed)})).collect())`;
  return fail("value_type", "Native Rust value is outside the owned JSON domain");
}
function fromValue(value: string, type: NativeProgramType): string {
  if (type.kind === "integer") return `<${type.text}>::try_from(_native_${type.signed ? "signed" : "unsigned"}(${value})).expect("native integer range")`;
  if (type.kind === "float") return `_native_float(${value}) as ${type.text}`;
  if (type.kind === "bool") return `match ${value} { _NativeValue::Bool(value)=>value,_=>panic!("native bool type mismatch") }`;
  if (type.kind === "string") return `match ${value} { _NativeValue::Text(value)=>value,_=>panic!("native string type mismatch") }`;
  if (type.kind === "optional") return `match ${value} { _NativeValue::Null=>None,value=>Some(${fromValue("value", type.element)}) }`;
  if (type.kind === "sequence") return `match ${value} { _NativeValue::List(values)=>values.into_iter().map(|value|${fromValue("value", type.element)}).collect::<${type.text}>(),_=>panic!("native sequence type mismatch") }`;
  if (type.kind === "mapping" && type.key.kind === "string") return `match ${value} { _NativeValue::Object(values)=>values.into_iter().map(|(key,value)|(key,${fromValue("value", type.value)})).collect::<${type.text}>(),_=>panic!("native map type mismatch") }`;
  return fail("value_type", "Native Rust result is outside the owned JSON domain");
}
function rustStateReturn(result: string, type: NativeProgramType): string {
  if (type.kind === "optional") return `if !${result}.present && (${result}.value.is_none() || ${result}.value.as_ref()==Some(&_NativeValue::Null)) { None } else { Some(${fromValue(`${result}.value.expect("native state value is undefined")`, type.element)}) }`;
  return fromValue(`${result}.value.expect("native state value is undefined")`, type);
}
function rustLiteral(value: JsonValue, type: NativeProgramType, native?: ProgramNativeLiteral): string {
  if (native?.kind === "none") return type.kind === "optional" ? "None" : fail("expected_type", "A native None needs its declared Option type");
  if (native?.kind === "some") return type.kind === "optional" ? `Some(${rustLiteral(nativeLiteralJson(native.value), type.element, native.value)})`
    : fail("expected_type", "A native Some needs its declared Option type");
  if (type.kind === "reference") return type.element.kind === "string"
    ? typeof value === "string" ? rustString(value) : fail("literal_type", "A borrowed native string needs a string literal")
    : `&${rustLiteral(value, type.element, native)}`;
  if (type.kind === "optional") return value === null ? "None" : `Some(${rustLiteral(value, type.element, native)})`;
  if (type.kind === "integer" && typeof value === "number" && Number.isSafeInteger(value)) {
    if (native?.kind === "value" && native.nativeNumberKind === "float") return fail("literal_type", "A native float literal does not satisfy an integer declaration");
    return `{ let value: ${type.text} = ${value}; value }`;
  }
  if (type.kind === "float" && typeof value === "number" && Number.isFinite(value)) {
    if (native?.kind === "value" && native.nativeNumberKind === "integer") return fail("literal_type", "A native integer literal does not satisfy a float declaration");
    const text = (Object.is(value, -0) || native?.kind === "value" && native.nativeNegativeZero) ? "-0.0" : Number.isInteger(value) && !/[eE]/u.test(String(value)) ? `${value}.0` : String(value);
    return `{ let value: ${type.text} = ${text}; value }`;
  }
  if (type.kind === "string" && typeof value === "string") return `${rustString(value)}.to_owned()`;
  if (type.kind === "bool" && typeof value === "boolean") return value ? "true" : "false";
  if (type.kind === "sequence" && Array.isArray(value)) return `vec![${value.map(item => rustLiteral(item, type.element)).join(",")}]`;
  if (type.kind === "mapping" && value !== null && typeof value === "object" && !Array.isArray(value) && type.key.kind === "string") return `[${Object.entries(value).map(([key,value]) => `(${rustString(key)}.to_owned(),${rustLiteral(value, type.value)})`).join(",")}].into_iter().collect::<${type.text}>()`;
  return fail("literal_type", "Owned native literal does not fit its declared type");
}
function rustValue(value: JsonValue): string {
  if (value === null) return "_NativeValue::Null";
  if (typeof value === "boolean") return `_NativeValue::Bool(${value})`;
  if (typeof value === "string") return `_NativeValue::Text(${rustString(value)}.to_owned())`;
  if (typeof value === "number") {
    const text = Number.isInteger(value) && !/[eE]/u.test(String(value)) ? `${value}.0` : String(value);
    return Number.isSafeInteger(value) ? `_NativeValue::Signed(${value}i128)` : `_NativeValue::Float(${text})`;
  }
  if (Array.isArray(value)) return `_NativeValue::List(vec![${value.map(rustValue).join(",")}])`;
  return `_NativeValue::Object([${Object.entries(value).map(([key,value]) => `(${rustString(key)}.to_owned(),${rustValue(value)})`).join(",")}].into_iter().collect())`;
}

const RUST_NATIVE_VALUES = String.raw`
#[derive(Clone,Debug)]
enum _NativeValue { Null,Bool(bool),Signed(i128),Unsigned(u128),Float(f64),Text(String),List(Vec<_NativeValue>),Object(::std::collections::BTreeMap<String,_NativeValue>) }
#[derive(Debug)]
struct _NativeResult { present:bool,value:Option<_NativeValue> }
impl PartialEq for _NativeValue { fn eq(&self,other:&Self)->bool { self.canonical()==other.canonical() } }
impl _NativeValue {
 fn canonical(&self)->String {
  fn frame(value:String)->String {format!("{}:{}",value.len(),value)}
  match self {
   Self::Null=>"null".to_owned(),Self::Bool(value)=>format!("b:{}",if *value {1}else{0}),
   Self::Signed(value)=>format!("n:{}",value),Self::Unsigned(value)=>format!("n:{}",value),
   Self::Float(value)=>{assert!(value.is_finite(),"nonfinite native key");if *value==0.0 {"n:0".to_owned()} else if value.fract()==0.0 {format!("n:{:.0}",value)} else {format!("f:{:016x}",value.to_bits())}},
   Self::Text(value)=>format!("s:{}",frame(value.clone())),
   Self::List(values)=>format!("a:{}:{}",values.len(),values.iter().map(|value|frame(value.canonical())).collect::<String>()),
   Self::Object(values)=>format!("o:{}:{}",values.len(),values.iter().map(|(key,value)|format!("{}{}",frame(key.clone()),frame(value.canonical()))).collect::<String>())
  }
 }
}
fn _native_signed(value:_NativeValue)->i128 {
 match value { _NativeValue::Signed(value)=>value,_NativeValue::Unsigned(value)=>i128::try_from(value).expect("signed integer range"),
 _NativeValue::Float(value)=>{assert!(value.is_finite()&&value.fract()==0.0&&value>=i128::MIN as f64&&value<i128::MAX as f64,"signed integer conversion");value as i128},_=>panic!("native integer type mismatch") }
}
fn _native_unsigned(value:_NativeValue)->u128 {
 match value { _NativeValue::Unsigned(value)=>value,_NativeValue::Signed(value)=>u128::try_from(value).expect("unsigned integer range"),
 _NativeValue::Float(value)=>{assert!(value.is_finite()&&value.fract()==0.0&&value>=0.0&&value<u128::MAX as f64,"unsigned integer conversion");value as u128},_=>panic!("native integer type mismatch") }
}
fn _native_float(value:_NativeValue)->f64 { let number=match value { _NativeValue::Float(value)=>value,_NativeValue::Signed(value)=>value as f64,_NativeValue::Unsigned(value)=>value as f64,_=>panic!("native float type mismatch") };assert!(number.is_finite(),"nonfinite native value");number }
`;

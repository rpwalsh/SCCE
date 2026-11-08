// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { JsonValue } from "./types.js";
import type { ProgramPlan } from "./program-planner.js";
import type { ProgramExpression } from "./program-transformation-search.js";
import { nativeOwnerAbis, NativeProgramEmissionError, type NativeOwnerAbi } from "./native-owner-abis.js";
import type { NativeProgramType } from "./native-program-types.js";
import { GO_PROGRAM_STANDARD_LIBRARY } from "./native-runtime-dependencies.js";
import type { ProgramNativeLiteral } from "./program-native-abi.js";

export function nativeGoProgram(plan: ProgramPlan): { source: string; test: string; module: string } {
  const abis = nativeOwnerAbis(plan, "go"), byName = new Map(abis.map(abi => [abi.name, abi]));
  const packages = new Set(abis.map(abi => abi.abi.packageName));
  const packageName = abis[0]!.abi.packageName;
  if (packages.size !== 1 || !packageName || !identifier(packageName)) throw issue("package", "Native Go declarations need one owned package");
  for (const abi of abis) if (!identifier(abi.name) || abi.abi.parameters.some(parameter => !identifier(parameter.name))) throw issue("identifier", "Invalid native Go identifier");
  const stateful = plan.ownerStatefulBehaviorRequirements.length > 0;
  const selected = plan.ownerBehaviorImplementationPhase === "selected";
  const scalar = stateful ? "" : abis.map(abi => {
    const candidate = plan.ownerBehaviorTransformationCandidates.find(row => row.callableId === abi.name && plan.selectedOwnerBehaviorTransformationIds.includes(row.id));
    if (abi.result.kind === "unit") throw issue("return_type", "A scalar owner function needs a return type");
    const guards = candidate?.preconditions.flatMap(precondition => precondition.kind === "finite_numeric_argument"
      ? [`if !_nativeFinite(_arg${precondition.index}) { panic("nonfinite argument") }`]
      : precondition.kind === "nonzero_denominator" ? [`if (${goExpression(precondition.expression, abi)}) == 0 { panic("zero denominator") }`] : []).join("\n") ?? "";
    const body = !selected ? `var zero ${abi.result.text}; return zero` : candidate
      ? `${guards}\nresult := _nativeCast[${abi.result.text}](${goExpression(candidate.producedIr, abi)}); ${candidate.preconditions.some(row => row.kind === "finite_numeric_result") ? 'if !_nativeFinite(result) { panic("nonfinite result") };' : ""} return result`
      : fail("transformation", `No selected transformation for ${abi.name}`);
    return `${goSignature(abi)} { ${body} }`;
  }).join("\n\n");
  const transition = stateful ? plan.ownerStatefulBehaviorTransformationCandidates.find(row => plan.selectedOwnerStatefulBehaviorTransformationIds.includes(row.id)) : undefined;
  if (stateful && selected && !transition) throw issue("transformation", "Native keyed state needs its selected transition IR");
  const instructions = selected ? transition?.transitionIr.map(instruction => {
    const abi = byName.get(instruction.operationId);
    if (!abi) throw issue("operation", "A state operation has no owned ABI");
    const operation = JSON.stringify(instruction.operationId);
    if (instruction.kind === "noop") return `case ${operation}: return _nativeResult{}`;
    if (abi.parameters.length <= instruction.keyArgumentIndex) throw issue("arity", "State key is outside the declared parameters");
    const key = `_nativeKey(args[${instruction.keyArgumentIndex}])`;
    if (instruction.kind === "associate") {
      if (abi.parameters.length <= instruction.valueArgumentIndex || abi.result.kind !== "unit") throw issue("state_result", "Association needs its declared value and unit result");
      return `case ${operation}: p.state[${key}] = args[${instruction.valueArgumentIndex}]; return _nativeResult{}`;
    }
    if (instruction.kind === "dissociate") return `case ${operation}: value, found := p.state[${key}]; delete(p.state, ${key}); return _nativeResult{Present:found, Defined:found, Value:value}`;
    const absent = transition!.absentValue;
    return `case ${operation}: value, found := p.state[${key}]; if found { return _nativeResult{Present:true, Defined:true, Value:value} }; return _nativeResult{Defined:${absent === undefined ? "false" : "true"}, Value:${absent === undefined ? "nil" : goLiteral(absent as JsonValue)}}`;
  }).join("\n") ?? "" : "";
  const methods = stateful ? abis.map(abi => {
    const args = abi.abi.parameters.map((_, index) => `_arg${index}`).join(", ");
    const body = !selected ? abi.result.kind === "unit" ? "return" : `var zero ${abi.result.text}; return zero`
      : abi.result.kind === "unit" ? `p._invoke(${JSON.stringify(abi.name)}, []any{${args}}); return`
      : `result := p._invoke(${JSON.stringify(abi.name)}, []any{${args}}); ${goStateReturn(abi.result)}`;
    const global = abi.result.kind === "unit" ? `_nativeDefault.${abi.name}(${args})` : `return _nativeDefault.${abi.name}(${args})`;
    return `${goSignature(abi, "(p *StatefulProgram) ")} { ${body} }\n${goSignature(abi)} { ${global} }`;
  }).join("\n\n") : "";
  const factory = stateful ? `type StatefulProgram struct { state map[string]any; mu sync.Mutex }
func CreateStatefulProgram() *StatefulProgram { return &StatefulProgram{state:make(map[string]any)} }
var _nativeDefault = CreateStatefulProgram()
func (p *StatefulProgram) _invoke(operation string, args []any) _nativeResult {
 p.mu.Lock(); defer p.mu.Unlock()
 switch operation { ${instructions} }
 panic("operation is outside selected transition IR")
}
${methods}` : "";
  const checks: string[] = [];
  for (const [index, requirement] of plan.ownerBehaviorRequirements.entries()) {
    const abi = byName.get(requirement.callableId)!;
    const call = `${abi.name}(${requirement.arguments.map((value, i) => goLiteral(value, abi.parameters[i], requirement.sourceContract?.nativeArguments?.[i])).join(", ")})`;
    checks.push(`func TestOwnerRequirement${index}(t *testing.T) { actual := ${call}; if actual != ${goLiteral(requirement.expectedResult, abi.result, requirement.sourceContract?.nativeExpected)} { t.Fatalf("owner requirement failed: %#v", actual) } }`);
  }
  for (const [index, requirement] of plan.ownerStatefulBehaviorRequirements.entries()) {
    const calls = requirement.invocations.map((invocation, i) => {
      const abi = byName.get(invocation.callableId)!;
      const call = `p.${abi.name}(${invocation.arguments.map((value, j) => goLiteral(value, abi.parameters[j], requirement.sourceContract?.invocations[i]?.nativeArguments?.[j])).join(", ")})`;
      if (i !== requirement.invocations.length - 1) return call;
      if (abi.result.kind === "unit") throw issue("state_result", "An observed state call needs a result");
      const dereference = requirement.sourceContract?.nativeResultProjection === "dereference";
      if (dereference) return `actual := ${call}; if actual == nil { t.Fatal("expected a present native value") }; if *actual != ${goLiteral(requirement.expectedResult, abi.result.kind === "optional" ? abi.result.element : undefined, requirement.sourceContract?.nativeExpected)} { t.Fatalf("state result failed: %#v", *actual) }`;
      return `actual := ${call}; if actual != ${goLiteral(requirement.expectedResult, abi.result, requirement.sourceContract?.nativeExpected)} { t.Fatalf("state result failed: %#v", actual) }`;
    }).join("\n");
    checks.push(`func TestStatefulRequirement${index}(t *testing.T) { p := CreateStatefulProgram(); ${calls} }`);
  }
  return { source: `package ${packageName}\nimport (\n${GO_PROGRAM_STANDARD_LIBRARY.source.map(module => JSON.stringify(module)).join("\n")}\n)\n${GO_NATIVE_RUNTIME}\n${scalar}\n${factory}\n`,
    test: `package ${packageName}\nimport "testing"\n${checks.join("\n\n")}\n`, module: "module scce.generated\n\ngo 1.20\n" };
}

function goStateReturn(type: NativeProgramType): string {
  if (type.kind === "optional") return `if !result.Present && (!result.Defined || result.Value == nil) { return nil }; value := _nativeCast[${type.element.text}](result.Value); return &value`;
  return `if !result.Defined { var zero ${type.text}; return zero }; return _nativeCast[${type.text}](result.Value)`;
}
function goSignature(abi: NativeOwnerAbi, receiver = ""): string {
  return `func ${receiver}${abi.name}(${abi.parameters.map((type, index) => `_arg${index} ${type.text}`).join(", ")})${abi.result.kind === "unit" ? "" : ` ${abi.result.text}`}`;
}
function identifier(name: string): boolean { return /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(name); }
function issue(kind: string, message: string): NativeProgramEmissionError { return new NativeProgramEmissionError(`program.emission.go.${kind}_unsupported`, message); }
function fail(kind: string, message: string): never { throw issue(kind, message); }

function goLiteral(value: JsonValue, type?: NativeProgramType, native?: ProgramNativeLiteral): string {
  if (type?.kind === "optional") return value === null ? "nil" : `func() ${type.text} { value := ${goLiteral(value, type.element)}; return &value }()`;
  if (value === null) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("literal", "Native JSON numbers must be finite");
    const number = (Object.is(value, -0) || native?.kind === "value" && native.nativeNegativeZero) ? "math.Copysign(0, -1)" : String(value);
    if ((!type || type.kind === "any") && native?.kind === "value" && native.nativeNumberKind === "float") return `float64(${number})`;
    return type?.kind === "float" || type?.kind === "integer" ? `${type.text}(${number})` : number;
  }
  if (Array.isArray(value)) {
    const element = type?.kind === "sequence" ? type.element : undefined;
    return `${type?.kind === "sequence" ? type.text : "[]any"}{${value.map(item => goLiteral(item, element)).join(", ")}}`;
  }
  const mapped = type?.kind === "mapping" ? type : undefined;
  return `${mapped?.text ?? "map[string]any"}{${Object.entries(value).map(([key, value]) => `${JSON.stringify(key)}: ${goLiteral(value, mapped?.value)}`).join(", ")}}`;
}

function goExpression(expression: ProgramExpression, abi: NativeOwnerAbi, element?: string, accumulator?: string): string {
  const render = (node: ProgramExpression) => goExpression(node, abi, element, accumulator);
  if (expression.kind === "argument") return abi.abi.parameters[expression.index] ? `_arg${expression.index}` : fail("argument", "IR argument is outside native ABI");
  if (expression.kind === "element") return element ?? fail("element", "Unbound IR element");
  if (expression.kind === "accumulator") return accumulator ?? fail("accumulator", "Unbound IR accumulator");
  if (expression.kind === "literal") return goLiteral(expression.value);
  if (expression.kind === "value") return goLiteral(expression.value);
  if (expression.kind === "unary") return `(-${render(expression.operand)})`;
  if (expression.kind === "binary") {
    if (expression.operator === "minimum" || expression.operator === "maximum") return `_native${expression.operator === "minimum" ? "Min" : "Max"}(${render(expression.left)}, ${render(expression.right)})`;
    const operator = expression.operator === "add" ? "+" : expression.operator === "subtract" ? "-" : expression.operator === "multiply" ? "*" : "/";
    return `(${render(expression.left)} ${operator} ${render(expression.right)})`;
  }
  if (expression.kind === "equivalent") return `_nativeEqual(${render(expression.left)}, ${render(expression.right)})`;
  if (expression.kind === "comparison") {
    const operator = expression.operator === "less" ? "<" : expression.operator === "less_or_equal" ? "<=" : expression.operator === "greater" ? ">" : ">=";
    return `(${render(expression.left)} ${operator} ${render(expression.right)})`;
  }
  if (expression.kind === "member") return `(${render(expression.subject)})[${typeof expression.key === "string" ? JSON.stringify(expression.key) : expression.key}]`;
  if (expression.kind === "cardinality") return `_nativeLength(${render(expression.operand)})`;
  if (expression.kind === "conditional") return `_nativeChoose(${render(expression.condition)}, func() any { return ${render(expression.whenTrue)} }, func() any { return ${render(expression.whenFalse)} })`;
  if (expression.kind === "sequence") return `[]any{${expression.items.map(render).join(", ")}}`;
  if (expression.kind === "mapping") return `map[string]any{${expression.entries.map(entry => `${JSON.stringify(entry.key)}:${render(entry.value)}`).join(", ")}}`;
  return fail("expression", `Native Go lowering does not yet support ${expression.kind}`);
}

const GO_NATIVE_RUNTIME = String.raw`
type _nativeMutex = sync.Mutex
type _nativeResult struct { Present bool; Defined bool; Value any }
func _nativeCast[T any](value any) T {
 var result T
 reflect.ValueOf(&result).Elem().Set(_nativeConvert(reflect.ValueOf(value), reflect.TypeOf((*T)(nil)).Elem()))
 return result
}
func _nativeConvert(value reflect.Value, target reflect.Type) reflect.Value {
 if !value.IsValid() { switch target.Kind() { case reflect.Interface,reflect.Pointer,reflect.Map,reflect.Slice: return reflect.Zero(target); default: panic("null is outside native result type") } }
 if value.Kind() == reflect.Interface { if value.IsNil() { return _nativeConvert(reflect.Value{},target) }; value = value.Elem() }
 if value.Type().AssignableTo(target) { return value }
 if target.Kind() == reflect.Interface && value.Type().Implements(target) { return value }
 result := reflect.New(target).Elem()
 if target.Kind() >= reflect.Int && target.Kind() <= reflect.Int64 {
  if value.Kind() >= reflect.Int && value.Kind() <= reflect.Int64 { number := value.Int(); if result.OverflowInt(number) { panic("integer overflow") }; result.SetInt(number); return result }
  if value.Kind() >= reflect.Uint && value.Kind() <= reflect.Uint64 { number := value.Uint(); if number > math.MaxInt64 || result.OverflowInt(int64(number)) { panic("integer overflow") }; result.SetInt(int64(number)); return result }
 }
 if target.Kind() >= reflect.Uint && target.Kind() <= reflect.Uint64 {
  if value.Kind() >= reflect.Uint && value.Kind() <= reflect.Uint64 { number := value.Uint(); if result.OverflowUint(number) { panic("integer overflow") }; result.SetUint(number); return result }
  if value.Kind() >= reflect.Int && value.Kind() <= reflect.Int64 { number := value.Int(); if number < 0 || result.OverflowUint(uint64(number)) { panic("integer overflow") }; result.SetUint(uint64(number)); return result }
 }
 if target.Kind() == reflect.Float32 || target.Kind() == reflect.Float64 {
  var number float64
  switch value.Kind() { case reflect.Float32,reflect.Float64: number=value.Float(); case reflect.Int,reflect.Int8,reflect.Int16,reflect.Int32,reflect.Int64: number=float64(value.Int()); case reflect.Uint,reflect.Uint8,reflect.Uint16,reflect.Uint32,reflect.Uint64: number=float64(value.Uint()); default: panic("numeric type mismatch") }
  if math.IsNaN(number) || math.IsInf(number,0) || result.OverflowFloat(number) { panic("nonfinite result") }; result.SetFloat(number); return result
 }
 if target.Kind() == reflect.Slice && (value.Kind() == reflect.Slice || value.Kind() == reflect.Array) { result=reflect.MakeSlice(target,value.Len(),value.Len()); for i:=0;i<value.Len();i++ { result.Index(i).Set(_nativeConvert(value.Index(i),target.Elem())) }; return result }
 if target.Kind() == reflect.Map && value.Kind() == reflect.Map { result=reflect.MakeMapWithSize(target,value.Len()); iter:=value.MapRange(); for iter.Next() { result.SetMapIndex(_nativeConvert(iter.Key(),target.Key()),_nativeConvert(iter.Value(),target.Elem())) }; return result }
 panic("native result type mismatch")
}
func _nativeFrame(value string) string { return strconv.Itoa(len(value))+":"+value }
func _nativeKey(value any) string { return _nativeReflectKey(reflect.ValueOf(value)) }
func _nativeReflectKey(value reflect.Value) string {
 if !value.IsValid() { return "null" }
 if value.Kind()==reflect.Interface || value.Kind()==reflect.Pointer { if value.IsNil() { return "null" }; return _nativeReflectKey(value.Elem()) }
 if (value.Kind()==reflect.Map || value.Kind()==reflect.Slice) && value.IsNil() { return "null" }
 switch value.Kind() {
 case reflect.Bool: if value.Bool() { return "b:1" }; return "b:0"
 case reflect.String: return "s:"+_nativeFrame(value.String())
 case reflect.Int,reflect.Int8,reflect.Int16,reflect.Int32,reflect.Int64: return "n:"+strconv.FormatInt(value.Int(),10)
 case reflect.Uint,reflect.Uint8,reflect.Uint16,reflect.Uint32,reflect.Uint64: return "n:"+strconv.FormatUint(value.Uint(),10)
 case reflect.Float32,reflect.Float64:
  number:=value.Float(); if math.IsNaN(number)||math.IsInf(number,0) { panic("nonfinite key") }; if number==0 { return "n:0" }
  if math.Trunc(number)==number { integer,_:=new(big.Float).SetFloat64(number).Int(nil); return "n:"+integer.String() }; return fmt.Sprintf("f:%016x",math.Float64bits(number))
 case reflect.Slice,reflect.Array:
  var parts []string; for i:=0;i<value.Len();i++ { parts=append(parts,_nativeFrame(_nativeReflectKey(value.Index(i)))) }; return "a:"+strconv.Itoa(value.Len())+":"+strings.Join(parts,"")
 case reflect.Map:
  if value.Type().Key().Kind()!=reflect.String { panic("JSON object keys must be strings") }; keys:=value.MapKeys(); sort.Slice(keys,func(i,j int)bool{return keys[i].String()<keys[j].String()}); var parts []string
  for _,key:=range keys { parts=append(parts,_nativeFrame(key.String())+_nativeFrame(_nativeReflectKey(value.MapIndex(key)))) }; return "o:"+strconv.Itoa(len(keys))+":"+strings.Join(parts,"")
 }
 panic("value is outside native JSON domain")
}
func _nativeEqual(left,right any) bool { return _nativeKey(left)==_nativeKey(right) }
func _nativeFinite(value any) bool { switch number:=reflect.ValueOf(value); number.Kind() { case reflect.Int,reflect.Int8,reflect.Int16,reflect.Int32,reflect.Int64,reflect.Uint,reflect.Uint8,reflect.Uint16,reflect.Uint32,reflect.Uint64: return true; case reflect.Float32,reflect.Float64: return !math.IsNaN(number.Float())&&!math.IsInf(number.Float(),0); default: return false } }
func _nativeLength(value any) int { if text,ok:=value.(string);ok { return len(utf16.Encode([]rune(text))) }; return reflect.ValueOf(value).Len() }
func _nativeChoose(condition bool, yes,no func()any)any { if condition { return yes() }; return no() }
type _nativeNumber interface { ~int|~int8|~int16|~int32|~int64|~uint|~uint8|~uint16|~uint32|~uint64|~float32|~float64 }
func _nativeMin[T _nativeNumber](left,right T)T { if left<right { return left }; return right }
func _nativeMax[T _nativeNumber](left,right T)T { if left>right { return left }; return right }
`;

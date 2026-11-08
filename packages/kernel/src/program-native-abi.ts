// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import { nativeProgramType } from "./native-program-types.js";
import type { JsonValue } from "./types.js";

export type ProgramNativeLiteral = { readonly kind: "value"; readonly value: JsonValue; readonly nativeNumberKind?: "integer" | "float"; readonly nativeNegativeZero?: true }
  | { readonly kind: "none" } | { readonly kind: "some"; readonly value: ProgramNativeLiteral };
export function nativeLiteralJson(value: ProgramNativeLiteral): JsonValue {
  return value.kind === "none" ? null : value.kind === "some" ? nativeLiteralJson(value.value) : value.value;
}
export function ownedNativeLiteral(value: unknown, expected: JsonValue): ProgramNativeLiteral | undefined {
  const read = (value: unknown): ProgramNativeLiteral | undefined => {
    const row = record(value);
    if (row.kind === "none") return { kind: "none" };
    if (row.kind === "some") { const inner = read(row.value); return inner ? { kind: "some", value: inner } : undefined; }
    if (row.kind === "value") {
      try {
        if(!finiteJson(row.value)) return undefined;
        const parsed = JSON.parse(JSON.stringify(row.value)) as JsonValue;
        if(row.nativeNegativeZero!==undefined && (row.nativeNegativeZero!==true || row.nativeNumberKind!=="float" || parsed!==0)) return undefined;
        if (row.nativeNumberKind !== undefined && (typeof parsed !== "number" || !["integer", "float"].includes(String(row.nativeNumberKind)))) return undefined;
        if (row.nativeNumberKind === "integer" && !Number.isSafeInteger(parsed)) return undefined;
        return { kind: "value", value: parsed, ...(row.nativeNumberKind === "integer" || row.nativeNumberKind === "float" ? { nativeNumberKind: row.nativeNumberKind } : {}),...(row.nativeNegativeZero===true?{nativeNegativeZero:true as const}:{}) };
      } catch { return undefined; }
    }
    return undefined;
  };
  const literal = read(value);
  return literal && canonicalStringify(nativeLiteralJson(literal)) === canonicalStringify(expected) ? literal : undefined;
}
function finiteJson(value:unknown):value is JsonValue {
  if(value===null || typeof value==="string" || typeof value==="boolean") return true;
  if(typeof value==="number") return Number.isFinite(value);
  if(Array.isArray(value)) return value.every(finiteJson);
  return typeof value==="object" && (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null)
    && Object.values(value).every(finiteJson);
}

export function ownedNativeArguments(value: unknown, expected: readonly JsonValue[]): readonly ProgramNativeLiteral[] | undefined {
  if (!Array.isArray(value) || value.length !== expected.length) return undefined;
  const arguments_ = value.map((literal, index) => ownedNativeLiteral(literal, expected[index]!));
  return arguments_.every((literal): literal is ProgramNativeLiteral => Boolean(literal)) ? arguments_ : undefined;
}

export interface NativeSourceSpan { readonly start: number; readonly end: number; readonly textHash: string }
export interface ProgramNativeTypeEvidence {
  readonly id: string;
  readonly nodeKind: string;
  readonly text: string;
  readonly span: NativeSourceSpan;
}
export interface ProgramNativeCallableAbi {
  readonly schema: "scce.program.native_callable_abi.v1";
  readonly id: string;
  readonly languageId: "go" | "rust";
  readonly callableName: string;
  readonly packageName?: string;
  readonly owner: { readonly targetSymbolId: string; readonly sourcePath: string; readonly sourceHash: string; readonly sourceVersionId: string };
  readonly parameters: ReadonlyArray<{ readonly name: string; readonly type: ProgramNativeTypeEvidence }>;
  readonly stateParameter?: { readonly index: number; readonly typeId: string; readonly mutable: boolean };
  readonly returnType?: ProgramNativeTypeEvidence;
  readonly signatureText: string;
  readonly signatureSpan: NativeSourceSpan;
  readonly declarationSpan: NativeSourceSpan;
}
const hasher = createHasher();
export function nativeTypeEvidenceId(languageId: string, nodeKind: string, text: string): string {
  return `native.type.${hasher.digestHex(canonicalStringify([languageId, nodeKind, text]))}`;
}
export function nativeCallableAbiId(abi: Omit<ProgramNativeCallableAbi, "id">): string {
  return `native.abi.${hasher.digestHex(canonicalStringify(abi))}`;
}

/** Source ownership and exact signature bytes stay bound when optional ABI evidence crosses the IR boundary. */
export function ownedNativeCallableAbi(value: unknown, owner: ProgramNativeCallableAbi["owner"] & { callableName: string; languageId: string }): ProgramNativeCallableAbi | undefined {
  const row = record(value), binding = record(row.owner), signature = readSpan(row.signatureSpan), declaration = readSpan(row.declarationSpan);
  if (row.schema !== "scce.program.native_callable_abi.v1" || row.languageId !== owner.languageId
    || (row.languageId !== "go" && row.languageId !== "rust") || row.callableName !== owner.callableName
    || !Object.entries(owner).filter(([key]) => key !== "callableName" && key !== "languageId").every(([key, expected]) => binding[key] === expected)
    || !signature || !declaration || declaration.start > signature.start || declaration.end < signature.end
    || typeof row.signatureText !== "string" || row.signatureText.length !== signature.end - signature.start
    || signature.textHash !== `sha256:${hasher.digestHex(row.signatureText)}` || !Array.isArray(row.parameters)) return undefined;
  const signatureText = row.signatureText;
  const type = (value: unknown): ProgramNativeTypeEvidence | undefined => {
    const part = record(value), span = readSpan(part.span);
    return span && typeof part.nodeKind === "string" && part.nodeKind && typeof part.text === "string" && part.text
      && span.start >= signature.start && span.end <= signature.end && span.textHash === `sha256:${hasher.digestHex(part.text)}`
      && signatureText.slice(span.start - signature.start, span.end - signature.start) === part.text
      && part.id === nativeTypeEvidenceId(String(row.languageId), part.nodeKind, part.text)
      ? { id: part.id as string, nodeKind: part.nodeKind, text: part.text, span } : undefined;
  };
  const parameters: Array<ProgramNativeCallableAbi["parameters"][number]> = [];
  for (const parameter of row.parameters) {
    const part = record(parameter), evidence = type(part.type);
    if (typeof part.name !== "string" || !part.name || !evidence) return undefined;
    parameters.push({ name: part.name, type: evidence });
  }
  const returnType = row.returnType === undefined ? undefined : type(row.returnType);
  if (row.returnType !== undefined && !returnType) return undefined;
  const expectedState=nativeMapStateParameter({languageId:row.languageId,parameters});
  const state=record(row.stateParameter);
  if(row.stateParameter!==undefined&&(!expectedState||Object.keys(state).length!==3||state.index!==expectedState.index||state.typeId!==expectedState.typeId||state.mutable!==expectedState.mutable))return undefined;
  const abi: Omit<ProgramNativeCallableAbi, "id"> = { schema: "scce.program.native_callable_abi.v1", languageId: row.languageId,
    callableName: owner.callableName, owner: { targetSymbolId: owner.targetSymbolId, sourcePath: owner.sourcePath, sourceHash: owner.sourceHash, sourceVersionId: owner.sourceVersionId },
    ...(typeof row.packageName === "string" ? { packageName: row.packageName } : {}),
    parameters, ...(row.stateParameter !== undefined ? {stateParameter: expectedState!} : {}), ...(returnType ? { returnType } : {}), signatureText, signatureSpan: signature, declarationSpan: declaration };
  const id = nativeCallableAbiId(abi);
  return row.id === id ? { ...abi, id } : undefined;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function readSpan(value: unknown): NativeSourceSpan | undefined {
  const row = record(value);
  return Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && Number(row.start) >= 0 && Number(row.end) > Number(row.start)
    && typeof row.textHash === "string" && /^sha256:[0-9a-f]{64}$/u.test(row.textHash)
    ? { start: Number(row.start), end: Number(row.end), textHash: row.textHash } : undefined;
}

/** A unique grammar-owned borrowed map is an external state port, never an observed literal. */
export function nativeMapStateParameter(abi: Pick<ProgramNativeCallableAbi,"languageId"|"parameters">): ProgramNativeCallableAbi["stateParameter"] {
  if (abi.languageId !== "rust") return undefined;
  const candidates=abi.parameters.flatMap((parameter,index)=>{
    const type=nativeProgramType("rust",parameter.type.text);
    return parameter.type.nodeKind==="reference_type" && type?.kind==="reference" && type.element.kind==="mapping"
      ? [{index,typeId:parameter.type.id,mutable:type.mutable===true}] : [];
  });
  return candidates.length===1?candidates[0]:undefined;
}

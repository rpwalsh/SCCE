// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";

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
  const abi: Omit<ProgramNativeCallableAbi, "id"> = { schema: "scce.program.native_callable_abi.v1", languageId: row.languageId,
    callableName: owner.callableName, owner: { targetSymbolId: owner.targetSymbolId, sourcePath: owner.sourcePath, sourceHash: owner.sourceHash, sourceVersionId: owner.sourceVersionId },
    ...(typeof row.packageName === "string" ? { packageName: row.packageName } : {}),
    parameters, ...(returnType ? { returnType } : {}), signatureText, signatureSpan: signature, declarationSpan: declaration };
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

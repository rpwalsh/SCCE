// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, type JsonValue, type ProgramDiagnostic } from "@scce/kernel";

interface SourceFile { readonly path: string; readonly contentHash: string; readonly sourceVersionId: string | null; readonly bytes: Uint8Array }
interface ExactSpan { readonly start: number; readonly end: number; readonly textHash: string }
export interface WorkspaceTestSubject {
 readonly targetPath: string; readonly targetHash: string; readonly targetSourceVersionId: string; readonly targetSymbolId: string;
 readonly testPath: string; readonly testHash: string; readonly testSourceVersionId: string;
 readonly assertionSpan: ExactSpan; readonly callSpan: ExactSpan; readonly bindingResolverId: string;
}
const hasher = createHasher();
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function checkedSpan(value: unknown, text: string): ExactSpan | undefined {
 const span = record(value), { start, end, textHash } = span;
 if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
   || start < 0 || end <= start || end > text.length || textHash !== `sha256:${hasher.digestHex(text.slice(start, end))}`) return undefined;
 return { start, end, textHash: String(textHash) };
}

/** Consume the existing compiler/grammar-owned assertion projection after the kernel's owner/byte checks. */
export function workspaceTestSubjects(input: { files: readonly SourceFile[]; contracts: readonly { readonly patternJson: JsonValue }[] }): readonly WorkspaceTestSubject[] {
 const files = new Map(input.files.map(file => [file.path, file])), subjects = new Map<string, WorkspaceTestSubject>(), texts = new Map<string, string>();
 for (const item of input.contracts) {
  const contract = record(item.patternJson), source = files.get(String(contract.sourcePath));
  if (contract.schema !== "scce.source_owned_test_contract.v1" || !source?.sourceVersionId
    || contract.sourceVersionId !== source.sourceVersionId || contract.sourceHash !== source.contentHash || !Array.isArray(contract.cases)) continue;
  for (const value of contract.cases) {
   const row = record(value), test = files.get(String(row.testPath));
   if (!test?.sourceVersionId || row.testSourceVersionId !== test.sourceVersionId || row.testHash !== test.contentHash
     || row.sourcePath !== source.path || row.sourceVersionId !== source.sourceVersionId || row.sourceHash !== source.contentHash
     || typeof row.targetSymbolId !== "string" || !row.targetSymbolId || row.targetSymbolId !== contract.targetSymbolId
     || typeof row.bindingResolverId !== "string" || !row.bindingResolverId) continue;
   if (Array.isArray(row.invocations) && row.invocations.some(value => { const call = record(value); return call.targetSymbolId !== row.targetSymbolId || call.sourcePath !== source.path; })) continue;
   let text = texts.get(test.path); if (text === undefined) { text = new TextDecoder("utf-8", { fatal: true }).decode(test.bytes); texts.set(test.path, text); }
   const assertionSpan = checkedSpan(row.assertionSpan, text), callSpan = checkedSpan(row.callSpan, text);
   if (!assertionSpan || !callSpan || callSpan.start < assertionSpan.start || callSpan.end > assertionSpan.end) continue;
   const subject: WorkspaceTestSubject = { targetPath: source.path, targetHash: source.contentHash, targetSourceVersionId: source.sourceVersionId,
    targetSymbolId: row.targetSymbolId, testPath: test.path, testHash: test.contentHash, testSourceVersionId: test.sourceVersionId,
    assertionSpan, callSpan, bindingResolverId: row.bindingResolverId };
   subjects.set(canonicalStringify(subject), subject);
  }
 }
 return [...subjects.values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
}

/** Native locations select exact owned assertion spans; messages and expected values do not select a target. */
export function testSubjectsAtDiagnostic(input: { file: SourceFile; diagnostic: ProgramDiagnostic; subjects: readonly WorkspaceTestSubject[] }): readonly WorkspaceTestSubject[] {
 const { file, diagnostic } = input;
 if (diagnostic.class !== "runtime" || !Number.isSafeInteger(diagnostic.line) || Number(diagnostic.line) < 1) return [];
 const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), starts = [0];
 for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
 const start = starts[Number(diagnostic.line) - 1]; if (start === undefined) return [];
 const end = starts[Number(diagnostic.line)] ?? text.length;
 const column = diagnostic.column;
 if (column !== undefined && (!Number.isSafeInteger(column) || column < 1 || start + column - 1 >= end)) return [];
 const position = column === undefined ? undefined : start + column - 1;
 return input.subjects.filter(subject => subject.testPath === file.path && subject.testHash === file.contentHash && subject.testSourceVersionId === file.sourceVersionId
  && (position === undefined ? subject.assertionSpan.start < end && subject.assertionSpan.end > start : subject.assertionSpan.start <= position && position < subject.assertionSpan.end));
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedCodeRepairCandidate, LearnedCodeRepairSpan, ProgramDiagnostic, SourceCodeRepairSite } from "@scce/kernel";
import { languageIdForFilePath, parseRepositorySyntax, withRepositorySyntaxTree } from "./tree-sitter-syntax.js";

/** These are source-owned hypothesis sites, not locations asserted by a compiler or a test. */
export async function treeSitterBehaviorRepairSites(input: { targetPath: string; text: string }): Promise<SourceCodeRepairSite[]> {
  const languageId = languageIdForFilePath(input.targetPath);
  if (!languageId) return [];
  return await withRepositorySyntaxTree({ fileId: input.targetPath, languageId, text: input.text }, root => {
    const pending = [root];
    const sites: SourceCodeRepairSite[] = [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.hasError || node.isError || node.isMissing) continue;
      if (node.childCount) pending.push(...node.children);
      else if (node.endIndex > node.startIndex) sites.push({ start: node.startIndex, length: node.endIndex - node.startIndex, grammarNodeType: node.type });
    }
    return sites.sort((left, right) => left.start - right.start);
  }) ?? [];
}

/** A grammar rejects malformed compositions before the full application spends a compiler attempt on them. */
export async function grammaticalTreeSitterRepairs(input: { targetPath: string; text: string; candidates: readonly LearnedCodeRepairCandidate[] }): Promise<LearnedCodeRepairCandidate[]> {
  const languageId = languageIdForFilePath(input.targetPath);
  if (!languageId) return [...input.candidates];
  const baseline = await parseRepositorySyntax({ fileId: input.targetPath, languageId, text: input.text });
  const out: LearnedCodeRepairCandidate[] = [];
  for (const candidate of input.candidates) {
    const lines = input.text.split(/\r?\n/u);
    lines.splice(candidate.startLine - 1, candidate.endLine - candidate.startLine + 1, ...candidate.content.split(/\r?\n/u));
    const text = lines.join(input.text.includes("\r\n") ? "\r\n" : "\n");
    const parsed = await parseRepositorySyntax({ fileId: input.targetPath, languageId, text });
    if (parsed.errors.length <= baseline.errors.length) out.push(candidate);
  }
  return out;
}

/** The grammar bounds a compiler-located hole; the corpus still supplies every replacement token. */
export async function treeSitterRepairSpans(input: { targetPath: string; text: string; diagnostics: readonly ProgramDiagnostic[] }): Promise<LearnedCodeRepairSpan[]> {
  const languageId = languageIdForFilePath(input.targetPath);
  if (!languageId) return [];
  const starts = [0];
  for (let index = 0; index < input.text.length; index++) if (input.text[index] === "\n") starts.push(index + 1);
  return await withRepositorySyntaxTree({ fileId: input.targetPath, languageId, text: input.text }, root => {
    const spans = new Map<string, LearnedCodeRepairSpan>();
    for (const diagnostic of input.diagnostics) {
      if (!diagnostic.line || !diagnostic.column) continue;
      const lineStart = starts[diagnostic.line - 1];
      if (lineStart === undefined) continue;
      const offset = lineStart + diagnostic.column - 1;
      if (offset >= (starts[diagnostic.line] ?? input.text.length + 1)) continue;
      let node = root;
      while (true) {
        const child = node.namedChildren.find(child => child.startIndex <= offset && child.endIndex > offset);
        if (!child) break;
        node = child;
      }
      if (node.namedChildCount || node.hasError || node.isError || node.isMissing || node.startIndex > offset || node.endIndex <= offset) continue;
      spans.set(`${node.startIndex}:${node.endIndex}`, { start: node.startIndex, length: node.endIndex - node.startIndex, diagnosticId: diagnostic.id });
    }
    return [...spans.values()];
  }) ?? [];
}

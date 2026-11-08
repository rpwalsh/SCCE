// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedCodeRepairCandidate, LearnedCodeRepairSpan, ProgramDiagnostic, SourceCodeRepairSite } from "@scce/kernel";
import { CODE_SOURCE_SYMBOL, codeSurfaceTokens, renderCodeTokens } from "@scce/kernel";
import { languageIdForFilePath, parseRepositorySyntax, withRepositorySyntaxTree } from "./tree-sitter-syntax.js";

/** Recovery regions admit lexical boundaries; missing nodes also own their adjacent layout boundaries. */
export async function treeSitterSyntaxInsertionSites(input: { targetPath: string; text: string }): Promise<SourceCodeRepairSite[]> {
  const languageId = languageIdForFilePath(input.targetPath);
  if (!languageId) return [];
  return await withRepositorySyntaxTree({ fileId: input.targetPath, languageId, text: input.text }, root => {
    if (!root.hasError) return [];
    const pending = [root];
    const recoveries: Array<{ start: number; end: number; missing: boolean; type: string }> = [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.isMissing || node.isError) recoveries.push({ start: node.startIndex, end: node.endIndex, missing: node.isMissing, type: node.type });
      pending.push(...node.children);
    }
    const sites = new Map<number, SourceCodeRepairSite>();
    let offset = 0;
    for (const symbol of [...codeSurfaceTokens(input.text), ""]) {
      const recovery = recoveries.find(recovery => recovery.start <= offset && offset <= recovery.end
        || recovery.missing && /^\s*$/u.test(input.text.slice(Math.min(offset, recovery.start), Math.max(offset, recovery.end))));
      if (recovery) sites.set(offset, { start: offset, length: 0, grammarNodeType: recovery.type });
      offset += renderCodeTokens([CODE_SOURCE_SYMBOL, symbol]).length;
    }
    return [...sites.values()];
  }) ?? [];
}

/** These are source-owned hypothesis sites, not locations asserted by a compiler or a test. */
export async function treeSitterBehaviorRepairSites(input: { targetPath: string; text: string }): Promise<SourceCodeRepairSite[]> {
  const languageId = languageIdForFilePath(input.targetPath);
  if (!languageId) return [];
  return await withRepositorySyntaxTree({ fileId: input.targetPath, languageId, text: input.text }, root => {
    const pending = [{ node: root, visited: false }];
    const bodyOwners = new Set<number>();
    const sites = new Map<string, SourceCodeRepairSite>();
    const add = (node: typeof root) => {
      if (node === root || bodyOwners.has(node.id) || node.hasError || node.isError || node.isMissing || node.endIndex <= node.startIndex) return;
      sites.set(`${node.startIndex}:${node.endIndex}`, { start: node.startIndex, length: node.endIndex - node.startIndex, grammarNodeType: node.type });
    };
    while (pending.length) {
      const { node, visited } = pending.pop()!;
      if (node.hasError || node.isError || node.isMissing) continue;
      if (node.childCount) {
        const children = node.children;
        if (!visited) {
          pending.push({ node, visited: true }, ...children.map(node => ({ node, visited: false })));
          continue;
        }
        // A region may not carry a nested grammar-owned body across its binding boundary.
        if (node.childForFieldName("body") || children.some(child => bodyOwners.has(child.id))) bodyOwners.add(node.id);
        const argumentsNode = node.childForFieldName("arguments");
        if (argumentsNode) {
          // Grammar fields bound the invocation, its argument list, and individual argument expressions.
          add(node);
          add(argumentsNode);
          for (const argument of argumentsNode.namedChildren) add(argument);
        }
      } else add(node);
    }
    return [...sites.values()].sort((left, right) => left.start - right.start || left.length - right.length);
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
    if (candidate.requireSyntaxErrorReduction ? parsed.errors.length < baseline.errors.length : parsed.errors.length <= baseline.errors.length) out.push(candidate);
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

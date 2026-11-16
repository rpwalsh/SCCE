// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import ts from "typescript";
import type Parser from "web-tree-sitter";
import { canonicalStringify, compilerCommandWitnessHash, hashPatchContent, toJsonValue, verifyExactTypeScriptCodeActionTransformation, type ProgramDiagnostic } from "@scce/kernel";
import type { CompilerRepairProposal } from "./code-mouth-compiler-proposer.js";
import { languageIdForFilePath, parseRepositorySyntax, withRepositorySyntaxTree } from "./tree-sitter-syntax.js";
import { bindObservedTypeScriptCompilerCommand } from "./workspace-runtime.js";
import type { ExecutedTypeScriptCompilerObservation } from "./typescript-compiler-observation.js";
type ParsedSource = ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.DiagnosticWithLocation[];
};
const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) as ParsedSource;
const shapeHash = (value: unknown) => hashPatchContent(canonicalStringify(value));
function compilerShape(node: ts.Node): unknown {
    const children: unknown[] = [];
    ts.forEachChild(node, child => {
        children.push(compilerShape(child));
    });
    return [
        node.kind, ts.isIdentifier(node) || ts.isLiteralExpression(node) ? node.text : null, children
    ];
}
function grammarShape(node: Parser.SyntaxNode): unknown {
    return [
        node.type, node.childCount ? null : node.text, node.namedChildren.map(grammarShape)
    ];
}
function triviaOnly(text: string): boolean {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (kind < ts.SyntaxKind.FirstTriviaToken || kind > ts.SyntaxKind.LastTriviaToken)
            return false;
    }
    return true;
}
/** Native missing token + compiler recovery position, with no diagnostic-message interpretation or invented token. */
export async function materializeCompilerOwnedSyntaxRecovery(input: {
    root: string;
    targetPath: string;
    targetText: string;
    diagnostics: readonly ProgramDiagnostic[];
    attempt: number;
    compilerObservations?: readonly ExecutedTypeScriptCompilerObservation[] | null;
}): Promise<CompilerRepairProposal | undefined> {
    const languageId = languageIdForFilePath(input.targetPath);
    if (languageId !== "typescript" && languageId !== "tsx")
        return undefined;
    const before = parse(input.targetPath, input.targetText);
    if (before.parseDiagnostics.length !== 1)
        return undefined;
    const failure = before.parseDiagnostics[0]!;
    if (failure.start === undefined || failure.length === undefined)
        return undefined;
    const point = before.getLineAndCharacterOfPosition(failure.start);
    const observations = input.diagnostics.filter(row => row.path && path.resolve(input.root, row.path) === path.resolve(input.root, input.targetPath));
    if (observations.length !== 1 || observations[0]!.patternId !== `TS${failure.code}` || observations[0]!.line !== point.line + 1 || observations[0]!.column !== point.character + 1)
        return undefined;
    const recovery = await withRepositorySyntaxTree({
        fileId: input.targetPath, languageId, text: input.targetText
    }, root => {
        const pending = [
            root
        ], holes: Parser.SyntaxNode[] = [];
        while (pending.length) {
            const node = pending.pop()!;
            if (node.isMissing || node.isError)
                holes.push(node);
            pending.push(...node.children);
        }
        if (holes.length !== 1)
            return undefined;
        const node = holes[0]!;
        if (!node.isMissing || node.isNamed || node.isError || node.startIndex !== node.endIndex || node.childCount)
            return undefined;
        return {
            token: node.type, start: node.startIndex, grammarHash: shapeHash(grammarShape(root))
        };
    });
    if (!recovery || !triviaOnly(input.targetText.slice(Math.min(recovery.start, failure.start), Math.max(recovery.start, failure.start))))
        return undefined;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, recovery.token), kind = scanner.scan();
    if (kind < ts.SyntaxKind.FirstPunctuation || kind > ts.SyntaxKind.LastPunctuation || scanner.getTokenText() !== recovery.token || scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
        return undefined;
    const change = {
        start: failure.start, length: 0, newText: recovery.token
    };
    const surface = input.targetText.slice(0, change.start) + change.newText + input.targetText.slice(change.start);
    if (!verifyExactTypeScriptCodeActionTransformation({
        before: input.targetText, after: surface, textChanges: [
            change
        ]
    }))
        return undefined;
    const after = parse(input.targetPath, surface), compilerAstHash = shapeHash(compilerShape(before));
    if (after.parseDiagnostics.length || shapeHash(compilerShape(after)) !== compilerAstHash)
        return undefined;
    const grammarAfter = await withRepositorySyntaxTree({
        fileId: input.targetPath, languageId, text: surface
    }, root => !root.hasError && shapeHash(grammarShape(root)) === recovery.grammarHash);
    if (!grammarAfter)
        return undefined;
    const binding = await bindObservedTypeScriptCompilerCommand(input);
    if (!binding)
        return undefined;
    const confirmed = await bindObservedTypeScriptCompilerCommand(input);
    if (!confirmed || confirmed.snapshot.revisionHash !== binding.snapshot.revisionHash)
        return undefined;
    const grammar = await parseRepositorySyntax({
        fileId: input.targetPath, languageId, text: input.targetText
    });
    const id = "scce.compiler.syntax_recovery.v1";
    return {
        surface, fixName: id, diagnosticCode: failure.code, operations: [
            {
                id: `op:${input.attempt}:native-syntax`, kind: "replace", path: path.resolve(input.root, input.targetPath), startLine: 1, endLine: input.targetText.split(/\r?\n/u).length,
                content: surface, textChanges: [
                    change
                ], reason: id, risk: 0.1
            }
        ], audit: toJsonValue({
            schema: id, authority: "native_missing_token_and_compiler_recovery_consensus", sourceHash: hashPatchContent(input.targetText), afterHash: hashPatchContent(surface),
            workspaceRevisionHash: binding.snapshot.revisionHash, commandWitnessHash: compilerCommandWitnessHash(binding.compilerLane.command.witness ?? {
                kind: "source_declaration"
            }),
            grammarVersion: grammar.grammarVersion, grammarNodeType: recovery.token, grammarMissingOffset: recovery.start, compilerDiagnosticCode: failure.code,
            compilerDiagnosticOffset: failure.start, compilerVersion: ts.version, compilerAstHash, grammarNamedTreeHash: recovery.grammarHash, textChanges: [
                change
            ]
        })
    };
}

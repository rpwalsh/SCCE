// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import type { ProgramDiagnostic } from "@scce/kernel";
import { materializeCompilerOwnedSyntaxRecovery } from "../compiler-syntax-recovery.js";
import { runWorkspaceCodeCommand } from "../workspace-code-command.js";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { runProcess } from "../document.js";
import type { StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const access = {
    tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted" as const
};
const variants = [
    {
        id: "block", source: "export function compute(x:number):number {\n return x * 5 - 4;\n", token: "}", expected: (x: number) => x * 5 - 4, module: "CommonJS"
    },
    {
        id: "parenthesis", source: "export const compute=(x:number):number => (x * 3 + 2;\n", token: ")", expected: (x: number) => x * 3 + 2, module: "CommonJS"
    },
    {
        id: "array", source: "export function compute(x:number):number { const values=[x,x*2,x*3; return values.reduce((a,b)=>a+b,0); }\n", token: "]", expected: (x: number) => x * 6, module: "NodeNext"
    },
    {
        id: "mixed-comments-unicode", source: `export function compute(x:number):number {\r\n const marker="${String.fromCodePoint(0x1f9ed)}Cafe\u0301";\n return x + marker.length; // trailing comment\r\n`, token: "}", expected: (x: number) => x + 7, module: "CommonJS"
    }
];
it.each(variants)("qualifies native $id recovery, actual target authority and independent behavior without a model", async (variant) => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-native-syntax-"));
    try {
        const config = JSON.stringify({
            compilerOptions: {
                target: "ES2022", module: variant.module, ...(variant.module === "NodeNext" ? {
                    moduleResolution: "NodeNext"
                } : {}), strict: true, types: [], outDir: "compiled"
            }, include: [
                "subject.ts"
            ]
        });
        const checks = `import assert from 'node:assert/strict';import {compute} from './compiled/subject.js';assert.equal(compute(3),${variant.expected(3)});\n`;
        await writeFile(path.join(root, "subject.ts"), variant.source);
        await writeFile(path.join(root, "tsconfig.json"), config);
        await writeFile(path.join(root, "package.json"), JSON.stringify({
            private: true, type: variant.module === "NodeNext" ? "module" : "commonjs"
        }));
        await writeFile(path.join(root, "checks.mjs"), checks);
        const f = ordinaryWorkspaceProgramFixture(root);
        expect((await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 100000
        })).failed).toBe(0);
        f.storage.languageMemory.listNgramModels = async () => {
            throw Error("native parser recovery must not query learned models");
        };
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: `owner.syntax.${variant.id}`, commands: [
                {
                    executable: process.execPath, argv: [
                        compiler, "--pretty", "false", "-p", "tsconfig.json"
                    ], checkIds: [
                        "compiler"
                    ]
                },
                {
                    executable: process.execPath, argv: [
                        "checks.mjs"
                    ], checkIds: [
                        "tests"
                    ]
                }
            ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 100000, environment: {
                NODE_OPTIONS: "--max-old-space-size=512"
            }
        };
        const command = {
            storage: f.storage, workspaceRoot: root, request: "Repair the project checks.", maxAttempts: 1, projectValidation: {
                policy
            }, informationAccess: access
        };
        let result = await runWorkspaceCodeCommand(command);
        expect(result.result, JSON.stringify(result.result)).toMatchObject({
            outcome: "resolved", attempts: 1, proposalSources: [
                "compiler_owned"
            ], finalDiagnostics: []
        });
        expect(result.localization).toMatchObject({
            status: "selected", targetPath: "subject.ts", mode: "project"
        });
        expect(result.projectVerification).toMatchObject({
            buildSucceeded: true, testsRun: true, testsSucceeded: true
        });
        const operation = result.result.appliedOperations[0]!, change = operation.textChanges![0]!;
        expect(operation.textChanges).toHaveLength(1);
        expect(change).toMatchObject({
            length: 0, newText: variant.token
        });
        const after = await readFile(path.join(root, "subject.ts"), "utf8");
        expect(after).toBe(variant.source.slice(0, change.start) + change.newText + variant.source.slice(change.start));
        expect(after).toBe(operation.content);
        expect(result.result.proposalAudits?.[0]?.audit).toMatchObject({
            schema: "scce.compiler.syntax_recovery.v1", grammarNodeType: variant.token, authority: "native_missing_token_and_compiler_recovery_consensus"
        });
        expect(await readFile(path.join(root, "checks.mjs"), "utf8")).toBe(checks);
        expect(await readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(config);
        // Independent observations are never ingested or made part of the public validation policy.
        const built = await runProcess(process.execPath, [
            compiler, "-p", "tsconfig.json"
        ], {
            cwd: root
        });
        expect(built.code, built.stderr).toBe(0);
        const hidden = await runProcess(process.execPath, [
            "-e", `(async()=>{const assert=require('node:assert/strict');const {compute}=await import(process.argv[1]);assert.equal(compute(-17),${variant.expected(-17)});assert.equal(compute(91),${variant.expected(91)});})().catch(error=>{console.error(error);process.exitCode=1;});`, pathToFileURL(path.join(root, "compiled/subject.js")).href
        ], {
            cwd: root
        });
        expect(hidden.code, hidden.stderr).toBe(0);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
}, 60000);
function nativeDiagnostics(root: string, name: string, text: string): ProgramDiagnostic[] {
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) as ts.SourceFile & {
        parseDiagnostics: ts.DiagnosticWithLocation[];
    };
    return source.parseDiagnostics.map(diagnostic => {
        const point = source.getLineAndCharacterOfPosition(diagnostic.start);
        return {
            id: `native:${diagnostic.code}:${diagnostic.start}`, class: "syntax", patternId: `TS${diagnostic.code}`, path: path.join(root, name), line: point.line + 1, column: point.character + 1,
            raw: "opaque localized output", message: "opaque localized output", confidence: 1
        };
    });
}
it.each([
    {
        id: "named parameter hole", text: "export function compute(:number){return 1;}\n"
    },
    {
        id: "expression error region", text: "export const value = ;\n"
    },
    {
        id: "multiple missing delimiters", text: "export function compute(x:number {return (x+1;\n"
    },
    {
        id: "valid syntax with missing semantics", text: "export const value = unknownName;\n"
    },
    {
        id: "line comment without a token boundary", text: "export function compute(){ return 1; // no newline"
    }
])("refuses $id instead of inventing a semantic repair", async ({ text }) => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-native-syntax-refuse-"));
    try {
        await writeFile(path.join(root, "subject.ts"), text);
        await writeFile(path.join(root, "package.json"), JSON.stringify({
            scripts: {
                typecheck: "tsc -p tsconfig.json"
            }
        }));
        await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                strict: true, types: []
            }, include: [
                "subject.ts"
            ]
        }));
        expect(await materializeCompilerOwnedSyntaxRecovery({
            root, targetPath: "subject.ts", targetText: text, diagnostics: nativeDiagnostics(root, "subject.ts", text), attempt: 1
        })).toBeUndefined();
        expect(await readFile(path.join(root, "subject.ts"), "utf8")).toBe(text);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("uses native token/location data with opaque diagnostic prose, but refuses stale locations and JSON config edits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-native-syntax-observed-"));
    try {
        const text = "export function marker():void {\n";
        await writeFile(path.join(root, "subject.ts"), text);
        await writeFile(path.join(root, "package.json"), JSON.stringify({
            scripts: {
                typecheck: "tsc -p tsconfig.json"
            }
        }));
        await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
            compilerOptions: {
                strict: true, types: []
            }, include: [
                "subject.ts"
            ]
        }));
        const diagnostics = nativeDiagnostics(root, "subject.ts", text), input = {
            root, targetPath: "subject.ts", targetText: text, diagnostics, attempt: 1
        };
        expect(await materializeCompilerOwnedSyntaxRecovery(input)).toMatchObject({
            diagnosticCode: 1005, operations: [
                {
                    textChanges: [
                        {
                            length: 0, newText: "}"
                        }
                    ]
                }
            ]
        });
        expect(await materializeCompilerOwnedSyntaxRecovery({
            ...input, diagnostics: diagnostics.map(row => ({
                ...row, line: row.line! + 1
            }))
        })).toBeUndefined();
        expect(await materializeCompilerOwnedSyntaxRecovery({
            ...input, targetPath: "tsconfig.json"
        })).toBeUndefined();
        expect(await readFile(path.join(root, "subject.ts"), "utf8")).toBe(text);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it, expect } from "vitest";
import { codeSurfaceTokens, persistedKneserNey, trainKneserNey, toJsonValue } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";
import { runProcess } from "../document.js";
import { localizeWorkspaceDiagnostics, prepareWorkspaceCodeCommand, runWorkspaceCodeCommand } from "../workspace-code-command.js";
import type { StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const access = {
    tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted" as const
};
it.each([
    "spelling_with_graph", "spelling_without_command", "syntax"
] as const)("localizes unfamiliar TypeScript %s without a path or selector and preserves repair authority", async (family) => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-project-localize-ts-"));
    try {
        await mkdir(path.join(root, "domain"));
        const source = "export function total(values: number[]): number {\n let balance = 0;\n for (const value of values) balance += value;\n return balance;\n}\n";
        const files = {
            "domain/ledger.ts": family === "syntax" ? source.slice(0, source.lastIndexOf("}")) : source.replace("return balance", "return balnce"), "main.ts": "import {total} from './domain/ledger.js';export const run=(values:number[])=>total(values);\n", "tsconfig.json": JSON.stringify({
                compilerOptions: {
                    target: "ES2020", module: "CommonJS", strict: true, outDir: "build"
                }, include: [
                    "domain/*.ts", "main.ts"
                ]
            }), "package.json": JSON.stringify({
                private: true, type: "commonjs", ...(family === "spelling_with_graph" ? {
                    scripts: {
                        typecheck: "tsc -p tsconfig.json"
                    }
                } : {})
            }), "checks.cjs": "const assert=require('node:assert/strict');const {run}=require('./build/main.js');assert.equal(run([12,-7,3]),8);assert.equal(run([]),0);\n"
        };
        for (const [name, text] of Object.entries(files))
            await writeFile(path.join(root, name), text);
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 20, maxFileBytes: 100000
        });
        expect(ingested.failed).toBe(0);
        const model = trainKneserNey(codeSurfaceTokens(source.replace("total(", "referenceSum(")), {
            order: 5, discount: 0.75
        });
        const record = {
            id: "public.training.reference-sum", streamId: "oss_code:reference.ts", languageHint: "opaque", maxOrder: model.order, discount: model.discount, updatedAt: 1, modelJson: toJsonValue({
                sourceSystem: "oss_code", formalLanguage: "typescript", model: persistedKneserNey(model)
            })
        };
        f.storage.languageMemory.listNgramModels = async () => [
            record
        ];
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: "owned.project.ts", commands: [
                {
                    executable: process.execPath, argv: [
                        compiler, "--pretty", "false", "-p", "tsconfig.json"
                    ], checkIds: [
                        "compiler"
                    ]
                },
                {
                    executable: process.execPath, argv: [
                        "checks.cjs"
                    ], checkIds: [
                        "tests"
                    ]
                }
            ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 20, maxWorkspaceBytes: 200000, environment: {
                NODE_OPTIONS: "--max-old-space-size=512"
            }
        };
        const input = {
            storage: f.storage, workspaceRoot: root, request: "Repair the project's failing checks.", maxAttempts: 3, projectValidation: {
                policy
            }, informationAccess: access
        };
        const prepared = await prepareWorkspaceCodeCommand(input);
        expect(prepared.mode).toBe("project");
        const diagnostic = (name: string, id: string) => ({
            id, class: "syntax" as const, path: path.join(root, name), line: 1, column: 1, message: "observed compiler failure", raw: "observed compiler failure", confidence: 1
        });
        expect(localizeWorkspaceDiagnostics(prepared, [
            diagnostic("domain/ledger.ts", "a"), diagnostic("main.ts", "b")
        ])).toMatchObject({
            status: "unresolved", reasonId: "workspace.code.ambiguous_sources"
        });
        expect(localizeWorkspaceDiagnostics(prepared, [
            diagnostic("checks.cjs", "protected")
        ])).toMatchObject({
            status: "unresolved", reasonId: "workspace.code.source_target_unavailable"
        });
        expect(localizeWorkspaceDiagnostics(prepared, [
            diagnostic("domain/ledger.ts", "a"), diagnostic("../unowned.ts", "outside")
        ])).toMatchObject({
            status: "unresolved", reasonId: "workspace.code.unmapped_observation", unmappedDiagnosticIds: [
                "outside"
            ]
        });
        const execution = await runWorkspaceCodeCommand({
            ...input, prepared
        });
        expect(execution.localization).toMatchObject({
            status: "selected", targetPath: "domain/ledger.ts", selectionBasis: "observed_diagnostic_and_canonical_file_graph"
        });
        expect(execution.initialVerification).toMatchObject({
            buildSucceeded: false, testsRun: false
        });
        expect(execution.result, JSON.stringify(execution.result)).toMatchObject({
            outcome: "resolved", finalDiagnostics: [], proposalSources: [
                "compiler_owned"
            ]
        });
        if (family !== "syntax") expect(execution.result.planningSelections).toHaveLength(1);
        else expect(execution.result.proposalAudits?.[0]?.audit).toMatchObject({schema:"scce.compiler.syntax_recovery.v1"});
        expect(execution.projectVerification).toMatchObject({
            buildSucceeded: true, testsRun: true, testsSucceeded: true
        });
        const independent = await runProcess(process.execPath, [
            compiler, "-p", "tsconfig.json"
        ], {
            cwd: root
        });
        expect(independent.code).toBe(0);
        const hidden = await runProcess(process.execPath, [
            "-e", "const assert=require('node:assert/strict');const{run}=require('./build/main.js');assert.equal(run([-300,8,300,91]),99);assert.equal(run([1,1,1]),3);"
        ], {
            cwd: root
        });
        expect(hidden.code, hidden.stderr).toBe(0);
        expect(await readFile(path.join(root, "main.ts"), "utf8")).toBe(files["main.ts"]);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
}, 60000);
it("refuses automatic discovery without a policy or after canonical file bytes change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-project-localize-stale-"));
    try {
        await writeFile(path.join(root, "program.py"), "value = 1\n");
        const fixture = ordinaryWorkspaceProgramFixture(root);
        expect((await fixture.runtime.ingest(root, {
            maxFiles: 5, maxFileBytes: 10000
        })).failed).toBe(0);
        const base = {
            storage: fixture.storage, workspaceRoot: root, request: "Repair project", maxAttempts: 1, informationAccess: access
        };
        await expect(prepareWorkspaceCodeCommand(base)).rejects.toThrow("owner-declared project validation policy");
        let nativeCalls = 0;
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: "owner.stale.project", commands: [
                {
                    executable: process.execPath, argv: [
                        "-e", "process.exit(0)"
                    ], checkIds: [
                        "compiler"
                    ]
                }
            ], timeoutMs: 1000, maxOutputBytes: 1024, maxWorkspaceFiles: 5, maxWorkspaceBytes: 10000, environment: {}
        };
        const input = {
            ...base, projectValidation: {
                policy, provider: {
                    id: "unreached.provider", boundary: "trusted-host" as const, execute: async () => {
                        nativeCalls++;
                        throw Error("native must remain uncalled");
                    }
                }
            }
        };
        const prepared = await prepareWorkspaceCodeCommand(input);
        await expect(runWorkspaceCodeCommand({ ...input, maxAttempts: 2, prepared })).rejects.toThrow("approval scope changed");
        await writeFile(path.join(root, "program.py"), "value = 2\n");
        await expect(runWorkspaceCodeCommand({
            ...input, prepared
        })).rejects.toThrow("stale canonical workspace bytes");
        expect(nativeCalls).toBe(0);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("rejects an owned canonical source with a second hardlink before any native check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-project-localize-hardlink-"));
    try {
        await writeFile(path.join(root, "program.py"), "value = 1\n");
        const fixture = ordinaryWorkspaceProgramFixture(root);
        expect((await fixture.runtime.ingest(root, { maxFiles: 5, maxFileBytes: 10000 })).failed).toBe(0);
        await link(path.join(root, "program.py"), path.join(root, "retained.py"));
        let nativeCalls = 0;
        const policy: StructuredPatchValidationPolicy = { schemaVersion: "scce.patch-validation-policy.v1", id: "owner.hardlink.project",
            commands: [{ executable: process.execPath, argv: ["-e", "process.exit(0)"], checkIds: ["compiler"] }],
            timeoutMs: 1000, maxOutputBytes: 1024, maxWorkspaceFiles: 5, maxWorkspaceBytes: 10000, environment: {} };
        await expect(runWorkspaceCodeCommand({ storage: fixture.storage, workspaceRoot: root, request: "Repair project", maxAttempts: 1,
            informationAccess: access, projectValidation: { policy, provider: { id: "unreached.provider", boundary: "trusted-host",
                execute: async () => { nativeCalls++; throw Error("native must remain uncalled"); } } } })).rejects.toThrow("canonical workspace file identity changed");
        expect(nativeCalls).toBe(0);
        expect(await readFile(path.join(root, "retained.py"), "utf8")).toBe("value = 1\n");
    } finally { await rm(root, { recursive: true, force: true }); }
});

it("localizes an owned Python runtime stack frame from initial real tests without a supplied file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-project-localize-python-"));
    try {
        const capability = await findCodeVerifierCapability("python");
        expect(capability.status).toBe("available");
        if (capability.status !== "available")
            throw Error(capability.reason);
        const python = capability.verifier.command;
        const source = "def total(values):\n    balance = 0\n    for value in values:\n        balance += value\n    return balance\n";
        const files = {
            "ledger.py": source.replace("return balance", "return balnce"), "main.py": "from ledger import total\ndef run(values):\n    return total(values)\n", "checks.py": "import unittest\nfrom ledger import total\nclass Check(unittest.TestCase):\n    def test_values(self): self.assertEqual(total([12,-7,3]),8)\nif __name__ == '__main__': unittest.main()\n"
        };
        for (const [name, text] of Object.entries(files))
            await writeFile(path.join(root, name), text);
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 20, maxFileBytes: 100000
        });
        expect(ingested.failed).toBe(0);
        const model = trainKneserNey(codeSurfaceTokens(source.replace("total(", "reference_sum(")), {
            order: 5, discount: 0.75
        }), record = {
            id: "public.training.reference-sum.py", streamId: "oss_code:reference.py", languageHint: "opaque", maxOrder: model.order, discount: model.discount, updatedAt: 1, modelJson: toJsonValue({
                sourceSystem: "oss_code", formalLanguage: "python", model: persistedKneserNey(model)
            })
        };
        f.storage.languageMemory.listNgramModels = async () => [
            record
        ];
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: "owned.project.py", commands: [
                {
                    executable: python, argv: [
                        "-m", "py_compile", "ledger.py", "main.py", "checks.py"
                    ], checkIds: [
                        "compiler"
                    ]
                },
                {
                    executable: python, argv: [
                        "checks.py"
                    ], checkIds: [
                        "tests"
                    ]
                }
            ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 20, maxWorkspaceBytes: 200000, environment: {}
        };
        const execution = await runWorkspaceCodeCommand({
            storage: f.storage, workspaceRoot: root, request: "Repair the project's failing checks.", maxAttempts: 3, projectValidation: {
                policy
            }, informationAccess: access
        });
        expect(execution.localization).toMatchObject({
            status: "selected", targetPath: "ledger.py"
        });
        expect(execution.initialVerification).toMatchObject({
            buildSucceeded: true, testsRun: true, testsSucceeded: false
        });
        expect(execution.result).toMatchObject({
            outcome: "resolved"
        });
        expect(execution.result.attempts).toBeGreaterThan(0);
        expect(execution.result.proposalSources).toEqual(Array.from({
            length: execution.result.attempts
        }, () => "learned_construction"));
        expect(execution.projectVerification).toMatchObject({
            buildSucceeded: true, testsRun: true, testsSucceeded: true
        });
        const hidden = await runProcess(python, [
            "-c", "from main import run; assert run([-300,8,300,91]) == 99; assert run([]) == 0"
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

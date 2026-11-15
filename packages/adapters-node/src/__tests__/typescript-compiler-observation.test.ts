// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { verifyWorkspaceApplication } from "../workspace-code-mouth-ports.js";
import { planObservedTypeScriptFailure } from "../workspace-runtime.js";
import { finishTypeScriptCompilerObservations, prepareTypeScriptCompilerObservations, semanticCompilerProjectArgs } from "../typescript-compiler-observation.js";
import type { StructuredPatchValidationPolicy } from "../structured-patch-validation.js";
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
it.each([
    "commandless", "matching", "conflicting", "foreign"
] as const)("binds only actual owner-policy compiler authority: %s", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-compiler-authority-"));
    try {
        const text = "export const balance = 42;\nexport const value = balnce;\n";
        const config = JSON.stringify({
            compilerOptions: {
                strict: true, noEmit: true, target: "es2022", types: []
            }, include: [
                "program.ts"
            ]
        });
        await writeFile(path.join(root, "program.ts"), text);
        await writeFile(path.join(root, "tsconfig.json"), config);
        await writeFile(path.join(root, "package.json"), JSON.stringify({
            private: true, ...(mode === "commandless" ? {} : {
                scripts: {
                    typecheck: `tsc -p ${mode === "conflicting" ? "alternate.json" : "tsconfig.json"}`
                }
            })
        }));
        if (mode === "conflicting")
            await writeFile(path.join(root, "alternate.json"), config);
        if (mode === "foreign")
            await writeFile(path.join(root, "foreign.cjs"), "console.log(\"program.ts(2,22): error TS2552: Cannot find name 'balnce'. Did you mean 'balance'?\");process.exit(1);\n");
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: "owner.observed.compiler", commands: [
                {
                    executable: process.execPath, argv: mode === "foreign" ? [
                        path.join(root, "foreign.cjs")
                    ] : [
                        compiler, "--pretty", "false", "-p", "tsconfig.json"
                    ], checkIds: [
                        "compiler"
                    ]
                }
            ], timeoutMs: 15000, maxOutputBytes: 100000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 100000, environment: {
                NODE_OPTIONS: "--max-old-space-size=512"
            }
        };
        const observation = await verifyWorkspaceApplication({
            workspaceRoot: root, projectValidation: {
                policy
            }
        });
        expect(observation.buildSucceeded).toBe(false);
        expect(observation.diagnostics).toHaveLength(1);
        const args = {
            root, targetPath: "program.ts", targetText: text, requestText: "Repair project", diagnostics: observation.diagnostics, compilerObservations: observation.compilerObservations
        };
        const planned = await planObservedTypeScriptFailure(args);
        if (mode === "foreign" || mode === "conflicting") {
            expect(planned).toBeUndefined();
            expect(await readFile(path.join(root, "program.ts"), "utf8")).toBe(text);
            if (mode === "foreign")
                expect(observation.compilerObservations).toEqual([]);
            return;
        }
        expect(planned?.selection.selected?.patchPlan.operations).toEqual([
            expect.objectContaining({
                path: "program.ts", content: "export const balance = 42;\nexport const value = balance;\n"
            })
        ]);
        expect(observation.compilerObservations?.[0]?.witness).toMatchObject({
            kind: "executed_owner_policy", policyId: policy.id, commandIndex: 0, configPath: "tsconfig.json"
        });
        expect(planned?.graph.nodes.filter(node => node.kindId === "scce.task.validation.command.v1")).toHaveLength(1);
        // Serialized claims are not native receipts and cannot establish that a process ran.
        expect(await planObservedTypeScriptFailure({
            ...args, compilerObservations: structuredClone(observation.compilerObservations)
        })).toBeUndefined();
        const prepared = await prepareTypeScriptCompilerObservations(root, policy);
        expect(await finishTypeScriptCompilerObservations(root, policy, structuredClone(observation.projectEvidence!), prepared)).toEqual([]);
        await writeFile(path.join(root, "tsconfig.json"), `${config}\n`);
        await expect(planObservedTypeScriptFailure(args)).rejects.toThrow("exact workspace/config/compiler revision");
        expect(await readFile(path.join(root, "program.ts"), "utf8")).toBe(text);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
}, 60000);
it("normalizes presentation-only compiler argv and declines unsupported semantic overrides", () => {
    expect(semanticCompilerProjectArgs([
        "--pretty", "false", "--noEmit", "-p", "tsconfig.json"
    ])).toEqual([
        "-p", "tsconfig.json"
    ]);
    expect(semanticCompilerProjectArgs([
        "--strict", "false", "-p", "tsconfig.json"
    ])).toBeUndefined();
    expect(semanticCompilerProjectArgs([
        "program.ts"
    ])).toBeUndefined();
});

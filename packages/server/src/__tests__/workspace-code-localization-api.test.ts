// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { codeSurfaceTokens, persistedKneserNey, trainKneserNey, toJsonValue } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "../../../adapters-node/src/__tests__/fixtures/ordinary-workspace-program.js";
import { findCodeVerifierCapability } from "../../../adapters-node/src/code-verifier-discovery.js";
import { runProcess } from "../../../adapters-node/src/document.js";
import { trustedHostPatchValidationProvider, type StructuredPatchValidationPolicy, type StructuredPatchValidationProviderInput } from "../../../adapters-node/src/structured-patch-validation.js";
import { handleRequest, type ApiContext } from "../routes.js";
it.each(["REST", "GraphQL"] as const)("%s requires scoped owner approval before native observations and repairs an unfamiliar project without a supplied file", async transport => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-project-code-api-"));
    let server: ReturnType<typeof createServer> | undefined;
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
        const fixture = ordinaryWorkspaceProgramFixture(root);
        expect((await fixture.runtime.ingest(root, {
            maxFiles: 20, maxFileBytes: 100000
        })).failed).toBe(0);
        const model = trainKneserNey(codeSurfaceTokens(source.replace("total(", "reference_sum(")), {
            order: 5, discount: 0.75
        });
        fixture.storage.languageMemory.listNgramModels = async () => [
            {
                id: "public.prior.python.sum", streamId: "oss_code:reference.py", languageHint: "opaque", maxOrder: model.order, discount: model.discount, updatedAt: 1, modelJson: toJsonValue({
                    sourceSystem: "oss_code", formalLanguage: "python", model: persistedKneserNey(model)
                })
            }
        ];
        const policy: StructuredPatchValidationPolicy = {
            schemaVersion: "scce.patch-validation-policy.v1", id: "owner.python.project", commands: [
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
        let executions = 0;
        const context = {
            startupReadiness: { snapshot: () => ({ phase: "loading", ok: false }) },
            runtime: {
                storage: fixture.storage, kernel: fixture.kernel, approvals: fixture.approvals
            }, config: {
                server: {
                    url: "http://127.0.0.1:0"
                }, database: { url: "postgres://fixture@127.0.0.1:1/no-connection", schema: "fixture" }, runtime: {
                    workspaceRoot: root, allowedRoots: [
                        root
                    ], patchValidation: {
                        provider: "trusted-host", policies: [
                            policy
                        ]
                    }
                }, policy: {
                    allowMutation: true
                }, security: {
                    informationAccess: {
                        tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted"
                    }
                }
            }, patchValidation: {
                provider: {
                    ...trustedHostPatchValidationProvider, execute: async (input: StructuredPatchValidationProviderInput) => {
                        executions++;
                        return trustedHostPatchValidationProvider.execute(input);
                    }
                }
            }
        } as unknown as ApiContext;
        server = createServer((request, response) => {
            void handleRequest(request, response, context);
        });
        await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string")
            throw Error("fixture address missing");
        const post = async (route: string, body: unknown) => {
            const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
                method: "POST", headers: {
                    "content-type": "application/json"
                }, body: JSON.stringify(body)
            });
            return {
                status: response.status, body: await response.json()
            };
        };
        const request = {
            request: "Repair the project's failing checks.", validationPolicyId: policy.id, attempts: 3
        };
        let generation: string | undefined;
        if (transport === "GraphQL") {
            const runtime = await post("/api/graphql", { protocolVersion: "scce.graphql.v1", operationName: "VscodeRuntimeQuery" });
            expect(runtime.body.errors, JSON.stringify(runtime.body)).toBeUndefined();
            generation = runtime.body.extensions.generation;
        }
        const command = async (operationName: string, input: unknown) => {
            const result = await post("/api/graphql", { protocolVersion: "scce.graphql.v1", operationName, generation,
                variables: { input: { operationId: randomUUID(), ...input as object } } });
            expect(result.body.errors, JSON.stringify(result.body)).toBeUndefined();
            return result;
        };
        const edit = async () => {
            if (transport === "REST") return post("/api/workspace/code", request);
            const result = await command("VscodeEditCodeMutation", request);
            return { status: result.status, body: result.body.data.vscodeEditCode.value };
        };
        const pending = await edit();
        expect(pending.status, JSON.stringify(pending.body)).toBe(transport === "REST" ? 202 : 200);
        expect(executions).toBe(0);
        expect(pending.body.pendingApproval.input).not.toHaveProperty("path");
        expect(pending.body.pendingApproval.input.workspaceScope).toMatchObject({
            schema: "scce.workspace.code-scope.v1", writablePaths: [
                "ledger.py", "main.py"
            ]
        });
        expect(pending.body.pendingApproval.input.workspaceScope.manifestHash).toMatch(/^[a-f0-9]{64}$/);
        expect(pending.body.pendingApproval.input.validationBinding).toBeDefined();
        const approval = transport === "REST" ? await post("/api/session/approve", { planId: pending.body.pendingApproval.planId })
            : await command("VscodeApprovePlanMutation", { planId: pending.body.pendingApproval.planId });
        expect(approval.status).toBe(200);
        const repaired = await edit();
        expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
        expect(repaired.body).toMatchObject({
            outcome: "resolved", targetPath: "ledger.py", localization: {
                status: "selected", selectionBasis: "observed_diagnostic_and_canonical_file_graph"
            }, initialVerification: {
                buildSucceeded: true, testsRun: true, testsSucceeded: false
            }, projectVerification: {
                buildSucceeded: true, testsRun: true, testsSucceeded: true
            }
        });
        expect(repaired.body.proposalSources.length).toBeGreaterThan(0);
        expect(new Set(repaired.body.proposalSources)).toEqual(new Set([
            "learned_construction"
        ]));
        expect(executions).toBeGreaterThan(1);
        expect(await readFile(path.join(root, "checks.py"), "utf8")).toBe(files["checks.py"]);
        expect(await readFile(path.join(root, "main.py"), "utf8")).toBe(files["main.py"]);
        // This behavior check is never ingested, declared as a policy, or offered to the proposer.
        const independent = await runProcess(python, [
            "-c", "from main import run; assert run([-100, 11, 207]) == 118; assert run([]) == 0"
        ], {
            cwd: root
        });
        expect(independent.code, independent.stderr).toBe(0);
    }
    finally {
        if (server)
            await new Promise<void>(resolve => server!.close(() => resolve()));
        await rm(root, {
            recursive: true, force: true
        });
    }
}, 60000);

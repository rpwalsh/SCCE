// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
vi.mock("@scce/adapters-node", async (original) => ({
    ...await original<typeof import("@scce/adapters-node")>(), ...await import("../../../adapters-node/src/workspace-capability-operations.js"), assertHydratedRuntimeReady: vi.fn(async () => ({
        activeBrainVersion: "brain.workspace-actions", activeImportRunIds: []
    }))
}));
import { createScceKernel, createRuntimeCapabilities, createClock, createHasher, createIdFactory, CAPABILITY_DEMONSTRATION_SCHEMA, compileCapabilityDemonstrations, capabilityBindingForRequest, decodeProgramArtifactWire, DEFAULT_POLICY, type RuntimeCapabilityPlanStep } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "../../../adapters-node/src/__tests__/fixtures/ordinary-workspace-program.js";
import { createWorkspaceCapabilityOperations, type WorkspaceActionPolicy } from "../../../adapters-node/src/workspace-capability-operations.js";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
import { handleRequest, type ApiContext } from "../routes.js";
import type { ScceRuntimeConfig } from "../../../adapters-node/src/config.js";
import { NodeBuildTestAdapter } from "../../../adapters-node/src/process.js";
it.each(["rest", "graphql"] as const)("executes an ordinary source-learned read/write/read/check request through %s scoped approvals and cold durable replay", async (transport) => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-action-api-"));
    let server: ReturnType<typeof createServer> | undefined;
    let privateRoot: string | undefined;
    try {
        const request = "copy «alpha.json» to «beta.json» inspect «beta.json»", steps: RuntimeCapabilityPlanStep[] = [
            {
                id: "observe", capabilityId: "filesystem.read", payload: {
                    workspaceContext: {}, path: "alpha.json"
                }, dependencyStepIds: []
            },
            {
                id: "persist", capabilityId: "filesystem.write", payload: {
                    workspaceContext: {}, path: "beta.json", content: null, expectedContentHash: null
                }, dependencyStepIds: [
                    "observe"
                ], resultBindings: [
                    {
                        path: [
                            "content"
                        ], predecessorTaskId: "observe", resultPath: [
                            "content"
                        ], type: "string"
                    }
                ]
            },
            {
                id: "readback", capabilityId: "filesystem.read", payload: {
                    workspaceContext: {}, path: "beta.json"
                }, dependencyStepIds: [
                    "persist"
                ]
            },
            {
                id: "verify", capabilityId: "workspace.check", payload: {
                    workspaceContext: {}, index: 0
                }, dependencyStepIds: [
                    "readback"
                ]
            }
        ];
        const binding = (name: string, at: number, field: string) => ({
            path: [
                "steps", at, "payload", field
            ], startCodePoint: [
                ...request.slice(0, (at === 2 ? request.lastIndexOf(name) : request.indexOf(name)))
            ].length, endCodePoint: [
                ...request.slice(0, (at === 2 ? request.lastIndexOf(name) : request.indexOf(name)) + name.length)
            ].length
        });
        const corpus = JSON.stringify({
            schema: CAPABILITY_DEMONSTRATION_SCHEMA, examples: [
                {
                    request, steps, bindings: [
                        binding("alpha.json", 0, "path"), binding("beta.json", 1, "path"), binding("beta.json", 2, "path")
                    ]
                }
            ]
        });
        await writeFile(path.join(root, "operations.json"), corpus);
        const input = JSON.stringify([
            {
                opaque: "unseen-\u0394", value: 31
            },
            {
                opaque: "second", value: -9
            }
        ]);
        await writeFile(path.join(root, "input.json"), input);
        await writeFile(path.join(root, "check.mjs"), "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.deepEqual(JSON.parse(await readFile('output.json','utf8')),JSON.parse(await readFile('input.json','utf8')));\n");
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 200000
        });
        expect(ingested.failed, JSON.stringify(ingested)).toBe(0);
        const source = f.versions.find(version => String(version.contentHash) === `sha256_${createHasher().digestHex(corpus)}`)!;
        expect(source).toBeDefined();
        const patterns = compileCapabilityDemonstrations({
            sourceText: corpus, owner: {
                sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, contentHash: source.contentHash, profileId: "profile.workspace-capability-source"
            }, evidence: f.spans.filter(span => span.sourceVersionId === source.sourceVersionId), hasher: createHasher(), updatedAt: 1000
        });
        expect(patterns.length).toBeGreaterThan(0);
        for (const pattern of patterns)
            await f.storage.languageMemory.putLanguagePattern(pattern);
        expect(await capabilityBindingForRequest({
            storage: f.storage, requestText: "copy «input.json» to «output.json» inspect «output.json»"
        })).toBeDefined();
        const config: ScceRuntimeConfig = {
            server: {
                url: "http://127.0.0.1"
            }, database: { url: "postgres://offline.invalid/none", schema: "fixture" }, runtime: {
                workspaceRoot: root, allowedRoots: [
                    root
                ], tempRoot: root, maxFileBytes: 200000, maxChunkBytes: 64000, excludedPaths: [], tools: {}
            }, connectors: {}, policy: {
                ...DEFAULT_POLICY
            }, security: {
                informationAccess: {
                    tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted"
                }, defaultSourceInformationLabel: f.versions[0]!.informationLabel
            }
        };
        const durable = capabilityRuntimeFixture(), counts = new Map<string, number>();
        const operations = createWorkspaceCapabilityOperations({
            storage: f.storage, config
        }).map(operation => ({
            ...operation, execute: async (...args: Parameters<typeof operation.execute>) => {
                counts.set(operation.capability.id, (counts.get(operation.capability.id) ?? 0) + 1);
                return operation.execute(...args);
            }
        }));
        const capabilities = createRuntimeCapabilities({
            executive: durable.executive(), blobs: f.storage.blobs, operations
        });
        const makeKernel = () => {
            const clock = createClock({
                fixedTime: 5000, stepMs: 1
            }), hasher = createHasher();
            return createScceKernel({
                storage: f.storage, files: {
                    streamPath: async function* () {
                    }
                }, buildTest: new NodeBuildTestAdapter(config), capabilities, executive: durable.executive(), approvals: f.approvals, policy: config.policy, informationAccess: config.security!.informationAccess, sourceInformationLabel: config.security!.defaultSourceInformationLabel, clock, idFactory: createIdFactory({
                    clock, hasher, deterministicReplay: true
                }), deterministicReplay: true
            });
        };
        const context = {
            runtime: {
                kernel: makeKernel(), storage: f.storage, approvals: f.approvals, capabilities, executive: durable.executive()
            }, config, startupReadiness: {
                snapshot: () => ({
                    phase: "running", ok: true, complete: true
                })
            }
        } as unknown as ApiContext;
        server = createServer((req, res) => {
            void handleRequest(req, res, context);
        });
        await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string")
            throw Error("no API address");
        const httpPost = async (route: string, body: unknown) => {
            const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
                method: "POST", headers: {
                    "content-type": "application/json"
                }, body: JSON.stringify(body)
            });
            return {
                status: response.status, body: await response.json()
            };
        };
        let generation: string | undefined, taskId: string | undefined;
        const registrationOperationId = randomUUID();
        const graphql = async (operationName: string, variables: unknown) => {
            if (!generation) {
                const status = await httpPost("/api/graphql", { protocolVersion: "scce.graphql.v1", operationName: "VscodeWorkspaceStatusQuery" });
                expect(status.body.errors, JSON.stringify(status.body)).toBeUndefined();
                generation = status.body.extensions.generation;
            }
            return httpPost("/api/graphql", { protocolVersion: "scce.graphql.v1", operationName, generation, variables });
        };
        const post = async (route: string, value: unknown) => {
            if (transport === "rest") return httpPost(route, value);
            const body = value as Record<string, any>;
            if (route === "/api/workspace/actions/register") {
                const result = await graphql("WorkbenchRegisterWorkspaceActionPolicyMutation", { input: { operationId: registrationOperationId, ...body } });
                expect(result.body.errors, JSON.stringify(result.body)).toBeUndefined();
                return { status: result.status, body: result.body.data.registerWorkspaceActionPolicy };
            }
            if (route === "/api/session/approve") {
                const result = await graphql("VscodeApprovePlanMutation", { input: { operationId: randomUUID(), planId: body.planId } });
                expect(result.body.errors, JSON.stringify(result.body)).toBeUndefined();
                return { status: result.status, body: result.body.data.vscodeApprovePlan };
            }
            if (route === "/api/turn") {
                if (!taskId) {
                    const reserved = await graphql("VscodeReserveTurnMutation", { input: {} });
                    expect(reserved.body.errors, JSON.stringify(reserved.body)).toBeUndefined();
                    taskId = reserved.body.data.reserveTurn.task.id;
                }
                const result = await graphql("VscodeStartTurnMutation", { input: { operationId: taskId, text: body.text,
                    requestedAuthority: body.requestedAuthority, workspaceActionContext: body.metadata.workspaceActionContext } });
                expect(result.body.errors, JSON.stringify(result.body)).toBeUndefined();
                let receipt: any;
                await vi.waitFor(async () => {
                    const read = await graphql("WorkbenchTaskQuery", { id: taskId });
                    expect(read.body.errors, JSON.stringify(read.body)).toBeUndefined();
                    const task = read.body.data.turnTask;
                    expect(task.id).toBe(taskId);
                    expect(task.persistence).toBe("durable");
                    expect(task.latestFrame.phase === "application.turn.awaiting_approval" || ["succeeded", "failed", "interrupted"].includes(task.status)).toBe(true);
                    expect(task.result).not.toBeNull();
                    receipt = { status: task.result.httpStatus, body: task.result.value };
                }, { timeout: 60_000, interval: 20 });
                return receipt;
            }
            throw Error(`Unexpected GraphQL test route ${route}`);
        };
        const coldCoordinator = () => {
            context.runtime.kernel = makeKernel();
            if (transport === "graphql") {
                context.runtime = { ...context.runtime, storage: { ...f.storage } };
                generation = undefined;
            }
        };
        const files = [
            "operations.json", "input.json", "check.mjs"
        ], hasher = createHasher();
        const policy: WorkspaceActionPolicy = {
            schema: "scce.workspace.action-policy.v1", capabilityIds: [
                "filesystem.read", "filesystem.write", "workspace.check"
            ], readablePaths: [
                ...files, "output.json"
            ], writablePaths: [
                "output.json"
            ], protectedFiles: await Promise.all(files.map(async (name) => ({
                path: name, sha256: hasher.digestHex(await readFile(path.join(root, name)))
            }))), checks: [
                {
                    executable: process.execPath, executableSha256: hasher.digestHex(await readFile(process.execPath)), argv: [
                        "check.mjs"
                    ], cwd: "."
                }
            ], maxFileBytes: 200000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 400000, timeoutMs: 5000, maxOutputBytes: 20000, maxCalls: 8
        };
        const registered = await post("/api/workspace/actions/register", {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy
        });
        expect(registered.status, JSON.stringify(registered.body)).toBe(200);
        expect(f.approvals.snapshot().approved).toEqual([]);
        if (transport === "graphql") {
            const repeated = await post("/api/workspace/actions/register", { workspaceId: ingested.workspace.id,
                expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: Object.fromEntries(Object.entries(policy).reverse()) });
            expect(repeated.body).toEqual(registered.body);
            const conflict = await graphql("VscodeRegisterWorkspaceActionPolicyMutation", { input: { operationId: registrationOperationId,
                workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: { ...policy, maxCalls: policy.maxCalls + 1 } } });
            expect(conflict.body.errors[0].extensions.code).toBe("CONFLICT");
            for (const altered of [{ ...policy, runtime: { workspaceActionScope: { maxCalls: 1000 } } }, { ...policy, writablePaths: ["../escape"] }]) {
                const refused = await graphql("VscodeRegisterWorkspaceActionPolicyMutation", { input: { operationId: randomUUID(),
                    workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: altered } });
                expect(refused.body.errors?.length).toBeGreaterThan(0);
            }
            const stale = await graphql("VscodeRegisterWorkspaceActionPolicyMutation", { input: { operationId: randomUUID(),
                workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt + 1, policy } });
            expect(stale.body.errors?.length).toBeGreaterThan(0);
            const reserved = await graphql("VscodeReserveTurnMutation", { input: {} });
            taskId = reserved.body.data.reserveTurn.task.id;
            const forgery = await graphql("VscodeStartTurnMutation", { input: { operationId: taskId, text: "attempt",
                workspaceActionContext: { ...registered.body.workspaceActionContext, maxCalls: 1000 }, metadata: { runtime: { workspaceActionScope: {} } } } });
            expect(forgery.body.errors?.length).toBeGreaterThan(0);
            expect(counts.size).toBe(0);
        }
        const body = {
            text: "copy «input.json» to «output.json» inspect «output.json»", requestedAuthority: "action", operationId: "operation.fresh-workspace", metadata: {
                workspaceActionContext: registered.body.workspaceActionContext, runtime: {
                    workspaceActionScope: {
                        context: {
                            forged: true
                        }, maxCalls: 1000
                    }
                }
            }
        };
        const first = await post("/api/turn", body);
        expect(first.status, JSON.stringify(first.body)).toBe(202);
        expect(first.body.pendingApproval.capabilityId).toBe("filesystem.write");
        expect(first.body.pendingApproval.input.content).toBe(input);
        expect(first.body.pendingApproval.input.workspaceContext).toEqual(registered.body.workspaceActionContext);
        expect(first.body.pendingApproval.approvalScope).toBeDefined();
        expect(counts.get("filesystem.write")).toBeUndefined();
        if (transport === "graphql") {
            const conflict = await graphql("VscodeStartTurnMutation", { input: { operationId: taskId, text: body.text, requestedAuthority: "action",
                workspaceActionContext: { ...registered.body.workspaceActionContext, policyId: "forged-policy" } } });
            expect(conflict.body.errors[0].extensions.code).toBe("CONFLICT");
            expect(counts.get("filesystem.write")).toBeUndefined();
        }
        expect((await post("/api/session/approve", {
            planId: first.body.pendingApproval.planId
        })).status).toBe(200);
        coldCoordinator();
        const second = await post("/api/turn", body);
        expect(second.status, JSON.stringify(second.body)).toBe(202);
        expect(second.body.pendingApproval.capabilityId).toBe("workspace.check");
        expect(await readFile(path.join(root, "output.json"), "utf8")).toBe(input);
        expect(counts.get("filesystem.read")).toBe(2);
        expect(counts.get("workspace.check")).toBeUndefined();
        expect((await post("/api/session/approve", {
            planId: second.body.pendingApproval.planId
        })).status).toBe(200);
        coldCoordinator();
        const completed = await post("/api/turn", body);
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        const result = decodeProgramArtifactWire(completed.body);
        expect(result.actionResults).toHaveLength(4);
        expect(counts.get("filesystem.write")).toBe(1);
        expect(counts.get("workspace.check")).toBe(1);
        privateRoot = await mkdtemp(path.join(tmpdir(), "scce-private-action-check-"));
        const privateCheck = path.join(privateRoot, "hidden.mjs");
        await writeFile(privateCheck, "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';const expected=JSON.parse(await readFile(process.argv[2],'utf8'));const actual=JSON.parse(await readFile(process.argv[3],'utf8'));assert.deepEqual(actual,expected,'PRIVATE_CHECKER_CANARY_921485');assert.equal(actual[0].opaque,'unseen-\\u0394');assert.equal(actual[1].value,-9);\n");
        const independent = spawnSync(process.execPath, [privateCheck, path.join(root, "input.json"), path.join(root, "output.json")], { cwd: privateRoot, encoding: "utf8", windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", WINDIR: process.env.WINDIR ?? "" } });
        expect(independent.status, independent.stderr).toBe(0);
        expect(JSON.stringify(f.spans)).not.toContain("PRIVATE_CHECKER_CANARY_921485");
        expect(JSON.parse(await readFile(path.join(root, "output.json"), "utf8"))).toEqual([
            {
                opaque: "unseen-\u0394", value: 31
            },
            {
                opaque: "second", value: -9
            }
        ]);
        coldCoordinator();
        expect((await post("/api/turn", body)).status).toBe(200);
        expect([
            ...counts.entries()
        ]).toEqual([
            [
                "filesystem.read", 2
            ],
            [
                "filesystem.write", 1
            ],
            [
                "workspace.check", 1
            ]
        ]);
        await writeFile(path.join(root, "input.json"), "[]");
        if (transport === "graphql") taskId = undefined;
        const stale = await post("/api/turn", body);
        expect(stale.status).toBeGreaterThanOrEqual(400);
        expect(counts.get("filesystem.write")).toBe(1);
    }
    finally {
        if (server)
            await new Promise<void>(resolve => server!.close(() => resolve()));
        await rm(root, {
            recursive: true, force: true
        });
        if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
    }
}, 120000);

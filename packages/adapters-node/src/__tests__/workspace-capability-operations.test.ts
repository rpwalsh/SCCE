// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { createHasher, toJsonValue, createRuntimeCapabilities, invokeRuntimeCapability, DEFAULT_POLICY } from "@scce/kernel";
import { ordinaryWorkspaceProgramFixture } from "./fixtures/ordinary-workspace-program.js";
import { createWorkspaceCapabilityOperations, registerWorkspaceActionPolicy, registeredWorkspaceActionPolicies } from "../workspace-capability-operations.js";
import type { ScceRuntimeConfig } from "../config.js";
import { capabilityRuntimeFixture } from "../../../kernel/src/__tests__/fixtures/capability-runtime.js";
function configFor(root: string): ScceRuntimeConfig {
    return {
        server: { url: "http://127.0.0.1" }, database: { url: "postgres://offline.invalid/none", schema: "fixture" },
        runtime: { workspaceRoot: root, tempRoot: root, allowedRoots: [root], maxFileBytes: 10000, maxChunkBytes: 64000, excludedPaths: [], tools: {} },
        connectors: {}, policy: { ...DEFAULT_POLICY },
        security: { informationAccess: { tenantId: "workspace-contract-test", principalId: "owner", compartments: [], maximumExportClass: "restricted" } }
    };
}
it("registers real source-owned workspace operations and refuses stale or out-of-scope effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-capabilities-"));
    try {
        await writeFile(path.join(root, "input.json"), JSON.stringify([
            {
                key: "fresh", value: 7
            }
        ]));
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 10000
        });
        const scope = {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: {
                schema: "scce.workspace.action-policy.v1" as const, capabilityIds: [
                    "filesystem.read", "filesystem.write"
                ], protectedFiles: [
                    {
                        path: "input.json", sha256: createHasher().digestHex(await readFile(path.join(root, "input.json")))
                    }
                ], checks: [], maxCalls: 8, maxWorkspaceFiles: 10, maxWorkspaceBytes: 10000, timeoutMs: 1000, maxOutputBytes: 10000,
                readablePaths: [
                    "input.json", "output.json"
                ], writablePaths: [
                    "output.json"
                ], maxFileBytes: 10000
            }
        };
        const config = configFor(root);
        const context = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, scope);
        const [summary] = await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId);
        expect(summary).toMatchObject({ available: true, context, policy: scope.policy, remainingCalls: scope.policy.maxCalls });
        const workspace = await f.storage.workspace.getWorkspace(context.workspaceId);
        const metadata = workspace!.metadata as Record<string, any>, stamp = metadata.actionPolicyRegistrations;
        delete metadata.actionPolicyRegistrations;
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]).toMatchObject({ available: false });
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]!.context).toBeUndefined();
        metadata.actionPolicyRegistrations = { ...stamp, [context.policyId]: { expectedWorkspaceUpdatedAt: context.expectedWorkspaceUpdatedAt - 1 } };
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]!.available).toBe(false);
        metadata.actionPolicyRegistrations = stamp;
        const operations = createWorkspaceCapabilityOperations({
            storage: f.storage, config
        });
        const read = operations.find(row => row.capability.id === "filesystem.read")!, write = operations.find(row => row.capability.id === "filesystem.write")!;
        expect(read).toBeDefined();
        expect(write.capability.requiresApproval).toBe(true);
        const original = await read.execute(toJsonValue({
            workspaceContext: context, path: "input.json"
        }));
        expect(original).toMatchObject({
            content: '[{"key":"fresh","value":7}]'
        });
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]!.remainingCalls).toBe(scope.policy.maxCalls - 1);
        await registerWorkspaceActionPolicy({ storage: f.storage, config }, scope);
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]!.remainingCalls).toBe(scope.policy.maxCalls - 1);
        const content = JSON.stringify({
            observed: original
        });
        expect(await write.execute(toJsonValue({
            workspaceContext: context, path: "output.json", content, expectedContentHash: null
        }))).toMatchObject({
            path: "output.json", contentHash: `sha256_${createHasher().digestHex(content)}`
        });
        expect(await read.execute(toJsonValue({
            workspaceContext: context, path: "output.json"
        }))).toMatchObject({
            content
        });
        await expect(write.execute(toJsonValue({
            workspaceContext: context, path: "input.json", content: "[]", expectedContentHash: null
        }))).rejects.toThrow(/scope/);
        await expect(write.execute(toJsonValue({
            workspaceContext: context, path: "output.json", content: "[]", expectedContentHash: null
        }))).rejects.toThrow(/changed/);
        await expect(read.execute(toJsonValue({
            workspaceContext: {
                ...context, expectedWorkspaceUpdatedAt: -1
            }, path: "input.json"
        }))).rejects.toThrow(/stale/);
        await expect(read.execute(toJsonValue({
            workspaceContext: context, path: "../outside.json"
        }))).rejects.toThrow(/path/);
        await writeFile(path.join(root, "input.json"), "[]");
        expect((await registeredWorkspaceActionPolicies({ storage: f.storage, config }, context.workspaceId))[0]!.available).toBe(false);
        await expect(read.execute(toJsonValue({
            workspaceContext: context, path: "input.json"
        }))).rejects.toThrow(/canonical/);
        expect(await readFile(path.join(root, "output.json"), "utf8")).toBe(content);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("updates an existing canonical writable file, validates it natively, and rejects total workspace overruns before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-existing-"));
    try {
        await writeFile(path.join(root, "input.json"), "[]");
        await writeFile(path.join(root, "output.json"), '["old"]');
        const check = "import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';assert.deepEqual(JSON.parse(await readFile('output.json','utf8')),['fresh']);";
        await writeFile(path.join(root, "check.mjs"), check);
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 10000
        });
        const config = configFor(root);
        const policy = {
            schema: "scce.workspace.action-policy.v1" as const, capabilityIds: [
                "filesystem.read", "filesystem.write", "workspace.check"
            ], readablePaths: [
                "input.json", "output.json"
            ], writablePaths: [
                "output.json", "extra.json"
            ], protectedFiles: [
                {
                    path: "input.json", sha256: createHasher().digestHex("[]")
                },
                {
                    path: "check.mjs", sha256: createHasher().digestHex(check)
                }
            ], checks: [
                {
                    executable: process.execPath, executableSha256: createHasher().digestHex(await readFile(process.execPath)), argv: [
                        "check.mjs"
                    ], cwd: "."
                }
            ], maxCalls: 8, maxFileBytes: 10000, maxWorkspaceFiles: 3, maxWorkspaceBytes: 10000, timeoutMs: 5000, maxOutputBytes: 10000
        };
        const registration = {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy
        };
        const context = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, registration), operations = createWorkspaceCapabilityOperations({
            storage: f.storage, config
        });
        const write = operations.find(row => row.capability.id === "filesystem.write")!, read = operations[0]!, validate = operations.find(row => row.capability.id === "workspace.check")!;
        await write.execute(toJsonValue({
            workspaceContext: context, path: "output.json", content: '["fresh"]', expectedContentHash: `sha256_${createHasher().digestHex('["old"]')}`
        }));
        expect(await read.execute(toJsonValue({
            workspaceContext: context, path: "output.json"
        }))).toMatchObject({
            content: '["fresh"]'
        });
        expect(await validate.execute(toJsonValue({
            workspaceContext: context, index: 0
        }))).toMatchObject({
            passed: true
        });
        await expect(write.execute(toJsonValue({
            workspaceContext: context, path: "extra.json", content: "x", expectedContentHash: null
        }))).rejects.toThrow(/total file or byte/);
        await expect(readFile(path.join(root, "extra.json"))).rejects.toMatchObject({
            code: "ENOENT"
        });
        const bounded = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, {
            ...registration, policy: {
                ...policy, maxWorkspaceFiles: 4, maxWorkspaceBytes: Buffer.byteLength(check) + 2 + 9
            }
        });
        await expect(write.execute(toJsonValue({
            workspaceContext: bounded, path: "extra.json", content: "xx", expectedContentHash: null
        }))).rejects.toThrow(/total file or byte/);
        expect(await readFile(path.join(root, "output.json"), "utf8")).toBe('["fresh"]');
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("reserves the shared durable call quota atomically across concurrent runtimes, restart and repeated registration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-quota-"));
    try {
        await writeFile(path.join(root, "input.json"), "[]");
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 10000
        });
        const config = configFor(root);
        const registration = {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: {
                schema: "scce.workspace.action-policy.v1" as const, capabilityIds: [
                    "filesystem.read"
                ], readablePaths: [
                    "input.json"
                ], writablePaths: [], protectedFiles: [
                    {
                        path: "input.json", sha256: createHasher().digestHex("[]")
                    }
                ], checks: [], maxCalls: 1, maxFileBytes: 10000, maxWorkspaceFiles: 1, maxWorkspaceBytes: 10000, timeoutMs: 1000, maxOutputBytes: 10000
            }
        };
        const context = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, registration), payload = toJsonValue({
            workspaceContext: context, path: "input.json"
        });
        const left = createWorkspaceCapabilityOperations({
            storage: {
                ...f.storage
            }, config
        }), right = createWorkspaceCapabilityOperations({
            storage: {
                ...f.storage
            }, config
        });
        const results = await Promise.allSettled([
            left[0]!.execute(payload), right[0]!.execute(payload)
        ]);
        expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
        expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
        await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, registration);
        await expect(createWorkspaceCapabilityOperations({
            storage: {
                ...f.storage
            }, config
        })[0]!.execute(payload)).rejects.toThrow(/call budget/);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("compensates a rejected write receipt after quota exhaustion and refuses planner-requested restoration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-compensation-"));
    try {
        await writeFile(path.join(root, "input.json"), "[]");
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 10000
        });
        const config = configFor(root);
        const context = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: {
                schema: "scce.workspace.action-policy.v1", capabilityIds: [
                    "filesystem.write"
                ], readablePaths: [
                    "output.json"
                ], writablePaths: [
                    "output.json"
                ], protectedFiles: [
                    {
                        path: "input.json", sha256: createHasher().digestHex("[]")
                    }
                ], checks: [], maxCalls: 1, maxFileBytes: 10000, maxWorkspaceFiles: 2, maxWorkspaceBytes: 10000, timeoutMs: 1000, maxOutputBytes: 10000
            }
        });
        const durable = capabilityRuntimeFixture();
        const operations = createWorkspaceCapabilityOperations({
            storage: f.storage, config
        }).map(operation => operation.capability.id === "filesystem.write" ? {
            ...operation, succeeded: () => false
        } : operation);
        const restart = () => createRuntimeCapabilities({
            executive: durable.executive(), blobs: f.storage.blobs, operations
        });
        const request = {
            episodeId: "episode.workspace-rollback", taskId: "task.workspace-rollback", ownerId: "owner", policyVersionId: "policy.workspace", approved: true
        };
        const result = await invokeRuntimeCapability({
            ...request, capabilities: restart(), capabilityId: "filesystem.write", payload: toJsonValue({
                workspaceContext: context, path: "output.json", content: "[]", expectedContentHash: null
            })
        });
        expect(result.disposition).toBe("failed");
        expect(await readFile(path.join(root, "output.json"), "utf8")).toBe("[]");
        const restore = operations.find(row => row.capability.id === "filesystem.restore")!;
        await expect(restore.execute(toJsonValue({
            workspaceContext: context, path: "output.json", content: null, expectedContentHash: `sha256_${createHasher().digestHex("[]")}`
        }))).rejects.toThrow(/executive compensation/);
        expect((await restart().rollback(request)).disposition).toBe("rolled_back");
        expect((await restart().rollback(request)).disposition).toBe("rolled_back");
        await expect(readFile(path.join(root, "output.json"))).rejects.toMatchObject({
            code: "ENOENT"
        });
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});
it("refuses a readable symlink even when its target lies inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "scce-workspace-symlink-"));
    try {
        await mkdir(path.join(root, "actual"));
        await writeFile(path.join(root, "actual", "input.json"), "[]");
        const f = ordinaryWorkspaceProgramFixture(root), ingested = await f.runtime.ingest(root, {
            maxFiles: 10, maxFileBytes: 10000
        });
        const config = configFor(root);
        const context = await registerWorkspaceActionPolicy({
            storage: f.storage, config
        }, {
            workspaceId: ingested.workspace.id, expectedWorkspaceUpdatedAt: ingested.workspace.updatedAt, policy: {
                schema: "scce.workspace.action-policy.v1", capabilityIds: [
                    "filesystem.read"
                ], readablePaths: [
                    "alias/input.json"
                ], writablePaths: [
                    "alias/input.json"
                ], protectedFiles: [
                    {
                        path: "actual/input.json", sha256: createHasher().digestHex("[]")
                    }
                ], checks: [], maxCalls: 8, maxFileBytes: 10000, maxWorkspaceFiles: 10, maxWorkspaceBytes: 10000, timeoutMs: 1000, maxOutputBytes: 10000
            }
        });
        await symlink(path.join(root, "actual"), path.join(root, "alias"), "junction");
        const operations = createWorkspaceCapabilityOperations({
            storage: f.storage, config
        });
        await expect(operations[0]!.execute(toJsonValue({
            workspaceContext: context, path: "alias/input.json"
        }))).rejects.toThrow(/symlink/);
    }
    finally {
        await rm(root, {
            recursive: true, force: true
        });
    }
});

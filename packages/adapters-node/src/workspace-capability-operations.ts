// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify, createCapabilityRegistry, readWorkspaceOwnedProgramContracts, toJsonValue, type CapabilityOperation, type JsonValue, type ScceStorage } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { runStructuredWorkspaceValidation, type StructuredPatchValidationPolicy } from "./structured-patch-validation.js";
export const WORKSPACE_ACTION_POLICY_SCHEMA = "scce.workspace.action-policy.v1";
export const WORKSPACE_ACTION_CONTEXT_SCHEMA = "scce.workspace.action-context.v1";
export interface WorkspaceActionPolicy {
    schema: typeof WORKSPACE_ACTION_POLICY_SCHEMA;
    capabilityIds: string[];
    readablePaths: string[];
    writablePaths: string[];
    protectedFiles: Array<{
        path: string;
        sha256: string;
    }>;
    checks: Array<{
        executable: string;
        executableSha256: string;
        argv: string[];
        cwd: string;
    }>;
    maxFileBytes: number;
    maxWorkspaceFiles: number;
    maxWorkspaceBytes: number;
    timeoutMs: number;
    maxOutputBytes: number;
    maxCalls: number;
}
export interface WorkspaceActionContext {
    schema: typeof WORKSPACE_ACTION_CONTEXT_SCHEMA;
    workspaceId: string;
    expectedWorkspaceUpdatedAt: number;
    policyId: string;
}
type Dependencies = {
    storage: ScceStorage;
    config: ScceRuntimeConfig;
};
const workspaceLocks = new WeakMap<ScceStorage, Map<string, Promise<void>>>();
async function serialWorkspace<T>(storage: ScceStorage, id: string, operation: () => Promise<T>): Promise<T> {
    let locks = workspaceLocks.get(storage);
    if (!locks) {
        locks = new Map();
        workspaceLocks.set(storage, locks);
    }
    const previous = locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
        release = resolve;
    }), queued = previous.then(() => current);
    locks.set(id, queued);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (locks.get(id) === queued)
            locks.delete(id);
    }
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("workspace capability requires an object");
    return value as Record<string, unknown>;
}
function relative(value: unknown): value is string {
    return typeof value === "string" && !!value && !value.includes("\\") && !value.includes(":") && !value.includes("\0") && !path.isAbsolute(value) && value.split("/").every(part => !!part && part !== "." && part !== "..");
}
function strings(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(row => typeof row === "string") && new Set(value).size === value.length;
}
function inside(root: string, target: string) {
    const rel = path.relative(root, target);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
export function workspaceActionPolicyId(policy: WorkspaceActionPolicy): string {
    return `workspace_action_${digest(canonicalStringify(policy))}`;
}
function validatePolicy(value: unknown): asserts value is WorkspaceActionPolicy {
    const row = object(value);
    if (Object.keys(row).some(key => ![
        "schema", "capabilityIds", "readablePaths", "writablePaths", "protectedFiles", "checks", "maxFileBytes", "maxWorkspaceFiles", "maxWorkspaceBytes", "timeoutMs", "maxOutputBytes", "maxCalls"
    ].includes(key)))
        throw Error("undeclared workspace policy field");
    if (row.schema !== WORKSPACE_ACTION_POLICY_SCHEMA || !strings(row.capabilityIds) || row.capabilityIds.some(id => ![
        "filesystem.read", "filesystem.write", "workspace.check"
    ].includes(id))
        || !strings(row.readablePaths) || !strings(row.writablePaths) || [
        ...row.readablePaths, ...row.writablePaths
    ].some(name => !relative(name))
        || !Array.isArray(row.protectedFiles) || !Array.isArray(row.checks))
        throw Error("invalid workspace action policy scope");
    for (const name of [
        "maxFileBytes", "maxWorkspaceFiles", "maxWorkspaceBytes", "timeoutMs", "maxOutputBytes", "maxCalls"
    ])
        if (!Number.isSafeInteger(row[name]) || Number(row[name]) < 1)
            throw Error(`invalid workspace policy ${name}`);
    const pathKey = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
    if (new Set(row.writablePaths.map(pathKey)).size !== row.writablePaths.length || new Set(row.readablePaths.map(pathKey)).size !== row.readablePaths.length)
        throw Error("duplicate workspace path identity");
    const protectedPaths = new Set<string>(), writableKeys = new Set(row.writablePaths.map(pathKey));
    for (const raw of row.protectedFiles) {
        const file = object(raw);
        if (Object.keys(file).some(key => ![
            "path", "sha256"
        ].includes(key)) || !relative(file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256) || protectedPaths.has(pathKey(file.path)) || writableKeys.has(pathKey(file.path)))
            throw Error("invalid protected workspace file");
        protectedPaths.add(pathKey(file.path));
    }
    for (const raw of row.checks) {
        const command = object(raw);
        if (typeof command.executable !== "string" || !path.isAbsolute(command.executable) || typeof command.executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(command.executableSha256)
            || !Array.isArray(command.argv) || !command.argv.length || command.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || command.cwd !== "." && !relative(command.cwd))
            throw Error("invalid predeclared workspace check");
    }
}
async function workspaceRoot(deps: Dependencies, context: Pick<WorkspaceActionContext, "workspaceId" | "expectedWorkspaceUpdatedAt">) {
    const workspace = await deps.storage.workspace.getWorkspace(context.workspaceId);
    if (!workspace || workspace.updatedAt !== context.expectedWorkspaceUpdatedAt)
        throw Error("stale workspace action context");
    const owned = await readWorkspaceOwnedProgramContracts({
        storage: deps.storage, context: {
            schema: "scce.workspace.program-context.v1", workspaceId: context.workspaceId, expectedWorkspaceUpdatedAt: context.expectedWorkspaceUpdatedAt
        }, informationAccess: deps.config.security?.informationAccess
    });
    if (owned.status !== "available")
        throw Error(`workspace source ownership unavailable: ${owned.reasonId}`);
    const root = await realpath(workspace.rootPath), allowed = await Promise.all(deps.config.runtime.allowedRoots.map(name => realpath(name)));
    if (!allowed.some(name => inside(name, root)))
        throw Error("workspace root outside configured scope");
    return {
        workspace, root
    };
}
async function targetPath(root: string, name: string, allowAbsent = false): Promise<string> {
    if (!relative(name))
        throw Error("invalid workspace path");
    const target = path.resolve(root, name);
    if (!inside(root, target))
        throw Error("workspace path escapes root");
    let current = root;
    for (const [index, part] of name.split("/").entries()) {
        current = path.join(current, part);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink())
                throw Error("workspace symlink is forbidden");
            if (index < name.split("/").length - 1 && !stat.isDirectory())
                throw Error("workspace parent is not a directory");
            if (index === name.split("/").length - 1 && (!stat.isFile() || stat.nlink !== 1))
                throw Error("workspace target is not an independent file");
        }
        catch (error) {
            if (allowAbsent && index === name.split("/").length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT")
                return target;
            throw error;
        }
    }
    return target;
}
async function boundedRead(root: string, name: string, maxBytes: number) {
    const target = await targetPath(root, name), stat = await lstat(target);
    if (stat.size > maxBytes)
        throw Error("workspace file byte budget exceeded");
    const bytes = await readFile(target);
    if (bytes.length > maxBytes)
        throw Error("workspace file byte budget exceeded");
    return bytes;
}
async function verifyProtected(root: string, policy: WorkspaceActionPolicy) {
    for (const file of policy.protectedFiles)
        if (digest(await boundedRead(root, file.path, policy.maxFileBytes)) !== file.sha256)
            throw Error(`canonical protected workspace bytes changed: ${file.path}`);
}
async function workspaceSize(root: string, policy: WorkspaceActionPolicy) {
    let files = 0, bytes = 0;
    const pending = [
        root
    ];
    while (pending.length) {
        const directory = pending.pop()!;
        for (const name of await readdir(directory)) {
            const target = path.join(directory, name), stat = await lstat(target);
            if (stat.isSymbolicLink())
                throw Error("workspace symlink is forbidden");
            if (stat.isDirectory())
                pending.push(target);
            else {
                if (!stat.isFile() || stat.nlink !== 1)
                    throw Error("workspace contains a non-independent file");
                files++;
                bytes += stat.size;
                if (stat.size > policy.maxFileBytes || files > policy.maxWorkspaceFiles || bytes > policy.maxWorkspaceBytes)
                    throw Error("workspace total file or byte budget exceeded");
            }
        }
    }
    return {
        files, bytes
    };
}
type Registration = {
    workspaceId: string;
    expectedWorkspaceUpdatedAt: number;
    policy: WorkspaceActionPolicy;
};
export async function registerWorkspaceActionPolicy(deps: Dependencies, input: Registration): Promise<WorkspaceActionContext> {
    return serialWorkspace(deps.storage, input.workspaceId, () => registerPolicy(deps, input));
}
async function registerPolicy(deps: Dependencies, input: Registration): Promise<WorkspaceActionContext> {
    validatePolicy(input.policy);
    if (input.policy.maxFileBytes > deps.config.runtime.maxFileBytes)
        throw Error("workspace policy exceeds configured file bound");
    const { workspace, root } = await workspaceRoot(deps, input);
    const records = await deps.storage.workspace.listSourceFiles({
        workspaceId: workspace.id
    });
    const protectedPaths = new Map(input.policy.protectedFiles.map(file => [
        file.path, file.sha256
    ]));
    for (const record of records.filter(row => row.ingestionStatus !== "missing" && !input.policy.writablePaths.includes(row.path))) {
        if (!record.contentHash || protectedPaths.get(record.path) !== String(record.contentHash).replace(/^sha256_/u, ""))
            throw Error("workspace policy must protect every canonical input");
    }
    await verifyProtected(root, input.policy);
    await workspaceSize(root, input.policy);
    for (const check of input.policy.checks)
        if (digest(await readFile(check.executable)) !== check.executableSha256)
            throw Error("workspace check executable hash differs");
    const policyId = workspaceActionPolicyId(input.policy);
    if (!deps.storage.workspace.registerActionPolicy)
        throw Error("atomic workspace policy registration unavailable");
    if (!await deps.storage.workspace.registerActionPolicy({
        workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt, policyId, policy: toJsonValue(input.policy)
    }))
        throw Error("stale workspace policy registration");
    return {
        schema: WORKSPACE_ACTION_CONTEXT_SCHEMA, workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt, policyId
    };
}
async function resolve(deps: Dependencies, value: unknown, capabilityId: string) {
    const context = object(value);
    if (context.schema !== WORKSPACE_ACTION_CONTEXT_SCHEMA || typeof context.workspaceId !== "string" || typeof context.expectedWorkspaceUpdatedAt !== "number" || !Number.isFinite(context.expectedWorkspaceUpdatedAt) || typeof context.policyId !== "string" || Object.keys(context).some(key => ![
        "schema", "workspaceId", "expectedWorkspaceUpdatedAt", "policyId"
    ].includes(key)))
        throw Error("workspace action context unavailable");
    const { workspace, root } = await workspaceRoot(deps, context as unknown as WorkspaceActionContext), policies = object(object(workspace.metadata).actionPolicies), policy = policies[context.policyId];
    validatePolicy(policy);
    if (workspaceActionPolicyId(policy) !== context.policyId || !policy.capabilityIds.includes(capabilityId))
        throw Error("workspace capability outside registered policy scope");
    await verifyProtected(root, policy);
    return {
        root, policy
    };
}
export async function resolveWorkspaceActionContext(deps: Dependencies, value: unknown) {
    const context = object(value);
    if (typeof context.workspaceId !== "string" || typeof context.expectedWorkspaceUpdatedAt !== "number" || typeof context.policyId !== "string")
        throw Error("workspace action context unavailable");
    const workspace = await deps.storage.workspace.getWorkspace(context.workspaceId), policies = object(object(workspace?.metadata).actionPolicies), policy = policies[context.policyId];
    validatePolicy(policy);
    await resolve(deps, value, policy.capabilityIds[0] ?? "");
    return {
        context: toJsonValue({
            schema: WORKSPACE_ACTION_CONTEXT_SCHEMA, workspaceId: context.workspaceId, expectedWorkspaceUpdatedAt: context.expectedWorkspaceUpdatedAt, policyId: context.policyId
        }), maxCalls: policy.maxCalls
    };
}
async function policyCall(deps: Dependencies, value: JsonValue, id: string, effect: () => Promise<JsonValue>, compensating = false) {
    const context = object(object(value).workspaceContext);
    if (typeof context.workspaceId !== "string")
        throw Error("workspace action context unavailable");
    return serialWorkspace(deps.storage, context.workspaceId, async () => {
        const { policy, root } = await resolve(deps, context, id === "filesystem.restore" ? "filesystem.write" : id), workspace = await deps.storage.workspace.getWorkspace(context.workspaceId as string);
        if (!workspace || workspace.updatedAt !== context.expectedWorkspaceUpdatedAt)
            throw Error("stale workspace action context");
        await workspaceSize(root, policy);
        if (!compensating) {
            if (!deps.storage.workspace.claimActionCall)
                throw Error("atomic workspace call reservation unavailable");
            if (!await deps.storage.workspace.claimActionCall({
                workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt, policyId: String(context.policyId), maxCalls: policy.maxCalls
            }))
                throw Error("workspace policy call budget exhausted or stale");
        }
        const result = await effect();
        await workspaceSize(root, policy);
        return result;
    });
}
export function createWorkspaceCapabilityOperations(deps: Dependencies): CapabilityOperation[] {
    const registry = createCapabilityRegistry({
        filesystem: true, process: true
    });
    const add = (id: string, inputSchema: JsonValue, execute: CapabilityOperation["execute"]): CapabilityOperation => ({
        capability: id === "workspace.check" ? {
            ...registry.get("process.build_test")!, id, label: id
        } : id === "filesystem.restore" ? {
            ...registry.get("filesystem.write")!, id, label: id
        } : registry.get(id)!, phase: id === "filesystem.read" ? "read" : "commit", inputSchema, validate(value) {
            const row = object(value);
            if (!row.workspaceContext)
                throw Error("workspaceContext is required");
            const fields = object(inputSchema);
            if (Object.keys(row).some(key => !Object.hasOwn(fields, key)))
                throw Error("undeclared workspace capability input");
            for (const [key, type] of Object.entries(fields)) {
                if (type === "string" && typeof row[key] !== "string" || type === "object" && (!row[key] || typeof row[key] !== "object"))
                    throw Error(`invalid workspace capability ${key}`);
            }
        }, execute: async (value, execution) => {
            if (id === "filesystem.restore" && execution?.attemptKind !== "rollback")
                throw Error("filesystem restoration requires executive compensation");
            return policyCall(deps, value, id, () => execute(value), id === "filesystem.restore");
        }
    });
    const writeOutput = (restoring = false): CapabilityOperation["execute"] => async (value) => {
        const row = object(value), { root, policy } = await resolve(deps, row.workspaceContext, "filesystem.write");
        if (typeof row.path !== "string" || !policy.writablePaths.includes(row.path) || (typeof row.content !== "string" && !(restoring && row.content === null)))
            throw Error("write outside workspace policy scope");
        const bytes = row.content === null ? null : Buffer.from(row.content as string, "utf8");
        if (bytes && bytes.length > policy.maxFileBytes)
            throw Error("workspace file byte budget exceeded");
        const target = await targetPath(root, row.path, true);
        let existing: string | null = null, previousContent: string | null = null;
        try {
            const previous = await boundedRead(root, row.path, policy.maxFileBytes);
            existing = `sha256_${digest(previous)}`;
            previousContent = new TextDecoder("utf-8", {
                fatal: true
            }).decode(previous);
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
        }
        if (row.expectedContentHash !== existing)
            throw Error("workspace output changed since proposal");
        const size = await workspaceSize(root, policy), previousBytes = previousContent === null ? 0 : Buffer.byteLength(previousContent, "utf8");
        if (size.files + (existing === null && bytes ? 1 : 0) - (existing !== null && !bytes ? 1 : 0) > policy.maxWorkspaceFiles || size.bytes - previousBytes + (bytes?.length ?? 0) > policy.maxWorkspaceBytes)
            throw Error("workspace total file or byte budget exceeded");
        if (bytes) {
            const staging = `${target}.${digest(bytes)}.scce-write`;
            let staged = false;
            try {
                await writeFile(staging, bytes, {
                    flag: "wx"
                });
                staged = true;
                await rename(staging, target);
            }
            finally {
                if (staged)
                    await unlink(staging).catch(error => {
                        if (error.code !== "ENOENT")
                            throw error;
                    });
            }
        }
        else if (existing !== null)
            await unlink(target);
        return toJsonValue({
            workspaceContext: row.workspaceContext, path: row.path, contentHash: bytes ? `sha256_${digest(bytes)}` : null, bytes: bytes?.length ?? 0, previousContent
        });
    };
    return [
        add("filesystem.read", {
            workspaceContext: "object", path: "string"
        }, async (value) => {
            const row = object(value), { root, policy } = await resolve(deps, row.workspaceContext, "filesystem.read");
            if (!relative(row.path))
                throw Error("invalid workspace path");
            if (!policy.readablePaths.includes(row.path))
                throw Error("read outside workspace policy scope");
            const bytes = await boundedRead(root, row.path, policy.maxFileBytes);
            return {
                path: row.path, content: bytes.toString("utf8"), contentHash: `sha256_${digest(bytes)}`
            };
        }),
        {
            ...add("filesystem.write", {
                workspaceContext: "object", path: "string", content: "string", expectedContentHash: "json"
            }, writeOutput()), compensation: {
                capabilityId: "filesystem.restore", payload: result => {
                    const row = object(result);
                    return toJsonValue({
                        workspaceContext: row.workspaceContext, path: row.path, content: row.previousContent, expectedContentHash: row.contentHash
                    });
                }
            }
        },
        add("filesystem.restore", {
            workspaceContext: "object", path: "string", content: "json", expectedContentHash: "json"
        }, writeOutput(true)),
        {
            ...add("workspace.check", {
                workspaceContext: "object", index: "json"
            }, async (value) => {
                const row = object(value), { root, policy } = await resolve(deps, row.workspaceContext, "workspace.check");
                if (!Number.isSafeInteger(row.index) || Number(row.index) < 0 || !policy.checks[Number(row.index)])
                    throw Error("check outside workspace policy scope");
                const check = policy.checks[Number(row.index)]!;
                if (digest(await readFile(check.executable)) !== check.executableSha256)
                    throw Error("workspace check executable hash differs");
                const validation: StructuredPatchValidationPolicy = {
                    schemaVersion: "scce.patch-validation-policy.v1", id: workspaceActionPolicyId(policy), commands: [
                        {
                            executable: check.executable, argv: check.argv, cwd: check.cwd, checkIds: [
                                "tests"
                            ]
                        }
                    ], timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, maxWorkspaceFiles: policy.maxWorkspaceFiles, maxWorkspaceBytes: policy.maxWorkspaceBytes, environment: {}
                };
                const result = await runStructuredWorkspaceValidation({
                    workspaceRoot: root, policy: validation
                });
                await verifyProtected(root, policy);
                return toJsonValue({
                    passed: result.ok, evidence: result.evidence
                });
            }), succeeded: result => object(result).passed === true
        }
    ];
}

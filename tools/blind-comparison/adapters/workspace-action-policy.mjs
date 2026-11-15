import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, hash } from '../protocol.mjs';
import { sha256Text, sha256Bytes } from '../../sealed-eval/harness/lib/util.mjs';
import { containedFile } from './native-contract.mjs';
export const PUBLIC_WORKSPACE_CAPABILITIES = Object.freeze({
    'filesystem.read': 'filesystem.read', 'filesystem.write': 'filesystem.write', 'workspace.check': 'workspace.check', 'workspace.read': 'filesystem.read', 'workspace.write': 'filesystem.write', 'public.check': 'workspace.check'
});
export const workspaceCapabilityId = name => PUBLIC_WORKSPACE_CAPABILITIES[name];
export async function publicWorkspaceActionPolicy(input, contract) {
    const files = Object.fromEntries(input.steps.flatMap(step => Object.entries(step.files)));
    const checks = [];
    for (const check of contract.publicChecks) {
        const [command, ...argv] = check.argv, executable = command === '{node}' ? process.execPath : command;
        if (!path.isAbsolute(executable))
            throw Error('Public workspace checks require an exact executable');
        checks.push({
            executable, executableSha256: sha256Bytes(await readFile(executable)), argv, cwd: '.'
        });
    }
    return {
        schema: 'scce.workspace.action-policy.v1', capabilityIds: [
            ...new Set(contract.toolPolicy.tools.map(workspaceCapabilityId))
        ],
        readablePaths: [
            ...new Set([
                ...Object.keys(files), ...contract.writablePaths
            ])
        ], writablePaths: contract.writablePaths.slice(),
        protectedFiles: Object.entries(files).filter(([name]) => !contract.writablePaths.includes(name)).map(([name, content]) => ({
            path: name, sha256: sha256Text(content)
        })), checks,
        maxFileBytes: input.budgets.artifactBytes, maxWorkspaceFiles: new Set([
            ...Object.keys(files), ...contract.writablePaths
        ]).size,
        maxWorkspaceBytes: input.budgets.artifactBytes, timeoutMs: input.budgets.timeMs, maxOutputBytes: input.budgets.outputBytes, maxCalls: contract.toolPolicy.maxCalls
    };
}
export function publicWorkspacePolicyId(policy) {
    return `workspace_action_${hash(policy)}`;
}
export async function workspaceActionApprovalAllowed({ pending, context, policy, cwd }) {
    if (!pending || !policy.capabilityIds.includes(pending.capabilityId) || !pending.approvalScope || pending.approvalScope.inputRef !== hash(pending.input))
        return false;
    const payload = pending.input;
    if (!payload || canonical(payload.workspaceContext) !== canonical(context))
        return false;
    if (pending.capabilityId === 'filesystem.write') {
        if (Object.keys(payload).some(key => ![
            'workspaceContext', 'path', 'content', 'expectedContentHash'
        ].includes(key)) || !policy.writablePaths.includes(payload.path) || typeof payload.content !== 'string' || Buffer.byteLength(payload.content) > policy.maxFileBytes)
            return false;
        let current = null;
        try {
            current = `sha256_${sha256Bytes(await readFile(await containedFile(cwd, payload.path)))}`;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return false;
        }
        return current === payload.expectedContentHash;
    }
    return pending.capabilityId === 'workspace.check' && Object.keys(payload).every(key => [
        'workspaceContext', 'index'
    ].includes(key)) && Number.isSafeInteger(payload.index) && payload.index >= 0 && Boolean(policy.checks[payload.index]);
}

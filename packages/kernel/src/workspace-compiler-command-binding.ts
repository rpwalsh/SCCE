// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { hashPatchContent } from "./patch-transaction.js";
export type CompilerCommandWitness = {
    readonly kind: "source_declaration";
} | {
    readonly kind: "executed_owner_policy";
    readonly schema: "scce.workspace.executed_compiler_command.v1";
    readonly policyId: string;
    readonly policyHash: string;
    readonly providerId: string;
    readonly commandIndex: number;
    readonly executionHash: string;
    readonly toolIdentityHash: string;
    readonly commandHash: string;
    readonly workspaceManifestHash: string;
    readonly configPath: string;
    readonly configContentHash: string;
    readonly compilerVersion: string;
};
export interface CompilerCommandBinding {
    readonly identity: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    /** Exact declaration artifact for a declaration witness; exact config artifact for an execution witness. */
    readonly sourcePath: string;
    readonly sourceContentHash: string;
    readonly sourceSelector: string;
    readonly rawCommandHash: string;
    readonly witness?: CompilerCommandWitness;
}
export function compilerWorkspaceManifestHash(files: readonly {
    path: string;
    contentHash: string;
}[]): string {
    return hashPatchContent(canonicalStringify(files.map(file => ({
        path: file.path, contentHash: canonicalHash(file.contentHash)
    }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
export function compilerCommandWitnessHash(witness: CompilerCommandWitness): string {
    return hashPatchContent(canonicalStringify(witness));
}
export function assertExecutedCompilerWitness(witness: CompilerCommandWitness, input: {
    files: readonly {
        path: string;
        contentHash: string;
    }[];
    configPath: string;
    configContentHash: string;
    compilerVersion: string;
}): void {
    if (witness.kind !== "executed_owner_policy" || witness.schema !== "scce.workspace.executed_compiler_command.v1"
        || !witness.policyId || !witness.providerId || !Number.isSafeInteger(witness.commandIndex) || witness.commandIndex < 0
        || witness.configPath !== input.configPath || canonicalHash(witness.configContentHash) !== canonicalHash(input.configContentHash)
        || witness.compilerVersion !== input.compilerVersion || witness.workspaceManifestHash !== compilerWorkspaceManifestHash(input.files)) {
        throw new Error("executed compiler witness does not bind the exact workspace/config/compiler revision");
    }
    for (const hash of [
        witness.policyHash, witness.executionHash, witness.toolIdentityHash, witness.commandHash, witness.workspaceManifestHash
    ])
        canonicalHash(hash);
}
function canonicalHash(value: string): string {
    const match = /^sha256[:_]([0-9a-f]{64})$/u.exec(value);
    if (!match)
        throw new Error("compiler witness requires a canonical SHA-256 hash");
    return `sha256:${match[1]}`;
}

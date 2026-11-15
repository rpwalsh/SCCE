// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { canonicalStringify, hashPatchContent, type CompilerCommandWitness } from "@scce/kernel";
import type { StructuredPatchValidationPolicy, StructuredWorkspaceValidationEvidence } from "./structured-patch-validation.js";
import { isTrustedHostValidationCommandReceipt } from "./structured-patch-validation.js";
import type { TypeScriptObservedCompilerCommand } from "./typescript-code-actions.js";
export interface ExecutedTypeScriptCompilerObservation {
    readonly command: TypeScriptObservedCompilerCommand;
    readonly witness: Extract<CompilerCommandWitness, {
        kind: "executed_owner_policy";
    }>;
}
interface Candidate {
    index: number;
    args: string[];
    configPath: string;
    cwd: string;
    toolIdentityHash: string;
    policyHash: string;
}
const measured = new WeakSet<object>();
const require = createRequire(import.meta.url);
const key = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
/** Presentation/emission-only flags do not change the semantic compiler. Semantic overrides require another index input. */
export function semanticCompilerProjectArgs(args: readonly string[]): string[] | undefined {
    const parsed = ts.parseCommandLine([
        ...args
    ]);
    if (parsed.errors.length || parsed.fileNames.length)
        return undefined;
    // The index currently consumes tsconfig semantics. These two CLI options only control display/emission.
    if (Object.keys(parsed.options).some(name => ![
        "project", "pretty", "noEmit"
    ].includes(name)))
        return undefined;
    return [
        "-p", parsed.options.project ?? "tsconfig.json"
    ];
}
async function toolIdentity(): Promise<{
    entry: string;
    launcher: string;
    hash: string;
}> {
    const entry = await realpath(require.resolve("typescript/bin/tsc")), launcher = await realpath(process.execPath);
    const library = require.resolve("typescript"), files = [
        entry, launcher, library, path.join(path.dirname(library), "tsc.js")
    ];
    try {
        await readFile(path.join(path.dirname(library), "_tsc.js"));
        files.push(path.join(path.dirname(library), "_tsc.js"));
    }
    catch {
    }
    const identities = await Promise.all(files.map(async (name) => ({
        path: await realpath(name), contentHash: hashPatchContent(await readFile(name))
    })));
    return {
        entry, launcher, hash: hashPatchContent(canonicalStringify({
            compilerVersion: ts.version, files: identities
        }))
    };
}
/** Measured before and after the already-authorized command; no command is invented or executed here. */
export async function prepareTypeScriptCompilerObservations(root: string, policy: StructuredPatchValidationPolicy): Promise<readonly Candidate[]> {
    if (!policy.commands.some(command => key(path.resolve(command.executable)) === key(path.resolve(process.execPath))))
        return [];
    const identity = await toolIdentity(), candidates: Candidate[] = [];
    const nodeOptions = policy.environment?.NODE_OPTIONS;
    if (nodeOptions && nodeOptions.split(/\s+/u).some(flag => !/^--max-(?:old-space|semi-space)-size=\d+$/u.test(flag)))
        return [];
    for (const [index, command] of policy.commands.entries()) {
        if (!command.checkIds?.some(check => check === "compiler" || check === "typecheck") || !command.argv[0])
            continue;
        try {
            if (key(await realpath(command.executable)) !== key(identity.launcher)
                || key(await realpath(command.argv[0])) !== key(identity.entry))
                continue;
            const args = semanticCompilerProjectArgs(command.argv.slice(1));
            if (!args)
                continue;
            const cwd = command.cwd ?? ".", absolute = path.resolve(root, cwd, args[1]!);
            let configPath = path.relative(root, absolute).split(path.sep).join("/");
            if (configPath === ".." || configPath.startsWith("../") || path.isAbsolute(configPath))
                continue;
            if (!configPath.endsWith(".json"))
                configPath = path.posix.join(configPath, "tsconfig.json");
            candidates.push({
                index, args, configPath, cwd, toolIdentityHash: identity.hash, policyHash: hashPatchContent(canonicalStringify(policy))
            });
        }
        catch {
        }
    }
    return candidates;
}
export async function finishTypeScriptCompilerObservations(root: string, policy: StructuredPatchValidationPolicy, evidence: StructuredWorkspaceValidationEvidence, before: readonly Candidate[]): Promise<readonly ExecutedTypeScriptCompilerObservation[]> {
    if (evidence.execution.verificationLevel !== "local-process-executed" || evidence.execution.boundary !== "trusted-host" || evidence.execution.providerId !== "trusted-host-process.v1")
        return [];
    const identity = await toolIdentity(), observations: ExecutedTypeScriptCompilerObservation[] = [];
    for (const candidate of before) {
        const receipt = evidence.commands.find(command => command.index === candidate.index), declared = policy.commands[candidate.index];
        if (!receipt || !declared || !isTrustedHostValidationCommandReceipt(receipt) || candidate.policyHash !== hashPatchContent(canonicalStringify(policy)) || candidate.toolIdentityHash !== identity.hash || receipt.timedOut || receipt.outputLimitExceeded || receipt.code === null
            || receipt.executable !== declared.executable || canonicalStringify(receipt.argv) !== canonicalStringify(declared.argv) || receipt.cwd !== candidate.cwd)
            continue;
        const configContentHash = hashPatchContent(await readFile(path.resolve(root, candidate.configPath)));
        const commandHash = hashPatchContent(canonicalStringify({
            executable: receipt.executable, argv: receipt.argv, cwd: receipt.cwd
        }));
        const witness: ExecutedTypeScriptCompilerObservation["witness"] = {
            kind: "executed_owner_policy", schema: "scce.workspace.executed_compiler_command.v1", policyId: policy.id,
            policyHash: candidate.policyHash, providerId: evidence.execution.providerId, commandIndex: candidate.index,
            executionHash: hashPatchContent(canonicalStringify(evidence)), toolIdentityHash: identity.hash, commandHash, workspaceManifestHash: evidence.workspaceManifestHash,
            configPath: candidate.configPath, configContentHash, compilerVersion: ts.version
        };
        const command: TypeScriptObservedCompilerCommand = {
            executable: "tsc", args: Object.freeze([
                ...candidate.args
            ]), cwd: candidate.cwd, sourcePath: candidate.configPath, witness
        };
        Object.freeze(witness);
        Object.freeze(command);
        const observation = Object.freeze({
            command, witness
        });
        measured.add(observation);
        observations.push(observation);
    }
    return Object.freeze(observations);
}
export function isMeasuredTypeScriptCompilerObservation(value: ExecutedTypeScriptCompilerObservation): boolean {
    return measured.has(value);
}

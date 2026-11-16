// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify, codeLanguageForPath, createHasher, createRepoSnapshot, createSourceRepositoryFacts, readWorkspaceOwnedProgramContracts, type InformationAccessContext, type ProgramDiagnostic, type RepoSnapshot, type ScceStorage } from "@scce/kernel";
import { extractNodeSourceCodeFacts } from "./code-graph.js";
import { codeMouthVerificationReceipt, runCodeMouth, type CodeMouthResult } from "./code-mouth.js";
import { createLearnedCodeProposer } from "./learned-code-proposer.js";
import { createWorkspaceCodeMouthPorts, verifyWorkspaceApplication, type WorkspaceApplicationVerification, type WorkspaceCodeMouthOptions } from "./workspace-code-mouth-ports.js";
import { validateStructuredPatchValidationPolicy } from "./structured-patch-validation.js";
import { workspaceTestSubjects, testSubjectsAtDiagnostic, type WorkspaceTestSubject } from "./workspace-test-subject-localization.js";
export interface WorkspaceCodeCommandInput {
    storage: ScceStorage;
    workspaceRoot: string;
    targetPath?: string;
    request: string;
    maxAttempts: number;
    projectValidation?: WorkspaceCodeMouthOptions["projectValidation"];
    informationAccess?: InformationAccessContext;
    log?: (message: string) => void;
}
export interface PreparedWorkspaceCodeCommand {
    mode: "explicit" | "project";
    workspaceRoot: string;
    targetPath?: string;
    scope?: {
        schema: "scce.workspace.code-scope.v1";
        workspaceId: string;
        expectedWorkspaceUpdatedAt: number;
        manifestHash: string;
        graphHash: string;
        policyHash: string;
        maxAttempts: number;
        writablePaths: string[];
        testSubjectHash?: string;
    };
    files?: Array<{
        path: string;
        contentHash: string;
        sourceVersionId: string | null;
        bytes: Uint8Array;
    }>;
    graph?: RepoSnapshot;
    testSubjects?: readonly WorkspaceTestSubject[];
}
export interface WorkspaceCodeLocalization {
    schema: "scce.workspace.code-localization.v1";
    mode: PreparedWorkspaceCodeCommand["mode"];
    status: "selected" | "unresolved" | "already_valid";
    reasonId: string;
    selectionBasis?: "observed_diagnostic_and_canonical_file_graph" | "owner_explicit_path" | "observed_assertion_and_owned_callable";
    subjectBindings?: readonly { readonly diagnosticId: string; readonly subject: WorkspaceTestSubject }[];
    targetPath?: string;
    scope?: PreparedWorkspaceCodeCommand["scope"];
    candidates: Array<{
        path: string;
        contentHash: string;
        diagnosticIds: string[];
    }>;
    unmappedDiagnosticIds: string[];
}
const hasher = createHasher();
const normalized = (name: string) => name.split(path.sep).join("/");
const pathKey = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
function relative(root: string, target: string) {
    const name = normalized(path.relative(root, path.resolve(root, target)));
    if (!name || name === ".." || name.startsWith("../") || path.isAbsolute(name))
        throw Error("code target escapes workspace");
    return name;
}
function bytesHash(bytes: Uint8Array) {
    return `sha256_${hasher.digestHex(bytes)}`;
}
export async function prepareWorkspaceCodeCommand(input: WorkspaceCodeCommandInput): Promise<PreparedWorkspaceCodeCommand> {
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)
        throw new RangeError("maxAttempts must be a positive safe integer");
    if (input.projectValidation) {
        validateStructuredPatchValidationPolicy(input.projectValidation.policy);
        if (!input.projectValidation.policy.commands.some(command => command.checkIds?.some(check => check === "compiler" || check === "typecheck")))
            throw new Error("workspace code validation requires a compiler or typecheck command");
    }
    const root = await realpath(input.workspaceRoot);
    if (input.targetPath !== undefined)
        return {
            mode: "explicit", workspaceRoot: root, targetPath: relative(root, input.targetPath)
        };
    if (!input.projectValidation)
        throw Error("automatic localization requires an owner-declared project validation policy");
    const workspace = await input.storage.workspace.latestWorkspace();
    if (!workspace || pathKey(await realpath(workspace.rootPath)) !== pathKey(root))
        throw Error("automatic localization requires the current canonical workspace");
    const owned = await readWorkspaceOwnedProgramContracts({
        storage: input.storage, context: {
            schema: "scce.workspace.program-context.v1", workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt
        }, informationAccess: input.informationAccess
    });
    if (owned.status !== "available")
        throw Error(`automatic localization source ownership unavailable: ${owned.reasonId}`);
    const ownedSourceVersions = new Set(owned.sourceVersionIds);
    const versionsByEvidenceId = new Map<string, Set<string>>();
    for (const span of owned.evidence) {
        const id = String(span.id), versions = versionsByEvidenceId.get(id) ?? new Set<string>();
        versions.add(String(span.sourceVersionId));
        versionsByEvidenceId.set(id, versions);
    }
    const policy = input.projectValidation.policy, records = await input.storage.workspace.listSourceFiles({
        workspaceId: workspace.id, limit: policy.maxWorkspaceFiles + 1
    });
    if (!records.length || records.length > policy.maxWorkspaceFiles)
        throw Error("canonical workspace file scope exceeds the declared validation bound");
    const files: NonNullable<PreparedWorkspaceCodeCommand["files"]> = [], facts: Array<NonNullable<ReturnType<typeof extractNodeSourceCodeFacts>>> = [];
    let total = 0;
    for (const record of records.sort((a, b) => a.path.localeCompare(b.path))) {
        if (![
            "ingested", "skipped"
        ].includes(record.ingestionStatus) || !record.contentHash)
            throw Error(`canonical workspace source is unavailable: ${record.path}`);
        const name = relative(root, record.path), absolute = path.resolve(root, name), stat = await lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || pathKey(await realpath(absolute)) !== pathKey(absolute) || stat.size !== record.byteLength || stat.size > policy.maxWorkspaceBytes)
            throw Error(`canonical workspace file identity changed: ${name}`);
        total += stat.size;
        if (total > policy.maxWorkspaceBytes)
            throw Error("canonical workspace byte scope exceeds the declared validation bound");
        const bytes = await input.storage.blobs.get(record.contentHash);
        if (bytesHash(bytes) !== record.contentHash || bytes.length !== record.byteLength || bytesHash(await readFile(absolute)) !== record.contentHash)
            throw Error(`stale canonical workspace bytes: ${name}`);
        const ownerVersions = [...new Set(record.evidenceIds.flatMap(id => [...versionsByEvidenceId.get(String(id)) ?? []]))];
        const sourceVersionId = record.sourceVersionId ? String(record.sourceVersionId) : ownerVersions.length === 1 ? ownerVersions[0]! : null;
        files.push({ path: name, contentHash: String(record.contentHash), sourceVersionId, bytes });
        if (codeLanguageForPath(name) && sourceVersionId && ownedSourceVersions.has(sourceVersionId)) {
            const fact = extractNodeSourceCodeFacts({
                absolutePath: absolute, uri: name, mediaType: record.mediaType, text: new TextDecoder("utf-8", {
                    fatal: true
                }).decode(bytes), sha256: hasher.digestHex(bytes), hasher
            });
            if (fact)
                facts.push(fact);
        }
    }
    const recordByPath = new Map(records.map(record => [record.path, record]));
    const factsByPath = new Map(facts.map(fact => [fact.normalizedPath, fact]));
    const repositoryFacts = createSourceRepositoryFacts({
        rootUri: workspace.rootUri, files: files.map(file => ({
            path: file.path, mediaType: recordByPath.get(file.path)!.mediaType, byteLength: file.bytes.length, contentHash: file.contentHash, facts: factsByPath.get(file.path)
        })), hasher
    });
    const graph = createRepoSnapshot({
        rootUri: workspace.rootUri, repositoryFacts, fileFacts: facts, hasher
    });
    const testCommandPaths = new Set(policy.commands.filter(command => command.checkIds?.includes("tests")).flatMap(command => command.argv.filter(arg => codeLanguageForPath(arg) !== undefined).flatMap(arg => {
        try {
            return [
                pathKey(relative(root, path.resolve(root, command.cwd ?? ".", arg)))
            ];
        }
        catch {
            return [];
        }
    })));
    const ownedPaths = new Set(files.filter(file => file.sourceVersionId && ownedSourceVersions.has(file.sourceVersionId)).map(file => pathKey(file.path)));
    const writablePaths = graph.files.filter(file => ownedPaths.has(pathKey(file.sourcePath)) && codeLanguageForPath(file.sourcePath) !== undefined && !file.roles.includes("source.role.test") && !testCommandPaths.has(pathKey(file.sourcePath))).map(file => file.sourcePath).sort();
    const testSubjects = workspaceTestSubjects({ files, contracts: owned.contracts });
    const manifestHash = hasher.digestHex(canonicalStringify(files.map(({ bytes, ...file }) => file))), provider = input.projectValidation.provider;
    const scope: NonNullable<PreparedWorkspaceCodeCommand["scope"]> = {
        schema: "scce.workspace.code-scope.v1", workspaceId: workspace.id, expectedWorkspaceUpdatedAt: workspace.updatedAt, manifestHash, graphHash: graph.rootHash, maxAttempts: input.maxAttempts, policyHash: hasher.digestHex(canonicalStringify({
            policy, provider: provider ? {
                id: provider.id, boundary: provider.boundary, approvalBinding: provider.approvalBinding
            } : null
        })), writablePaths, testSubjectHash: hasher.digestHex(canonicalStringify(testSubjects))
    };
    return {
        mode: "project", workspaceRoot: root, scope, files, graph, testSubjects
    };
}
/** Direct source locations and exact source-owned assertion subjects establish candidates; imports alone do not. */
export function localizeWorkspaceDiagnostics(prepared: PreparedWorkspaceCodeCommand, diagnostics: readonly ProgramDiagnostic[]): WorkspaceCodeLocalization {
    const candidates = new Map<string, WorkspaceCodeLocalization["candidates"][number]>(), unmappedDiagnosticIds: string[] = [];
    const subjectBindings: Array<{ diagnosticId: string; subject: WorkspaceTestSubject }> = [], subjectIds = new Set<string>();
    const unmatchedProtected: string[] = [];
    const byPath = new Map((prepared.files ?? []).map(file => [
        pathKey(file.path), file
    ])), writable = new Set(prepared.scope?.writablePaths.map(pathKey));
    for (const diagnostic of diagnostics) {
        if (!diagnostic.path || !Number.isSafeInteger(diagnostic.line) || Number(diagnostic.line) < 1) {
            unmappedDiagnosticIds.push(diagnostic.id);
            continue;
        }
        let name: string;
        try {
            name = relative(prepared.workspaceRoot, diagnostic.path);
        }
        catch {
            unmappedDiagnosticIds.push(diagnostic.id);
            continue;
        }
        const file = byPath.get(pathKey(name));
        if (!file) {
            unmappedDiagnosticIds.push(diagnostic.id);
            continue;
        }
        if (!writable.has(pathKey(name))) {
            const subjects = testSubjectsAtDiagnostic({ file, diagnostic, subjects: prepared.testSubjects ?? [] });
            const before = subjectBindings.length;
            for (const subject of subjects) {
                const target = byPath.get(pathKey(subject.targetPath));
                if (!target || !writable.has(pathKey(target.path)) || target.contentHash !== subject.targetHash || target.sourceVersionId !== subject.targetSourceVersionId) continue;
                subjectBindings.push({ diagnosticId: diagnostic.id, subject });
                subjectIds.add(canonicalStringify([subject.targetPath, subject.targetSourceVersionId, subject.targetSymbolId]));
                const candidate = candidates.get(target.path) ?? { path: target.path, contentHash: target.contentHash, diagnosticIds: [] };
                candidate.diagnosticIds.push(diagnostic.id); candidates.set(target.path, candidate);
            }
            if (subjectBindings.length === before) unmatchedProtected.push(diagnostic.id);
            continue;
        }
        const prior = candidates.get(file.path) ?? {
            path: file.path, contentHash: file.contentHash, diagnosticIds: []
        };
        prior.diagnosticIds.push(diagnostic.id);
        candidates.set(file.path, prior);
    }
    if (subjectBindings.length) unmappedDiagnosticIds.push(...unmatchedProtected);
    const rows = [
        ...candidates.values()
    ].sort((a, b) => a.path.localeCompare(b.path)), selected = rows.length === 1 && subjectIds.size <= 1 && unmappedDiagnosticIds.length === 0;
    return {
        schema: "scce.workspace.code-localization.v1", mode: prepared.mode, status: selected ? "selected" : "unresolved", reasonId: selected ? "workspace.code.observed_unique_source" : rows.length > 1 ? "workspace.code.ambiguous_sources" : subjectIds.size > 1 ? "workspace.code.ambiguous_subjects" : unmappedDiagnosticIds.length ? "workspace.code.unmapped_observation" : "workspace.code.source_target_unavailable", ...(selected ? {
            targetPath: rows[0]!.path, selectionBasis: subjectBindings.length ? "observed_assertion_and_owned_callable" as const : "observed_diagnostic_and_canonical_file_graph" as const
        } : {}), scope: prepared.scope, candidates: rows, unmappedDiagnosticIds, ...(subjectBindings.length ? { subjectBindings } : {})
    };
}
/** Both caller-selected and observed targets use the same initial observation and guarded repair loop. */
export async function runWorkspaceCodeCommand(input: WorkspaceCodeCommandInput & {
    prepared?: PreparedWorkspaceCodeCommand;
}) {
    const prepared = await prepareWorkspaceCodeCommand(input);
    if (input.prepared && canonicalStringify(input.prepared.scope ?? input.prepared.targetPath) !== canonicalStringify(prepared.scope ?? prepared.targetPath))
        throw Error("workspace code approval scope changed");
    const initialVerification = input.projectValidation ? await verifyWorkspaceApplication({
        workspaceRoot: prepared.workspaceRoot, projectValidation: input.projectValidation
    }, prepared.targetPath) : undefined;
    let localization: WorkspaceCodeLocalization = prepared.mode === "explicit" ? {
        schema: "scce.workspace.code-localization.v1", mode: "explicit", status: "selected", reasonId: "workspace.code.owner_target", targetPath: prepared.targetPath, selectionBasis: "owner_explicit_path", candidates: [], unmappedDiagnosticIds: []
    } : localizeWorkspaceDiagnostics(prepared, initialVerification?.diagnostics ?? []);
    if (prepared.mode === "project") {
        const current = await prepareWorkspaceCodeCommand(input);
        if (canonicalStringify(current.scope) !== canonicalStringify(prepared.scope))
            throw Error("workspace code source changed during initial validation");
        if (initialVerification?.buildSucceeded && initialVerification.testsSucceeded)
            localization = {
                ...localization, status: "already_valid", reasonId: "workspace.code.initial_checks_passed"
            };
    }
    const targetPath = localization.targetPath, learnedProposer = createLearnedCodeProposer({
        storage: input.storage, workspaceRoot: prepared.workspaceRoot, log: input.log
    });
    if (!targetPath) {
        const result: CodeMouthResult = {
            outcome: localization.status === "already_valid" ? "resolved" : "no_proposal", attempts: 0, finalDiagnostics: initialVerification?.diagnostics ?? [], appliedOperations: [], proposalSources: [], verification: codeMouthVerificationReceipt(initialVerification), reason: localization.reasonId
        };
        return {
            result, localization, initialVerification, projectVerification: initialVerification, targetPath: undefined, language: undefined, corpusAvailability: undefined, composed: learnedProposer.lastCandidates()
        };
    }
    const ports = createWorkspaceCodeMouthPorts({
        workspaceRoot: prepared.workspaceRoot, targetPath, learnedProposer, log: input.log, ...(input.projectValidation ? {
            projectValidation: input.projectValidation, initialVerification
        } : {})
    });
    const apply = ports.apply, expectedHashes = new Map(prepared.files?.map(file => [
        file.path, file.contentHash
    ]));
    ports.apply = async (operations) => {
        if (prepared.scope && operations.some(operation => !prepared.scope!.writablePaths.includes(relative(prepared.workspaceRoot, operation.path))))
            throw Error("repair operation escapes the approved canonical source graph");
        for (const [name, hash] of expectedHashes)
            if (bytesHash(await readFile(path.resolve(prepared.workspaceRoot, name))) !== hash)
                throw Error(`approved workspace code source changed: ${name}`);
        const previous = new Map(expectedHashes), rollback = await apply(operations);
        for (const operation of operations) {
            const name = relative(prepared.workspaceRoot, operation.path);
            if (expectedHashes.has(name))
                expectedHashes.set(name, bytesHash(await readFile(path.resolve(prepared.workspaceRoot, name))));
        }
        return async () => {
            await rollback();
            expectedHashes.clear();
            for (const [name, hash] of previous)
                expectedHashes.set(name, hash);
        };
    };
    const result = await runCodeMouth({
        request: input.request, targetPath, maxAttempts: input.maxAttempts, log: input.log, ports
    });
    return {
        result, localization, initialVerification, projectVerification: ports.projectVerification(), targetPath, language: codeLanguageForPath(targetPath), corpusAvailability: ports.corpusAvailability(), composed: learnedProposer.lastCandidates()
    };
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalStringify, codeTrainingSurface, CODE_SURFACE_RECIPE_ID, CORPUS_SOURCE_SYSTEM_IDS, createHasher, createClock, createIdFactory,
  toJsonValue, canonicalJsonByteLength, SOURCE_OWNED_CONTRACT_COMPILER_RECIPE,SOURCE_OWNED_PROJECT_CONTRACT_CLOSURE_SCHEMA, type EvidenceSpan, type InformationLabel, type JsonValue, type ScceStorage, type SourceVersion, type LanguagePatternProjection } from "@scce/kernel";
import { buildTypeScriptSemanticProgramIndex } from "./typescript-semantic-program-index.js";
import { compileSourceOwnedContracts, type OwnedContractSnapshotFile } from "./source-owned-contract-compiler.js";
import { sourceOwnedAssertionPatterns, SOURCE_OWNED_ASSERTION_FRAMEWORK_MODULES } from "./source-owned-test-contracts.js";
import { collectTypeScriptContractClosure, hasSourceOwnedTestImport, loadContractClosureFile, type ContractClosureBudget, type ContractClosureInventoryFile } from "./typescript-contract-closure.js";
import { SOURCE_OWNED_PROJECT_PROJECTION_PREFIX } from "./source-owned-project-projection.js";
import ts from "typescript";

export const OSS_CONTRACT_CLOSURE_RECIPE = `scce.oss_owned_project_closure.v1:${SOURCE_OWNED_CONTRACT_COMPILER_RECIPE}`;
export interface OssContractClosureReport {
  readonly reasonIds?:readonly string[];
  readonly recipe: string; readonly candidateCount: number; readonly nextCandidateIndex: number; readonly round: number;
  readonly complete: boolean; readonly incompleteInRound: number; readonly filesLoaded: number; readonly bytesLoaded: number;readonly publicationBytesPrepared:number;
  readonly sourceBytesLoaded?: number; readonly descriptorBytesLoaded?: number;
  readonly roots: readonly { readonly path: string; readonly status: "not_test" | "compiled" | "current" | "incomplete" | "deferred"; readonly reasons: readonly string[]; readonly contracts?: number; readonly digest?: string }[];
}
interface OwnedFile { readonly file: OwnedContractSnapshotFile; readonly original: SourceVersion; readonly source: SourceVersion; readonly evidence: readonly EvidenceSpan[] }
export const OSS_CONTRACT_CLOSURE_BOUNDS = { maxTotalBytes: 8 * 1024 * 1024, maxCandidates: 32 } as const;
const bounds = OSS_CONTRACT_CLOSURE_BOUNDS;

/** The same full native compilation qualifies planned bytes and verified canonical source closures. */
export async function qualifyOssProjectContext(input: {
  rootPath: string; testPath: string; configPath: string; files: readonly OwnedContractSnapshotFile[]; sourceUriBase: string;
  maxFileBytes: number; maxTotalBytes: number; maxFiles?: number;
}) {
  const program = await buildTypeScriptSemanticProgramIndex({ workspaceRoot: input.rootPath, tsconfigPath: input.configPath, compileOnlyBoundedFiles: true, preserveProjectReferences: true,
    bounds: { workspacePaths: input.files.map(file => file.path), observedTestPaths: [input.testPath], maxFiles: input.maxFiles ?? Math.max(1, input.files.length), maxFileBytes: input.maxFileBytes, maxTotalBytes: input.maxTotalBytes },
    sourceSnapshot: input.files.map(file => ({ path: file.path, bytes: file.bytes, contentHash: `sha256:${bareHash(file.sourceHash)}` })) });
  const frameworkImports = program.imports.filter(row => SOURCE_OWNED_ASSERTION_FRAMEWORK_MODULES.some(module => module === row.moduleSpecifierEvidence));
  const blocking = program.diagnostics.filter(diagnostic => diagnostic.compilerCategory === ts.DiagnosticCategory.Error && !(diagnostic.compilerCode === 2307 && diagnostic.span
    && frameworkImports.some(row => row.moduleSpecifierSpan.path === diagnostic.span!.path && diagnostic.span!.start >= row.moduleSpecifierSpan.start && diagnostic.span!.end <= row.moduleSpecifierSpan.end)));
  if (blocking.length || !program.files.some(file => file.path === input.testPath && file.compilerOwned && file.observedTest)) return {
    available: false as const, program, reasons: blocking.length ? blocking.map(diagnostic => `compiler_diagnostic:${diagnostic.compilerCode}`) : ["test_root_outside_project_config"]
  };
  const compiled = await compileSourceOwnedContracts({ root: input.rootPath, files: input.files, sourceUriBase: input.sourceUriBase, knownPaths: input.files.map(file => file.path), complete: true,
    maxFileBytes: input.maxFileBytes, maxTotalBytes: input.maxTotalBytes, semanticProgram: program });
  return { available: true as const, program, compiled, reasons: [] };
}

/** Continues a bounded canonical project component after ordinary source commits. */
export async function publishOssOwnedContractClosures(input: {
  readonly storage: ScceStorage; readonly root: string; readonly inventory: readonly ContractClosureInventoryFile[];
  readonly sourceUriBase: string; readonly snapshotHash: string; readonly snapshotComplete: boolean;
  readonly maxFileBytes: number; readonly informationLabel: InformationLabel;
  readonly priorityTestPaths?: readonly string[];
  readonly maxFiles?: number;
}): Promise<OssContractClosureReport> {
  const storage = input.storage, hasher = createHasher(), ids = createIdFactory({ clock: createClock(), hasher });
  const candidates = input.inventory.filter(file => /\.[cm]?[jt]sx?$/u.test(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  if(!storage.ingestion?.get||!storage.ingestion.put||!storage.evidence?.sourceVersionById||!storage.blobs?.get)return{recipe:OSS_CONTRACT_CLOSURE_RECIPE,reasonIds:["canonical_store_unavailable"],candidateCount:candidates.length,nextCandidateIndex:0,round:0,complete:false,incompleteInRound:Math.min(candidates.length,bounds.maxCandidates),
    filesLoaded:0,bytesLoaded:0,publicationBytesPrepared:0,roots:candidates.slice(0,bounds.maxCandidates).map(file=>({path:file.path,status:"incomplete",reasons:["canonical_store_unavailable"]}))};
  const identity = hasher.digestHex(canonicalStringify({ recipe: OSS_CONTRACT_CLOSURE_RECIPE, sourceUriBase: input.sourceUriBase, snapshotHash: input.snapshotHash,
    inventory: input.inventory.map(file => file.sourceUri ? [file.path, file.contentHash, file.byteLength, file.sourceUri, file.sourceSnapshotHash, file.sourceDependencyPaths]
      : [file.path, file.contentHash, file.byteLength]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }));
  const snapshotCheckpointId=`oss.contract.snapshot.${hasher.digestHex(input.sourceUriBase)}`;
  const snapshotMetadata=toJsonValue({schema:"scce.oss_owned_contract_snapshot.v1",snapshotHash:input.snapshotHash,complete:input.snapshotComplete,recipe:OSS_CONTRACT_CLOSURE_RECIPE,identity,informationLabel:input.informationLabel});
  const oldSnapshot=await storage.ingestion.get(snapshotCheckpointId);
  if(canonicalStringify(oldSnapshot?.metadata)!==canonicalStringify(snapshotMetadata))await storage.ingestion.put({id:snapshotCheckpointId,rootUri:input.sourceUriBase,itemUri:"@source-owned-project-snapshot",phase:input.snapshotComplete?"stored":"extracting",status:input.snapshotComplete?"complete":"pending",offsetBytes:0,updatedAt:Date.now(),metadata:snapshotMetadata});
  const checkpointId = `oss.contract.closure.${identity}`, checkpoint = await storage.ingestion.get(checkpointId);
  const previous = object(checkpoint?.metadata);
  let cursor = typeof previous.nextCandidateIndex === "number" && Number.isSafeInteger(previous.nextCandidateIndex) && previous.nextCandidateIndex >= 0 && previous.nextCandidateIndex < candidates.length ? previous.nextCandidateIndex : 0;
  let round = typeof previous.round === "number" && Number.isSafeInteger(previous.round) && previous.round >= 0 ? previous.round : 0;
  let incomplete = cursor > 0 && typeof previous.incompleteInRound === "number" && Number.isSafeInteger(previous.incompleteInRound) && previous.incompleteInRound >= 0 ? previous.incompleteInRound : 0;
  const roots: Array<OssContractClosureReport["roots"][number]> = [], owners = new Map<string, OwnedFile>();
  const priorityPaths = new Set(input.priorityTestPaths ?? []);
  const priority = candidates.filter(file => priorityPaths.has(file.path));
  const visited = new Set<string>();
  let publicationBytesPrepared=0;
  const chargePublication=(value:unknown)=>{const bytes=canonicalJsonByteLength(value,bounds.maxTotalBytes-publicationBytesPrepared);if(bytes>bounds.maxTotalBytes-publicationBytesPrepared)throw new Error("max_publication_bytes");publicationBytesPrepared+=bytes;};
  const maxFiles = input.maxFiles ?? Math.max(1, input.inventory.length);
  const budget: ContractClosureBudget = { ...bounds, maxFiles, maxFileBytes: input.maxFileBytes, files: new Map(), usedBytes: 0 };
  const inventory = new Map(input.inventory.map(file => [file.path, file]));
  const load = async (name: string): Promise<OwnedContractSnapshotFile | undefined> => {
    const existing = owners.get(name); if (existing) return existing.file;
    const row = inventory.get(name); if (!row?.contentHash || row.byteLength > input.maxFileBytes || !storage.evidence.sourceVersionById) return undefined;
    const uri = row.sourceUri ?? `${input.sourceUriBase}#path=${encodeURIComponent(name)}`, namespace = `corpus:${CORPUS_SOURCE_SYSTEM_IDS.ossCode}`, sourceId = ids.sourceId(namespace, uri);
    const contentHash = `sha256_${bareHash(row.contentHash)}` as SourceVersion["contentHash"];
    const originalId = ids.sourceVersionId(canonicalStringify({ contract: "scce.corpus-source-version.v1", sourceId, contentHash, role: "original" }));
    const original = await storage.evidence.sourceVersionById(originalId);
    if (!original || original.role !== "original" || original.sourceId !== sourceId || original.namespace !== namespace || original.canonicalUri !== uri
      || original.contentHash !== contentHash || original.byteLength !== row.byteLength || canonicalStringify(original.informationLabel) !== canonicalStringify(input.informationLabel)) return undefined;
    const bytes = await storage.blobs.get(original.contentHash);
    if (bytes.byteLength !== row.byteLength || createHash("sha256").update(bytes).digest("hex") !== bareHash(row.contentHash)
      || !Buffer.from(Buffer.from(bytes).toString("utf8"), "utf8").equals(Buffer.from(bytes))) return undefined;
    const projected = codeTrainingSurface(Buffer.from(bytes).toString("utf8"));
    const sourceVersionId = ids.sourceVersionId(canonicalStringify({ contract: "scce.oss-projection-source-version.v1", sourceUri: uri, sourceHash: row.contentHash,
      transformId: `${CODE_SURFACE_RECIPE_ID}:code_surface_tokens`, projectedTextHash: hasher.digestHex(projected) }));
    const source = await storage.evidence.sourceVersionById(sourceVersionId);
    if (!source || source.sourceId !== sourceId || source.namespace !== namespace || source.canonicalUri !== uri || source.role !== "evidence-derivative"
      || source.derivation?.derivedFromSourceVersionId !== originalId || source.derivation.transformId !== `${CODE_SURFACE_RECIPE_ID}:code_surface_tokens`
      || source.contentHash !== `sha256_${hasher.digestHex(projected.replace(/\u0000/g, " ").normalize("NFC"))}`
      || canonicalStringify(source.informationLabel) !== canonicalStringify(input.informationLabel)) return undefined;
    const evidence = (await storage.evidence.searchEvidence({ sourceVersionId, status: "promoted", limit: 1 })).map(result => result.span)
      .filter(span => span.sourceVersionId === sourceVersionId && span.sourceId === sourceId && span.status === "promoted" && canonicalStringify(span.informationLabel) === canonicalStringify(input.informationLabel));
    if (!evidence.length) return undefined;
    const file: OwnedContractSnapshotFile = { path: name, bytes, sourceHash: row.contentHash, sourceVersionId: String(sourceVersionId) };
    owners.set(name, { file, original, source, evidence }); return file;
  };
  const invalidateRoot = async (name: string, existingOnly = false, forcePending = false) => {
          const rootOwner = owners.get(name)!;
          const rootCheckpointId = `oss.contract.root.${hasher.digestHex(canonicalStringify([input.sourceUriBase, name]))}`;
          const rootRecipe = `${SOURCE_OWNED_PROJECT_PROJECTION_PREFIX}${hasher.digestHex(String(rootOwner.source.sourceId))}`;
          const oldHead = await storage.ingestion.get(rootCheckpointId), oldHeadMetadata = object(oldHead?.metadata);
          if (existingOnly && !oldHead) return;
          if (forcePending && oldHead?.status === "complete" || oldHeadMetadata.sourceVersionId !== rootOwner.source.sourceVersionId || oldHeadMetadata.snapshotHash !== input.snapshotHash || oldHeadMetadata.closureRecipe !== OSS_CONTRACT_CLOSURE_RECIPE) {
            const pendingDigest = hasher.digestHex(canonicalStringify([identity, rootOwner.source.sourceVersionId, "pending"]));
            const root = { checkpointId: rootCheckpointId, sourceId: rootOwner.source.sourceId, sourceVersionId: rootOwner.source.sourceVersionId, inputDigest: pendingDigest,snapshotCheckpointId,snapshotHash:input.snapshotHash,scopeIdentity:identity };
            await storage.transaction(async () => {
              if (!await ownerCurrent(storage, rootOwner)) throw new Error("OSS test owner changed before withdrawing its old component");
              const profile = await profileForOwner(storage, rootOwner, input.informationLabel);
              await storage.ingestion.put({ id: rootCheckpointId, rootUri: input.sourceUriBase, itemUri: `@source-owned-test-root/${name}`, status: "pending", phase: "extracting", offsetBytes: 0, updatedAt: Date.now(),
                metadata: toJsonValue({ schema: "scce.oss_owned_contract_root.v1", inputDigest: pendingDigest, sourceId: root.sourceId, sourceVersionId: root.sourceVersionId,
                  componentRecipe: rootRecipe, closureRecipe: OSS_CONTRACT_CLOSURE_RECIPE, snapshotCheckpointId,snapshotHash: input.snapshotHash,scopeIdentity:identity, informationLabel: input.informationLabel }) });
              if (!storage.languageMemory.replaceLanguagePatternProjection) throw new Error("OSS contracts require canonical projection publication");
              const withdrawal={ projection: { ...scopeFor(rootOwner, profile.id, [rootOwner], rootRecipe, root, input.informationLabel), patternIds: [] }, patterns: [] };
              chargePublication(withdrawal);await storage.languageMemory.replaceLanguagePatternProjection(withdrawal);
            });
          }
  };
  let wrapped = candidates.length === 0, attempted = 0;
  while (attempted < bounds.maxCandidates && !wrapped) {
    while (!wrapped && visited.has(candidates[cursor]!.path)) {
      cursor++; if (cursor >= candidates.length) { cursor = 0; wrapped = true; }
    }
    if (wrapped) break;
    const candidate = priority.find(file => !visited.has(file.path)) ?? candidates[cursor]!, beforeBytes = budget.usedBytes;
    let entry: OssContractClosureReport["roots"][number];
    try {
    if (!input.snapshotComplete) entry = { path: candidate.path, status: "incomplete", reasons: ["repository_inventory_incomplete"] };
    else if (candidate.byteLength > input.maxFileBytes) entry = { path: candidate.path, status: "incomplete", reasons: ["max_file_bytes"] };
    else if (!budget.files.has(candidate.path) && (budget.files.size >= maxFiles || budget.usedBytes + candidate.byteLength > bounds.maxTotalBytes)) {
      roots.push({ path: candidate.path, status: "deferred", reasons: ["workunit_budget_exhausted"] }); break;
    } else {
      const admission = await loadContractClosureFile({ row: candidate, budget, load, discard: name => { owners.delete(name); } });
      const file = admission.file;
      if (!file) entry = { path: candidate.path, status: "incomplete", reasons: [admission.reason ?? "canonical_owner_unavailable"] };
      else {
        if (!hasSourceOwnedTestImport(Buffer.from(file.bytes).toString("utf8"), candidate.path)) {
          await invalidateRoot(candidate.path, true); entry = { path: candidate.path, status: "not_test", reasons: [] };
        }
        else {
          await invalidateRoot(candidate.path);
          const rootCheckpointId = `oss.contract.root.${hasher.digestHex(canonicalStringify([input.sourceUriBase, candidate.path]))}`;
          const closure = await collectTypeScriptContractClosure({ root: input.root, testPath: candidate.path, inventory: input.inventory, budget, load, discard: name => { owners.delete(name); } });
          if (!closure.complete || !closure.configPath) {
            if(closure.reasons.some(reason=>reason.startsWith("canonical_owner_unavailable:")))await invalidateRoot(candidate.path,false,true);
            const deferred = beforeBytes > 0 && closure.reasons.some(reason => reason.startsWith("max_files:") || reason.startsWith("max_total_bytes:"));
            entry = { path: candidate.path, status: deferred ? "deferred" : "incomplete", reasons: closure.reasons };
            if (deferred) { roots.push(entry); break; }
          } else {
            const files = closure.files;
            const qualified = await qualifyOssProjectContext({ rootPath: input.root, testPath: candidate.path, configPath: closure.configPath, files, sourceUriBase: input.sourceUriBase,
              maxFileBytes: input.maxFileBytes, maxTotalBytes: bounds.maxTotalBytes, maxFiles });
            if (!qualified.available) { await invalidateRoot(candidate.path,false,true); entry = { path: candidate.path, status: "incomplete", reasons: qualified.reasons }; }
            else {
              const { compiled, program } = qualified;
              const dependencies = files.map(file => owners.get(file.path)!);
              const dependencyReceipt = dependencies.map(owner => ({ path: owner.file.path, sourceHash: owner.file.sourceHash, originalSourceVersionId: owner.original.sourceVersionId,
                sourceId: owner.source.sourceId, sourceVersionId: owner.source.sourceVersionId, evidenceIds: owner.evidence.map(span => span.id), informationLabel: owner.source.informationLabel }));
              const digest = hasher.digestHex(canonicalStringify({ identity, testPath: candidate.path, configPath: closure.configPath, compiler: program.config, dependencies: dependencyReceipt }));
              const testOwner = owners.get(candidate.path)!;
              const componentRecipe = `${SOURCE_OWNED_PROJECT_PROJECTION_PREFIX}${hasher.digestHex(String(testOwner.source.sourceId))}`;
              const sourceContractRoot = { checkpointId: rootCheckpointId, sourceId: testOwner.source.sourceId, sourceVersionId: testOwner.source.sourceVersionId, inputDigest: digest,snapshotCheckpointId,snapshotHash:input.snapshotHash,scopeIdentity:identity };
              const targetPaths = new Set([candidate.path, ...compiled.keys(), ...program.testRelations.flatMap(row => {
                const file = program.files.find(file => file.id === row.targetFileId); return file ? [file.path] : [];
              })]);
              let contracts = 0, changed = false;
              await storage.transaction(async () => {
                for (const owner of dependencies) if (!await ownerCurrent(storage, owner)) throw new Error("OSS contract closure owner changed before publication");
                const rootMetadata = toJsonValue({ schema: "scce.oss_owned_contract_root.v1", inputDigest: digest, sourceId: testOwner.source.sourceId, sourceVersionId: testOwner.source.sourceVersionId, componentRecipe,
                  snapshotCheckpointId,snapshotHash: input.snapshotHash,scopeIdentity:identity, closureRecipe: OSS_CONTRACT_CLOSURE_RECIPE, informationLabel: input.informationLabel });
                const oldRoot = await storage.ingestion.get(rootCheckpointId);
                if (canonicalStringify(oldRoot?.metadata) !== canonicalStringify(rootMetadata)) await storage.ingestion.put({ id: rootCheckpointId, rootUri: input.sourceUriBase, itemUri: `@source-owned-test-root/${candidate.path}`,
                  status: "complete", phase: "stored", offsetBytes: 0, updatedAt: Date.now(), metadata: rootMetadata });
                for (const sourcePath of [...targetPaths].sort()) {
                  const values = compiled.get(sourcePath) ?? [];
                  const owner = owners.get(sourcePath); if (!owner) continue;
                  const profile = await profileForOwner(storage, owner, input.informationLabel), material = toJsonValue(values.map(value => ({ ...object(value), componentRecipe, sourceContractClosure: { schema:SOURCE_OWNED_PROJECT_CONTRACT_CLOSURE_SCHEMA,recipe: OSS_CONTRACT_CLOSURE_RECIPE, digest, testPath: candidate.path,testSourceId:testOwner.source.sourceId,testSourceVersionId:testOwner.source.sourceVersionId,testHash:testOwner.file.sourceHash,
                    configPath: closure.configPath,configHash:program.config.compilerOptionsHash,compilerVersion:program.config.compilerVersion, rootCheckpointId,snapshotCheckpointId,snapshotHash:input.snapshotHash,scopeIdentity:identity } })));
                  const patterns = sourceOwnedAssertionPatterns({ contracts: material, metadata: toJsonValue({ sourceHash: owner.file.sourceHash }), sourceSystem: "oss_code", profileId: profile.id,
                    sourceVersionId: owner.source.sourceVersionId, originalSourceVersionId: owner.original.sourceVersionId, evidence: owner.evidence, hasher, updatedAt: Date.now() }).map(pattern => ({ ...pattern, informationLabel: input.informationLabel }));
                  const projection = scopeFor(owner, profile.id, dependencies, componentRecipe, sourceContractRoot, input.informationLabel);
                  chargePublication({patterns,projection});
                  const active = await storage.languageMemory.getLanguagePatternProjection?.(projection);
                  if (canonicalStringify(active?.patternIds) !== canonicalStringify(patterns.map(pattern => pattern.id).sort()) || canonicalStringify(active?.sourceDependencies) !== canonicalStringify(projection.sourceDependencies)
                    || canonicalStringify(active?.sourceContractRoot) !== canonicalStringify(sourceContractRoot)) {
                    if (!storage.languageMemory.replaceLanguagePatternProjection) throw new Error("OSS contracts require canonical projection publication");
                    await storage.languageMemory.replaceLanguagePatternProjection({ projection: { ...projection, patternIds: patterns.map(pattern => pattern.id).sort() }, patterns }); changed = true;
                  }
                  contracts += values.length;
                }
              });
              entry = { path: candidate.path, status: changed ? "compiled" : "current", reasons: [], contracts, digest };
            }
          }
        }
      }
    }
    } catch (error) { entry = {path:candidate.path,status:"incomplete",reasons:[`compilation_or_publication_failed:${error instanceof Error ? error.message : String(error)}`]}; }
    roots.push(entry); if (entry.status === "incomplete") incomplete++;
    visited.add(candidate.path); attempted++;
    if (candidate.path === candidates[cursor]!.path) {
      cursor++; if (cursor >= candidates.length) { cursor = 0; wrapped = true; }
    }
  }
  const complete = wrapped && incomplete === 0 && input.snapshotComplete;
  const unchangedComplete = complete && previous.complete === true && roots.every(root=>root.status==="current"||root.status==="not_test");
  const report: OssContractClosureReport = { recipe: OSS_CONTRACT_CLOSURE_RECIPE, candidateCount: candidates.length, nextCandidateIndex: cursor, round: wrapped && !unchangedComplete ? round + 1 : round,
    complete, incompleteInRound: incomplete, filesLoaded: budget.files.size, bytesLoaded: budget.usedBytes,
    sourceBytesLoaded: budget.sourceBytes ?? 0, descriptorBytesLoaded: budget.descriptorBytes ?? 0, publicationBytesPrepared, roots };
  const metadata = toJsonValue({ identity, nextCandidateIndex: cursor, round: report.round, incompleteInRound: wrapped ? 0 : incomplete, complete });
  if (canonicalStringify(checkpoint?.metadata) !== canonicalStringify(metadata)) await storage.ingestion.put({ id: checkpointId, rootUri: input.sourceUriBase, itemUri: "@source-owned-project-closure",
    phase: complete ? "stored" : "extracting", status: complete ? "complete" : "pending", offsetBytes: cursor, updatedAt: Date.now(), metadata });
  return report;
}
async function profileForOwner(storage: ScceStorage, owner: OwnedFile, label: InformationLabel) {
  const profiles = await storage.model.listLanguageProfiles({ sourceVersionIds: [owner.source.sourceVersionId], limit: 2 });
  if (profiles.length !== 1 || profiles[0]!.sourceVersionId !== owner.source.sourceVersionId || canonicalStringify(profiles[0]!.informationLabel) !== canonicalStringify(label)) throw new Error("OSS contract source profile unavailable");
  return profiles[0]!;
}
function scopeFor(owner: OwnedFile, profileId: string, dependencies: readonly OwnedFile[], componentRecipe: string, sourceContractRoot: NonNullable<LanguagePatternProjection["sourceContractRoot"]>, informationLabel: InformationLabel): Omit<LanguagePatternProjection, "patternIds"> {
  return { profileId, sourceId: owner.source.sourceId, sourceVersionId: owner.source.sourceVersionId, sourceSystem: "oss_code", patternSchema: "scce.source_owned_test_contract.v1", componentRecipe, sourceContractRoot, informationLabel,
    sourceDependencies: dependencies.map(item => ({ sourceId: item.source.sourceId, sourceVersionId: item.source.sourceVersionId, evidenceIds: item.evidence.map(span => span.id),
      contentHash: item.source.contentHash, originalSourceVersionId: item.original.sourceVersionId, originalContentHash: item.original.contentHash })) };
}
async function ownerCurrent(storage: ScceStorage, owner: OwnedFile): Promise<boolean> {
  const [original, source, evidence] = await Promise.all([storage.evidence.sourceVersionById?.(owner.original.sourceVersionId), storage.evidence.sourceVersionById?.(owner.source.sourceVersionId), storage.evidence.getEvidenceBatch(owner.evidence.map(span => span.id))]);
  return canonicalStringify(original) === canonicalStringify(owner.original) && canonicalStringify(source) === canonicalStringify(owner.source)
    && canonicalStringify(evidence.map(span => [span.id, span.sourceId, span.sourceVersionId, span.status, span.informationLabel]).sort()) === canonicalStringify(owner.evidence.map(span => [span.id, span.sourceId, span.sourceVersionId, span.status, span.informationLabel]).sort());
}
function bareHash(value: string): string { return value.replace(/^sha256[:_]/u, ""); }
function object(value: unknown): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }

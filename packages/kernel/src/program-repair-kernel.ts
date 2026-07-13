import type { ArtifactId, BuildTestResult, ContentHash, FileArtifact, Hasher, JsonValue, ProgramGraph } from "./types.js";
import { canonicalStringify, clamp01, createHasher, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { createProgramHydrationContract, hydrationSummary, validateProgramGraphHydration } from "./program-runtime.js";

export type DiagnosticClass = "syntax" | "type" | "dependency" | "runtime" | "contract" | "security" | "unknown";
export type RepairOperationKind = "insert" | "replace" | "delete" | "move" | "dependency" | "config" | "repair.op.diagnostic_note";

export interface DiagnosticPattern {
  id: string;
  class: DiagnosticClass;
  pattern: RegExp;
  confidence?: number;
  symbolGroup?: number;
}

export interface ProgramDiagnostic {
  id: string;
  class: DiagnosticClass;
  patternId?: string;
  path?: string;
  line?: number;
  column?: number;
  symbol?: string;
  message: string;
  raw: string;
  confidence: number;
}

export interface RepairOperation {
  id: string;
  kind: RepairOperationKind;
  path: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  packageName?: string;
  reason: string;
  risk: number;
}

export interface RepairPatchSet {
  id: string;
  diagnostics: ProgramDiagnostic[];
  operations: RepairOperation[];
  affectedFiles: string[];
  sourceEvidence: Array<{ path: string; artifactId: string; contentHash: string }>;
  rollbackPlan: Array<{ path: string; restoreContentHash: string; strategyId: string }>;
  unsupportedFields: string[];
  approvalRequired: boolean;
  estimatedRisk: number;
  confidence: number;
  explanation: string[];
  audit: JsonValue;
}

export interface RepairPlan {
  id: string;
  programId: string;
  attemptsAllowed: number;
  selectedPatchSet?: RepairPatchSet;
  patchSets: RepairPatchSet[];
  buildCommand: ProgramGraph["build"];
  testCommand: ProgramGraph["test"];
  validationPlan: Array<{ id: string; command: ProgramGraph["build"]; commandSource: string; expectedFiles: string[] }>;
  riskList: Array<{ id: string; severity: "info" | "warning" | "error"; path?: string; reason: string }>;
  dryRunPatchArtifact: JsonValue;
  transaction: {
    reads: string[];
    writes: string[];
    approvalGate: boolean;
  };
  audit: JsonValue;
}

export interface MaterializedProgramRepair {
  program: ProgramGraph;
  changedPaths: string[];
  trace: JsonValue;
}

/**
 * Materializes a selected, source-bound repair as complete file artifacts. The
 * result is still a proposal: it neither touches a workspace nor claims that
 * build or test validation succeeded.
 */
export function materializeProgramRepair(input: {
  program: ProgramGraph;
  build?: BuildTestResult;
  stdout?: string;
  stderr?: string;
  requestText?: string;
  patchSetId?: string;
  hasher?: Hasher;
  maxAttempts?: number;
  diagnosticPatterns?: readonly DiagnosticPattern[];
}): MaterializedProgramRepair {
  const hasher = input.hasher ?? createHasher();
  const repairPlan = createProgramRepairKernel({
    hasher,
    maxAttempts: input.maxAttempts,
    diagnosticPatterns: input.diagnosticPatterns
  }).plan({
    program: input.program,
    build: input.build,
    stdout: input.stdout,
    stderr: input.stderr,
    requestText: input.requestText
  });
  const patchSet = input.patchSetId
    ? repairPlan.patchSets.find(candidate => candidate.id === input.patchSetId)
    : repairPlan.selectedPatchSet;
  if (!patchSet) {
    throw new Error(input.patchSetId
      ? "program repair patch set is not part of the internally recomputed repair plan"
      : "program repair plan has no selected patch set");
  }
  const sourceHydration = input.program.hydration;
  if (!sourceHydration) throw new Error("program repair materialization requires a hydrated ProgramGraph");
  const hydrationCheck = validateProgramGraphHydration(input.program);
  if (!hydrationCheck.valid || sourceHydration.program.programId !== input.program.id) {
    throw new Error(`program repair source hydration is invalid: ${hydrationCheck.diagnostics.join(", ") || "program identity mismatch"}`);
  }
  if (patchSet.unsupportedFields.length > 0) {
    throw new Error(`program repair cannot materialize unsupported diagnostics: ${patchSet.unsupportedFields.join(", ")}`);
  }
  const unsupportedOperations = patchSet.operations.filter(operation => operation.kind === "move" || operation.kind === "repair.op.diagnostic_note");
  if (unsupportedOperations.length > 0) {
    throw new Error(`program repair cannot materialize operations without exact file content: ${unsupportedOperations.map(operation => operation.id).join(", ")}`);
  }
  const byPath = new Map(input.program.files.map(file => [file.path, file]));
  if (sourceHydration.files.length !== input.program.files.length || sourceHydration.emissions.length !== input.program.files.length) {
    throw new Error("program repair hydration file set does not match the ProgramGraph");
  }
  const hydratedByPath = new Map(sourceHydration.files.map(file => [file.path, file]));
  const emittedByPath = new Map(sourceHydration.emissions.map(emission => [emission.filePath, emission]));
  for (const file of input.program.files) {
    const actualHash = `sha256_${hasher.digestHex(file.content)}`;
    if (String(file.contentHash) !== actualHash
      || String(hydratedByPath.get(file.path)?.contentHash ?? "") !== actualHash
      || String(emittedByPath.get(file.path)?.contentHash ?? "") !== actualHash) {
      throw new Error(`program repair source artifact identity is stale: ${file.path}`);
    }
  }
  const operationPaths = [...new Set(patchSet.operations.map(operation => operation.path))].sort();
  const affectedPaths = [...new Set(patchSet.affectedFiles)].sort();
  if (canonicalStringify(operationPaths) !== canonicalStringify(affectedPaths)) {
    throw new Error("program repair affected file set does not match its operations");
  }
  const evidencePaths = new Set(patchSet.sourceEvidence.map(source => source.path));
  const missingSourceEvidence = affectedPaths.filter(path => !evidencePaths.has(path));
  if (missingSourceEvidence.length > 0) {
    throw new Error(`program repair source evidence is missing for affected paths: ${missingSourceEvidence.join(", ")}`);
  }
  for (const source of patchSet.sourceEvidence) {
    const artifact = byPath.get(source.path);
    if (!artifact || String(artifact.artifactId) !== source.artifactId || String(artifact.contentHash) !== source.contentHash) {
      throw new Error(`program repair source evidence is stale: ${source.path}`);
    }
  }
  for (const operation of patchSet.operations) {
    if (!byPath.has(operation.path)) throw new Error(`program repair operation is not bound to an owned full-file artifact: ${operation.path}`);
  }

  const materialized = applyVirtualRepair(input.program.files, patchSet);
  const materializedByPath = new Map(materialized.files.map(file => [file.path, file]));
  const materiallyChanged = materialized.changed.filter(path => materializedByPath.get(path)?.content !== byPath.get(path)?.content);
  if (materiallyChanged.length === 0 || materiallyChanged.length !== affectedPaths.length) {
    throw new Error("program repair produced no complete byte-level change for every affected path");
  }
  const changed = new Set(materiallyChanged);
  const files = materialized.files.map(file => {
    if (!changed.has(file.path)) return file;
    const digest = hasher.digestHex(file.content);
    return {
      ...file,
      artifactId: `repair_artifact_${digest.slice(0, 32)}` as ArtifactId,
      contentHash: `sha256_${digest}` as ContentHash
    };
  });
  const sourceEvidenceIds = sourceHydration.program.provenanceEvidenceIds;
  if (sourceEvidenceIds.length === 0) throw new Error("program repair materialization requires source-bound program provenance");
  const sourcePlanId = `program-repair:${repairPlan.id}:${patchSet.id}`;
  const materializedHydrationNodeId = `${sourcePlanId}:hydration`;
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const sourceHydrationNodeIds = new Set(
    input.program.nodes.filter(node => node.kind === "program_hydration_contract").map(node => node.id)
  );
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    ...input.program,
    id: `repair_program_${hasher.digestHex(JSON.stringify({ programId: input.program.id, patchSetId: patchSet.id, files: files.map(file => file.contentHash) })).slice(0, 32)}`,
    files,
    nodes: [
      ...input.program.nodes
        .filter(node => !sourceHydrationNodeIds.has(node.id))
        .map(node => {
          if (!node.id.startsWith("artifact:")) return node;
          const file = filesByPath.get(node.id.slice("artifact:".length));
          if (!file) return node;
          const metadata = typeof node.metadata === "object" && node.metadata !== null && !Array.isArray(node.metadata)
            ? node.metadata
            : {};
          return { ...node, metadata: toJsonValue({ ...metadata, contentHash: file.contentHash, mediaType: file.mediaType }) };
        }),
      {
        id: sourcePlanId,
        kind: "program_repair_full_file_materialization",
        label: sourcePlanId,
        metadata: toJsonValue({
          schema: "scce.program_repair.full_file_lineage.v1",
          repairPlanId: repairPlan.id,
          patchSetId: patchSet.id,
          changedPaths: materiallyChanged,
          transformations: materiallyChanged.map(path => {
            const before = byPath.get(path)!;
            const after = filesByPath.get(path)!;
            return {
              path,
              baseArtifactId: before.artifactId,
              baseContentHash: before.contentHash,
              outputArtifactId: after.artifactId,
              outputContentHash: after.contentHash,
              operationIds: patchSet.operations.filter(operation => operation.path === path).map(operation => operation.id),
              evidence: patchSet.sourceEvidence.filter(source => source.path === path)
            };
          })
        })
      }
    ],
    edges: [
      ...input.program.edges.filter(edge => edge.relation !== "hydrates_as"
        && !sourceHydrationNodeIds.has(edge.source)
        && !sourceHydrationNodeIds.has(edge.target)),
      ...materialized.changed.map(path => ({ source: sourcePlanId, target: `artifact:${path}`, relation: "materializes_full_file", weight: 1 }))
    ]
  };
  const materializedHydration = createProgramHydrationContract({
    program: graphWithoutHydration,
    sourcePlanId,
    evidenceIds: sourceEvidenceIds,
    risks: repairPlan.riskList.map(risk => risk.id)
  });
  return {
    program: {
      ...graphWithoutHydration,
      hydration: materializedHydration,
      nodes: [
        ...graphWithoutHydration.nodes,
        { id: materializedHydrationNodeId, kind: "program_hydration_contract", label: materializedHydration.schema, metadata: hydrationSummary(materializedHydration) }
      ],
      edges: [
        ...graphWithoutHydration.edges,
        { source: sourcePlanId, target: materializedHydrationNodeId, relation: "hydrates_as", weight: materializedHydration.valid ? 1 : 0.35 }
      ]
    },
    changedPaths: [...materiallyChanged].sort(),
    trace: toJsonValue({
      schema: "scce.program_repair.full_file_materialization.v1",
      sourceProgramId: input.program.id,
      programId: graphWithoutHydration.id,
      repairPlanId: repairPlan.id,
      patchSetId: patchSet.id,
      sourceEvidence: patchSet.sourceEvidence,
      changedPaths: [...materiallyChanged].sort(),
      mutatesRealWorkspace: false,
      validationState: "not_executed"
    })
  };
}

export function createProgramRepairKernel(options: { hasher?: Hasher; maxAttempts?: number; diagnosticPatterns?: readonly DiagnosticPattern[] } = {}) {
  const hasher = options.hasher ?? createHasher();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const diagnosticPatterns = options.diagnosticPatterns ?? [];
  return {
    parseDiagnostics(input: { stdout?: string; stderr?: string; artifacts?: FileArtifact[] }): ProgramDiagnostic[] {
      return parseDiagnostics(input.stdout ?? "", input.stderr ?? "", input.artifacts ?? [], hasher, diagnosticPatterns);
    },

    plan(input: { program: ProgramGraph; build?: BuildTestResult; stdout?: string; stderr?: string; requestText?: string }): RepairPlan {
      const diagnostics = parseDiagnostics(input.stdout ?? input.build?.build.stdout ?? "", input.stderr ?? input.build?.build.stderr ?? "", input.program.files, hasher, diagnosticPatterns);
      const patchSets = buildPatchSets({ program: input.program, diagnostics, requestText: input.requestText ?? "", hasher });
      const selectedPatchSet = patchSets.sort((a, b) => b.confidence - a.confidence || a.estimatedRisk - b.estimatedRisk)[0];
      return {
        id: `repair_plan_${hasher.digestHex(JSON.stringify({ program: input.program.id, diagnostics: diagnostics.map(d => d.id), patchSets: patchSets.map(p => p.id) })).slice(0, 32)}`,
        programId: input.program.id,
        attemptsAllowed: maxAttempts,
        selectedPatchSet,
        patchSets,
        buildCommand: input.program.build,
        testCommand: input.program.test,
        validationPlan: validationPlanFor(input.program),
        riskList: riskListFor(selectedPatchSet),
        dryRunPatchArtifact: dryRunPatchArtifactFor(input.program, selectedPatchSet),
        transaction: {
          reads: ["blobs", "construct_graphs", "self_rewrite_episodes"],
          writes: ["blobs", "construct_graphs", "self_rewrite_episodes", "self_rewrite_patches", "events"],
          approvalGate: Boolean(selectedPatchSet?.approvalRequired)
        },
        audit: toJsonValue({
          diagnostics,
          selectedPatchSet: selectedPatchSet ? { id: selectedPatchSet.id, risk: selectedPatchSet.estimatedRisk, confidence: selectedPatchSet.confidence } : null,
          attemptsAllowed: maxAttempts,
          validationPlan: validationPlanFor(input.program),
          riskList: riskListFor(selectedPatchSet),
          dryRunPatchArtifact: dryRunPatchArtifactFor(input.program, selectedPatchSet)
        })
      };
    },

    applyVirtual(input: { files: FileArtifact[]; patchSet: RepairPatchSet }): { files: FileArtifact[]; changed: string[]; audit: JsonValue } {
      const result = applyVirtualRepair(input.files, input.patchSet);
      return { ...result, audit: toJsonValue({ patchSet: input.patchSet.id, changed: result.changed }) };
    }
  };
}

function applyVirtualRepair(files: readonly FileArtifact[], patchSet: RepairPatchSet): { files: FileArtifact[]; changed: string[] } {
  const byPath = new Map(files.map(file => [file.path, file]));
  const changed = new Set<string>();
  for (const op of patchSet.operations) {
    const file = byPath.get(op.path);
    if (!file && op.kind !== "dependency" && op.kind !== "config") continue;
    if (op.kind === "replace" && file) {
      byPath.set(op.path, { ...file, content: replaceLines(file.content, op.startLine ?? 1, op.endLine ?? op.startLine ?? 1, op.content ?? "") });
      changed.add(op.path);
    } else if (op.kind === "insert" && file) {
      byPath.set(op.path, { ...file, content: insertAtLine(file.content, op.startLine ?? 1, op.content ?? "") });
      changed.add(op.path);
    } else if (op.kind === "delete" && file) {
      byPath.set(op.path, { ...file, content: replaceLines(file.content, op.startLine ?? 1, op.endLine ?? op.startLine ?? 1, "") });
      changed.add(op.path);
    } else if ((op.kind === "dependency" || op.kind === "config") && file) {
      byPath.set(op.path, { ...file, content: op.content ?? file.content });
      changed.add(op.path);
    }
  }
  return { files: [...byPath.values()], changed: [...changed] };
}

function parseDiagnostics(stdout: string, stderr: string, artifacts: readonly FileArtifact[], hasher: Hasher, patterns: readonly DiagnosticPattern[]): ProgramDiagnostic[] {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const diagnostics: ProgramDiagnostic[] = [];
  const artifactPaths = artifacts.map(file => file.path);
  for (const raw of lines) {
    const loc = parseLocation(raw, artifactPaths);
    const matched = matchDiagnosticPattern(raw, patterns);
    const klass = matched?.class ?? diagnosticClassFromText(raw);
    if (klass === "unknown" && !loc) continue;
    const message = raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
    diagnostics.push({
      id: `diag_${hasher.digestHex(raw).slice(0, 24)}`,
      class: klass,
      patternId: matched?.patternId,
      path: loc?.path,
      line: loc?.line,
      column: loc?.column,
      symbol: matched?.symbol,
      message,
      raw,
      confidence: diagnosticConfidence(klass, loc, raw, matched?.confidence)
    });
  }
  return dedupeDiagnostics(diagnostics);
}

function diagnosticClassFromText(raw: string): DiagnosticClass {
  const lower = raw.toLocaleLowerCase();
  if (lower.includes("syntax")) return "syntax";
  if (lower.includes("type")) return "type";
  if (lower.includes("dependency") || lower.includes("module not found") || lower.includes("cannot find module")) return "dependency";
  if (lower.includes("runtime")) return "runtime";
  if (lower.includes("contract")) return "contract";
  if (lower.includes("security") || lower.includes("secret")) return "security";
  return "unknown";
}

function buildPatchSets(input: { program: ProgramGraph; diagnostics: ProgramDiagnostic[]; requestText: string; hasher: Hasher }): RepairPatchSet[] {
  if (!input.diagnostics.length) return [diagnosticNotePatch(input.program, "No diagnostics were present; preserve artifacts and request fresh verification.", input.hasher)];
  const ownedPaths = new Set(input.program.files.map(file => file.path));
  const byFile = new Map<string, ProgramDiagnostic[]>();
  for (const diag of input.diagnostics) {
    const path = diag.path && ownedPaths.has(diag.path) ? diag.path : nearestFile(input.program.files, diag);
    if (!path) continue;
    const bucket = byFile.get(path) ?? [];
    bucket.push(diag);
    byFile.set(path, bucket);
  }
  const patchSets: RepairPatchSet[] = [];
  for (const [path, diagnostics] of byFile) {
    const file = input.program.files.find(item => item.path === path);
    if (!file) continue;
    const operations = diagnostics.flatMap(diag => operationForDiagnostic(file, diag, input.requestText, input.hasher));
    if (!operations.length) {
      patchSets.push(diagnosticNotePatch(input.program, `Diagnostics in ${path} require human inspection.`, input.hasher, diagnostics));
      continue;
    }
    patchSets.push(patchSetFor(input.program, diagnostics, operations, input.hasher));
  }
  const dependencyDiagnostics = input.diagnostics.filter(diag => diag.class === "dependency");
  if (dependencyDiagnostics.length) {
    const packageFiles = input.program.files.filter(file => /package\.json|Cargo\.toml|pyproject\.toml|\.csproj$/u.test(file.path));
    for (const file of packageFiles) {
      const operations = dependencyDiagnostics.map(diag => dependencyRepair(file, diag, input.hasher)).filter((op): op is RepairOperation => Boolean(op));
      if (operations.length) patchSets.push(patchSetFor(input.program, dependencyDiagnostics, operations, input.hasher));
    }
  }
  return patchSets.length ? patchSets : [diagnosticNotePatch(input.program, "Diagnostics did not map to owned files.", input.hasher, input.diagnostics)];
}

function operationForDiagnostic(file: FileArtifact, diag: ProgramDiagnostic, requestText: string, hasher: Hasher): RepairOperation[] {
  if (diag.class === "syntax") return syntaxRepair(file, diag, hasher);
  if (diag.class === "type") return typeRepair(file, diag, requestText, hasher);
  if (diag.class === "contract") return contractRepair(file, diag, hasher);
  if (diag.class === "runtime") return runtimeRepair(file, diag, hasher);
  if (diag.class === "security") return securityRepair(file, diag, hasher);
  return [];
}

function syntaxRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const closeBalance = delimiterRepair(current);
  if (closeBalance) {
    return [operation("replace", file.path, line, line, `${current}${closeBalance}`, `Balance delimiters near syntax diagnostic: ${diag.message}`, 0.28, hasher)];
  }
  if (!current.trim() && closingForFile(file)) {
    return [operation("insert", file.path, line + 1, line + 1, closingForFile(file), `Close unterminated module after syntax diagnostic: ${diag.message}`, 0.34, hasher)];
  }
  return [operation("replace", file.path, line, line, current.trimEnd(), `Normalize syntax line near diagnostic: ${diag.message}`, 0.22, hasher)];
}

function typeRepair(file: FileArtifact, diag: ProgramDiagnostic, _requestText: string, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const symbol = diag.symbol;
  if (symbol) {
    const exportLine = file.mediaType.includes("typescript") || file.path.endsWith(".ts") || file.path.endsWith(".tsx")
      ? `const ${safeIdentifier(symbol)} = undefined as never;`
      : file.path.endsWith(".py")
        ? `${safeIdentifier(symbol)} = None`
        : "";
    if (exportLine) return [operation("insert", file.path, Math.max(1, line - 1), Math.max(1, line - 1), exportLine, `Introduce explicit symbol boundary for ${symbol}; caller remains visible for next verification.`, 0.48, hasher)];
  }
  const widened = widenStructuralAccess(current);
  if (widened !== current) {
    return [operation("replace", file.path, line, line, widened, `Guard structural property access from diagnostic: ${diag.message}`, 0.42, hasher)];
  }
  const converted = addExplicitConversion(current);
  if (converted !== current) {
    return [operation("replace", file.path, line, line, converted, `Add explicit conversion boundary for type diagnostic: ${diag.message}`, 0.46, hasher)];
  }
  return [operation("replace", file.path, line, line, current, `Keep type diagnostic localized for verification: ${diag.message}`, 0.55, hasher)];
}

function contractRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  return current.trim()
    ? [operation("insert", file.path, line, line, contractGuardFor(file), `Add explicit contract guard for ${diag.message}`, 0.38, hasher)]
    : [operation("replace", file.path, line, line, current, `Contract diagnostic retained for focused review: ${diag.message}`, 0.5, hasher)];
}

function runtimeRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const guarded = addNullishGuard(current);
  if (guarded !== current) return [operation("replace", file.path, line, line, guarded, `Guard nullish runtime access: ${diag.message}`, 0.44, hasher)];
  if (current.trim()) return [operation("insert", file.path, line, line, boundCheckFor(file), `Add bounded runtime guard: ${diag.message}`, 0.4, hasher)];
  return [operation("replace", file.path, line, line, current, `Runtime diagnostic localized: ${diag.message}`, 0.52, hasher)];
}

function securityRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const redacted = current.replace(/(["'`])[^"'`]{8,}\1/g, "\"[REDACTED]\"");
  if (redacted !== current) return [operation("replace", file.path, line, line, redacted, `Redact sensitive literal near diagnostic: ${diag.message}`, 0.3, hasher)];
  return [operation("insert", file.path, line, line, securityCommentFor(file), `Surface security invariant near diagnostic: ${diag.message}`, 0.36, hasher)];
}

function dependencyRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation | undefined {
  const pkg = diag.symbol;
  if (!pkg) return undefined;
  if (file.path.endsWith("package.json")) {
    const next = patchPackageJson(file.content, pkg);
    return operation("dependency", file.path, 1, lineCount(file.content), next, `Add or preserve dependency ${pkg} for diagnostic: ${diag.message}`, 0.5, hasher, pkg);
  }
  if (file.path.endsWith("Cargo.toml")) {
    const next = file.content.includes(`[dependencies]`) ? `${file.content.trimEnd()}\n${pkg} = "*"\n` : `${file.content.trimEnd()}\n\n[dependencies]\n${pkg} = "*"\n`;
    return operation("dependency", file.path, 1, lineCount(file.content), next, `Add dependency ${pkg}`, 0.54, hasher, pkg);
  }
  if (file.path.endsWith("pyproject.toml")) {
    return operation("dependency", file.path, 1, lineCount(file.content), `${file.content.trimEnd()}\n# dependency required: ${pkg}\n`, `Record dependency requirement ${pkg}`, 0.48, hasher, pkg);
  }
  return undefined;
}

function patchSetFor(program: ProgramGraph, diagnostics: ProgramDiagnostic[], operations: RepairOperation[], hasher: Hasher): RepairPatchSet {
  const affectedFiles = [...new Set(operations.map(op => op.path))];
  const sourceEvidence = affectedFiles.flatMap(path => {
    const file = program.files.find(item => item.path === path);
    return file ? [{ path: file.path, artifactId: String(file.artifactId), contentHash: String(file.contentHash) }] : [];
  });
  const rollbackPlan = sourceEvidence.map(item => ({ path: item.path, restoreContentHash: item.contentHash, strategyId: "repair.rollback.restore_original_artifact" }));
  const unsupportedFields = diagnostics
    .filter(diag => diag.class === "unknown")
    .map(diag => diag.path ? `${diag.class}:${diag.path}` : diag.class);
  const estimatedRisk = clamp01(operations.reduce((sum, op) => sum + op.risk, 0) / Math.max(1, operations.length) + affectedFiles.length * 0.03);
  const diagnosticConfidence = diagnostics.reduce((sum, diag) => sum + diag.confidence, 0) / Math.max(1, diagnostics.length);
  const operationConfidence = clamp01(1 - estimatedRisk * 0.55);
  const confidence = clamp01(0.55 * diagnosticConfidence + 0.45 * operationConfidence);
  return {
    id: `patchset_${hasher.digestHex(JSON.stringify({ program: program.id, diagnostics: diagnostics.map(d => d.id), operations: operations.map(o => o.id) })).slice(0, 28)}`,
    diagnostics,
    operations,
    affectedFiles,
    sourceEvidence,
    rollbackPlan,
    unsupportedFields,
    approvalRequired: estimatedRisk > 0.45 || operations.some(op => op.kind === "dependency" || op.kind === "config"),
    estimatedRisk,
    confidence,
    explanation: [
      `${diagnostics.length} diagnostics mapped to ${affectedFiles.length} owned files`,
      `${operations.length} repair operations prepared`,
      `confidence=${confidence.toFixed(3)}`,
      `risk=${estimatedRisk.toFixed(3)}`
    ],
    audit: toJsonValue({ affectedFiles, sourceEvidence, rollbackPlan, unsupportedFields, diagnostics: diagnostics.map(d => ({ id: d.id, class: d.class, path: d.path, line: d.line })), operations })
  };
}

function validationPlanFor(program: ProgramGraph): RepairPlan["validationPlan"] {
  const expectedFiles = program.files.map(file => file.path);
  return [
    { id: `${program.id}:build`, command: program.build, commandSource: commandSourceId(program.build), expectedFiles },
    { id: `${program.id}:test`, command: program.test, commandSource: commandSourceId(program.test), expectedFiles }
  ];
}

function commandSourceId(command: { command: string }): string {
  return command.command === "source-derived" ? "program.validation.command.source_derived" : "program.validation.command.observed";
}

function riskListFor(patchSet: RepairPatchSet | undefined): RepairPlan["riskList"] {
  if (!patchSet) return [{ id: "repair.risk.no_patchset", severity: "warning", reason: "No patch set was selected." }];
  const risks: RepairPlan["riskList"] = [];
  if (patchSet.approvalRequired) risks.push({ id: "repair.risk.approval_required", severity: "warning", reason: "Patch set requires owner approval before mutation." });
  if (patchSet.estimatedRisk > 0.45) risks.push({ id: "repair.risk.estimated_high", severity: "warning", reason: `Estimated risk ${patchSet.estimatedRisk.toFixed(3)}.` });
  for (const op of patchSet.operations) if (op.kind === "dependency" || op.kind === "config") risks.push({ id: "repair.risk.config_or_dependency", severity: "warning", path: op.path, reason: op.reason });
  return risks.length ? risks : [{ id: "repair.risk.low", severity: "info", reason: "Patch set is source-local and dry-run only." }];
}

function dryRunPatchArtifactFor(program: ProgramGraph, patchSet: RepairPatchSet | undefined): JsonValue {
  return toJsonValue({
    schema: "scce.program_repair.dry_run_patch.v1",
    programId: program.id,
    patchSetId: patchSet?.id ?? null,
    affectedFiles: patchSet?.affectedFiles ?? [],
    operations: patchSet?.operations.map(op => ({ id: op.id, kind: op.kind, path: op.path, startLine: op.startLine ?? null, endLine: op.endLine ?? null, reason: op.reason, risk: op.risk })) ?? [],
    rollbackPlan: patchSet?.rollbackPlan ?? [],
    sourceEvidence: patchSet?.sourceEvidence ?? [],
    mutatesRealWorkspace: false
  });
}

function diagnosticNotePatch(program: ProgramGraph, reason: string, hasher: Hasher, diagnostics: ProgramDiagnostic[] = []): RepairPatchSet {
  const diagnosticPath = diagnostics.find(diag => diag.path && program.files.some(file => file.path === diag.path))?.path;
  const operations = [operation("repair.op.diagnostic_note", diagnosticPath ?? program.files[0]?.path ?? "README.md", 1, 1, reason, reason, 0.18, hasher)];
  return patchSetFor(program, diagnostics, operations, hasher);
}

function operation(kind: RepairOperationKind, path: string, startLine: number | undefined, endLine: number | undefined, content: string | undefined, reason: string, risk: number, hasher: Hasher, packageName?: string): RepairOperation {
  return {
    id: `repair_op_${hasher.digestHex(`${kind}:${path}:${startLine}:${endLine}:${content}:${reason}`).slice(0, 24)}`,
    kind,
    path,
    startLine,
    endLine,
    content,
    packageName,
    reason,
    risk: clamp01(risk)
  };
}

function matchDiagnosticPattern(raw: string, patterns: readonly DiagnosticPattern[]): { class: DiagnosticClass; patternId: string; symbol?: string; confidence?: number } | undefined {
  for (const pattern of patterns) {
    pattern.pattern.lastIndex = 0;
    const match = pattern.pattern.exec(raw);
    if (!match) continue;
    const symbol = pattern.symbolGroup === undefined ? undefined : match[pattern.symbolGroup];
    return {
      class: pattern.class,
      patternId: pattern.id,
      symbol,
      confidence: pattern.confidence
    };
  }
  return undefined;
}

function parseLocation(raw: string, paths: readonly string[]): { path: string; line?: number; column?: number } | undefined {
  for (const path of paths) {
    const escaped = escapeRegex(path);
    const match = new RegExp(`${escaped}[:(](\\d+)?[:,]?(\\d+)?`).exec(raw);
    if (match) return { path, line: match[1] ? Number.parseInt(match[1], 10) : undefined, column: match[2] ? Number.parseInt(match[2], 10) : undefined };
  }
  const generic = /([\p{Letter}\p{Number}_./\\-]+\.(?:ts|tsx|js|jsx|py|rs|cs|json|toml|css|html))[:(](\d+)?[:,]?(\d+)?/u.exec(raw);
  if (generic) return { path: generic[1]!.replace(/\\/g, "/"), line: generic[2] ? Number.parseInt(generic[2], 10) : undefined, column: generic[3] ? Number.parseInt(generic[3], 10) : undefined };
  return undefined;
}

function diagnosticConfidence(klass: DiagnosticClass, loc: { path: string; line?: number; column?: number } | undefined, raw: string, patternConfidence?: number): number {
  const classBase: Record<DiagnosticClass, number> = { syntax: 0.82, type: 0.76, dependency: 0.74, runtime: 0.68, contract: 0.72, security: 0.8, unknown: 0.25 };
  const base = patternConfidence ?? classBase[klass];
  const locBoost = loc?.path ? 0.12 : 0;
  const lineBoost = loc?.line ? 0.06 : 0;
  const rawPenalty = raw.length > 1000 ? 0.08 : 0;
  return clamp01(base + locBoost + lineBoost - rawPenalty);
}

function dedupeDiagnostics(diagnostics: ProgramDiagnostic[]): ProgramDiagnostic[] {
  const map = new Map<string, ProgramDiagnostic>();
  for (const diag of diagnostics) {
    const key = `${diag.class}:${diag.path}:${diag.line}:${diag.symbol}:${diag.message}`;
    const existing = map.get(key);
    if (!existing || diag.confidence > existing.confidence) map.set(key, diag);
  }
  return [...map.values()];
}

function nearestFile(files: readonly FileArtifact[], diag: ProgramDiagnostic): string | undefined {
  if (diag.path) {
    const diagFeatures = featureSet(diag.path, 128);
    return files
      .map(file => ({ path: file.path, score: weightedJaccard(diagFeatures, featureSet(file.path, 128)) }))
      .sort((a, b) => b.score - a.score)[0]?.path;
  }
  return files[0]?.path;
}

function locateLikelyLine(content: string, diag: ProgramDiagnostic): number {
  if (diag.line) return diag.line;
  const symbol = diag.symbol;
  if (!symbol) return 1;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(symbol));
  return index >= 0 ? index + 1 : 1;
}

function lineText(content: string, line: number): string {
  return content.split(/\r?\n/)[Math.max(0, line - 1)] ?? "";
}

function lineCount(content: string): number {
  return content.split(/\r?\n/).length;
}

function replaceLines(content: string, startLine: number, endLine: number, replacement: string): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  const end = Math.max(start, endLine - 1);
  lines.splice(start, end - start + 1, ...replacement.split(/\r?\n/));
  return `${lines.join("\n")}${content.endsWith("\n") ? "\n" : ""}`;
}

function insertAtLine(content: string, line: number, insertion: string): string {
  const lines = content.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length, line - 1));
  lines.splice(index, 0, ...insertion.split(/\r?\n/));
  return `${lines.join("\n")}${content.endsWith("\n") ? "\n" : ""}`;
}

function delimiterRepair(line: string): string {
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  let suffix = "";
  for (const [open, close] of pairs) {
    const diff = countChar(line, open) - countChar(line, close);
    if (diff > 0) suffix += close.repeat(Math.min(3, diff));
  }
  return suffix;
}

function closingForFile(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx") || file.path.endsWith(".js") || file.path.endsWith(".jsx")) return "}";
  if (file.path.endsWith(".rs") || file.path.endsWith(".cs")) return "}";
  if (file.path.endsWith(".py")) return "";
  return "";
}

function widenStructuralAccess(line: string): string {
  if (line.includes("?.")) return line;
  return line.replace(/([\p{Letter}\p{Number}_$\]\)])\.([\p{Letter}_$][\p{Letter}\p{Number}_$]*)/gu, "$1?.$2");
}

function addExplicitConversion(line: string): string {
  if (line.includes("String(") || line.includes("Number(")) return line;
  return line.replace(/=\s*([^;]+);?$/, "= String($1);");
}

function addNullishGuard(line: string): string {
  if (line.includes("??") || line.includes("?.")) return line;
  return line.replace(/([\p{Letter}_$][\p{Letter}\p{Number}_$]*)\.([\p{Letter}_$][\p{Letter}\p{Number}_$]*)/gu, "$1?.$2");
}

function contractGuardFor(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) return "if (!input || typeof input !== \"object\") throw new Error(\"contract.invalid_input\");";
  if (file.path.endsWith(".py")) return "if input is None:\n    raise ValueError('contract.invalid_input')";
  if (file.path.endsWith(".rs")) return "if input.is_empty() { return Err(\"contract.invalid_input\".into()); }";
  return "/* contract.invalid_input */";
}

function boundCheckFor(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx") || file.path.endsWith(".js")) return "if (input.length > 1_000_000) throw new Error(\"runtime.bound_exceeded\");";
  if (file.path.endsWith(".py")) return "if len(input) > 1_000_000:\n    raise ValueError('runtime.bound_exceeded')";
  if (file.path.endsWith(".rs")) return "if input.len() > 1_000_000 { return Err(\"runtime.bound_exceeded\".into()); }";
  return "/* runtime.bound_exceeded */";
}

function securityCommentFor(file: FileArtifact): string {
  if (file.path.endsWith(".py")) return "# security.invariant.encrypted_config_required";
  return "// security.invariant.encrypted_config_required";
}

function patchPackageJson(content: string, pkg: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const deps = parsed.dependencies && typeof parsed.dependencies === "object" && !Array.isArray(parsed.dependencies)
      ? parsed.dependencies as Record<string, unknown>
      : {};
    deps[pkg] = typeof deps[pkg] === "string" ? deps[pkg] : "*";
    parsed.dependencies = deps;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return `${content.trimEnd()}\n/* dependency required: ${pkg} */\n`;
  }
}

function safeIdentifier(value: string): string {
  const cleaned = value.replace(/[^\p{Letter}\p{Number}_$]/gu, "_").replace(/^([^\p{Letter}_$])/u, "_$1");
  return cleaned || "value";
}

function countChar(value: string, char: string): number {
  return [...value].filter(c => c === char).length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

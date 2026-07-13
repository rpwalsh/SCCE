import type { IdFactory } from "./ids.js";
import type { EpisodeId, EvidenceSpan, GraphSlice, Hasher, JsonValue, ModelState } from "./types.js";
import type { SelfRewriteEpisodeRecord, SelfRewritePatchRecord } from "./storage.js";
import { clamp01, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";

export interface SelfRewriteFile {
  path: string;
  content: string;
  mediaType?: string;
}

export interface SelfRewriteGoal {
  target: string;
  requiredCapabilities: string[];
  disallowedPatterns?: string[];
  preferredFiles?: string[];
  approvalMode: "manual" | "temporary_operator_grant";
}

export interface SelfProgramNode {
  id: string;
  kind: "file" | "export" | "import" | "storage_table" | "deficit" | "patch";
  label: string;
  features: string[];
  metadata: JsonValue;
}

export interface SelfProgramEdge {
  source: string;
  target: string;
  relation: "imports" | "exports" | "persists" | "violates" | "repairs" | "depends_on";
  weight: number;
}

export interface SelfPatchProposal {
  id: string;
  filePath: string;
  beforeHash?: string;
  afterHash: string;
  title: string;
  rationale: string;
  unifiedDiff: string;
  score: {
    semanticGain: number;
    locality: number;
    safety: number;
    dependencyRisk: number;
    total: number;
  };
  approvalRequired: boolean;
}

export interface SelfRewriteProposal {
  id: string;
  episode: SelfRewriteEpisodeRecord;
  patches: SelfRewritePatchRecord[];
  programGraph: {
    nodes: SelfProgramNode[];
    edges: SelfProgramEdge[];
  };
  patchProposals: SelfPatchProposal[];
  audit: JsonValue;
}

export function createSelfRewriteEngine(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    propose(input: {
      episodeId: EpisodeId;
      goal: SelfRewriteGoal;
      files: SelfRewriteFile[];
      graph?: GraphSlice;
      model?: ModelState;
      evidence?: EvidenceSpan[];
      createdAt: number;
    }): SelfRewriteProposal {
      const fileNodes = input.files.map(file => fileNode(file, options.hasher));
      const importEdges = importsFor(input.files);
      const exportNodes = exportsFor(input.files, options.hasher);
      const storageNodes = storageTables(input.files);
      const deficits = detectDeficits(input.goal, input.files, storageNodes);
      const deficitNodes = deficits.map(deficit => ({
        id: deficit.id,
        kind: "deficit" as const,
        label: deficit.title,
        features: featureSet(`${deficit.title}\n${deficit.reason}`, 64),
        metadata: toJsonValue(deficit)
      }));
      const patchProposals = deficits.flatMap(deficit => proposePatches(deficit, input.files, input.goal, options.idFactory, options.hasher));
      const patchNodes = patchProposals.map(patch => ({
        id: patch.id,
        kind: "patch" as const,
        label: patch.title,
        features: featureSet(`${patch.filePath}\n${patch.title}\n${patch.rationale}`, 96),
        metadata: toJsonValue({ filePath: patch.filePath, score: patch.score, approvalRequired: patch.approvalRequired })
      }));
      const nodes: SelfProgramNode[] = [...fileNodes, ...exportNodes, ...storageNodes, ...deficitNodes, ...patchNodes];
      const repairEdges: SelfProgramEdge[] = patchProposals.map(patch => ({
        source: patch.id,
        target: deficits.find(deficit => patch.rationale.includes(deficit.id))?.id ?? deficits[0]?.id ?? "deficit:none",
        relation: "repairs",
        weight: patch.score.total
      }));
      const graphEdges: SelfProgramEdge[] = [
        ...importEdges,
        ...exportNodes.map(node => ({ source: node.id, target: fileId(String((node.metadata as { path?: JsonValue }).path ?? "")), relation: "exports" as const, weight: 0.7 })),
        ...storageNodes.map(node => ({ source: node.id, target: fileId(String((node.metadata as { path?: JsonValue }).path ?? "")), relation: "persists" as const, weight: 0.9 })),
        ...deficitEdges(deficits),
        ...repairEdges
      ];
      const programGraph = { nodes, edges: graphEdges };
      const improvement = scoreImprovement({ goal: input.goal, deficits, patchProposals, graph: input.graph, model: input.model, evidence: input.evidence });
      const episode: SelfRewriteEpisodeRecord = {
        id: options.idFactory.semanticId("self_rewrite_episode", { episodeId: input.episodeId, target: input.goal.target, patches: patchProposals.map(patch => patch.id) }),
        episodeId: input.episodeId,
        target: input.goal.target,
        programGraphJson: toJsonValue(programGraph),
        improvementJson: improvement,
        status: patchProposals.length ? "proposed" : "rejected",
        createdAt: input.createdAt
      };
      const patches = patchProposals.map(patch => ({
        id: patch.id,
        rewriteEpisodeId: episode.id,
        filePath: patch.filePath,
        beforeHash: patch.beforeHash,
        afterHash: patch.afterHash,
        patchJson: toJsonValue({ title: patch.title, rationale: patch.rationale, unifiedDiff: patch.unifiedDiff, approvalRequired: patch.approvalRequired }),
        scoreJson: toJsonValue(patch.score),
        createdAt: input.createdAt
      } satisfies SelfRewritePatchRecord));
      return {
        id: episode.id,
        episode,
        patches,
        programGraph,
        patchProposals,
        audit: toJsonValue({
          target: input.goal.target,
          files: input.files.length,
          imports: importEdges.length,
          exports: exportNodes.length,
          storageTables: storageNodes.length,
          deficits: deficits.length,
          patches: patchProposals.length,
          improvement
        })
      };
    }
  };
}

interface Deficit {
  id: string;
  title: string;
  reason: string;
  filePath?: string;
  kind: "missing_export" | "missing_storage_table" | "disallowed_pattern" | "thin_surface" | "unwired_module";
  severity: number;
  expectedText?: string;
}

function fileNode(file: SelfRewriteFile, hasher: Hasher): SelfProgramNode {
  return {
    id: fileId(file.path),
    kind: "file",
    label: file.path,
    features: featureSet(file.content, 128),
    metadata: toJsonValue({ path: file.path, hash: hasher.digestHex(file.content), bytes: file.content.length, mediaType: file.mediaType ?? "text/plain" })
  };
}

function importsFor(files: readonly SelfRewriteFile[]): SelfProgramEdge[] {
  const byBasename = new Map(files.map(file => [basenameNoExt(file.path), file.path]));
  const out: SelfProgramEdge[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file.content)) {
      const normalized = specifier.replace(/^\.\//, "").replace(/\.(js|ts|mjs|cjs)$/u, "");
      const target = byBasename.get(normalized.split(/[\\/]/u).pop() ?? normalized);
      if (target) out.push({ source: fileId(file.path), target: fileId(target), relation: "imports", weight: 0.8 });
    }
  }
  return out;
}

function exportsFor(files: readonly SelfRewriteFile[], hasher: Hasher): SelfProgramNode[] {
  return files.flatMap(file => exportedSymbols(file.content).map(symbol => ({
    id: `export:${file.path}:${symbol}`,
    kind: "export" as const,
    label: symbol,
    features: featureSet(symbol, 32),
    metadata: toJsonValue({ path: file.path, symbol, hash: hasher.digestHex(`${file.path}\n${symbol}`) })
  })));
}

function storageTables(files: readonly SelfRewriteFile[]): SelfProgramNode[] {
  return files.flatMap(file => {
    const tables = [...file.content.matchAll(/["`]([a-z][a-z0-9_]{2,})["`]/gu)]
      .map(match => match[1]!)
      .filter(value => /(?:_spans|_graphs|_states|_models|_traces|_alignments|_patches|_episodes|_observations|_profiles|_proofs|_calls|_versions)$/u.test(value));
    return [...new Set(tables)].map(table => ({
      id: `storage:${table}`,
      kind: "storage_table" as const,
      label: table,
      features: [`table:${table}`],
      metadata: toJsonValue({ path: file.path, table })
    }));
  });
}

function detectDeficits(goal: SelfRewriteGoal, files: readonly SelfRewriteFile[], storageNodes: readonly SelfProgramNode[]): Deficit[] {
  const out: Deficit[] = [];
  const indexFile = files.find(file => /(?:^|[/\\])index\.ts$/u.test(file.path));
  const sourceModules = files.filter(file => /packages[/\\]kernel[/\\]src[/\\][^/\\]+\.ts$/u.test(file.path) && !/(?:^|[/\\])index\.ts$/u.test(file.path));
  if (indexFile) {
    for (const file of sourceModules) {
      const exportLine = `export * from "./${basenameNoExt(file.path)}.js";`;
      if (!indexFile.content.includes(exportLine)) {
        out.push({
          id: `deficit:missing_export:${basenameNoExt(file.path)}`,
          title: `Export ${basenameNoExt(file.path)}`,
          reason: `deficit:missing_export:${basenameNoExt(file.path)} keeps a source module unreachable from the public kernel barrel`,
          kind: "missing_export",
          filePath: indexFile.path,
          severity: 0.62,
          expectedText: exportLine
        });
      }
    }
  }
  for (const pattern of goal.disallowedPatterns ?? []) {
    for (const file of files) {
      if (file.content.includes(pattern)) {
        out.push({
          id: `deficit:disallowed:${hashish(`${file.path}:${pattern}`)}`,
          title: `Remove disallowed source pattern`,
          reason: `deficit:disallowed:${hashish(`${file.path}:${pattern}`)} matched a prohibited source phrase in ${file.path}`,
          kind: "disallowed_pattern",
          filePath: file.path,
          severity: 0.8,
          expectedText: pattern
        });
      }
    }
  }
  for (const capability of goal.requiredCapabilities) {
    const capabilityFeatures = featureSet(capability, 64);
    const best = Math.max(0, ...files.map(file => weightedJaccard(capabilityFeatures, featureSet(file.content, 256))));
    if (best < 0.04) {
      out.push({
        id: `deficit:thin_surface:${hashish(capability)}`,
        title: `Deepen capability surface`,
        reason: `deficit:thin_surface:${hashish(capability)} has weak coupling between the goal and source files`,
        kind: "thin_surface",
        severity: clamp01(1 - best)
      });
    }
  }
  const requiredStorage = goal.requiredCapabilities.filter(capability => /memory|persist|storage|postgres|trace|alignment|episode|patch/u.test(capability.toLowerCase()));
  if (requiredStorage.length && storageNodes.length === 0) {
    out.push({
      id: "deficit:missing_storage_table:goal",
      title: "Add durable storage tables",
      reason: "deficit:missing_storage_table:goal requested durable cognition but no storage table contract was detected",
      kind: "missing_storage_table",
      severity: 0.76
    });
  }
  return out.sort((a, b) => b.severity - a.severity);
}

function proposePatches(deficit: Deficit, files: readonly SelfRewriteFile[], goal: SelfRewriteGoal, idFactory: IdFactory, hasher: Hasher): SelfPatchProposal[] {
  if (deficit.kind === "missing_export" && deficit.filePath && deficit.expectedText) {
    const file = files.find(candidate => candidate.path === deficit.filePath);
    if (!file) return [];
    const newContent = file.content.endsWith("\n") ? `${file.content}${deficit.expectedText}\n` : `${file.content}\n${deficit.expectedText}\n`;
    return [patchProposal({
      file,
      newContent,
      title: deficit.title,
      rationale: `${deficit.reason}; append a public barrel export`,
      approvalMode: goal.approvalMode,
      idFactory,
      hasher
    })];
  }
  if (deficit.kind === "disallowed_pattern" && deficit.filePath && deficit.expectedText) {
    const file = files.find(candidate => candidate.path === deficit.filePath);
    if (!file) return [];
    const replacement = `[removed:${hashish(deficit.expectedText)}]`;
    const newContent = file.content.split(deficit.expectedText).join(replacement);
    return [patchProposal({
      file,
      newContent,
      title: deficit.title,
      rationale: `${deficit.reason}; replace prohibited phrase with deterministic redaction marker`,
      approvalMode: goal.approvalMode,
      idFactory,
      hasher
    })];
  }
  return [];
}

function patchProposal(input: {
  file: SelfRewriteFile;
  newContent: string;
  title: string;
  rationale: string;
  approvalMode: SelfRewriteGoal["approvalMode"];
  idFactory: IdFactory;
  hasher: Hasher;
}): SelfPatchProposal {
  const beforeHash = input.hasher.digestHex(input.file.content);
  const afterHash = input.hasher.digestHex(input.newContent);
  const diff = unifiedDiff(input.file.path, input.file.content, input.newContent);
  const changedLines = Math.max(1, diff.split("\n").filter(line => /^[+-]/u.test(line) && !/^(?:---|\+\+\+)/u.test(line)).length);
  const locality = clamp01(1 / Math.log2(changedLines + 2));
  const dependencyRisk = clamp01(importSpecifiers(input.newContent).filter(spec => !importSpecifiers(input.file.content).includes(spec)).length / 8);
  const semanticGain = clamp01(weightedJaccard(featureSet(input.title, 64), featureSet(`${input.rationale}\n${input.newContent}`, 256)) + 0.25);
  const safety = clamp01(1 - dependencyRisk);
  const total = clamp01(0.38 * semanticGain + 0.28 * locality + 0.24 * safety + 0.1 * (1 - dependencyRisk));
  return {
    id: input.idFactory.semanticId("self_rewrite_patch", { path: input.file.path, beforeHash, afterHash, title: input.title }),
    filePath: input.file.path,
    beforeHash,
    afterHash,
    title: input.title,
    rationale: input.rationale,
    unifiedDiff: diff,
    score: { semanticGain, locality, safety, dependencyRisk, total },
    approvalRequired: input.approvalMode !== "temporary_operator_grant"
  };
}

function scoreImprovement(input: {
  goal: SelfRewriteGoal;
  deficits: readonly Deficit[];
  patchProposals: readonly SelfPatchProposal[];
  graph?: GraphSlice;
  model?: ModelState;
  evidence?: EvidenceSpan[];
}): JsonValue {
  const deficitMass = input.deficits.reduce((sum, deficit) => sum + deficit.severity, 0);
  const patchMass = input.patchProposals.reduce((sum, patch) => sum + patch.score.total, 0);
  const graphGrounding = input.graph ? clamp01((input.graph.nodes.length + input.graph.edges.length) / 5000) : 0;
  const learningGrounding = input.model ? clamp01((input.model.learningGoals.length + input.model.latentConcepts.length) / 128) : 0;
  const evidenceGrounding = input.evidence ? clamp01(input.evidence.length / 64) : 0;
  return toJsonValue({
    target: input.goal.target,
    deficitMass,
    patchMass,
    graphGrounding,
    learningGrounding,
    evidenceGrounding,
    estimatedGain: clamp01((patchMass / Math.max(1, deficitMass)) * 0.62 + graphGrounding * 0.16 + learningGrounding * 0.12 + evidenceGrounding * 0.1),
    approvalMode: input.goal.approvalMode
  });
}

function deficitEdges(deficits: readonly Deficit[]): SelfProgramEdge[] {
  return deficits
    .filter(deficit => deficit.filePath)
    .map(deficit => ({ source: deficit.id, target: fileId(deficit.filePath!), relation: "violates" as const, weight: deficit.severity }));
}

function importSpecifiers(content: string): string[] {
  return [
    ...[...content.matchAll(/import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/gu)].map(match => match[1]!),
    ...[...content.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/gu)].map(match => match[1]!)
  ];
}

function exportedSymbols(content: string): string[] {
  return [
    ...[...content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)].map(match => match[1]!),
    ...[...content.matchAll(/export\s+\{([^}]+)\}/gu)].flatMap(match => match[1]!.split(",").map(item => item.trim().split(/\s+as\s+/u)[1] ?? item.trim().split(/\s+as\s+/u)[0] ?? "").filter(Boolean))
  ];
}

function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n`;
  const beforeLines = before.replace(/\r\n?/gu, "\n").split("\n");
  const afterLines = after.replace(/\r\n?/gu, "\n").split("\n");
  const prefix = commonPrefix(beforeLines, afterLines);
  const suffix = commonSuffix(beforeLines.slice(prefix), afterLines.slice(prefix));
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  const start = Math.max(0, prefix - 3);
  const beforeContextEnd = Math.min(beforeLines.length, prefix + removed.length + 3);
  const afterContextEnd = Math.min(afterLines.length, prefix + added.length + 3);
  const beforeContext = beforeLines.slice(start, prefix);
  const afterTail = afterLines.slice(prefix + added.length, afterContextEnd);
  const oldCount = beforeContextEnd - start;
  const newCount = afterContextEnd - start;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`,
    ...beforeContext.map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...afterTail.map(line => ` ${line}`)
  ].join("\n");
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length - i && i < b.length - i && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function fileId(path: string): string {
  return `file:${path.replace(/\\/gu, "/")}`;
}

function basenameNoExt(path: string): string {
  const name = path.replace(/\\/gu, "/").split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/u, "");
}

function hashish(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

import type { BuildTestResult, ConstructGraph, EmissionGraph, EpisodeId, EvidenceSpan, FileArtifact, Hasher, JsonValue, ProgramConstructIntent, ProgramGraph, SemanticEntailmentResult, ValidationGraph } from "./types.js";
import type { IdFactory } from "./ids.js";
import { featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { createProgramPlanner } from "./program-planner.js";
import { formatSurfaceMessage, validationMessageKey } from "./localization.js";

interface ProgramActivationDecision {
  activate: boolean;
  pressure: number;
  reasons: string[];
  evidenceCoupling: number;
  proofPressure: number;
  explicitIntent: boolean;
  engineeringEvidence: number;
  sourceShapeSignal: boolean;
  sourceEvidenceShapeSignal: boolean;
}

export function createProgramGraphBuilder(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    build(input: { episodeId: EpisodeId; text: string; entailment: SemanticEntailmentResult; evidence: EvidenceSpan[]; createdAt: number; programIntent?: ProgramConstructIntent }): ConstructGraph {
      const activation = programActivation(input.text, input.entailment, input.evidence, input.programIntent);
      const shouldEmitProgram = activation.activate;
      const artifacts: FileArtifact[] = [];
      let program: ProgramGraph | undefined;
      if (shouldEmitProgram) {
        program = synthesizeProgramGraph(input, options.idFactory, options.hasher);
        artifacts.push(...program.files);
      }
      const families = constructFamilies(input, activation);
      const constructId = options.idFactory.constructId({ episodeId: input.episodeId, proofId: input.entailment.proof.id, artifactHashes: artifacts.map(a => a.contentHash) });
      return {
        id: constructId,
        episodeId: input.episodeId,
        forceVector: toJsonValue({ force: input.entailment.force, support: input.entailment.support, contradiction: input.entailment.contradiction, artifactCount: artifacts.length, constructFamilies: families.map(family => family.kind), programActivation: activation }),
        nodes: [
          { id: "request", kind: "owner_input", label: validationMessageKey("construct.node.owner_request"), metadata: { textHash: options.hasher.digestHex(input.text) } },
          { id: "proof", kind: "semantic_proof", label: String(input.entailment.proof.id), metadata: { force: input.entailment.force } },
          ...families,
          ...(program ? program.nodes : [])
        ],
        edges: [
          { source: "request", target: "proof", relation: "validated_by", weight: input.entailment.support },
          ...families.map(family => ({ source: "proof", target: family.id, relation: "licenses_construct_family", weight: Number((family.metadata as { activation?: number }).activation ?? 0.5) })),
          ...(program ? program.edges : [])
        ],
        program,
        artifacts
      };
    }
  };
}

function constructFamilies(input: { text: string; entailment: SemanticEntailmentResult; evidence: EvidenceSpan[]; programIntent?: ProgramConstructIntent }, activation: ProgramActivationDecision): ConstructGraph["nodes"] {
  const features = featureSet(input.text, 512);
  const evidenceFeatures = [...new Set(input.evidence.flatMap(span => span.features.slice(0, 96)))];
  const coupling = evidenceFeatures.length ? weightedJaccard(features, evidenceFeatures) : 0;
  const proofStrength = Math.min(1, 0.55 * input.entailment.support + 0.25 * input.entailment.faithfulnessLcb + 0.2 * (1 - input.entailment.contradiction));
  const familyDefs = [
    { id: "family:answer", kind: "construct:answer", label: validationMessageKey("construct.family.answer"), activation: proofStrength },
    { id: "family:program", kind: "construct:program", label: validationMessageKey("construct.family.program"), activation: activation.pressure },
    { id: "family:translation", kind: "construct:translation", label: validationMessageKey("construct.family.translation"), activation: Math.min(1, coupling + Math.min(1, input.evidence.length / 16) * 0.35) },
    { id: "family:action", kind: "construct:action_plan", label: validationMessageKey("construct.family.action"), activation: Math.min(1, input.entailment.support * 0.45 + input.evidence.length / 20) },
    { id: "family:learning", kind: "construct:learning_plan", label: validationMessageKey("construct.family.learning"), activation: Math.max(0.12, 1 - proofStrength) },
    { id: "family:forecast", kind: "construct:forecast", label: validationMessageKey("construct.family.forecast"), activation: Math.min(1, input.evidence.length / 24 + input.entailment.support * 0.3) },
    { id: "family:simulation", kind: "construct:simulation", label: validationMessageKey("construct.family.simulation"), activation: Math.min(1, input.entailment.contradiction + (1 - input.entailment.faithfulnessLcb) * 0.5) }
  ];
  return familyDefs
    .filter(family => family.activation > 0.08)
    .map(family => ({
      id: family.id,
      kind: family.kind,
      label: family.label,
      metadata: toJsonValue({
        activation: Number(family.activation.toFixed(4)),
        proofId: input.entailment.proof.id,
        evidenceCount: input.evidence.length,
        support: input.entailment.support,
        contradiction: input.entailment.contradiction,
        programActivation: family.id === "family:program" ? activation : undefined
      })
    }));
}

export function createValidationGraphBuilder(options: { idFactory: IdFactory }) {
  return {
    build(input: { construct: ConstructGraph; entailment: SemanticEntailmentResult; buildTest?: BuildTestResult; pca?: JsonValue }): ValidationGraph {
      const checks: ValidationGraph["checks"] = [
        {
          id: "semantic-proof-present",
          status: input.entailment.proof.proofGraph.nodes.length > 0 ? "passed" : "failed",
          score: input.entailment.support,
          message: validationMessageKey("validation.semantic_proof_present"),
          evidenceIds: input.entailment.evidenceIds
        },
        {
          id: "alpha-boundary",
          status: input.entailment.contradiction > 0.45 ? "failed" : input.entailment.contradiction > 0.2 ? "warning" : "passed",
          score: 1 - input.entailment.contradiction,
          message: validationMessageKey("validation.alpha_boundary"),
          evidenceIds: input.entailment.evidenceIds
        }
      ];
      for (const artifact of input.construct.artifacts) {
        const safePath = artifact.path.length > 0 && !artifact.path.includes("..") && !artifact.path.startsWith("/") && !hasDrivePrefix(artifact.path);
        checks.push({ id: `file-path:${artifact.path}`, status: safePath ? "passed" : "failed", score: safePath ? 1 : 0, message: validationMessageKey(safePath ? "validation.file_path_passed" : "validation.file_path_failed"), evidenceIds: [] });
      }
      if (input.construct.program) {
        const passed = input.buildTest?.passed ?? false;
        checks.push({ id: "program-build-test", status: passed ? "passed" : "failed", score: passed ? 1 : 0, message: validationMessageKey(passed ? "validation.program_passed" : "validation.program_failed"), evidenceIds: input.entailment.evidenceIds });
      }
      if (input.pca && typeof input.pca === "object" && !Array.isArray(input.pca)) {
        const report = input.pca as { supportedSentences?: number; totalSentences?: number; unsupportedSymbolRatio?: number; rejected?: unknown[] };
        const total = report.totalSentences ?? 0;
        const supported = report.supportedSentences ?? 0;
        const ratio = total ? supported / total : 0;
        const unsupported = report.unsupportedSymbolRatio ?? 1;
        checks.push({
          id: "proof-carrying-answer",
          status: total === 0 ? "warning" : unsupported > 0.62 ? "failed" : ratio < 0.5 ? "warning" : "passed",
          score: Math.max(0, ratio * (1 - unsupported)),
          message: validationMessageKey("validation.pca_attached"),
          evidenceIds: input.entailment.evidenceIds
        });
      }
      return {
        id: options.idFactory.validationId({ constructId: input.construct.id, checks: checks.map(c => [c.id, c.status]) }),
        constructId: input.construct.id,
        pca: input.pca,
        checks,
        passed: checks.every(check => check.status !== "failed")
      };
    }
  };
}

export function createEmissionEngine(options: { idFactory: IdFactory }) {
  return {
    emit(input: { construct: ConstructGraph; validation: ValidationGraph; entailment: SemanticEntailmentResult; answer: string; pca?: JsonValue }): EmissionGraph {
      const pcaAnswer = pcaReleaseAnswer(input.pca);
      const releaseAnswer = pcaAnswer ?? input.answer;
      const hasArtifacts = input.construct.artifacts.length > 0;
      return {
        id: options.idFactory.emissionId({ constructId: input.construct.id, validationId: input.validation.id }),
        constructId: input.construct.id,
        answer: input.validation.passed || !hasArtifacts ? releaseAnswer : `${releaseAnswer}\n\n${formatSurfaceMessage("validation.artifact_emission_failed")}`,
        epistemicForce: input.entailment.force,
        artifacts: input.validation.passed ? input.construct.artifacts : [],
        evidenceIds: input.entailment.evidenceIds,
        proofId: input.entailment.proof.id,
        pca: input.pca
      };
    }
  };
}

function pcaReleaseAnswer(pca: JsonValue | undefined): string | undefined {
  if (!pca || typeof pca !== "object" || Array.isArray(pca)) return undefined;
  const value = (pca as Record<string, JsonValue>).releaseAnswer;
  return typeof value === "string" ? value : undefined;
}

function programActivation(text: string, entailment: SemanticEntailmentResult, evidence: EvidenceSpan[], programIntent?: ProgramConstructIntent): ProgramActivationDecision {
  const requestFeatures = featureSet(text, 512);
  const evidenceCoupling = evidence.length
    ? Math.max(...evidence.map(span => weightedJaccard(requestFeatures, span.features) * span.alpha))
    : 0;
  const proofPressure = 0.5 * entailment.support + 0.3 * entailment.faithfulnessLcb + 0.2 * (1 - entailment.contradiction);
  const engineeringEvidence = evidence.filter(span => hasEngineeringCorpusMetadata(span)).length;
  const explicitIntent = hasExplicitProgramIntent(requestFeatures);
  const sourceShapeSignal = hasSourceShapeSignal(text);
  const sourceEvidenceShapeSignal = evidence.some(span => hasSourceEvidenceShape(span));
  const reasons: string[] = [];
  if (programIntent) reasons.push("program.activation.structured_intent");
  if (engineeringEvidence > 0 && (evidenceCoupling >= 0.08 || explicitIntent || sourceShapeSignal)) reasons.push("program.activation.engineering_evidence");
  if (explicitIntent) reasons.push("program.activation.explicit_request");
  if (sourceShapeSignal && evidence.length > 0) reasons.push("program.activation.source_shape");
  if (explicitIntent && sourceEvidenceShapeSignal) reasons.push("program.activation.source_evidence_shape");
  const activate = reasons.length > 0;
  const rawPressure = Math.min(1, Math.max(
    programIntent ? 1 : 0,
    engineeringEvidence > 0 ? 0.72 + Math.min(0.18, evidenceCoupling) : 0,
    explicitIntent ? 0.78 : 0,
    sourceShapeSignal && evidence.length > 0 ? 0.64 : 0,
    explicitIntent && sourceEvidenceShapeSignal ? 0.7 : 0,
    0.55 * evidenceCoupling + 0.35 * proofPressure + 0.1 * Math.min(1, evidence.length / 4)
  ));
  return {
    activate,
    pressure: activate ? rawPressure : Math.min(0.12, rawPressure * 0.18),
    reasons,
    evidenceCoupling: Number(evidenceCoupling.toFixed(6)),
    proofPressure: Number(proofPressure.toFixed(6)),
    explicitIntent,
    engineeringEvidence,
    sourceShapeSignal,
    sourceEvidenceShapeSignal
  };
}

function synthesizeProgramGraph(input: { episodeId: EpisodeId; text: string; entailment: SemanticEntailmentResult; evidence: EvidenceSpan[]; programIntent?: ProgramConstructIntent }, idFactory: IdFactory, hasher: Hasher): ProgramGraph {
  return createProgramPlanner({ idFactory, hasher }).emit({ episodeId: input.episodeId, requestText: input.text, entailment: input.entailment, evidence: input.evidence, programIntent: input.programIntent });
}

function hasDrivePrefix(path: string): boolean {
  if (path.length < 2 || path[1] !== ":") return false;
  const cp = path.charCodeAt(0);
  return cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122;
}

function hasEngineeringCorpusMetadata(span: EvidenceSpan): boolean {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
  const metadata = provenance.metadata && typeof provenance.metadata === "object" && !Array.isArray(provenance.metadata) ? provenance.metadata as Record<string, JsonValue> : {};
  return Boolean(metadata.engineeringCorpus || metadata.repositoryFacts || metadata.sourceCode);
}

function hasExplicitProgramIntent(features: readonly string[]): boolean {
  const set = new Set(features);
  const action = hasAny(set, [
    "sym:build",
    "sym:create",
    "sym:design",
    "sym:emit",
    "sym:fix",
    "sym:generate",
    "sym:implement",
    "sym:modify",
    "sym:patch",
    "sym:repair",
    "sym:update",
    "sym:write"
  ]);
  const object = hasAny(set, [
    "sym:api",
    "sym:app",
    "sym:artifact",
    "sym:cli",
    "sym:code",
    "sym:command",
    "sym:csv",
    "sym:file",
    "sym:function",
    "sym:handler",
    "sym:json",
    "sym:library",
    "sym:module",
    "sym:package",
    "sym:parser",
    "sym:patch",
    "sym:program",
    "sym:repo",
    "sym:repository",
    "sym:script",
    "sym:source",
    "sym:test",
    "sym:tool",
    "sym:transformer",
    "sym:website"
  ]);
  return action && object;
}

function hasSourceEvidenceShape(span: EvidenceSpan): boolean {
  const mediaType = span.mediaType.toLocaleLowerCase();
  if (mediaType.includes("csv") || mediaType.includes("tsv") || mediaType.includes("json") || mediaType.includes("log") || mediaType.includes("javascript") || mediaType.includes("typescript")) return true;
  const text = span.textPreview || span.text || "";
  return text.includes("\n") && (text.includes(",") || text.includes("\t") || text.includes("{") || text.includes("}") || text.includes("=>") || text.includes("()"));
}

function hasSourceShapeSignal(text: string): boolean {
  const value = text.toLocaleLowerCase();
  return value.includes("```") ||
    value.includes("=>") ||
    value.includes("()") ||
    value.includes("{") && value.includes("}") ||
    value.includes("./") ||
    value.includes("../") ||
    value.includes("src/") ||
    value.includes("packages/") ||
    value.includes(" --") ||
    value.includes("::");
}

function hasAny(values: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some(candidate => values.has(candidate));
}

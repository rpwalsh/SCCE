import type {
  CapabilityPlan,
  ConstructGraph,
  EmissionGraph,
  EpisodeId,
  EventId,
  EvidenceId,
  EvidenceSpan,
  ForecastEnvelope,
  FunctionalSelfState,
  GraphSlice,
  InspectionTarget,
  JsonValue,
  ScceEvent,
  SemanticProof,
  ValidationGraph
} from "./types.js";
import { canonicalStringify, createHasher, mean, toJsonValue } from "./primitives.js";
import { hashEvent } from "./events.js";

export interface EventChainVerification {
  ok: boolean;
  events: number;
  firstEventId?: EventId;
  lastEventId?: EventId;
  brokenHashes: Array<{ eventId: EventId; expected: string; observed: string }>;
  missingParents: Array<{ eventId: EventId; parentId: EventId }>;
  timeViolations: Array<{ eventId: EventId; previousT: number; currentT: number }>;
  typeHistogram: Record<string, number>;
}

export interface EpisodeAuditBundle {
  episodeId: EpisodeId;
  eventChain: EventChainVerification;
  evidence: EvidenceAuditSummary;
  proof?: ProofAuditSummary;
  construct?: ConstructAuditSummary;
  capabilities: CapabilityAuditSummary;
  forecast?: ForecastAuditSummary;
  self?: FunctionalSelfState;
  residualRisk: number;
  report: JsonValue;
}

export interface EvidenceAuditSummary {
  count: number;
  promoted: number;
  quarantined: number;
  sourceVersions: number;
  meanAlpha: number;
  meanSpanBytes: number;
  topFeatures: Array<{ feature: string; count: number }>;
  spans: Array<{ id: EvidenceId; sourceVersionId: string; byteRange: [number, number]; alpha: number; status: string; preview: string }>;
}

export interface ProofAuditSummary {
  proofId: string;
  verdict: string;
  evidenceCount: number;
  transformCount: number;
  proofNodes: number;
  proofEdges: number;
  supportEdges: number;
  contradictionEdges: number;
  boundaryCount: number;
  confidence: JsonValue;
}

export interface ConstructAuditSummary {
  constructId: string;
  nodeCount: number;
  edgeCount: number;
  artifactCount: number;
  programFiles: number;
  validationPassed?: boolean;
  validationWarnings: number;
  emissionForce?: string;
}

export interface CapabilityAuditSummary {
  calls: number;
  planned: number;
  invoked: number;
  succeeded: number;
  failed: number;
  mutating: number;
  dryRun: number;
  meanRisk: number;
}

export interface ForecastAuditSummary {
  forecastId: string;
  horizon: number;
  dimensions: number;
  meanWidth: number;
  createdAt: number;
}

export interface ReplayDiff {
  equal: boolean;
  leftHash: string;
  rightHash: string;
  changedPaths: string[];
  summary: JsonValue;
}

export function createAuditEngine() {
  const hasher = createHasher();
  return {
    verifyEventChain(events: readonly ScceEvent[]): EventChainVerification {
      const brokenHashes: EventChainVerification["brokenHashes"] = [];
      const missingParents: EventChainVerification["missingParents"] = [];
      const timeViolations: EventChainVerification["timeViolations"] = [];
      const typeHistogram: Record<string, number> = {};
      const byId = new Map(events.map(event => [event.id, event]));
      let previousT = -Infinity;
      for (const event of events) {
        typeHistogram[String(event.typeId)] = (typeHistogram[String(event.typeId)] ?? 0) + 1;
        const parentHashes = event.parents.map(parent => byId.get(parent)?.hash ?? "");
        const expected = hashEvent({ id: event.id, episodeId: event.episodeId, typeId: event.typeId, t: event.t, payload: event.payload, parents: event.parents }, parentHashes, hasher);
        if (event.hash !== expected) brokenHashes.push({ eventId: event.id, expected, observed: event.hash });
        for (const parent of event.parents) if (!byId.has(parent)) missingParents.push({ eventId: event.id, parentId: parent });
        if (event.t < previousT) timeViolations.push({ eventId: event.id, previousT, currentT: event.t });
        previousT = Math.max(previousT, event.t);
      }
      return {
        ok: brokenHashes.length === 0 && missingParents.length === 0 && timeViolations.length === 0,
        events: events.length,
        firstEventId: events[0]?.id,
        lastEventId: events[events.length - 1]?.id,
        brokenHashes,
        missingParents,
        timeViolations,
        typeHistogram
      };
    },

    summarizeEvidence(evidence: readonly EvidenceSpan[]): EvidenceAuditSummary {
      const features = new Map<string, number>();
      for (const span of evidence) for (const feature of span.features.slice(0, 200)) features.set(feature, (features.get(feature) ?? 0) + 1);
      return {
        count: evidence.length,
        promoted: evidence.filter(span => span.status === "promoted").length,
        quarantined: evidence.filter(span => span.status === "quarantined").length,
        sourceVersions: new Set(evidence.map(span => span.sourceVersionId)).size,
        meanAlpha: mean(evidence.map(span => span.alpha)),
        meanSpanBytes: mean(evidence.map(span => span.byteEnd - span.byteStart)),
        topFeatures: [...features.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 32).map(([feature, count]) => ({ feature, count })),
        spans: evidence.slice(0, 128).map(span => ({
          id: span.id,
          sourceVersionId: String(span.sourceVersionId),
          byteRange: [span.byteStart, span.byteEnd],
          alpha: span.alpha,
          status: span.status,
          preview: span.textPreview
        }))
      };
    },

    summarizeProof(proof: SemanticProof | undefined): ProofAuditSummary | undefined {
      if (!proof) return undefined;
      return {
        proofId: String(proof.id),
        verdict: proof.verdict,
        evidenceCount: proof.evidenceIds.length,
        transformCount: proof.transformIds.length,
        proofNodes: proof.proofGraph.nodes.length,
        proofEdges: proof.proofGraph.edges.length,
        supportEdges: proof.proofGraph.edges.filter(edge => edge.relation === "supports").length,
        contradictionEdges: proof.proofGraph.edges.filter(edge => edge.relation === "contradicts").length,
        boundaryCount: proof.proofGraph.nodes.filter(node => node.kind === "boundary").length,
        confidence: proof.confidence
      };
    },

    summarizeConstruct(input: { construct?: ConstructGraph; validation?: ValidationGraph; emission?: EmissionGraph }): ConstructAuditSummary | undefined {
      const construct = input.construct;
      if (!construct) return undefined;
      return {
        constructId: String(construct.id),
        nodeCount: construct.nodes.length,
        edgeCount: construct.edges.length,
        artifactCount: construct.artifacts.length,
        programFiles: construct.program?.files.length ?? 0,
        validationPassed: input.validation?.passed,
        validationWarnings: input.validation?.checks.filter(check => check.status === "warning").length ?? 0,
        emissionForce: input.emission?.epistemicForce
      };
    },

    summarizeCapabilities(plans: readonly CapabilityPlan[]): CapabilityAuditSummary {
      const risk = plans.map(plan => riskScalar(plan.riskVector));
      return {
        calls: plans.length,
        planned: plans.filter(plan => plan.status === "planned").length,
        invoked: plans.filter(plan => plan.status === "invoked").length,
        succeeded: plans.filter(plan => plan.status === "succeeded").length,
        failed: plans.filter(plan => plan.status === "failed").length,
        mutating: plans.filter(plan => Boolean((plan.permission as { mutates?: boolean }).mutates)).length,
        dryRun: plans.filter(plan => Boolean((plan.permission as { dryRun?: boolean }).dryRun)).length,
        meanRisk: mean(risk)
      };
    },

    summarizeForecast(forecast: ForecastEnvelope | undefined): ForecastAuditSummary | undefined {
      if (!forecast) return undefined;
      return {
        forecastId: String(forecast.id),
        horizon: forecast.horizon,
        dimensions: forecast.mean.length,
        meanWidth: mean(forecast.interval.map(item => item.high - item.low)),
        createdAt: forecast.createdAt
      };
    },

    bundle(input: {
      episodeId: EpisodeId;
      events: readonly ScceEvent[];
      evidence: readonly EvidenceSpan[];
      proof?: SemanticProof;
      construct?: ConstructGraph;
      validation?: ValidationGraph;
      emission?: EmissionGraph;
      capabilities?: readonly CapabilityPlan[];
      forecast?: ForecastEnvelope;
      self?: FunctionalSelfState;
    }): EpisodeAuditBundle {
      const eventChain = this.verifyEventChain(input.events);
      const evidence = this.summarizeEvidence(input.evidence);
      const proof = this.summarizeProof(input.proof);
      const construct = this.summarizeConstruct(input);
      const capabilities = this.summarizeCapabilities(input.capabilities ?? []);
      const forecast = this.summarizeForecast(input.forecast);
      const residual = residualRisk({ eventChain, evidence, proof, construct, capabilities, forecast });
      const report = toJsonValue({ episodeId: input.episodeId, eventChain, evidence, proof, construct, capabilities, forecast, self: input.self ?? null, residualRisk: residual });
      return { episodeId: input.episodeId, eventChain, evidence, proof, construct, capabilities, forecast, self: input.self, residualRisk: residual, report };
    },

    replayDiff(left: JsonValue, right: JsonValue): ReplayDiff {
      const leftHash = hasher.digestHex(canonicalStringify(left));
      const rightHash = hasher.digestHex(canonicalStringify(right));
      const changedPaths = diffPaths(left, right, []);
      return { equal: leftHash === rightHash, leftHash, rightHash, changedPaths, summary: toJsonValue({ changed: changedPaths.length, changedPaths: changedPaths.slice(0, 64) }) };
    },

    inspectGraphSlice(slice: GraphSlice): JsonValue {
      const typeCounts: Record<string, number> = {};
      for (const node of slice.nodes) {
        const type = String((node.metadata as { type?: string }).type ?? node.typeId);
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      }
      return toJsonValue({
        bounded: slice.bounded,
        query: slice.query,
        nodes: slice.nodes.length,
        edges: slice.edges.length,
        hyperedges: slice.hyperedges.length,
        typeCounts,
        meanNodeAlpha: mean(slice.nodes.map(node => node.alpha)),
        meanEdgeAlpha: mean(slice.edges.map(edge => edge.alpha)),
        evidenceRefs: new Set([...slice.nodes.flatMap(node => node.evidenceIds), ...slice.edges.flatMap(edge => edge.evidenceIds)]).size
      });
    },

    targetLabel(target: InspectionTarget): string {
      if (typeof target === "string") return target;
      if (target.kind === "episode") return `${target.kind}:${target.episodeId}`;
      if (target.kind === "event") return `${target.kind}:${target.eventId}`;
      if (target.kind === "brain-import") return `${target.kind}:${target.importRunId}`;
      return "inspect-target";
    }
  };
}

function riskScalar(value: JsonValue): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, JsonValue>;
  return typeof record.risk === "number" ? record.risk : typeof record.alphaRisk === "number" ? record.alphaRisk : 0;
}

function residualRisk(input: {
  eventChain: EventChainVerification;
  evidence: EvidenceAuditSummary;
  proof?: ProofAuditSummary;
  construct?: ConstructAuditSummary;
  capabilities: CapabilityAuditSummary;
  forecast?: ForecastAuditSummary;
}): number {
  let risk = 0;
  if (!input.eventChain.ok) risk += 0.35;
  if (input.evidence.count === 0) risk += 0.25;
  if (input.evidence.quarantined > input.evidence.promoted) risk += 0.12;
  if (!input.proof) risk += 0.15;
  else if (input.proof.boundaryCount > 0) risk += 0.06;
  if (input.construct && input.construct.validationPassed === false) risk += 0.2;
  if (input.capabilities.failed > 0) risk += 0.1;
  risk += Math.min(0.2, input.capabilities.meanRisk * 0.2);
  return Math.max(0, Math.min(1, risk));
}

function diffPaths(left: JsonValue, right: JsonValue, prefix: string[]): string[] {
  if (Object.is(left, right)) return [];
  if (typeof left !== typeof right) return [pathLabel(prefix)];
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return left === right ? [] : [pathLabel(prefix)];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [pathLabel(prefix)];
    const n = Math.max(left.length, right.length);
    return Array.from({ length: n }, (_, i) => diffPaths(left[i] ?? null, right[i] ?? null, [...prefix, String(i)])).flat().slice(0, 512);
  }
  const l = left as Record<string, JsonValue>;
  const r = right as Record<string, JsonValue>;
  const keys = [...new Set([...Object.keys(l), ...Object.keys(r)])].sort();
  return keys.flatMap(key => diffPaths(l[key] ?? null, r[key] ?? null, [...prefix, key])).slice(0, 512);
}

function pathLabel(prefix: string[]): string {
  return prefix.length ? prefix.join(".") : "$";
}

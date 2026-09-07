// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan, GraphEdge, GraphNode, Hyperedge, JsonValue, LanguageProfile, SourceVersionId } from "./types.js";
import type { IdFactory } from "./ids.js";
import { clamp01, toJsonValue, weightedJaccard } from "./primitives.js";
import { atomizeText, propositionNodeRepresentation } from "./semantic-proof-system.js";
import { SEMANTIC_SOURCE } from "./semantic-codes.js";
import { evidenceProofBoundary } from "./proof-boundary.js";

export interface SourceGraphBuildInput {
  sourceVersionId: SourceVersionId;
  uri: string;
  mediaType: string;
  languageProfile: LanguageProfile;
  evidence: EvidenceSpan[];
  observedAt: number;
}

export interface SourceGraphBuildResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hyperedges: Hyperedge[];
  diagnostics: {
    sourceVersionId: SourceVersionId;
    evidenceCount: number;
    nodeCount: number;
    edgeCount: number;
    hyperedgeCount: number;
    propositionCount: number;
    symbolCount: number;
    sectionCount: number;
    scriptCount: number;
    meanEvidenceAlpha: number;
  };
}

/** Propositions kept per evidence span. A span states a bounded number of things; the rest is apparatus. */
const MAX_PROPOSITIONS_PER_SPAN = 24;

export function createSourceGraphBuilder(deps: { idFactory: IdFactory }) {
  return {
    build(input: SourceGraphBuildInput): SourceGraphBuildResult {
      const nodes = new Map<string, GraphNode>();
      const edges = new Map<string, GraphEdge>();
      const hyperedges = new Map<string, Hyperedge>();
      const t = input.observedAt;
      let propositionCount = 0;
      const sourceNode = node(deps.idFactory, input.sourceVersionId, "source-version", { sourceVersionId: input.sourceVersionId, uri: input.uri, mediaType: input.mediaType }, ["source", `media:${input.mediaType}`, `uri:${input.uri}`], [], 0.72, t, { uri: input.uri });
      nodes.set(sourceNode.id, sourceNode);

      const scriptNodes = input.languageProfile.scripts.slice(0, 6).map(script => {
        const n = node(deps.idFactory, ["script", script.script], "script", script, [`script:${script.script}`], [], clamp01(0.3 + script.mass * 0.7), t, { script: script.script });
        nodes.set(n.id, n);
        edges.set(`${sourceNode.id}:${n.id}`, edge(deps.idFactory, sourceNode, n, "has-script", [], n.alpha, t, { mass: script.mass }));
        return n;
      });

      const sectionNodes = new Map<string, GraphNode>();
      const symbolNodes = new Map<string, GraphNode>();
      for (const span of input.evidence) {
        const evidenceNode = node(deps.idFactory, span.chunkId, "evidence-chunk", { chunkId: span.chunkId, preview: span.textPreview, byteStart: span.byteStart, byteEnd: span.byteEnd }, span.features.slice(0, 260), [span.id], span.alpha, t, { sourceVersionId: span.sourceVersionId });
        nodes.set(evidenceNode.id, evidenceNode);
        edges.set(`${sourceNode.id}:${evidenceNode.id}:contains`, edge(deps.idFactory, sourceNode, evidenceNode, "contains", [span.id], 0.86, t, { byteRange: [span.byteStart, span.byteEnd] }));

        const sectionTitle = sectionTitleFromSpan(span);
        if (sectionTitle) {
          const sectionNode = sectionNodes.get(sectionTitle) ?? node(deps.idFactory, ["section", input.sourceVersionId, sectionTitle], "section", { title: sectionTitle, sourceVersionId: input.sourceVersionId }, [`section:${sectionTitle.toLowerCase()}`], [span.id], span.alpha * 0.8, t, { title: sectionTitle });
          sectionNode.evidenceIds = [...new Set([...sectionNode.evidenceIds, span.id])];
          sectionNode.alpha = Math.max(sectionNode.alpha, span.alpha * 0.8);
          sectionNodes.set(sectionTitle, sectionNode);
          nodes.set(sectionNode.id, sectionNode);
          edges.set(`${sectionNode.id}:${evidenceNode.id}:section-contains`, edge(deps.idFactory, sectionNode, evidenceNode, "section-contains", [span.id], span.alpha * 0.82, t, { sectionTitle }));
        }

        const topSymbols = span.features.filter(feature => feature.startsWith("sym:") || feature.startsWith("bi:")).slice(0, 84);
        for (const feature of topSymbols) {
          const symbolNode = symbolNodes.get(feature) ?? node(deps.idFactory, ["symbol", feature], "symbol", { feature }, [feature], [], span.alpha * 0.55, t, { feature });
          symbolNode.evidenceIds = [...new Set([...symbolNode.evidenceIds, span.id])].slice(0, 512);
          symbolNode.alpha = Math.max(symbolNode.alpha, span.alpha * 0.62);
          symbolNodes.set(feature, symbolNode);
          nodes.set(symbolNode.id, symbolNode);
          edges.set(`${evidenceNode.id}:${symbolNode.id}:mentions`, edge(deps.idFactory, evidenceNode, symbolNode, "mentions", [span.id], span.alpha * symbolWeight(feature), t, { feature }));
        }

        // The propositions this span states, written as propositions.
        //
        // atomizeText and the contradiction search over its atoms were both already complete, and both ran only
        // while a turn was in flight, so every proposition the engine derived was thrown away when the turn ended
        // and the graph kept only the symbol nodes above. A proof asking about this span then had nothing to read
        // but feature strings, and atomizing "bi:appointed|headmistress" yields the predicate "|". The atoms are
        // bound to the evidence that states them rather than gated on corroboration across sources, because the
        // claim being stored is "this source says this", not "this relation holds" -- and two sources disagreeing
        // is exactly what contradiction needs both of, so requiring agreement first would erase it.
        const spanBoundary = evidenceProofBoundary(span);
        for (const atom of atomizeText({
          text: span.text,
          source: SEMANTIC_SOURCE.EVIDENCE,
          maxAtoms: MAX_PROPOSITIONS_PER_SPAN,
          evidenceIds: [span.id],
          alpha: span.alpha,
          proofClass: spanBoundary.forceClass,
          certifiesFactualProof: spanBoundary.certifiesFactualProof,
          proofBoundaryReason: spanBoundary.reason
        })) {
          const propositionNode = node(
            deps.idFactory,
            ["proposition", input.sourceVersionId, atom.id],
            "proposition",
            propositionNodeRepresentation(atom),
            [`predicate:${atom.predicate}`, ...atom.roles.slice(0, 8).map(role => `role:${role.name}:${role.normalized}`)],
            [span.id],
            atom.alpha,
            t,
            toJsonValue({ sourceVersionId: input.sourceVersionId, predicate: atom.predicate, constraints: atom.constraints.length })
          );
          nodes.set(propositionNode.id, propositionNode);
          edges.set(
            `${evidenceNode.id}:${propositionNode.id}:states`,
            edge(deps.idFactory, evidenceNode, propositionNode, "states", [span.id], atom.alpha, t, { predicate: atom.predicate })
          );
          propositionCount += 1;
        }

        for (const scriptNode of scriptNodes) {
          const overlap = weightedJaccard(scriptNode.features, span.features);
          const weight = overlap > 0 ? overlap : scriptNode.alpha * 0.22;
          edges.set(`${evidenceNode.id}:${scriptNode.id}:written-in`, edge(deps.idFactory, evidenceNode, scriptNode, "written-in", [span.id], clamp01(weight), t, { profileId: input.languageProfile.id }));
        }

        const members = [evidenceNode, ...topSymbols.slice(0, 12).map(feature => symbolNodes.get(feature)).filter((value): value is GraphNode => Boolean(value))];
        if (members.length > 1) {
          const relationId = deps.idFactory.relationId({ relation: "evidence-feature-bag" });
          const h: Hyperedge = {
            schema: "scce.hyperedge.v2",
            id: deps.idFactory.hyperedgeId({ relationId, members: members.map(member => member.id), provenanceHash: span.id }),
            relationId,
            participantPorts: members.map((member, index) => ({
              portId: String(deps.idFactory.dimensionId({
                kind: "evidence_feature_bag_port",
                relationId,
                index
              })),
              roleId: String(deps.idFactory.dimensionId({
                kind: "evidence_feature_bag_role",
                relationId,
                memberKind: index === 0 ? "evidence_chunk" : "surface_feature"
              })),
              nodeId: member.id,
              valueKind: index === 0 ? "evidence_chunk" : "surface_feature",
              realization: "observed",
              evidenceIds: [span.id]
            })),
            memberNodeIds: members.map(member => member.id),
            qualifiers: toJsonValue({ byteRange: [span.byteStart, span.byteEnd] }),
            modality: toJsonValue({ sourceObserved: true }),
            evidenceIds: [span.id],
            weightVector: toJsonValue({ alpha: span.alpha, featureCount: topSymbols.length, byteRange: [span.byteStart, span.byteEnd] }),
            temporalScope: { validFrom: t },
            provenanceRefs: [span.id],
            createdAt: t,
            updatedAt: t
          };
          hyperedges.set(h.id, h);
        }
      }

      for (const pair of adjacentEvidence(input.evidence)) {
        const left = nodes.get(deps.idFactory.nodeId(pair.left.chunkId));
        const right = nodes.get(deps.idFactory.nodeId(pair.right.chunkId));
        if (!left || !right) continue;
        const distance = Math.max(1, pair.right.byteStart - pair.left.byteEnd);
        const weight = clamp01(0.72 / Math.log2(2 + distance));
        edges.set(`${left.id}:${right.id}:next-evidence`, edge(deps.idFactory, left, right, "next-evidence", [pair.left.id, pair.right.id], weight, t, { distanceBytes: distance }));
      }

      const nodeList = [...nodes.values()];
      const edgeList = [...edges.values()];
      const hyperedgeList = [...hyperedges.values()];
      return {
        nodes: nodeList,
        edges: edgeList,
        hyperedges: hyperedgeList,
        diagnostics: {
          sourceVersionId: input.sourceVersionId,
          evidenceCount: input.evidence.length,
          nodeCount: nodeList.length,
          edgeCount: edgeList.length,
          hyperedgeCount: hyperedgeList.length,
          propositionCount,
          symbolCount: symbolNodes.size,
          sectionCount: sectionNodes.size,
          scriptCount: scriptNodes.length,
          meanEvidenceAlpha: input.evidence.length ? input.evidence.reduce((sum, span) => sum + span.alpha, 0) / input.evidence.length : 0
        }
      };
    }
  };
}

function node(idFactory: IdFactory, representation: unknown, type: string, canonical: unknown, features: string[], evidenceIds: EvidenceSpan["id"][], alpha: number, t: number, metadata: JsonValue): GraphNode {
  return {
    id: idFactory.nodeId(representation),
    typeId: idFactory.dimensionId({ type }),
    representation: toJsonValue(canonical),
    alpha: clamp01(alpha),
    evidenceIds,
    features: [...new Set(features)].sort(),
    createdAt: t,
    updatedAt: t,
    metadata
  };
}

function edge(idFactory: IdFactory, source: GraphNode, target: GraphNode, relation: string, evidenceIds: EvidenceSpan["id"][], alpha: number, t: number, metadata: JsonValue): GraphEdge {
  const relationId = idFactory.relationId({ relation });
  return {
    id: idFactory.edgeId({ source: source.id, target: target.id, relationId, provenanceHash: evidenceIds.join("|") }),
    source: source.id,
    target: target.id,
    relationId,
    alpha: clamp01(alpha),
    weight: clamp01(alpha),
    temporalScope: { validFrom: t },
    evidenceIds,
    createdAt: t,
    updatedAt: t,
    metadata: toJsonValue({ relation, ...jsonObject(metadata) })
  };
}

function sectionTitleFromSpan(span: EvidenceSpan): string | undefined {
  const hints = span.scriptHints as { section?: { title?: string } | null };
  const title = hints.section?.title?.trim();
  return title || undefined;
}

function symbolWeight(feature: string): number {
  if (feature.startsWith("bi:")) return 0.55;
  if (feature.startsWith("sym:")) return 0.72;
  return 0.42;
}

function adjacentEvidence(evidence: EvidenceSpan[]): Array<{ left: EvidenceSpan; right: EvidenceSpan }> {
  const sorted = [...evidence].sort((a, b) => a.byteStart - b.byteStart);
  const out: Array<{ left: EvidenceSpan; right: EvidenceSpan }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (left && right) out.push({ left, right });
  }
  return out;
}

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

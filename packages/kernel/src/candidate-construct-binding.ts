import type { CandidateSurface } from "./candidate.js";
import type { CognitiveProposal } from "./cognitive-planner.js";
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import { inventionConstructNode, type InventionConstruct } from "./prediction.js";
import { toJsonValue } from "./primitives.js";
import type { ConstructGraph } from "./types.js";

export function cognitiveProposalForCandidate(
  candidate: CandidateSurface,
  proposals: readonly CognitiveProposal[]
): CognitiveProposal | undefined {
  if (candidate.proposalId) return proposals.find(proposal => proposal.id === candidate.proposalId);
  const audit = jsonRecord(candidate.audit);
  const proposalId = kernelString(audit.proposalId);
  return proposals.find(proposal => proposal.id === proposalId);
}

export function attachCognitiveProposal(input: {
  construct: ConstructGraph;
  proposal?: CognitiveProposal;
}): ConstructGraph {
  if (!input.proposal) return input.construct;
  const node = {
    id: `construct:cognitive-proposal:${input.proposal.id}`,
    kind: "construct:cognitive-proposal",
    label: "cognitive proposal",
    metadata: toJsonValue({
      schema: "scce.cognitive_proposal.construct.v1",
      proposalId: input.proposal.id,
      claimBases: input.proposal.claims.map(claim => ({
        claimId: claim.id,
        basis: claim.basis,
        evidenceIds: claim.evidenceIds,
        actionReceiptId: claim.actionReceiptId ?? null
      })),
      operatorIds: input.proposal.operatorActivations.map(operator => operator.operatorId),
      constructIds: input.proposal.constructIds,
      quality: input.proposal.quality,
      trace: input.proposal.trace
    })
  };
  return {
    ...input.construct,
    nodes: [...input.construct.nodes.filter(existing => existing.id !== node.id), node],
    edges: [
      ...input.construct.edges.filter(edge => edge.source !== node.id && edge.target !== node.id),
      {
        source: input.construct.nodes.find(existing => existing.id === "request")?.id ?? input.construct.nodes[0]?.id ?? "request",
        target: node.id,
        relation: "licenses_cognitive_proposal",
        weight: Math.max(0, Math.min(1, input.proposal.quality.mmr))
      }
    ]
  };
}

export function attachInventionConstruct(input: {
  construct: ConstructGraph;
  invention?: InventionConstruct;
}): ConstructGraph {
  if (!input.invention) return input.construct;
  const node = inventionConstructNode(input.invention);
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(existing => existing.id !== node.id),
      node
    ],
    edges: [
      ...input.construct.edges.filter(edge => edge.source !== node.id && edge.target !== node.id),
      {
        source: input.construct.nodes.find(existing => existing.id === "request")?.id ?? input.construct.nodes[0]?.id ?? "request",
        target: node.id,
        relation: "licenses_invention",
        weight: Math.max(
          0,
          Math.min(
            1,
            input.invention.supportScore * 0.45
              + input.invention.noveltyScore * 0.35
              + (1 - input.invention.riskScore) * 0.2
          )
        )
      }
    ]
  };
}

export function selectedInventionForCandidate(
  candidate: CandidateSurface,
  inventions: readonly InventionConstruct[]
): InventionConstruct | undefined {
  if (candidate.kind !== "creative-candidate") return undefined;
  const audit = jsonRecord(candidate.audit);
  const candidateConstructIds = new Set([
    ...(candidate.constructIds ?? []),
    kernelString(audit.inventionConstructId),
    kernelString(audit.constructId)
  ].filter((id): id is string => Boolean(id)));
  const matches = inventions.filter(invention => candidateConstructIds.has(invention.id));
  return matches.length === 1 ? matches[0] : undefined;
}

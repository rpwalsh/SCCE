import { describe, expect, it } from "vitest";
import { typedSemanticInputForMouth } from "../production-turn-runtime.js";
import type { ConstructGraph, GraphSnapshot, NodeId } from "../types.js";

describe("typed production Mouth semantic input", () => {
  it("binds opaque roles from graph ports rather than surface order", () => {
    const graph = {
      nodes: [],
      edges: [],
      hyperedges: [{
        schema: "scce.hyperedge.v2",
        id: "hyperedge.writes",
        relationId: "relation.writes",
        participantPorts: [
          {
            portId: "port.writer",
            roleId: "role.opaque.writer",
            nodeId: "node.ada" as NodeId,
            valueKind: "opaque.entity",
            realization: "observed",
            evidenceIds: ["evidence.current"]
          },
          {
            portId: "port.work",
            roleId: "role.opaque.work",
            nodeId: "node.notes" as NodeId,
            valueKind: "opaque.entity",
            realization: "observed",
            evidenceIds: ["evidence.current"]
          }
        ],
        memberNodeIds: ["node.ada", "node.notes"] as NodeId[],
        qualifiers: {},
        modality: {},
        evidenceIds: ["evidence.current"],
        weightVector: { alpha: 1 },
        temporalScope: {},
        provenanceRefs: ["evidence.current"],
        createdAt: 1,
        updatedAt: 1
      }]
    } as unknown as GraphSnapshot;
    const construct = {
      nodes: [{
        kind: "construct:semantic_answer",
        metadata: {
          selectedFacts: [{
            subject: "Ada",
            predicate: "writes",
            object: "notes",
            sourceNodeId: "node.ada",
            targetNodeId: "node.notes",
            relationId: "relation.writes",
            evidenceIds: ["evidence.current"]
          }]
        }
      }]
    } as unknown as ConstructGraph;

    expect(typedSemanticInputForMouth({
      construct,
      graph,
      authority: "factual"
    })).toEqual({
      schema: "scce.mouth.semantic_input.v1",
      authority: "factual",
      slots: [
        expect.objectContaining({
          roleId: "role.opaque.writer",
          value: "Ada",
          sourceId: "node.ada"
        }),
        expect.objectContaining({
          roleId: "role.opaque.work",
          value: "notes",
          sourceId: "node.notes"
        })
      ],
      relations: [expect.objectContaining({
        relationId: "relation.writes"
      })]
    });
  });

  it("refuses ambiguous graph-role bindings", () => {
    const result = typedSemanticInputForMouth({
      construct: {
        nodes: [{
          kind: "construct:semantic_answer",
          metadata: {
            selectedFacts: [{
              subject: "Ada",
              predicate: "writes",
              object: "notes",
              sourceNodeId: "node.ada",
              targetNodeId: "node.notes",
              relationId: "relation.writes"
            }]
          }
        }]
      } as unknown as ConstructGraph,
      graph: {
        nodes: [],
        edges: [],
        hyperedges: []
      },
      authority: "factual"
    });
    expect(result).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { expandPowerWalkSeedAnchors, type NodeId } from "../index.js";

describe("PowerWalk query-conditioned seed expansion", () => {
  it("expands only through learned non-zero context vectors", () => {
    const anchor = "node:anchor" as NodeId;
    const structuralTwin = "node:structural-twin" as NodeId;
    const unrelated = "node:unrelated" as NodeId;
    const zeroContext = "node:zero-context" as NodeId;

    const result = expandPowerWalkSeedAnchors({
      anchors: [{ nodeId: anchor, weight: 0.8 }],
      embeddings: [
        { nodeId: anchor, vector: [1, 0, 0] },
        { nodeId: structuralTwin, vector: [0.9, 0.1, 0] },
        { nodeId: unrelated, vector: [0, 1, 0] },
        { nodeId: zeroContext, vector: [0, 0, 0] }
      ],
      minimumCosine: 0.5
    });

    expect(result.seeds.map(seed => seed.nodeId)).toEqual([structuralTwin]);
    expect(result.seeds[0]?.feature).toBe(`powerwalk:ppmi-cosine:${anchor}`);
    expect(result.audit).toMatchObject({
      method: "query_anchor_ppmi_cosine",
      anchorInputCount: 1,
      usableAnchorCount: 1,
      representedNodeCount: 3,
      expandedSeedCount: 1
    });
    expect(result.audit.top.some(row => row.nodeId === zeroContext)).toBe(false);
  });

  it("does not fabricate an anchor representation for a zero-context query node", () => {
    const result = expandPowerWalkSeedAnchors({
      anchors: [{ nodeId: "node:anchor" as NodeId, weight: 1 }],
      embeddings: [
        { nodeId: "node:anchor" as NodeId, vector: [0, 0] },
        { nodeId: "node:candidate" as NodeId, vector: [1, 0] }
      ]
    });

    expect(result.seeds).toEqual([]);
    expect(result.audit).toMatchObject({ usableAnchorCount: 0, excludedAnchorCount: 1, expandedSeedCount: 0 });
  });
});

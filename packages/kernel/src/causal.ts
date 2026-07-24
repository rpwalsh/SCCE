import type { Clock, GraphEdge, GraphNode, NodeId } from "./types.js";
import { clamp01 } from "./primitives.js";

export function createCausalDiscoveryEngine(clock: Clock) {
  return {
    discover(input: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[]; activeNodeIds: readonly NodeId[] }): Array<{ nodeId: NodeId; mass: number; reason: string }> {
      const active = new Set(input.activeNodeIds);
      const incoming = new Map<NodeId, number>();
      const outgoing = new Map<NodeId, number>();
      const screened = new Map<NodeId, number>();
      for (const edge of input.edges) {
        const w = edge.alpha * edge.weight;
        outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + w);
        incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + w);
        if (active.has(edge.source) || active.has(edge.target)) {
          screened.set(edge.source, (screened.get(edge.source) ?? 0) + w * 0.7);
          screened.set(edge.target, (screened.get(edge.target) ?? 0) + w);
        }
      }
      return input.nodes
        .map(node => {
          const temporal = input.edges
            .filter(edge => edge.source === node.id || edge.target === node.id)
            .reduce((sum, edge) => sum + Math.exp(-Math.max(0, clock.now() - edge.updatedAt) / (1000 * 60 * 60 * 24 * 30)), 0);
          const mass = clamp01((screened.get(node.id) ?? 0) * 0.45 + (incoming.get(node.id) ?? 0) * 0.25 + (outgoing.get(node.id) ?? 0) * 0.15 + temporal * 0.01);
          return { nodeId: node.id, mass, reason: active.has(node.id) ? "active-field-common-cause-screen" : "temporal-graph-causal-mass" };
        })
        .filter(item => item.mass > 0)
        .sort((a, b) => b.mass - a.mass)
        .slice(0, 32);
    }
  };
}

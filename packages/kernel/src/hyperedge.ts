import { canonicalStringify } from "./primitives.js";
import type { Hyperedge, NodeId } from "./types.js";

export function observedHyperedgeMemberNodeIds(
  participantPorts: readonly Hyperedge["participantPorts"][number][]
): NodeId[] {
  return participantPorts
    .filter(port => port.realization === "observed")
    .map(port => port.nodeId)
    .filter((nodeId): nodeId is NodeId => nodeId !== null);
}

export function assertCanonicalHyperedge(hyperedge: Hyperedge): void {
  if (hyperedge.schema !== "scce.hyperedge.v2") {
    throw new Error("hyperedge schema must be scce.hyperedge.v2");
  }
  if (!Array.isArray(hyperedge.participantPorts)) {
    throw new TypeError("hyperedge participantPorts must be an array");
  }
  const portIds = new Set<string>();
  for (const port of hyperedge.participantPorts) {
    if (!port.portId.trim()) throw new Error("hyperedge participant port id must be non-empty");
    if (portIds.has(port.portId)) throw new Error(`hyperedge participant port id must be unique: ${port.portId}`);
    portIds.add(port.portId);
    if (!port.valueKind.trim()) throw new Error(`hyperedge participant ${port.portId} valueKind must be non-empty`);
    if (port.realization === "observed" && port.nodeId === null) {
      throw new Error(`observed hyperedge participant ${port.portId} requires a nodeId`);
    }
    if (port.realization === "omitted" && port.nodeId !== null) {
      throw new Error(`omitted hyperedge participant ${port.portId} must have a null nodeId`);
    }
    if (!Array.isArray(port.evidenceIds)) {
      throw new TypeError(`hyperedge participant ${port.portId} evidenceIds must be an array`);
    }
  }
  const derivedMembers = observedHyperedgeMemberNodeIds(hyperedge.participantPorts);
  if (canonicalStringify(derivedMembers) !== canonicalStringify(hyperedge.memberNodeIds)) {
    throw new Error("hyperedge memberNodeIds must equal observed participant-port node IDs in port order");
  }
  if (!Array.isArray(hyperedge.evidenceIds)) throw new TypeError("hyperedge evidenceIds must be an array");
  if (!Array.isArray(hyperedge.provenanceRefs)) throw new TypeError("hyperedge provenanceRefs must be an array");
  const temporal = hyperedge.temporalScope && typeof hyperedge.temporalScope === "object" && !Array.isArray(hyperedge.temporalScope)
    ? hyperedge.temporalScope as Record<string, unknown>
    : undefined;
  if (!temporal || typeof temporal.validFrom !== "number" || !Number.isFinite(temporal.validFrom)) {
    throw new Error("hyperedge temporalScope.validFrom must be finite");
  }
  if (temporal.validTo !== undefined
    && (typeof temporal.validTo !== "number"
      || !Number.isFinite(temporal.validTo)
      || temporal.validTo < temporal.validFrom)) {
    throw new Error("hyperedge temporalScope.validTo must be finite and not precede validFrom");
  }
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement.
import type { Hyperedge, JsonValue } from "./types.js";

/** A source-neutral, lossless view of a promoted relation for routing and proof audit. */
export interface TypedRelationTrace {
  hyperedgeId: string;
  relationId: string;
  direction: {
    fromPortId: string;
    toPortId: string;
    orientation: "ordered_observed_ports";
  };
  participants: Array<{
    portId: string;
    roleId: string;
    nodeId: string | null;
    valueKind: string;
    realization: "observed" | "omitted";
    evidenceIds: string[];
  }>;
  evidenceIds: string[];
  qualifiers: JsonValue;
  temporalScope: JsonValue;
  support: number;
}

export function typedRelationTraces(hyperedges: readonly Hyperedge[]): TypedRelationTrace[] {
  return [...hyperedges]
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map(hyperedge => {
      const participants = hyperedge.participantPorts.map(port => ({
        portId: port.portId,
        roleId: port.roleId,
        nodeId: port.nodeId === null ? null : String(port.nodeId),
        valueKind: port.valueKind,
        realization: port.realization,
        evidenceIds: port.evidenceIds.map(String)
      }));
      const observed = participants.filter(port => port.realization === "observed" && port.nodeId !== null);
      const from = observed[0]?.portId ?? participants[0]?.portId ?? "";
      const to = observed[1]?.portId ?? participants[1]?.portId ?? from;
      const weight = hyperedge.weightVector && typeof hyperedge.weightVector === "object" && !Array.isArray(hyperedge.weightVector)
        ? hyperedge.weightVector.alpha
        : undefined;
      return {
        hyperedgeId: String(hyperedge.id),
        relationId: String(hyperedge.relationId),
        direction: { fromPortId: from, toPortId: to, orientation: "ordered_observed_ports" as const },
        participants,
        evidenceIds: hyperedge.evidenceIds.map(String),
        qualifiers: hyperedge.qualifiers,
        temporalScope: hyperedge.temporalScope,
        support: typeof weight === "number" && Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0.5
      };
    });
}

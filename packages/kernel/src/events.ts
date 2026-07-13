import type { Clock, EventId, EventTypeId, Hasher, JsonValue, KnownEventType, ScceEvent, EpisodeId } from "./types.js";
import type { IdFactory } from "./ids.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";

export function hashEvent(event: Omit<ScceEvent, "hash">, parentHashes: readonly string[], hasher: Hasher): string {
  return hasher.digestHex(`${String(event.id)}\u001f${String(event.episodeId)}\u001f${String(event.typeId)}\u001f${event.t}\u001f${canonicalStringify(event.payload)}\u001f${parentHashes.join("\u001f")}`);
}

export function createEventFactory(options: { idFactory: IdFactory; clock: Clock; hasher: Hasher }) {
  return {
    create(input: { episodeId: EpisodeId; typeId: KnownEventType | EventTypeId | string; payload: unknown; parents?: ScceEvent[] }): ScceEvent {
      const parents = input.parents ?? [];
      const eventWithoutHash: Omit<ScceEvent, "hash"> = {
        id: options.idFactory.eventId(),
        episodeId: input.episodeId,
        typeId: input.typeId as EventTypeId,
        t: options.clock.now(),
        payload: toJsonValue(input.payload),
        parents: parents.map(parent => parent.id as EventId)
      };
      return { ...eventWithoutHash, hash: hashEvent(eventWithoutHash, parents.map(parent => parent.hash), options.hasher) };
    },
    ledgerHash(events: readonly ScceEvent[]): string {
      return options.hasher.digestHex(events.map(event => event.hash).join("\u001f"));
    }
  };
}

export function extractReplayValue(events: readonly ScceEvent[]): {
  selectedCandidate?: JsonValue;
  entailment?: JsonValue;
  constructGraph?: JsonValue;
  validationGraph?: JsonValue;
  emissionGraph?: JsonValue;
  mouth?: JsonValue;
  corrections?: JsonValue;
  finalOutput?: string;
} {
  const last = (type: string) => [...events].reverse().find(event => event.typeId === type)?.payload;
  const closed = last("EpisodeClosed") as { output?: string } | undefined;
  return {
    selectedCandidate: last("CandidateSelected") as JsonValue | undefined,
    entailment: last("SemanticEntailmentChecked") as JsonValue | undefined,
    constructGraph: last("ConstructGraphBuilt") as JsonValue | undefined,
    validationGraph: last("ValidationGraphBuilt") as JsonValue | undefined,
    emissionGraph: last("EmissionGraphBuilt") as JsonValue | undefined,
    mouth: last("MouthSpoken") as JsonValue | undefined,
    corrections: last("CorrectionApplied") as JsonValue | undefined,
    finalOutput: closed?.output
  };
}

import { describe, expect, it } from "vitest";
import { consolidateEpisode, verifyConsolidatedEpisodeRecoverable } from "../episodic-memory-consolidation.js";
import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import type { EpisodeId, ScceEvent } from "../types.js";

function buildRealisticEpisode(): ScceEvent[] {
  const clock = createClock({ fixedTime: 1_000, stepMs: 10 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const eventFactory = createEventFactory({ idFactory, clock, hasher });
  const episodeId = idFactory.episodeId();
  const events: ScceEvent[] = [];
  const append = (typeId: string, payload: unknown) => {
    const event = eventFactory.create({ episodeId, typeId, payload });
    events.push(event);
    return event;
  };
  append("OwnerAsked", { ingest: "what is the release codename?" });
  append("SourceObserved", { sourceId: "source.1" });
  append("EvidenceLinked", { sourceVersionId: "sv.1" });
  append("CapabilityPlanned", { capabilityId: "cap.search" });
  append("CapabilityInvoked", { capabilityId: "cap.search" });
  append("CapabilityFailed", { reason: "connector timeout after 3 retries" });
  append("CapabilityPlanned", { capabilityId: "cap.search" });
  append("CapabilityInvoked", { capabilityId: "cap.search" });
  append("CapabilitySucceeded", { capabilityId: "cap.search" });
  append("CandidateGenerated", { candidateId: "candidate.1" });
  append("CandidateSelected", { candidateId: "candidate.1" });
  append("UserCorrected", { correctedOutput: "the codename is Aster, not Astra" });
  append("MouthSpoken", { text: "The release codename is Aster." });
  return events;
}

describe("episodic memory consolidation (plan items 211-212)", () => {
  it("buckets a real event stream into goal/context/actions/outcomes/corrections/lessons", () => {
    const events = buildRealisticEpisode();
    const consolidated = consolidateEpisode(events);

    expect(consolidated.goal).toEqual({ ingest: "what is the release codename?" });
    expect(consolidated.contextEventIds.length).toBe(2);
    expect(consolidated.actionEventIds.length).toBe(5);
    expect(consolidated.outcomeEventIds.length).toBe(4);
    expect(consolidated.correctionEventIds.length).toBe(1);
    expect(consolidated.lessons).toContain("connector timeout after 3 retries");
    expect(consolidated.lessons).toContain("the codename is Aster, not Astra");
    expect(consolidated.eventCount).toBe(events.length);
  });

  it("reduces replay volume: the consolidated record is far smaller than the raw event stream once it grows", () => {
    const clock = createClock({ fixedTime: 1_000, stepMs: 10 });
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
    const eventFactory = createEventFactory({ idFactory, clock, hasher });
    const episodeId: EpisodeId = idFactory.episodeId();
    const events: ScceEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events.push(eventFactory.create({ episodeId, typeId: "CapabilityInvoked", payload: { capabilityId: `cap.${i}` } }));
    }
    const consolidated = consolidateEpisode(events);
    const rawSize = JSON.stringify(events).length;
    const consolidatedSize = JSON.stringify(consolidated).length;
    expect(consolidated.eventCount).toBe(200);
    // sourceEventIds still lists all 200 ids (for exact recoverability), so
    // the real compression win is in not having to replay every full event
    // payload -- assert the consolidated record is meaningfully smaller
    // than the raw stream despite that.
    expect(consolidatedSize).toBeLessThan(rawSize * 0.6);
  });

  it("every event id a consolidated episode references is recoverable in the real source event set", () => {
    const events = buildRealisticEpisode();
    const consolidated = consolidateEpisode(events);
    expect(verifyConsolidatedEpisodeRecoverable(consolidated, events)).toBe(true);
    // Tamper: drop one referenced event from the "source of truth" set and
    // confirm recoverability is correctly detected as broken, not always true.
    const withoutOne = events.filter(event => event.id !== consolidated.contextEventIds[0]);
    expect(verifyConsolidatedEpisodeRecoverable(consolidated, withoutOne)).toBe(false);
  });

  it("never fabricates lesson text -- only verbatim strings from real failure/correction payloads appear", () => {
    const events = buildRealisticEpisode();
    const consolidated = consolidateEpisode(events);
    const failureEvent = events.find(event => event.typeId === "CapabilityFailed")!;
    const correctionEvent = events.find(event => event.typeId === "UserCorrected")!;
    expect(consolidated.lessons).toEqual(
      expect.arrayContaining([(failureEvent.payload as { reason: string }).reason, (correctionEvent.payload as { correctedOutput: string }).correctedOutput])
    );
    expect(consolidated.lessons.length).toBe(2);
  });

  it("rejects an event list spanning more than one episode", () => {
    const events = buildRealisticEpisode();
    const otherEpisodeEvent = { ...events[0]!, episodeId: "episode.other" as EpisodeId };
    expect(() => consolidateEpisode([...events, otherEpisodeEvent])).toThrow(/exactly one episode/);
  });

  it("rejects an empty event list", () => {
    expect(() => consolidateEpisode([])).toThrow(/empty event list/);
  });
});

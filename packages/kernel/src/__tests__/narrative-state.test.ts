import { describe, expect, it } from "vitest";
import { evaluateNarrativeConsistency, type InitialFact, type NarrativeEvent } from "../narrative-state.js";

describe("narrative-state consistency evaluation (plan items 223-224)", () => {
  it("detects an unexplained state change and an undischarged required setup in a synthetic story", () => {
    const initialFacts: InitialFact[] = [
      { subjectId: "hero", factId: "knows.map", value: false }
    ];
    const events: NarrativeEvent[] = [
      {
        id: "event.hero-finds-map",
        order: 1,
        description: "The hero finds a map and notices a gun mounted on the wall.",
        causedByEventIds: [],
        stateChanges: [{ subjectId: "hero", factId: "knows.map", fromValue: false, toValue: true }],
        setupIds: ["setup.gun-on-wall"],
        payoffForSetupIds: []
      },
      {
        id: "event.door-opens",
        order: 2,
        // Continuity error: nothing ever established the door as locked,
        // yet this event claims it changed FROM locked -- an unexplained
        // state change a real reader (or a real consistency checker)
        // should flag.
        description: "The door swings open.",
        causedByEventIds: [],
        stateChanges: [{ subjectId: "world", factId: "door.locked", fromValue: true, toValue: false }],
        setupIds: [],
        payoffForSetupIds: []
      }
      // setup.gun-on-wall is introduced but never paid off -- a classic
      // undischarged Chekhov's-gun obligation.
    ];

    const report = evaluateNarrativeConsistency({ events }, initialFacts);

    expect(report.consistent).toBe(false);
    expect(report.unexplainedStateChanges).toEqual([{
      eventId: "event.door-opens",
      subjectId: "world",
      factId: "door.locked",
      claimedFromValue: true,
      actualEstablishedValue: undefined
    }]);
    expect(report.undischargedSetupIds).toEqual(["setup.gun-on-wall"]);
  });

  it("reports a fully consistent story as consistent, with no false positives", () => {
    const initialFacts: InitialFact[] = [
      { subjectId: "world", factId: "door.locked", value: true }
    ];
    const events: NarrativeEvent[] = [
      {
        id: "event.setup",
        order: 1,
        description: "The hero notices a gun mounted on the wall.",
        causedByEventIds: [],
        stateChanges: [],
        setupIds: ["setup.gun-on-wall"],
        payoffForSetupIds: []
      },
      {
        id: "event.unlock",
        order: 2,
        description: "The hero unlocks the door.",
        causedByEventIds: [],
        stateChanges: [{ subjectId: "world", factId: "door.locked", fromValue: true, toValue: false }],
        setupIds: [],
        payoffForSetupIds: []
      },
      {
        id: "event.payoff",
        order: 3,
        description: "The hero uses the gun from the wall to resolve the conflict.",
        causedByEventIds: ["event.setup"],
        stateChanges: [],
        setupIds: [],
        payoffForSetupIds: ["setup.gun-on-wall"]
      }
    ];

    const report = evaluateNarrativeConsistency({ events }, initialFacts);
    expect(report.consistent).toBe(true);
    expect(report.unexplainedStateChanges).toEqual([]);
    expect(report.undischargedSetupIds).toEqual([]);
  });

  it("threads state through events out of declared array order, using each event's own `order` field", () => {
    const events: NarrativeEvent[] = [
      {
        id: "event.b",
        order: 2,
        description: "second",
        causedByEventIds: [],
        stateChanges: [{ subjectId: "hero", factId: "mood", fromValue: "hopeful", toValue: "resolved" }],
        setupIds: [],
        payoffForSetupIds: []
      },
      {
        id: "event.a",
        order: 1,
        description: "first",
        causedByEventIds: [],
        stateChanges: [{ subjectId: "hero", factId: "mood", fromValue: "anxious", toValue: "hopeful" }],
        setupIds: [],
        payoffForSetupIds: []
      }
    ];
    const report = evaluateNarrativeConsistency(
      { events },
      [{ subjectId: "hero", factId: "mood", value: "anxious" }]
    );
    expect(report.consistent).toBe(true);
  });

  it("a setup and its payoff in the same event correctly discharges it", () => {
    const events: NarrativeEvent[] = [
      {
        id: "event.self-contained",
        order: 1,
        description: "A twist is set up and immediately resolved in the same beat.",
        causedByEventIds: [],
        stateChanges: [],
        setupIds: ["setup.twist"],
        payoffForSetupIds: ["setup.twist"]
      }
    ];
    const report = evaluateNarrativeConsistency({ events }, []);
    expect(report.undischargedSetupIds).toEqual([]);
  });
});

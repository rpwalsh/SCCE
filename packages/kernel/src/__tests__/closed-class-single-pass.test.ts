// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { deriveClosedClassWords, requestClosedClassWords } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";

it("shares the model word ranking with named-run protection without rereading the dictionaries", () => {
  const model = trainKneserNey("α β α γ α β δ γ β α δ β", { order: 3 });
  const counts = model.continuationCounts;
  let reads = 0;
  model.continuationCounts = Object.defineProperties({}, Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, {
    enumerable: true, get: () => { reads++; return value; }
  }])));
  const request = { requestText: "α β γ δ", models: [model], limit: 3 };
  const expected = requestClosedClassWords({ ...request, models: [{ ...model, continuationCounts: counts }] });
  expect(requestClosedClassWords(request)).toEqual(expected);
  expect(reads).toBe(Object.keys(counts).length);
});

it("recomputes mutable model statistics and returns independently owned sets", () => {
  const model = trainKneserNey("α β α γ α β δ γ β α δ β", { order: 3 });
  const input = { models: [model], limit: 1 };
  const first = deriveClosedClassWords(input);
  first.add("poison");
  model.continuationCounts.δδ = 100;
  const second = deriveClosedClassWords(input);
  expect(second).not.toContain("poison");
  expect(second.has("δδ")).toBe(true);
});

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import { compileRequestCommunicativeActModel, requestCommunicativeActPatterns, requestCommunicativeActModelFromPatterns,
  classifyRequestCommunicativeAct, REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM } from "../request-communicative-act.js";
import type { LanguagePatternRecord } from "../storage.js";

const owner = (id: string, updatedAt: number, requests: string[], factual: boolean, version = "1") => requestCommunicativeActPatterns(
  compileRequestCommunicativeActModel(requests.map(requestText => ({ requestText, accepted: true, responseEvidenceCount: 0,
    responseExternallyFactual: factual, continuation: { floorReturned: false, replyDrawsOnTurn: true } }))),
  { profileId: `profile.${id}.${version}`, updatedAt, sourceOwner: { sourceId: `source.${id}`, sourceVersionId: `version.${id}.${version}`,
    sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, evidenceIds: [`evidence.${id}.${version}`] },
    makeId: value => createHasher().digestHex(canonicalStringify(value)) });

it("retains earlier English neutral counts through Russian and Catalan publications and repeated subsets", () => {
  const en = owner("en", 1, ["kapa dun serik", "kapa dun lomar"], true);
  const ru = owner("ru", 2, ["запомни мою идею", "обсудим мою идею"], false);
  const ca = owner("ca", 3, ["parlem del projecte"], false);
  const model = requestCommunicativeActModelFromPatterns([...en, ...ru, ...ca])!;
  expect(model).toBeDefined();
  expect(en).toHaveLength(1); expect(ru).toHaveLength(1); expect(ca).toHaveLength(1);
  expect(model.classCounts[DIALOGUE_ACT_IDS.neutral]).toBe(2);
  expect(Object.values(model.classCounts).reduce((sum, count) => sum + count, 0)).toBe(5);
  expect(classifyRequestCommunicativeAct("kapa dun serik", model).actId).toBe(DIALOGUE_ACT_IDS.neutral);
  expect(classifyRequestCommunicativeAct("запомни мою идею", model).actId).not.toBe(DIALOGUE_ACT_IDS.neutral);
  expect(requestCommunicativeActModelFromPatterns([...ca, ...en, ...ru, ...ca, ...ru])?.classCounts).toEqual(model.classCounts);
  expect(requestCommunicativeActModelFromPatterns([...ru, ...ca, ...en])).toEqual(model);
});

it("sums each current owner once, ignores legacy global counts, and preserves genuine neutral contrast", () => {
  const en = owner("en", 1, ["kapa dun"], true), ru = owner("ru", 2, ["запомни идею"], false);
  const legacy = requestCommunicativeActPatterns(compileRequestCommunicativeActModel([
    { requestText: "legacy", accepted: true, responseEvidenceCount: 20 }
  ]), { profileId: "global.legacy", updatedAt: 1000, makeId: value => JSON.stringify(value) });
  const model = requestCommunicativeActModelFromPatterns([...en, ...ru, ...legacy])!;
  expect(model).toBeDefined();
  expect(Object.values(model.classCounts).reduce((sum, count) => sum + count, 0)).toBe(2);
  expect([...model.features.values()].some(row => row.surface === "legacy")).toBe(false);
  expect(requestCommunicativeActModelFromPatterns(ru)).toBeUndefined();
  expect(requestCommunicativeActModelFromPatterns(en)).toBeUndefined();
  expect(requestCommunicativeActModelFromPatterns([...en, ...ru, { ...ru[0]!, id: "duplicate" }])?.classCounts).toEqual(model.classCounts);
});

it("fails closed on conflicting generations and damaged owner or sufficient-statistic payloads", () => {
  const en = owner("en", 1, ["kapa dun"], true), ru = owner("ru", 2, ["запомни идею"], false);
  const changed = owner("ru", 3, ["другая идея", "новая идея"], false, "2");
  expect(requestCommunicativeActModelFromPatterns([...en, ...ru, ...changed])).toBeUndefined();
  for (const damage of [
    (row: LanguagePatternRecord) => ({ ...row, profileId: "profile.foreign" }),
    (row: LanguagePatternRecord) => ({ ...row, evidenceIds: [] }),
    (row: LanguagePatternRecord) => ({ ...row, patternJson: { ...(row.patternJson as object), classCounts: { wrong: 100 } } })
  ]) expect(requestCommunicativeActModelFromPatterns([...en, damage(ru[0]!)] )).toBeUndefined();
  const current = requestCommunicativeActModelFromPatterns([...en, ...changed])!;
  expect(current).toBeDefined();
  expect(Object.values(current.classCounts).reduce((sum, count) => sum + count, 0)).toBe(3);
  expect(requestCommunicativeActModelFromPatterns(en)).toBeUndefined();
});

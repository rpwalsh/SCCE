// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { anchorFeatureSet, codeSurfaceTokens, toJsonValue, trainKneserNey, type EvidenceQuery, type LanguageProfileQuery, type NgramModelQuery } from "@scce/kernel";
import { createLearnedCodeProposer } from "../learned-code-proposer.js";

const source = "export const total = 1;\n";
const input = { request: "preserve total", context: { targetPath: "source.ts", targetText: source, language: "typescript", imports: [], symbols: [] }, diagnostics: [], attempt: 1 };
const prefix = "[repair-phase] ";

function fixture(enabled: boolean, failure?: Error) {
  const calls: unknown[] = [], messages: string[] = [];
  const model = trainKneserNey(codeSurfaceTokens(source), { order: 3 });
  const proposer = createLearnedCodeProposer({ phaseTimings: enabled, log: message => messages.push(message), storage: {
    evidence: { searchEvidence: async (query: EvidenceQuery) => {
      calls.push(["evidence", query]);
      return query.openingBlockPrior === false ? [{ span: { status: "promoted", sourceVersionId: "version.owned",
        features: anchorFeatureSet(codeSurfaceTokens(source).join(" ")), provenance: { sourceSystem: "oss_code", formalLanguage: "typescript" } } }] : [];
    } },
    model: { listLanguageProfiles: async (query: LanguageProfileQuery) => { calls.push(["profiles", query]); return [{ id: "profile.owned", sourceVersionId: "version.owned" }]; } },
    languageMemory: { listNgramModels: async (query: NgramModelQuery) => {
      calls.push(["models", query]);
      if (failure) throw failure;
      return [{ id: "model.owned", streamId: "fixture", maxOrder: 3, discount: model.discount, updatedAt: 1,
        modelJson: toJsonValue({ sourceSystem: "oss_code", formalLanguage: "typescript", model }) }];
    } }
  } as never });
  return { proposer, calls, messages };
}

it("reports numeric phase durations and result counts without changing source queries or proposals", async () => {
  const silent = fixture(false), measured = fixture(true);
  expect(await measured.proposer.propose(input)).toEqual(await silent.proposer.propose(input));
  expect(measured.calls).toEqual(silent.calls);
  expect(silent.messages.some(message => message.startsWith(prefix))).toBe(false);
  const receipts = measured.messages.filter(message => message.startsWith(prefix)).map(message => JSON.parse(message.slice(prefix.length)));
  expect(receipts.map(receipt => receipt.phase)).toEqual(["source_profile_evidence", "source_profiles", "profile_models", "models",
    "repair_spans", "project_constructions", "documentation_intent", "generate_candidates"]);
  for (const receipt of receipts) {
    expect(Object.keys(receipt).sort()).toEqual(["count", "elapsedMs", "phase", "status"]);
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(receipt.elapsedMs)).toBe(true);
    expect(Number.isSafeInteger(receipt.count)).toBe(true);
    expect(receipt.status).toBe("completed");
  }
  const before = measured.messages.length;
  await measured.proposer.propose({ ...input, attempt: 2 });
  expect(measured.messages.slice(before).some(message => message.startsWith(prefix))).toBe(false);
});

it("keeps phase failure receipts free of error details and preserves the original failure", async () => {
  const error = new Error("sensitive backend detail"), measured = fixture(true, error);
  await expect(measured.proposer.propose(input)).rejects.toBe(error);
  const failed = measured.messages.filter(message => message.startsWith(prefix)).map(message => JSON.parse(message.slice(prefix.length)))
    .filter(receipt => receipt.status === "failed");
  expect(failed.map(receipt => receipt.phase)).toEqual(["profile_models", "models"]);
  expect(measured.messages.join(" ")).not.toContain(error.message);
  for (const receipt of failed) expect(Object.keys(receipt).sort()).toEqual(["elapsedMs", "phase", "status"]);
});

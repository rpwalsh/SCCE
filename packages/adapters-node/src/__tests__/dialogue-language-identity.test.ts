// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { LANGUAGE_IDENTITY_SCHEMA, type InformationLabel, type LanguageIdentityRecord } from "@scce/kernel";
import { dialogueIdentityAllowsInformationFlow } from "../dialogue-language-identity.js";

const output: InformationLabel = { tenantId: "fixture", principals: ["owner"], compartments: ["cognitive"], exportClass: "restricted", mergePolicy: "isolated" };
const measured = (informationLabel: InformationLabel): LanguageIdentityRecord => ({ schema: LANGUAGE_IDENTITY_SCHEMA,
  evidence: { status: "cross_family_measured" }, informationLabel } as LanguageIdentityRecord);

it("admits an independently measured less restricted catalogue without changing either input label", () => {
  const identity = measured({ ...output, exportClass: "confidential", mergePolicy: "same_owner" });
  const before = structuredClone({ identity, output });
  expect(dialogueIdentityAllowsInformationFlow(identity, output)).toBe(true);
  expect({ identity, output }).toEqual(before);
  expect(dialogueIdentityAllowsInformationFlow(measured(output), output)).toBe(true);
});

it.each([
  { ...output, tenantId: "other" },
  { ...output, principals: ["other"] },
  { ...output, compartments: ["other"] },
  { ...output, compartments: [...output.compartments, "extra"] },
  { ...output, mergePolicy: "explicit" as const }
])("refuses catalogue information outside the construction boundary: %j", informationLabel => {
  expect(dialogueIdentityAllowsInformationFlow(measured(informationLabel), output)).toBe(false);
});

it("refuses declassification and unmeasured or missing catalogue authority", () => {
  expect(dialogueIdentityAllowsInformationFlow(measured(output), { ...output, exportClass: "confidential" })).toBe(false);
  expect(dialogueIdentityAllowsInformationFlow({ ...measured(output), evidence: { ...measured(output).evidence!, status: "source_observed" } }, output)).toBe(false);
  expect(dialogueIdentityAllowsInformationFlow({ ...measured(output), informationLabel: undefined }, output)).toBe(false);
  expect(dialogueIdentityAllowsInformationFlow(undefined, output)).toBe(false);
});

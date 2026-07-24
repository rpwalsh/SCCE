import { describe, expect, it } from "vitest";
import {
  fitRelationPotential,
  type RelationPotentialFeatures,
  type RelationPotentialModel
} from "@scce/kernel";
import { validateConfig, type ScceRuntimeConfig } from "../config.js";

describe("relation-potential runtime configuration", () => {
  it("accepts an intact frozen model and rejects coefficient edits under its old version id", () => {
    const model = fixtureModel();
    expect(() => validateConfig(config(model), "fixture")).not.toThrow();
    const edited = {
      ...model,
      coefficients: { ...model.coefficients, compatibility: model.coefficients.compatibility + 0.1 }
    } as RelationPotentialModel;
    expect(() => validateConfig(config(edited), "fixture")).toThrow(/invalid runtime\.relationPotentialModel.*modelId does not match/u);
  });
});

function config(relationPotentialModel: RelationPotentialModel): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873", host: "127.0.0.1" },
    database: { url: "postgresql://fixture:fixture@localhost:5432/fixture", schema: "fixture" },
    runtime: {
      workspaceRoot: ".",
      tempRoot: ".tmp",
      maxFileBytes: 1024,
      maxChunkBytes: 512,
      allowedRoots: ["."],
      excludedPaths: [],
      relationPotentialModel,
      tools: {}
    },
    connectors: {},
    security: {
      informationAccess: { tenantId: "fixture", principalId: "owner", compartments: ["test"], maximumExportClass: "restricted" },
      defaultSourceInformationLabel: { tenantId: "fixture", principals: ["owner"], compartments: ["test"], exportClass: "restricted", mergePolicy: "isolated" }
    },
    policy: {
      allowMutation: false,
      requireTwoPhaseCommit: true,
      dryRunByDefault: true,
      maxNetworkRequests: 0,
      maxToolCalls: 0,
      maxSpendCents: 0,
      alphaRiskCeiling: 0.5,
      encryptSecretsAtRest: false
    }
  };
}

function fixtureModel(): RelationPotentialModel {
  const positive = features(0.9, 0.05);
  const negative = features(0.1, 0.9);
  return fitRelationPotential(
    {
      coefficientTraining: [
        { id: "positive-1", features: positive, label: 1 },
        { id: "positive-2", features: { ...positive, recurrence: 0.7 }, label: 1 },
        { id: "negative-1", features: negative, label: 0 },
        { id: "negative-2", features: { ...negative, temporalFit: 0.2 }, label: 0 }
      ],
      calibrationFit: [
        { id: "calibration-positive", features: { ...positive, utility: 0.8 }, label: 1 },
        { id: "calibration-negative", features: { ...negative, compatibility: 0.2 }, label: 0 }
      ],
      evaluationHoldout: [
        { id: "holdout-positive", features: { ...positive, provenance: 0.8 }, label: 1 },
        { id: "holdout-negative", features: { ...negative, contradiction: 0.8 }, label: 0 }
      ]
    }
  );
}

function features(support: number, contradiction: number): RelationPotentialFeatures {
  return {
    compatibility: support,
    provenance: support,
    temporalFit: support,
    modalityAgreement: support,
    recurrence: support,
    utility: support,
    sourceAgreement: support,
    contradiction
  };
}

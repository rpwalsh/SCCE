import { describe, expect, it } from "vitest";
import {
  informationLabelAllowsRead,
  joinInformationLabels
} from "../information-flow.js";
import type { InformationLabel } from "../types.js";

describe("information-flow labels", () => {
  it("fails closed across tenants, principals, compartments, and export authority", () => {
    const label = privateLabel();

    expect(informationLabelAllowsRead(label, {
      tenantId: "tenant.alpha",
      principalId: "owner.alpha",
      compartments: ["project.red"],
      maximumExportClass: "restricted"
    })).toBe(true);
    expect(informationLabelAllowsRead(label, {
      tenantId: "tenant.beta",
      principalId: "owner.alpha",
      compartments: ["project.red"],
      maximumExportClass: "restricted"
    })).toBe(false);
    expect(informationLabelAllowsRead(label, {
      tenantId: "tenant.alpha",
      principalId: "owner.beta",
      compartments: ["project.red"],
      maximumExportClass: "restricted"
    })).toBe(false);
    expect(informationLabelAllowsRead(label, {
      tenantId: "tenant.alpha",
      principalId: "owner.alpha",
      compartments: [],
      maximumExportClass: "restricted"
    })).toBe(false);
    expect(informationLabelAllowsRead(label, {
      tenantId: "tenant.alpha",
      principalId: "owner.alpha",
      compartments: ["project.red"],
      maximumExportClass: "internal"
    })).toBe(false);
  });

  it("joins labels without broadening access", () => {
    const joined = joinInformationLabels([
      privateLabel(),
      {
        ...privateLabel(),
        principals: ["owner.alpha", "reviewer.alpha"],
        compartments: ["project.blue"],
        exportClass: "restricted",
        mergePolicy: "explicit"
      }
    ], { explicitMergeAuthority: true });

    expect(joined).toEqual({
      tenantId: "tenant.alpha",
      principals: ["owner.alpha"],
      compartments: ["project.blue", "project.red"],
      exportClass: "restricted",
      mergePolicy: "explicit"
    });
  });

  it("rejects unauthorized or identity-broadening merges", () => {
    expect(() => joinInformationLabels([
      privateLabel(),
      { ...privateLabel(), tenantId: "tenant.beta" }
    ])).toThrow(/cross-tenant/);
    expect(() => joinInformationLabels([
      privateLabel(),
      { ...privateLabel(), principals: ["owner.beta"] }
    ])).toThrow(/no jointly authorized principal/);
    expect(() => joinInformationLabels([
      privateLabel(),
      { ...privateLabel(), mergePolicy: "explicit" }
    ])).toThrow(/explicit information merge authority/);
  });
});

function privateLabel(): InformationLabel {
  return {
    tenantId: "tenant.alpha",
    principals: ["owner.alpha"],
    compartments: ["project.red"],
    exportClass: "confidential",
    mergePolicy: "same_owner"
  };
}

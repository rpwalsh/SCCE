// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
import { describe, expect, it } from "vitest";
import {
  findCodeVerifier,
  findCodeVerifierCapability,
  findCodeVerifierCapabilityForPath
} from "../code-verifier-discovery.js";

describe("code verifier capability discovery", () => {
  it("returns an explicit unavailable capability for an unknown language", async () => {
    const capability = await findCodeVerifierCapability("language-without-a-checker");

    expect(capability).toEqual({
      languageId: "language-without-a-checker",
      status: "unavailable",
      reason: "no checker specification exists for language-without-a-checker"
    });
    expect(await findCodeVerifier("language-without-a-checker")).toBeUndefined();
  });

  it("keeps path discovery and legacy verifier lookup causally aligned", async () => {
    const capability = await findCodeVerifierCapabilityForPath("src/capability.py");
    const verifier = await findCodeVerifier("python");

    expect(capability.languageId).toBe("python");
    expect(capability.status === "available").toBe(verifier !== undefined);
    if (capability.status === "available") {
      expect(capability.verifier).toEqual(verifier);
      expect(capability.verifier.check.extension).toBe("py");
    } else {
      expect(capability.reason).toContain("python");
    }
  }, 30_000);
});

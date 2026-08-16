import { describe, expect, it } from "vitest";
import {
  activeClaim,
  claimHistory,
  deleteUserModelClaim,
  EMPTY_USER_MODEL_STORE,
  isExplicit,
  recordUserModelClaim,
  type UserModelStore
} from "../user-model-store.js";

// Plan items 219-220. A real, provenance-aware user-model store: source/
// scope/confidence/time/supersession, and the real guarantee that an
// inferred preference is never indistinguishable from an explicit one.

describe("recordUserModelClaim (plan item 219)", () => {
  it("records a real claim with full provenance", () => {
    const store = recordUserModelClaim(EMPTY_USER_MODEL_STORE, {
      id: "claim.1",
      kind: "preference",
      subject: "code_style.indentation",
      value: "spaces",
      source: "explicit_instruction",
      scope: "global",
      confidence: 1,
      observedAt: 1000
    });
    const claim = store.claims.get("claim.1")!;
    expect(claim).toMatchObject({ subject: "code_style.indentation", value: "spaces", source: "explicit_instruction", scope: "global", confidence: 1 });
  });

  it("refuses a duplicate claim id rather than silently overwriting it", () => {
    const store = recordUserModelClaim(EMPTY_USER_MODEL_STORE, { id: "claim.1", kind: "preference", subject: "x", value: "y", source: "inferred", scope: "global", confidence: 0.5, observedAt: 1000 });
    expect(() => recordUserModelClaim(store, { id: "claim.1", kind: "preference", subject: "x", value: "z", source: "inferred", scope: "global", confidence: 0.5, observedAt: 2000 })).toThrow();
  });

  it("refuses an out-of-range confidence value", () => {
    expect(() => recordUserModelClaim(EMPTY_USER_MODEL_STORE, { id: "c1", kind: "preference", subject: "x", value: "y", source: "inferred", scope: "global", confidence: 1.5, observedAt: 1000 })).toThrow();
  });

  it("refuses to supersede an unknown claim id", () => {
    expect(() => recordUserModelClaim(EMPTY_USER_MODEL_STORE, { id: "c1", kind: "preference", subject: "x", value: "y", source: "inferred", scope: "global", confidence: 0.5, observedAt: 1000, supersedesClaimId: "ghost" })).toThrow();
  });
});

describe("activeClaim / claimHistory / supersession (plan items 219-220)", () => {
  function baseStore(): UserModelStore {
    return recordUserModelClaim(EMPTY_USER_MODEL_STORE, {
      id: "c1", kind: "preference", subject: "code_style.indentation", value: "tabs",
      source: "demonstrated_behavior", scope: "project:scce", confidence: 0.6, observedAt: 1000
    });
  }

  it("a correction (supersedesClaimId) becomes the active claim while the original remains fully inspectable in history, never mutated or deleted", () => {
    const store = baseStore();
    const corrected = recordUserModelClaim(store, {
      id: "c2", kind: "preference", subject: "code_style.indentation", value: "spaces",
      source: "explicit_instruction", scope: "project:scce", confidence: 1, observedAt: 2000, supersedesClaimId: "c1"
    });
    expect(activeClaim(corrected, "code_style.indentation", "project:scce")?.id).toBe("c2");
    const history = claimHistory(corrected, "code_style.indentation", "project:scce");
    expect(history.map(claim => claim.id)).toEqual(["c1", "c2"]);
    expect(history[0]!.value).toBe("tabs"); // the original claim's own value is never rewritten
  });

  it("an inferred preference is genuinely distinguishable from an explicit instruction via the real, required source field -- never defaulted or blended", () => {
    const store = baseStore();
    const claim = store.claims.get("c1")!;
    expect(isExplicit(claim)).toBe(false);
    const explicit = recordUserModelClaim(store, {
      id: "c2", kind: "preference", subject: "code_style.indentation", value: "spaces",
      source: "explicit_instruction", scope: "project:scce", confidence: 1, observedAt: 2000, supersedesClaimId: "c1"
    }).claims.get("c2")!;
    expect(isExplicit(explicit)).toBe(true);
  });

  it("a real deletion genuinely removes a claim -- distinct from supersession, which keeps the superseded claim inspectable", () => {
    const store = baseStore();
    const deleted = deleteUserModelClaim(store, "c1");
    expect(deleted.claims.has("c1")).toBe(false);
    expect(claimHistory(deleted, "code_style.indentation", "project:scce")).toEqual([]);
  });

  it("throws deleting an unknown claim id rather than silently no-op-ing", () => {
    expect(() => deleteUserModelClaim(EMPTY_USER_MODEL_STORE, "ghost")).toThrow();
  });

  it("claims in different scopes for the same subject never interfere with each other's active claim", () => {
    const globalStore = recordUserModelClaim(EMPTY_USER_MODEL_STORE, {
      id: "g1", kind: "preference", subject: "code_style.indentation", value: "tabs",
      source: "inferred", scope: "global", confidence: 0.4, observedAt: 1000
    });
    const both = recordUserModelClaim(globalStore, {
      id: "p1", kind: "preference", subject: "code_style.indentation", value: "spaces",
      source: "explicit_instruction", scope: "project:scce", confidence: 1, observedAt: 1500
    });
    expect(activeClaim(both, "code_style.indentation", "global")?.value).toBe("tabs");
    expect(activeClaim(both, "code_style.indentation", "project:scce")?.value).toBe("spaces");
  });

  it("returns undefined for a subject/scope with no claims at all", () => {
    expect(activeClaim(EMPTY_USER_MODEL_STORE, "nothing", "global")).toBeUndefined();
  });
});

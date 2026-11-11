// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createSerializedRequestContextPort } from "../request-context-port.js";

describe("serialized portable request context", () => {
  it("retains context across await and clears it at the boundary", async () => {
    const port = createSerializedRequestContextPort<{ id: string }>();
    await port.run({ id: "one" }, async () => {
      expect(port.getStore()?.id).toBe("one");
      await Promise.resolve();
      expect(port.getStore()?.id).toBe("one");
    });
    expect(port.getStore()).toBeUndefined();
  });

  it("rejects overlap rather than leaking request-owned learned forms", async () => {
    const port = createSerializedRequestContextPort<{ id: string }>();
    let release!: () => void;
    const first = port.run({ id: "one" }, () => new Promise<void>(resolve => { release = resolve; }));
    expect(() => port.run({ id: "two" }, () => undefined)).toThrow(/overlapping/u);
    expect(port.getStore()?.id).toBe("one");
    release();
    await first;
    expect(port.getStore()).toBeUndefined();
  });
});

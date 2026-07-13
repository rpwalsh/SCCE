import { describe, expect, it } from "vitest";
import { isLoopbackHostname, normalizeLocalServerUrl, normalizeRequestTimeout, normalizeToken } from "../config.js";

describe("VS Code local connection policy", () => {
  it("defaults to the repository server origin", () => {
    expect(normalizeLocalServerUrl(undefined)).toBe("http://127.0.0.1:3873");
  });

  it.each([
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://127.42.1.9:9000/", "http://127.42.1.9:9000"],
    ["https://localhost:9443", "https://localhost:9443"],
    ["http://[::1]:8787", "http://[::1]:8787"]
  ])("accepts a literal loopback origin %s", (input, expected) => {
    expect(normalizeLocalServerUrl(input)).toBe(expected);
  });

  it.each([
    "https://example.com",
    "http://192.168.1.2:8787",
    "ftp://127.0.0.1",
    "http://user:secret@127.0.0.1:8787",
    "http://127.0.0.1:8787/api",
    "http://127.0.0.1:8787?token=secret"
  ])("rejects non-local or credential-bearing URL %s", input => {
    expect(() => normalizeLocalServerUrl(input)).toThrow();
  });

  it("recognizes only explicit loopback host forms", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("localhost.example.com")).toBe(false);
    expect(isLoopbackHostname("2130706433")).toBe(false);
  });

  it("normalizes bounded timeout and header-safe token values", () => {
    expect(normalizeRequestTimeout(2)).toBe(1000);
    expect(normalizeRequestTimeout(999999)).toBe(600000);
    expect(normalizeToken(" secret ")).toBe("secret");
    expect(() => normalizeToken("one\ntwo")).toThrow();
  });
});

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { selectServerBoundWorkspaceFolder } from "../workspace-binding.js";

describe("VS Code server workspace binding", () => {
  const serverResolvedRoot = resolve("server-root");
  const serverRealRoot = resolve("real-server-root");
  const otherRoot = resolve("other-root");

  it("selects the only exact local match from a multi-root workspace", () => {
    const selected = selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("other-local", "file", otherRoot, otherRoot),
      identity("matching-remote", "vscode-remote", serverResolvedRoot, serverRealRoot),
      identity("matching-local", "file", serverResolvedRoot, serverRealRoot)
    ]);
    expect(selected).toEqual({ folder: "matching-local", resolvedRoot: serverResolvedRoot, realRoot: serverRealRoot });
  });

  it("never accepts a remote or non-file folder as the server workspace", () => {
    expect(() => selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("remote", "vscode-remote", serverResolvedRoot, serverRealRoot),
      identity("untitled", "untitled", serverResolvedRoot, serverRealRoot)
    ])).toThrow(/does not match any open local file-system/u);
  });

  it("rejects zero matches instead of guessing another local folder", () => {
    expect(() => selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("other-a", "file", otherRoot, otherRoot),
      identity("other-b", "file", resolve("other-b"), resolve("other-b"))
    ])).toThrow(/does not match any open local file-system/u);
  });

  it("rejects duplicate exact matches as ambiguous", () => {
    expect(() => selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("duplicate-a", "file", serverResolvedRoot, serverRealRoot),
      identity("duplicate-b", "file", serverResolvedRoot, serverRealRoot)
    ])).toThrow(/more than one/u);
  });

  it("requires both lexical and realpath identity", () => {
    expect(() => selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("symlink-alias", "file", resolve("server-alias"), serverRealRoot)
    ])).toThrow(/does not match/u);
    expect(() => selectServerBoundWorkspaceFolder(serverResolvedRoot, serverRealRoot, [
      identity("retargeted", "file", serverResolvedRoot, resolve("different-real-root"))
    ])).toThrow(/does not match/u);
  });
});

function identity(folder: string, scheme: string, resolvedRoot: string, realRoot: string) {
  return { folder, scheme, resolvedRoot, realRoot };
}

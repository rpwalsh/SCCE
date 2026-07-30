import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectRepoFilesForCognition } from "../repo-cognition-files.js";

describe("bounded repo-file collection for repo cognition (Phase 15 live-turn wiring)", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("reads a requested TypeScript file and attaches real tree-sitter syntaxNodes", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-files-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "widget.ts"), "export function render(): number { return 1; }", "utf8");

    const files = await collectRepoFilesForCognition(root, ["src/widget.ts"]);

    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/widget.ts");
    expect(files[0]!.text).toContain("export function render");
    expect(files[0]!.syntaxNodes?.some(node => node.kind === "function" && node.name === "render")).toBe(true);
  });

  it("attaches no syntaxNodes for a language without a wired grammar, but still returns the raw text", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-files-"));
    await writeFile(path.join(root, "notes.md"), "# real notes", "utf8");

    const files = await collectRepoFilesForCognition(root, ["notes.md"]);

    expect(files).toHaveLength(1);
    expect(files[0]!.text).toBe("# real notes");
    expect(files[0]!.syntaxNodes).toBeUndefined();
  });

  it("silently skips a requested path that escapes the workspace root instead of throwing", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-files-"));
    await writeFile(path.join(root, "in-root.ts"), "export const x = 1;", "utf8");

    const files = await collectRepoFilesForCognition(root, ["../outside.ts", "in-root.ts"]);

    expect(files.map(file => file.path)).toEqual(["in-root.ts"]);
  });

  it("silently skips a requested path that does not exist instead of throwing", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-files-"));
    const files = await collectRepoFilesForCognition(root, ["src/does-not-exist.ts"]);
    expect(files).toEqual([]);
  });

  it("bounds the number of files read even if more paths are requested", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-files-"));
    const paths: string[] = [];
    for (let index = 0; index < 30; index++) {
      const fileName = `f${index}.ts`;
      await writeFile(path.join(root, fileName), `export const v${index} = ${index};`, "utf8");
      paths.push(fileName);
    }

    const files = await collectRepoFilesForCognition(root, paths);
    expect(files.length).toBeLessThanOrEqual(25);
  });
});

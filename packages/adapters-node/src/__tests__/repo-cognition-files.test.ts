// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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

  it("carries Rust, Kotlin, and Python declarations through requested-file ingestion with exact UTF-8 byte starts", async () => {
    root = await mkdtemp(path.join(tmpdir(), "scce-repo-cognition-multilingual-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    const rust = "// π🙂\npub fn caféΔ(值: i32) -> i32 { 值 + 1 }\n";
    const kotlin = "// Δ🙂\nfun phoneIndex(value: String): String = value\n";
    const python = "# λ🙂\ndef caféΔ(值):\n    return 值\n";
    await Promise.all([
      writeFile(path.join(root, "src", "lib.rs"), rust, "utf8"),
      writeFile(path.join(root, "src", "Phone.kt"), kotlin, "utf8"),
      writeFile(path.join(root, "src", "mod.py"), python, "utf8")
    ]);

    const files = await collectRepoFilesForCognition(root, ["src/lib.rs", "src/Phone.kt", "src/mod.py"]);
    const rustFunction = files.find(file => file.path.endsWith("lib.rs"))?.syntaxNodes?.find(node => node.kind === "function");
    const kotlinFunction = files.find(file => file.path.endsWith("Phone.kt"))?.syntaxNodes?.find(node => node.kind === "function");
    const pythonFunction = files.find(file => file.path.endsWith("mod.py"))?.syntaxNodes?.find(node => node.kind === "function");
    expect(rustFunction?.name).toBe("caféΔ");
    expect(rustFunction?.byteStart).toBe(Buffer.byteLength(rust.slice(0, rust.indexOf("pub fn ")), "utf8"));
    expect(kotlinFunction?.name).toBe("phoneIndex");
    expect(kotlinFunction?.byteStart).toBe(Buffer.byteLength(kotlin.slice(0, kotlin.indexOf("fun ")), "utf8"));
    expect(pythonFunction?.name).toBe("caféΔ");
    expect(pythonFunction?.byteStart).toBe(Buffer.byteLength(python.slice(0, python.indexOf("def ")), "utf8"));
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

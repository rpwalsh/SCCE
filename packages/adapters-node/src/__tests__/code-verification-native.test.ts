// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSnippetVerifier } from "../code-verification.js";
import { findCodeVerifierCapability } from "../code-verifier-discovery.js";
import { createTreeSitterCodeMouthPorts } from "../tree-sitter-code-mouth-ports.js";

const probes = [
  { language: "python", executable: "C:/Python314/python.exe", file: "probe.py",
    good: "def double_value(value):\n    return value + value\n",
    bad: "def missing(value)\n    return value + value\n" },
  { language: "go", executable: "C:/Users/react/toolchains/go/bin/go.exe", file: "probe.go",
    good: "package probe\nfunc doubleValue(value float64) float64 { return value + value }",
    bad: "package probe\nfunc doubleValue(value float64) float64 { return missing }" },
  { language: "c", executable: "C:/Program Files/LLVM/bin/clang.exe", file: "probe.c",
    good: "double doubleValue(double value) { return value + value; }",
    bad: "double doubleValue(double value) { return missing; }" },
  { language: "cpp", executable: "C:/Users/react/toolchains/mingw64/bin/g++.exe", file: "probe.cpp",
    good: "namespace probe { double doubleValue(double value) { return value + value; } }",
    bad: "namespace probe { double doubleValue(double value) { return missing; } }" },
  { language: "csharp", executable: "C:/Program Files/dotnet/dotnet.exe", file: "Probe.cs",
    good: "public static class Probe { public static double DoubleValue(double value) { return value + value; } }",
    bad: "public static class Probe { public static double DoubleValue(double value) { return missing; } }" },
  { language: "java", executable: "C:/Program Files/Java/jdk-25/bin/javac.exe", file: "Probe.java",
    good: "public class Probe { public static double doubleValue(double value) { return value + value; } }",
    bad: "public class Probe { public static double doubleValue(double value) { return missing; } }" }
];

describe("installed native compiler verification", () => {
  for (const probe of probes) {
    it.skipIf(process.platform !== "win32" || !existsSync(probe.executable))(`${probe.language} discovers the installed compiler, checks valid and invalid source, and isolates workspace products`, async () => {
      const capability = await findCodeVerifierCapability(probe.language);
      expect(capability.status).toBe("available");
      if (capability.status !== "available") throw new Error(capability.reason);
      if (probe.language === "go") expect(capability.verifier.command).not.toContain("gofmt");
      const verifier = createSnippetVerifier();
      expect(await verifier.verify({ language: probe.language, source: probe.good })).toEqual({ status: "verified", diagnostics: [] });
      const invalid = await verifier.verify({ language: probe.language, source: probe.bad });
      expect(invalid.status).toBe("failed");
      expect(invalid.diagnostics.join(" ")).toContain("missing");

      // Exercise the production Code Mouth verifier as well as the snippet seam.
      const directory = await mkdtemp(join(tmpdir(), "scce-native-workspace-"));
      try {
        const file = join(directory, probe.file);
        const ports = createTreeSitterCodeMouthPorts({ workspaceRoot: directory });
        await writeFile(file, probe.good);
        expect((await ports.verify(probe.file)).buildSucceeded).toBe(true);
        expect(await readFile(file, "utf8")).toBe(probe.good);
        expect(await readdir(directory)).toEqual([probe.file]);
        await writeFile(file, probe.bad);
        const rejected = await ports.verify(probe.file);
        expect(rejected.buildSucceeded).toBe(false);
        expect(rejected.diagnostics.length).toBeGreaterThan(0);
        expect(await readdir(directory)).toEqual([probe.file]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }, 120000);
  }
});

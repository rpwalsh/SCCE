// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./document.js";
import { withRepositorySyntaxTree } from "./tree-sitter-syntax.js";

export type CodeVerificationStatus = "verified" | "failed" | "unsupported";

export interface CodeVerification {
  status: CodeVerificationStatus;
  diagnostics: string[];
}

export interface CodeVerifier {
  id: string;
  verify(input: { language: string; source: string }): Promise<CodeVerification>;
}

/**
 * How a formal language proves an artifact: the language's own checker, the file
 * extension it expects, and where the artifact goes in the command line. Nothing
 * here is special-cased in the engine, so a language SCCE has never seen becomes
 * checkable by adding one entry, and an unlisted language is reported unproven
 * rather than pretended to be correct.
 */
export interface LanguageCheckCommand {
  command: string;
  args: readonly string[];
  extension: string;
  /** Equivalent compiler drivers, probed in order through the same capability boundary. */
  commandAlternatives?: readonly string[];
  /** The installed SDK supplies the compiler and reference assembly arguments. */
  compilerDriver?: "dotnet-csharp";
}

const ARTIFACT = "{artifact}";

export const DEFAULT_LANGUAGE_CHECKS: Readonly<Record<string, LanguageCheckCommand>> = Object.freeze({
  typescript: { command: "", args: [], extension: "ts" },
  javascript: { command: "", args: [], extension: "js" },
  python: { command: "python", args: ["-m", "py_compile", ARTIFACT], extension: "py" },
  ruby: { command: "ruby", args: ["-c", ARTIFACT], extension: "rb" },
  php: { command: "php", args: ["-l", ARTIFACT], extension: "php" },
  shell: { command: "sh", args: ["-n", ARTIFACT], extension: "sh" },
  go: { command: "go", args: ["build", "-o", "{output}", ARTIFACT], extension: "go" },
  rust: { command: "rustc", args: ["--edition", "2021", "--emit=metadata", "--crate-type", "lib", "-o", "-", ARTIFACT], extension: "rs" },
  java: { command: "javac", args: ["-proc:none", "-d", "{output}", ARTIFACT], extension: "java" },
  csharp: { command: "dotnet", args: [], extension: "cs", compilerDriver: "dotnet-csharp" },
  kotlin: { command: "kotlinc", args: ["-nowarn", ARTIFACT], extension: "kt" },
  swift: { command: "swiftc", args: ["-parse", ARTIFACT], extension: "swift" },
  c: { command: "cc", commandAlternatives: ["clang", "gcc"], args: ["-fsyntax-only", ARTIFACT], extension: "c" },
  cpp: { command: "c++", commandAlternatives: ["clang++", "g++"], args: ["-fsyntax-only", ARTIFACT], extension: "cpp" },
  sql: { command: "", args: [], extension: "sql" }
});

const TYPESCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);

/** All compiler products stay outside the source workspace; no source or build hook is executed. */
export async function runLanguageCheck(check: LanguageCheckCommand, artifact: string, options: { cwd?: string; timeoutMs?: number } = {}) {
  if (check.compilerDriver) throw new Error("compiler driver must be resolved through capability discovery");
  const directory = await mkdtemp(join(tmpdir(), "scce-check-output-"));
  try {
    return await runProcess(check.command, check.args.map(argument => argument.split(ARTIFACT).join(artifact).split("{output}").join(join(directory, "output"))),
      { ...options, maxOutputBytes: 4_000_000 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** A checker that is not installed proves nothing; that is reported as unsupported, never as verified. */
function toolMissing(output: string, code: number | null): boolean {
  return code !== 0 && /ENOENT|not recognized|command not found|no such file or directory/iu.test(output);
}

/**
 * Proves a generated artifact with the toolchain of the language it is written in.
 * TypeScript and JavaScript use the compiler this workspace already depends on;
 * every other language uses its configured checker when that tool is present.
 */
export function createSnippetVerifier(options: {
  timeoutMs?: number;
  tscPath?: string;
  checks?: Readonly<Record<string, LanguageCheckCommand>>;
} = {}): CodeVerifier {
  const timeoutMs = options.timeoutMs ?? 40_000;
  const checks = { ...DEFAULT_LANGUAGE_CHECKS, ...(options.checks ?? {}) };
  return {
    id: "verifier:language-toolchain",
    async verify(input) {
      const language = input.language.trim().toLowerCase();
      const source = input.source.trim();
      if (!source) return { status: "failed", diagnostics: ["empty artifact"] };
      let check = checks[language];
      if (!check) return { status: "unsupported", diagnostics: [] };
      const typescript = TYPESCRIPT_LANGUAGES.has(language);
      if (!typescript && !Object.hasOwn(options.checks ?? {}, language)) {
        const capability = await (await import("./code-verifier-discovery.js")).findCodeVerifierCapability(language);
        if (capability.status !== "available") return { status: "unsupported", diagnostics: [capability.reason] };
        check = capability.verifier.check;
      }
      let tscPath = options.tscPath;
      if (typescript && !tscPath) {
        try {
          tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");
        } catch {
          return { status: "unsupported", diagnostics: [] };
        }
      }
      if (!typescript && !check.command) return { status: "unsupported", diagnostics: [] };
      const directory = await mkdtemp(join(tmpdir(), "scce-artifact-"));
      const file = join(directory, language === "java" ? await javaArtifactName(source) : `artifact.${check.extension}`);
      try {
        await writeFile(file, `${source}\n`, "utf8");
        const result = typescript
          ? await runProcess(process.execPath, [
            tscPath!, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext",
            "--moduleResolution", "bundler", "--skipLibCheck",
            ...(language === "javascript" ? ["--allowJs", "--checkJs"] : []),
            file
          ], { timeoutMs, maxOutputBytes: 4_000_000 })
          : await runLanguageCheck(check, file, { cwd: directory, timeoutMs });
        const output = `${result.stdout}${result.stderr}`;
        if (result.code === 0) return { status: "verified", diagnostics: [] };
        if (toolMissing(output, result.code)) return { status: "unsupported", diagnostics: [] };
        const diagnostics = output
          .split(/\r?\n/u)
          .map(line => line.split(directory).join("").replace(/^[\\/]/u, "").trim())
          .filter(Boolean)
          .slice(0, 8);
        // A non-zero exit with nothing to say proves nothing either way.
        return diagnostics.length ? { status: "failed", diagnostics } : { status: "unsupported", diagnostics: [] };
      } catch {
        return { status: "unsupported", diagnostics: [] };
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

/** javac requires a public top-level type's own name; grammar ownership supplies it without wrapping source. */
async function javaArtifactName(source: string): Promise<string> {
  return await withRepositorySyntaxTree({ fileId: "artifact.java", languageId: "java", text: source }, root => {
    for (const node of root.namedChildren) {
      if (!["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"].includes(node.type)) continue;
      if (!node.namedChildren.some(child => child.type === "modifiers" && child.children.some(modifier => modifier.type === "public"))) continue;
      const name = node.childForFieldName("name")?.text;
      if (name && !/[\\/]/u.test(name)) return `${name}.java`;
    }
    return "artifact.java";
  }) ?? "artifact.java";
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
}

const ARTIFACT = "{artifact}";

export const DEFAULT_LANGUAGE_CHECKS: Readonly<Record<string, LanguageCheckCommand>> = Object.freeze({
  typescript: { command: "", args: [], extension: "ts" },
  javascript: { command: "", args: [], extension: "js" },
  python: { command: "python", args: ["-m", "py_compile", ARTIFACT], extension: "py" },
  ruby: { command: "ruby", args: ["-c", ARTIFACT], extension: "rb" },
  php: { command: "php", args: ["-l", ARTIFACT], extension: "php" },
  shell: { command: "sh", args: ["-n", ARTIFACT], extension: "sh" },
  go: { command: "gofmt", args: ["-e", ARTIFACT], extension: "go" },
  rust: { command: "rustc", args: ["--edition", "2021", "--emit=metadata", "--crate-type", "lib", "-o", "-", ARTIFACT], extension: "rs" },
  java: { command: "javac", args: ["-proc:none", "-d", ARTIFACT + ".out", ARTIFACT], extension: "java" },
  csharp: { command: "", args: [], extension: "cs" },
  kotlin: { command: "kotlinc", args: ["-nowarn", ARTIFACT], extension: "kt" },
  swift: { command: "swiftc", args: ["-parse", ARTIFACT], extension: "swift" },
  c: { command: "cc", args: ["-fsyntax-only", ARTIFACT], extension: "c" },
  cpp: { command: "c++", args: ["-fsyntax-only", ARTIFACT], extension: "cpp" },
  sql: { command: "", args: [], extension: "sql" }
});

const TYPESCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);

function runCheck(command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`;
      const code = error && typeof (error as { code?: unknown }).code === "number" ? Number((error as { code?: unknown }).code) : error ? 1 : 0;
      resolve({ code, output });
    });
  });
}

/** A checker that is not installed proves nothing; that is reported as unsupported, never as verified. */
function toolMissing(output: string, code: number): boolean {
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
      const language = input.language.toLocaleLowerCase();
      const source = input.source.trim();
      if (!source) return { status: "failed", diagnostics: ["empty artifact"] };
      const check = checks[language];
      if (!check) return { status: "unsupported", diagnostics: [] };
      const typescript = TYPESCRIPT_LANGUAGES.has(language);
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
      const file = join(directory, `artifact.${check.extension}`);
      try {
        await writeFile(file, `${source}\n`, "utf8");
        const result = typescript
          ? await runCheck(process.execPath, [
            tscPath!, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext",
            "--moduleResolution", "bundler", "--skipLibCheck",
            ...(language === "javascript" ? ["--allowJs", "--checkJs"] : []),
            file
          ], timeoutMs)
          : await runCheck(check.command, check.args.map(argument => argument.split(ARTIFACT).join(file)), timeoutMs);
        if (result.code === 0) return { status: "verified", diagnostics: [] };
        if (toolMissing(result.output, result.code)) return { status: "unsupported", diagnostics: [] };
        const diagnostics = result.output
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

/** @deprecated Kept for callers that only ever meant TypeScript; {@link createSnippetVerifier} covers every configured language. */
export function createTypeScriptSnippetVerifier(options: { timeoutMs?: number; tscPath?: string } = {}): CodeVerifier {
  return createSnippetVerifier(options);
}

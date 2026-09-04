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

const TYPESCRIPT_LANGUAGES = new Set(["typescript", "javascript"]);

/** A generated artifact is proven by its compiler or it is not claimed to work. Unsupported languages are reported as unverified, never as verified. */
export function createTypeScriptSnippetVerifier(options: { timeoutMs?: number; tscPath?: string } = {}): CodeVerifier {
  const timeoutMs = options.timeoutMs ?? 40_000;
  return {
    id: "verifier:typescript",
    async verify(input) {
      if (!TYPESCRIPT_LANGUAGES.has(input.language.toLocaleLowerCase())) return { status: "unsupported", diagnostics: [] };
      const source = input.source.trim();
      if (!source) return { status: "failed", diagnostics: ["empty artifact"] };
      let tscPath = options.tscPath;
      if (!tscPath) {
        try {
          tscPath = createRequire(import.meta.url).resolve("typescript/bin/tsc");
        } catch {
          return { status: "unsupported", diagnostics: [] };
        }
      }
      const directory = await mkdtemp(join(tmpdir(), "scce-artifact-"));
      const file = join(directory, input.language.toLocaleLowerCase() === "javascript" ? "artifact.js" : "artifact.ts");
      try {
        await writeFile(file, `${source}\n`, "utf8");
        const args = [tscPath, "--noEmit", "--strict", "--target", "es2022", "--module", "esnext", "--moduleResolution", "bundler", "--skipLibCheck"];
        if (file.endsWith(".js")) args.push("--allowJs", "--checkJs");
        args.push(file);
        const result = await new Promise<{ code: number; output: string }>(resolve => {
          execFile(process.execPath, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
            const output = `${stdout ?? ""}${stderr ?? ""}`;
            resolve({ code: error && typeof (error as { code?: unknown }).code === "number" ? Number((error as { code?: unknown }).code) : error ? 1 : 0, output });
          });
        });
        if (result.code === 0) return { status: "verified", diagnostics: [] };
        const diagnostics = result.output
          .split(/\r?\n/u)
          .map(line => line.replace(directory, "").replace(/^[\\/]/u, "").trim())
          .filter(line => /error TS\d+/u.test(line))
          .slice(0, 8);
        // A non-zero exit with nothing parseable means the compiler could not run, which proves nothing either way.
        return diagnostics.length ? { status: "failed", diagnostics } : { status: "unsupported", diagnostics: [] };
      } catch {
        return { status: "unsupported", diagnostics: [] };
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

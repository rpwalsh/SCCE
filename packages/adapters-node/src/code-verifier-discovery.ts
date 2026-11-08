// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { codeLanguageForPath } from "@scce/kernel";
import { DEFAULT_LANGUAGE_CHECKS, type LanguageCheckCommand } from "./code-verification.js";
import { runProcess } from "./document.js";

/**
 * Finding the checkers a machine already has, for the languages this system already knows how to check.
 *
 * `code-verification.ts` holds the table: which command proves a file in which language, and where the file goes
 * in its arguments. This does not repeat it. What it adds is the one thing that table cannot express, which is
 * where the command actually lives.
 *
 * Searching PATH alone is wrong in a way that makes the product look worse than it is. `rustup` installs to
 * `~/.cargo/bin` and edits PATH for new shells only, so a machine with a working Rust toolchain reports none to
 * any process started before the install; the same is true of a Go under `~/go`, of a Homebrew tool on a Mac
 * whose shell has not been restarted, and of anything installed in the current session. A language reported
 * uncheckable is a language this system will not repair, so a false negative here costs a capability.
 */

/** Where a language's toolchain installs itself when it does not install onto PATH. `~` is expanded. */
const SEARCH_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  rust: ["~/.cargo/bin"],
  go: ["~/go/bin", "~/toolchains/go/bin", "/usr/local/go/bin"],
  c: ["~/toolchains/mingw64/bin", path.join(process.env.ProgramFiles ?? "C:/Program Files", "LLVM/bin")],
  cpp: ["~/toolchains/mingw64/bin", path.join(process.env.ProgramFiles ?? "C:/Program Files", "LLVM/bin")],
  csharp: [path.join(process.env.ProgramFiles ?? "C:/Program Files", "dotnet"), "/usr/share/dotnet", "~/.dotnet"],
  python: ["~/.pyenv/shims", "~/AppData/Local/Programs/Python"],
  ruby: ["~/.rbenv/shims"],
  java: ["~/.sdkman/candidates/java/current/bin"],
  kotlin: ["~/.sdkman/candidates/kotlin/current/bin"],
  php: ["~/toolchains/php"],
  swift: ["~/.swiftly/bin"]
});

/** Arguments that make a checker exit 0 and say what it is, without touching a file. */
const VERSION_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  go: ["version"],
  java: ["-version"],
  kotlin: ["-version"]
});

export interface DiscoveredCodeVerifier {
  languageId: string;
  command: string;
  version: string;
  /** The language's check, with its command resolved to where it was actually found. */
  check: LanguageCheckCommand;
}

export type CodeVerifierCapability =
  | { readonly languageId: string; readonly status: "available"; readonly verifier: DiscoveredCodeVerifier }
  | { readonly languageId: string; readonly status: "unavailable"; readonly reason: string };

const discovered = new Map<string, Promise<CodeVerifierCapability>>();

/** The checker for a language, resolved to where it lives, or nothing when this machine has none. */
export function findCodeVerifier(languageId: string): Promise<DiscoveredCodeVerifier | undefined> {
  return findCodeVerifierCapability(languageId).then(capability => capability.status === "available" ? capability.verifier : undefined);
}

/**
 * Resolve the strongest checker capability as data. The unavailable branch is
 * useful to callers that must explain why a grammar fallback was selected;
 * absence is not an exception and must never be mistaken for verification.
 */
export function findCodeVerifierCapability(languageId: string): Promise<CodeVerifierCapability> {
  // Callers receive language ids from different boundaries (file extension maps,
  // corpus metadata, and learned code proposals). Keep those boundaries on the
  // same warm entry so a casing/whitespace difference cannot start another
  // process probe for the same language.
  const key = canonicalLanguageId(languageId);
  const cached = discovered.get(key);
  if (cached) return cached;
  let lookup: Promise<CodeVerifierCapability>;
  lookup = probe(key).catch(error => {
    // A failed initialization is different from a stable unavailable result.
    // Drop only our own entry so concurrent callers still share this attempt,
    // while a later turn can retry after a transient process/filesystem fault.
    if (discovered.get(key) === lookup) discovered.delete(key);
    throw error;
  });
  discovered.set(key, lookup);
  return lookup;
}

/** The checker for a file, by the language its extension names. */
export function findCodeVerifierForPath(filePath: string): Promise<DiscoveredCodeVerifier | undefined> {
  const languageId = codeLanguageForPath(filePath);
  return languageId ? findCodeVerifier(languageId) : Promise.resolve(undefined);
}

/** Resolve the checker capability for a path, retaining an actionable absence reason. */
export function findCodeVerifierCapabilityForPath(filePath: string): Promise<CodeVerifierCapability> {
  const languageId = codeLanguageForPath(filePath);
  return languageId
    ? findCodeVerifierCapability(languageId)
    : Promise.resolve({ languageId: "unknown", status: "unavailable", reason: "no language checker is configured for this path" });
}

function canonicalLanguageId(languageId: string): string {
  return languageId.trim().toLowerCase();
}


async function probe(languageId: string): Promise<CodeVerifierCapability> {
  const check = DEFAULT_LANGUAGE_CHECKS[languageId];
  // TypeScript and JavaScript carry no command: the verifier resolves the compiler it ships with.
  if (!check?.command) {
    return {
      languageId,
      status: "unavailable",
      reason: check ? `${languageId} uses the workspace compiler path rather than a discovered checker` : `no checker specification exists for ${languageId}`
    };
  }
  const versionArgs = VERSION_ARGS[languageId] ?? ["--version"];
  const commands = [...new Set([check.command, ...(check.commandAlternatives ?? [])].flatMap(command => [command, ...installedElsewhere(languageId, command)]))];
  for (const command of commands) {
    const result = await runProcess(command, [...versionArgs], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!result || result.code !== 0) continue;
    const resolvedCheck = check.compilerDriver === "dotnet-csharp" ? await csharpCompilerCheck(command, check) : { ...check, command };
    if (!resolvedCheck) continue;
    return {
      status: "available",
      languageId,
      verifier: {
        languageId,
        command,
        version: `${result.stdout}${result.stderr}`.split(/\r?\n/u)[0]?.trim() ?? "",
        check: resolvedCheck
      }
    };
  }
  return {
    languageId,
    status: "unavailable",
    reason: `${languageId} checker was not found; tried ${commands.join(", ")}`
  };
}

/** Resolve the installed Roslyn compiler and SDK reference pack, without restore, projects, or build hooks. */
async function csharpCompilerCheck(command: string, check: LanguageCheckCommand): Promise<LanguageCheckCommand | undefined> {
  const result = await runProcess(command, ["--list-sdks"], { timeoutMs: 10_000 });
  if (result.code !== 0) return undefined;
  const sdks = result.stdout.split(/\r?\n/u).flatMap(line => {
    const match = /^(\S+) \[(.+)\]$/u.exec(line.trim());
    return match ? [{ version: match[1]!, directory: match[2]! }] : [];
  }).sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  for (const sdk of sdks) {
    const compiler = path.join(sdk.directory, sdk.version, "Roslyn/bincore/csc.dll");
    if (!existsSync(compiler)) continue;
    const packRoot = path.join(path.dirname(sdk.directory), "packs/Microsoft.NETCore.App.Ref");
    const versions = (await readdir(packRoot).catch(() => [])).filter(version => Number(version.split(".")[0]) <= Number(sdk.version.split(".")[0]))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    for (const version of versions) {
      const referenceRoot = path.join(packRoot, version, "ref");
      for (const framework of (await readdir(referenceRoot).catch(() => [])).sort().reverse()) {
        const directory = path.join(referenceRoot, framework);
        const assemblies = (await readdir(directory).catch(() => [])).filter(name => name.endsWith(".dll")).sort();
        if (!assemblies.length) continue;
        const { compilerDriver: _driver, ...resolved } = check;
        return { ...resolved, command, args: ["exec", compiler, "-nologo", "-noconfig", "-nostdlib+", "-target:library", "-out:{output}.dll",
          ...assemblies.map(name => `-reference:${path.join(directory, name)}`), "{artifact}"] };
      }
    }
  }
  return undefined;
}

/** The same executable under each search path that exists, so a toolchain outside PATH is still found. */
function installedElsewhere(languageId: string, command: string): string[] {
  const out: string[] = [];
  for (const directory of SEARCH_PATHS[languageId] ?? []) {
    const resolved = directory.startsWith("~") ? path.join(homedir(), directory.slice(1)) : directory;
    if (!existsSync(resolved)) continue;
    for (const name of [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]) {
      const full = path.join(resolved, name);
      if (existsSync(full)) out.push(full);
    }
  }
  return out;
}

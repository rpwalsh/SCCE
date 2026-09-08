// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
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
  go: ["~/go/bin", "/usr/local/go/bin"],
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

const discovered = new Map<string, Promise<DiscoveredCodeVerifier | undefined>>();

/** The checker for a language, resolved to where it lives, or nothing when this machine has none. */
export function findCodeVerifier(languageId: string): Promise<DiscoveredCodeVerifier | undefined> {
  const cached = discovered.get(languageId);
  if (cached) return cached;
  const lookup = probe(languageId);
  discovered.set(languageId, lookup);
  return lookup;
}

/** The checker for a file, by the language its extension names. */
export function findCodeVerifierForPath(filePath: string): Promise<DiscoveredCodeVerifier | undefined> {
  const languageId = codeLanguageForPath(filePath);
  return languageId ? findCodeVerifier(languageId) : Promise.resolve(undefined);
}


async function probe(languageId: string): Promise<DiscoveredCodeVerifier | undefined> {
  const check = DEFAULT_LANGUAGE_CHECKS[languageId];
  // TypeScript and JavaScript carry no command: the verifier resolves the compiler it ships with.
  if (!check?.command) return undefined;
  const versionArgs = VERSION_ARGS[languageId] ?? ["--version"];
  for (const command of [check.command, ...installedElsewhere(languageId, check.command)]) {
    const result = await runProcess(command, [...versionArgs], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!result || result.code !== 0) continue;
    return {
      languageId,
      command,
      version: `${result.stdout}${result.stderr}`.split(/\r?\n/u)[0]?.trim() ?? "",
      check: { ...check, command }
    };
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

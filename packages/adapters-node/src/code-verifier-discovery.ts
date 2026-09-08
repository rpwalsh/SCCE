// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { codeLanguageForPath } from "@scce/kernel";
import { runProcess } from "./document.js";

/**
 * Which languages this machine can check, and with what.
 *
 * The repair loop needs a verifier, not a compiler, and the difference matters commercially: composition is
 * language-neutral, so the only thing standing between this system and a language is something that can say
 * whether an edit is valid. There are three strengths of answer and they are not interchangeable.
 *
 * A **compiler** bounds meaning: types, scopes, arity. TypeScript and the C family have dedicated ports.
 * A **checker** discovered on the machine bounds rather less, but bounds it in the language's own terms -- what
 * `rustc --emit=metadata` or `python -m py_compile` will accept.
 * A **grammar** bounds form only. Every WebAssembly grammar this system carries answers that with nothing
 * installed at all.
 *
 * A language with none of the three gets no repair. Reporting an unverifiable edit as applied would forfeit the
 * only guarantee this lane has.
 *
 * Discovery searches beyond PATH deliberately. `rustup` installs to `~/.cargo/bin` and edits PATH for new shells
 * only, so a machine with a working Rust toolchain reports none to a process started before the install -- and
 * the same is true of a Go under `~/go` and of anything installed in the current session.
 */

export interface CodeVerifierSpec {
  languageId: string;
  /** Executables to try, in order of preference. */
  candidates: readonly string[];
  /** Directories to look in beyond PATH; `~` is expanded and missing ones are skipped. */
  searchPaths?: readonly string[];
  /** Arguments that make the tool exit 0 and print a version. */
  versionArgs: readonly string[];
  /** Arguments that check one file without producing an artifact, given the file path. */
  checkArgs: (filePath: string) => readonly string[];
  /** Where to get it, shown verbatim when it is absent. */
  install: string;
}

export interface DiscoveredCodeVerifier {
  languageId: string;
  command: string;
  version: string;
  checkArgs: (filePath: string) => readonly string[];
}

/**
 * The check commands, one per language, chosen so that each inspects a file and produces nothing.
 *
 * A verifier that emits a binary is a build, and a build has side effects a repair loop must not cause; every
 * invocation here is the language's own "would this be accepted" and writes nothing outside its own temp space.
 */
export const CODE_VERIFIER_SPECS: readonly CodeVerifierSpec[] = Object.freeze([
  {
    languageId: "python",
    candidates: ["python3", "python", "py"],
    searchPaths: ["~/.pyenv/shims", "~/AppData/Local/Programs/Python"],
    versionArgs: ["--version"],
    checkArgs: (filePath: string) => ["-m", "py_compile", filePath],
    install: "https://www.python.org/downloads/"
  },
  {
    languageId: "rust",
    candidates: ["rustc"],
    searchPaths: ["~/.cargo/bin"],
    versionArgs: ["--version"],
    checkArgs: (filePath: string) => ["--edition", "2021", "--emit=metadata", "--crate-type", "lib", "-o", devNull(), filePath],
    install: "https://rustup.rs"
  },
  {
    languageId: "go",
    candidates: ["go"],
    searchPaths: ["~/go/bin", "/usr/local/go/bin"],
    versionArgs: ["version"],
    checkArgs: (filePath: string) => ["vet", filePath],
    install: "https://go.dev/dl/"
  },
  {
    languageId: "php",
    candidates: ["php"],
    searchPaths: ["~/toolchains/php"],
    versionArgs: ["--version"],
    checkArgs: (filePath: string) => ["-l", filePath],
    install: "https://www.php.net/downloads"
  },
  {
    languageId: "ruby",
    candidates: ["ruby"],
    searchPaths: ["~/.rbenv/shims"],
    versionArgs: ["--version"],
    checkArgs: (filePath: string) => ["-c", filePath],
    install: "https://www.ruby-lang.org/en/downloads/"
  },
  {
    languageId: "java",
    candidates: ["javac"],
    searchPaths: ["~/.sdkman/candidates/java/current/bin"],
    versionArgs: ["-version"],
    checkArgs: (filePath: string) => ["-proc:only", "-d", devNull(), filePath],
    install: "https://adoptium.net"
  }
]);

const discovered = new Map<string, Promise<DiscoveredCodeVerifier | undefined>>();

/** Forget what was discovered, so a toolchain installed since the last look is seen. */
export function forgetDiscoveredVerifiers(): void {
  discovered.clear();
}

/** The verifier for a language, or nothing when this machine has none. */
export function findCodeVerifier(languageId: string): Promise<DiscoveredCodeVerifier | undefined> {
  const cached = discovered.get(languageId);
  if (cached) return cached;
  const spec = CODE_VERIFIER_SPECS.find(item => item.languageId === languageId);
  const lookup = spec ? probe(spec) : Promise.resolve(undefined);
  discovered.set(languageId, lookup);
  return lookup;
}

/** The verifier for a file, by the language its extension names. */
export function findCodeVerifierForPath(filePath: string): Promise<DiscoveredCodeVerifier | undefined> {
  const languageId = codeLanguageForPath(filePath);
  return languageId ? findCodeVerifier(languageId) : Promise.resolve(undefined);
}

async function probe(spec: CodeVerifierSpec): Promise<DiscoveredCodeVerifier | undefined> {
  for (const candidate of spec.candidates) {
    for (const command of [candidate, ...directoryCandidates(spec, candidate)]) {
      const result = await runProcess(command, [...spec.versionArgs], { timeoutMs: 10_000 }).catch(() => undefined);
      if (!result || result.code !== 0) continue;
      return {
        languageId: spec.languageId,
        command,
        version: `${result.stdout}${result.stderr}`.split(/\r?\n/u)[0]?.trim() ?? "",
        checkArgs: spec.checkArgs
      };
    }
  }
  return undefined;
}

/** The same executable under each search path that exists, so a toolchain outside PATH is still found. */
function directoryCandidates(spec: CodeVerifierSpec, candidate: string): string[] {
  const out: string[] = [];
  for (const directory of spec.searchPaths ?? []) {
    const resolved = directory.startsWith("~")
      ? path.join(homedir(), directory.slice(1))
      : directory;
    if (!existsSync(resolved)) continue;
    for (const name of [candidate, `${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]) {
      const full = path.join(resolved, name);
      if (existsSync(full)) out.push(full);
    }
  }
  return out;
}

/** The platform's discard sink, for checkers that insist on an output path they will not meaningfully use. */
function devNull(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

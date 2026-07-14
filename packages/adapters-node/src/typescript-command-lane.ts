export interface TypeScriptCommandLaneInput {
  rawCommand: string;
  sourceSelector: string;
  sourcePath: string;
  cwd: string;
}

export type TypeScriptCommandLaneWrapper =
  | "direct"
  | "pnpm_exec"
  | "npm_exec"
  | "npx_no_install"
  | "yarn_exec";

export type TypeScriptCommandLaneMode = "project" | "build";

export interface TypeScriptCommandLane {
  schema: "scce.typescript.compiler_command_lane.v1";
  wrapper: TypeScriptCommandLaneWrapper;
  observed: {
    executable: string;
    args: string[];
    rawCommand: string;
    sourceSelector: string;
    sourcePath: string;
    cwd: string;
  };
  compilerExecutable: string;
  normalizedTscArgs: string[];
  mode: TypeScriptCommandLaneMode;
  languageServiceCompatible: boolean;
  compatibilityReason:
    | "typescript_language_service_project_mode"
    | "typescript_build_mode_requires_solution_builder";
}

export type TypeScriptCommandLaneErrorCode =
  | "invalid_source_metadata"
  | "empty_command"
  | "unsafe_shell_syntax"
  | "malformed_command"
  | "empty_argument"
  | "environment_assignment"
  | "nested_script"
  | "installer_wrapper"
  | "missing_typescript_compiler"
  | "unsupported_command_lane";

export type TypeScriptCommandLaneResolution =
  | { ok: true; lane: TypeScriptCommandLane }
  | { ok: false; error: { code: TypeScriptCommandLaneErrorCode; message: string } };

export type PortablePackageScriptArgvResolution =
  | { ok: true; executable: string; args: string[] }
  | { ok: false; error: { code: TypeScriptCommandLaneErrorCode; message: string } };

export interface TypeScriptCommandLaneSourceBindingInput {
  lane: TypeScriptCommandLane;
  sourceContent: string;
}

export type TypeScriptCommandLaneSourceBindingErrorCode =
  | "invalid_lane"
  | "invalid_source_content"
  | "invalid_source_selector"
  | "ambiguous_source_selector"
  | "ambiguous_source_path"
  | "source_cwd_mismatch"
  | "invalid_source_json"
  | "invalid_source_object"
  | "missing_scripts_object"
  | "missing_script"
  | "non_string_script"
  | "source_script_mismatch"
  | "lane_reresolution_failed"
  | "wrapper_mismatch"
  | "observed_argv_mismatch"
  | "compiler_argv_mismatch"
  | "mode_mismatch";

export interface TypeScriptCommandLaneSourceBinding {
  schema: "scce.typescript.compiler_command_lane_source_binding.v1";
  sourceSelector: string;
  scriptName: string;
  sourcePath: string;
  normalizedSourcePath: string;
  cwd: string;
  rawCommand: string;
  wrapper: TypeScriptCommandLaneWrapper;
  mode: TypeScriptCommandLaneMode;
  languageServiceCompatible: boolean;
}

export type TypeScriptCommandLaneSourceBindingResult =
  | { ok: true; binding: TypeScriptCommandLaneSourceBinding }
  | {
    ok: false;
    error: {
      code: TypeScriptCommandLaneSourceBindingErrorCode;
      message: string;
      causeCode?: TypeScriptCommandLaneErrorCode;
    };
  };

interface ParsedWords {
  ok: true;
  words: string[];
}

interface ParsedWordsFailure {
  ok: false;
  code: "unsafe_shell_syntax" | "malformed_command";
  message: string;
}

interface CompilerInvocation {
  wrapper: TypeScriptCommandLaneWrapper;
  compilerExecutable: string;
  args: string[];
}

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const NESTED_SCRIPT_VERBS = new Set(["run", "run-script", "run-script-silent"]);
const INSTALLER_VERBS = new Set(["add", "create", "dlx", "i", "init", "install", "link"]);
const NETWORK_CAPABLE_EXECUTABLES = new Set(["bunx", "corepack", "pnpx"]);

/**
 * Resolves only compiler invocations that can be represented as an executable
 * and argv without invoking a shell. The returned observed command remains
 * source-exact; wrapper removal is confined to normalizedTscArgs.
 */
export function resolveTypeScriptCommandLane(input: TypeScriptCommandLaneInput): TypeScriptCommandLaneResolution {
  const metadataError = validateSourceMetadata(input);
  if (metadataError) return failure("invalid_source_metadata", metadataError);
  const portable = resolvePortablePackageScriptArgv(input.rawCommand);
  if (!portable.ok) return portable;
  const executable = portable.executable;
  const observedArgs = portable.args;
  const invocation = compilerInvocation(executable, observedArgs);
  if (!invocation.ok) return invocation;

  const mode: TypeScriptCommandLaneMode = invocation.value.args.some(isBuildArgument) ? "build" : "project";
  return {
    ok: true,
    lane: {
      schema: "scce.typescript.compiler_command_lane.v1",
      wrapper: invocation.value.wrapper,
      observed: {
        executable,
        args: observedArgs,
        rawCommand: input.rawCommand,
        sourceSelector: input.sourceSelector,
        sourcePath: input.sourcePath,
        cwd: input.cwd
      },
      compilerExecutable: invocation.value.compilerExecutable,
      normalizedTscArgs: invocation.value.args,
      mode,
      languageServiceCompatible: mode !== "build",
      compatibilityReason: mode === "build"
        ? "typescript_build_mode_requires_solution_builder"
        : "typescript_language_service_project_mode"
    }
  };
}

/**
 * Parse the portable, no-expansion argv subset accepted from an exact package
 * script. The result is safe to pass to a process API with `shell:false`.
 */
export function resolvePortablePackageScriptArgv(rawCommand: string): PortablePackageScriptArgvResolution {
  if (!rawCommand.trim()) return failure("empty_command", "observed package-script command is empty");
  if (rawCommand.includes("\u0000")) return failure("malformed_command", "observed package-script command contains NUL");
  const parsed = parseCommandWords(rawCommand);
  if (!parsed.ok) return failure(parsed.code, parsed.message);
  if (!parsed.words.length) return failure("empty_command", "observed package-script command is empty");
  if (parsed.words.some(word => !word || word.includes("\u0000"))) {
    return failure("empty_argument", "observed package-script command contains an empty or NUL argument");
  }
  if (parsed.words.some(word => ENVIRONMENT_ASSIGNMENT.test(word))) {
    return failure("environment_assignment", "environment assignments are not part of the portable package-script argv lane");
  }
  const [executable, ...args] = parsed.words;
  return executable
    ? { ok: true, executable, args }
    : failure("empty_command", "observed package-script command has no executable");
}

/**
 * Proves that a resolved command lane is an exact value from one JSON scripts
 * object and that its source location supplies the observed working directory.
 * All untrusted shapes and parse failures are returned as data.
 */
export function verifyTypeScriptCommandLaneSourceBinding(
  input: TypeScriptCommandLaneSourceBindingInput
): TypeScriptCommandLaneSourceBindingResult {
  try {
    return verifyTypeScriptCommandLaneSourceBindingInternal(input as unknown);
  } catch {
    return bindingFailure("invalid_lane", "compiler command lane could not be inspected safely");
  }
}

function verifyTypeScriptCommandLaneSourceBindingInternal(input: unknown): TypeScriptCommandLaneSourceBindingResult {
  const record = objectRecord(input);
  const lane = validLane(record?.lane);
  if (!lane) return bindingFailure("invalid_lane", "compiler command lane has an invalid structure");
  if (typeof record?.sourceContent !== "string") {
    return bindingFailure("invalid_source_content", "exact source artifact content must be a string");
  }

  const selector = sourceSelectorName(lane.observed.sourceSelector);
  if (!selector.ok) return selector.result;
  const sourcePath = normalizedRelativePath(lane.observed.sourcePath);
  if (!sourcePath) {
    return bindingFailure("ambiguous_source_path", "command source path is absolute, empty, or contains ambiguous traversal segments");
  }
  const expectedCwd = sourceDirectory(sourcePath);
  if (lane.observed.cwd !== expectedCwd) {
    return bindingFailure("source_cwd_mismatch", `observed cwd must equal the normalized command source directory: ${expectedCwd}`);
  }

  const source = parseSourceObject(record.sourceContent);
  if (!source.ok) return source.result;
  const scriptsValue = ownValue(source.value, "scripts");
  const scripts = objectRecord(scriptsValue);
  if (!scripts) return bindingFailure("missing_scripts_object", "exact source artifact does not contain a JSON scripts object");
  if (!Object.prototype.hasOwnProperty.call(scripts, selector.name)) {
    return bindingFailure("missing_script", `exact source artifact does not contain ${lane.observed.sourceSelector}`);
  }
  const script = ownValue(scripts, selector.name);
  if (typeof script !== "string") {
    return bindingFailure("non_string_script", `${lane.observed.sourceSelector} is not a string command`);
  }
  if (script !== lane.observed.rawCommand) {
    return bindingFailure("source_script_mismatch", "source script value does not exactly equal the observed raw command");
  }

  const resolved = resolveTypeScriptCommandLane({
    rawCommand: script,
    sourceSelector: lane.observed.sourceSelector,
    sourcePath: lane.observed.sourcePath,
    cwd: lane.observed.cwd
  });
  if (!resolved.ok) {
    return bindingFailure("lane_reresolution_failed", "source script does not independently resolve to a compiler command lane", resolved.error.code);
  }
  const replay = resolved.lane;
  if (lane.wrapper !== replay.wrapper) {
    return bindingFailure("wrapper_mismatch", "stored wrapper does not match independent command resolution");
  }
  if (!sameObservedCommand(lane.observed, replay.observed)) {
    return bindingFailure("observed_argv_mismatch", "stored observed executable or argv does not match independent command resolution");
  }
  if (lane.compilerExecutable !== replay.compilerExecutable || !sameStrings(lane.normalizedTscArgs, replay.normalizedTscArgs)) {
    return bindingFailure("compiler_argv_mismatch", "stored compiler executable or normalized tsc argv does not match independent command resolution");
  }
  if (
    lane.mode !== replay.mode ||
    lane.languageServiceCompatible !== replay.languageServiceCompatible ||
    lane.compatibilityReason !== replay.compatibilityReason
  ) {
    return bindingFailure("mode_mismatch", "stored compiler mode or LanguageService compatibility does not match independent command resolution");
  }

  return {
    ok: true,
    binding: {
      schema: "scce.typescript.compiler_command_lane_source_binding.v1",
      sourceSelector: lane.observed.sourceSelector,
      scriptName: selector.name,
      sourcePath: lane.observed.sourcePath,
      normalizedSourcePath: sourcePath,
      cwd: lane.observed.cwd,
      rawCommand: lane.observed.rawCommand,
      wrapper: lane.wrapper,
      mode: lane.mode,
      languageServiceCompatible: lane.languageServiceCompatible
    }
  };
}

function sourceSelectorName(selector: string):
  | { ok: true; name: string }
  | { ok: false; result: Extract<TypeScriptCommandLaneSourceBindingResult, { ok: false }> } {
  if (!selector.startsWith("scripts.")) {
    return { ok: false, result: bindingFailure("invalid_source_selector", "source selector must begin with scripts.") };
  }
  const name = selector.slice("scripts.".length);
  if (!name) {
    return { ok: false, result: bindingFailure("invalid_source_selector", "source selector script name is empty") };
  }
  if (name.trim() !== name || /[.\\/\u0000\r\n]/u.test(name)) {
    return { ok: false, result: bindingFailure("ambiguous_source_selector", "source selector contains ambiguous nesting or traversal syntax") };
  }
  return { ok: true, name };
}

function normalizedRelativePath(value: string): string | undefined {
  if (!value || value.includes("\u0000") || /^[A-Za-z]:[\\/]/u.test(value) || /^[\\/]/u.test(value)) return undefined;
  const normalized = value.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (!segments.length || segments.some(segment => !segment || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

function sourceDirectory(sourcePath: string): string {
  const segments = sourcePath.split("/");
  return segments.length <= 1 ? "." : segments.slice(0, -1).join("/");
}

function parseSourceObject(sourceContent: string):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: Extract<TypeScriptCommandLaneSourceBindingResult, { ok: false }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceContent) as unknown;
  } catch {
    return { ok: false, result: bindingFailure("invalid_source_json", "exact source artifact is not valid JSON") };
  }
  const value = objectRecord(parsed);
  return value
    ? { ok: true, value }
    : { ok: false, result: bindingFailure("invalid_source_object", "exact source artifact must be a top-level JSON object") };
}

function validLane(value: unknown): TypeScriptCommandLane | undefined {
  const lane = objectRecord(value);
  const observed = objectRecord(lane?.observed);
  if (
    lane?.schema !== "scce.typescript.compiler_command_lane.v1" ||
    !isWrapper(lane.wrapper) ||
    !observed ||
    typeof observed.executable !== "string" ||
    !stringArray(observed.args) ||
    typeof observed.rawCommand !== "string" ||
    typeof observed.sourceSelector !== "string" ||
    typeof observed.sourcePath !== "string" ||
    typeof observed.cwd !== "string" ||
    typeof lane.compilerExecutable !== "string" ||
    !stringArray(lane.normalizedTscArgs) ||
    !isMode(lane.mode) ||
    typeof lane.languageServiceCompatible !== "boolean" ||
    !isCompatibilityReason(lane.compatibilityReason)
  ) return undefined;
  return lane as unknown as TypeScriptCommandLane;
}

function isWrapper(value: unknown): value is TypeScriptCommandLaneWrapper {
  return value === "direct" || value === "pnpm_exec" || value === "npm_exec" || value === "npx_no_install" || value === "yarn_exec";
}

function isMode(value: unknown): value is TypeScriptCommandLaneMode {
  return value === "project" || value === "build";
}

function isCompatibilityReason(value: unknown): value is TypeScriptCommandLane["compatibilityReason"] {
  return value === "typescript_language_service_project_mode" || value === "typescript_build_mode_requires_solution_builder";
}

function sameObservedCommand(left: TypeScriptCommandLane["observed"], right: TypeScriptCommandLane["observed"]): boolean {
  return left.executable === right.executable &&
    sameStrings(left.args, right.args) &&
    left.rawCommand === right.rawCommand &&
    left.sourceSelector === right.sourceSelector &&
    left.sourcePath === right.sourcePath &&
    left.cwd === right.cwd;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function bindingFailure(
  code: TypeScriptCommandLaneSourceBindingErrorCode,
  message: string,
  causeCode?: TypeScriptCommandLaneErrorCode
): Extract<TypeScriptCommandLaneSourceBindingResult, { ok: false }> {
  return { ok: false, error: { code, message, ...(causeCode ? { causeCode } : {}) } };
}

function validateSourceMetadata(input: TypeScriptCommandLaneInput): string | undefined {
  for (const [name, value] of [
    ["sourceSelector", input.sourceSelector],
    ["sourcePath", input.sourcePath],
    ["cwd", input.cwd]
  ] as const) {
    if (!value.trim()) return `${name} is empty`;
    if (value.includes("\u0000")) return `${name} contains NUL`;
  }
  return undefined;
}

function compilerInvocation(
  executable: string,
  args: string[]
): { ok: true; value: CompilerInvocation } | Extract<TypeScriptCommandLaneResolution, { ok: false }> {
  const command = executableName(executable);
  if (command === "tsc") return compiler("direct", executable, args);

  if (NETWORK_CAPABLE_EXECUTABLES.has(command)) {
    return failure("installer_wrapper", `network-capable executable wrapper is not allowed: ${executable}`);
  }

  if (command === "npx") {
    if (args[0] !== "--no-install") {
      return failure("installer_wrapper", "npx is allowed only with --no-install");
    }
    return wrappedCompiler("npx_no_install", args, 1);
  }

  if (command === "pnpm" || command === "npm" || command === "yarn") {
    const first = executableName(args[0] ?? "");
    if (INSTALLER_VERBS.has(first)) {
      return failure("installer_wrapper", `installer or network-capable package-manager verb is not allowed: ${first}`);
    }
    const lifecycleShortcut = command === "npm" && ["restart", "start", "stop", "test"].includes(first);
    if (NESTED_SCRIPT_VERBS.has(first) || lifecycleShortcut || (command === "yarn" || command === "pnpm") && Boolean(first) && first !== "exec") {
      return failure("nested_script", `nested package script is not an observed compiler invocation: ${executable} ${args[0] ?? ""}`.trim());
    }
    if (first !== "exec") {
      return failure("unsupported_command_lane", `unsupported package-manager compiler lane: ${executable} ${args[0] ?? ""}`.trim());
    }
    const compilerIndex = args[1] === "--" ? 2 : 1;
    const wrapper: TypeScriptCommandLaneWrapper = command === "pnpm"
      ? "pnpm_exec"
      : command === "npm"
        ? "npm_exec"
        : "yarn_exec";
    return wrappedCompiler(wrapper, args, compilerIndex);
  }

  if (command === "env" || command === "cross-env" || command === "cross-env-shell") {
    return failure("environment_assignment", `environment wrapper is not allowed: ${executable}`);
  }
  return failure("missing_typescript_compiler", `observed command does not invoke tsc: ${executable}`);
}

function wrappedCompiler(
  wrapper: TypeScriptCommandLaneWrapper,
  args: string[],
  compilerIndex: number
): { ok: true; value: CompilerInvocation } | Extract<TypeScriptCommandLaneResolution, { ok: false }> {
  const executable = args[compilerIndex];
  if (!executable || executableName(executable) !== "tsc") {
    return failure("missing_typescript_compiler", `${wrapper} command does not select tsc`);
  }
  return compiler(wrapper, executable, args.slice(compilerIndex + 1));
}

function compiler(
  wrapper: TypeScriptCommandLaneWrapper,
  compilerExecutable: string,
  args: string[]
): { ok: true; value: CompilerInvocation } {
  return { ok: true, value: { wrapper, compilerExecutable, args: [...args] } };
}

function executableName(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? value;
  return basename.replace(/\.(?:cmd|exe)$/iu, "").toLocaleLowerCase();
}

function isBuildArgument(value: string): boolean {
  return value === "-b" || value === "--build" || value.startsWith("--build=");
}

function parseCommandWords(raw: string): ParsedWords | ParsedWordsFailure {
  const words: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "double" | undefined;

  const push = () => {
    if (!tokenStarted) return;
    words.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index] ?? "";
    if (char === "\r" || char === "\n") {
      return parseFailure("unsafe_shell_syntax", "line breaks are not allowed in an observed package-script command");
    }

    if (quote === "double") {
      if (char === "\"") {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if ("`$%!^\\".includes(char)) {
        return parseFailure("unsafe_shell_syntax", "shell expansion or platform-specific escaping is not allowed in an observed compiler command");
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'") {
      return parseFailure("unsafe_shell_syntax", "single-quoted arguments are not portable between package-script shells");
    }
    if (char === "\"") {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    if (";&|<>()#".includes(char)) {
      return parseFailure("unsafe_shell_syntax", `shell operator is not allowed: ${char}`);
    }
    if ("`$%!^\\".includes(char)) {
      return parseFailure("unsafe_shell_syntax", "shell expansion or platform-specific escaping is not allowed in an observed compiler command");
    }
    if ("*?[]".includes(char) || char === "~" && !tokenStarted) {
      return parseFailure("unsafe_shell_syntax", "shell pathname or home-directory expansion is not allowed in an observed compiler command");
    }
    current += char;
    tokenStarted = true;
  }

  if (quote) return parseFailure("malformed_command", "observed package-script command has an unterminated quote");
  push();
  return { ok: true, words };
}

function parseFailure(code: ParsedWordsFailure["code"], message: string): ParsedWordsFailure {
  return { ok: false, code, message };
}

function failure(code: TypeScriptCommandLaneErrorCode, message: string): Extract<TypeScriptCommandLaneResolution, { ok: false }> {
  return { ok: false, error: { code, message } };
}

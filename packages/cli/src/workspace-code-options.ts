import { createHash } from "node:crypto";

export const WORKSPACE_CODE_USAGE = "scce workspace plan-code --path=<workspace-file> [--diagnostic-code=<integer>] [options] <request>" as const;
export const WORKSPACE_CODING_REQUEST_MAX_BYTES = 20_000;
export const WORKSPACE_CODING_REQUEST_MAX_PATHS = 256;
export const WORKSPACE_CODING_PATH_MAX_CHARS = 1_024;
export const WORKSPACE_CODING_ID_MAX_CHARS = 256;
export const WORKSPACE_CODING_MAX_FILES = 100_000;
export const WORKSPACE_CODING_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_CODING_MAX_DEPTH = 256;
export const WORKSPACE_CODING_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_WORKSPACE_CODING_VALIDATOR_ID = "trusted-host-pnpm-validate.v1" as const;
export const WORKSPACE_CODING_CHECKS = ["compiler", "typecheck", "tests"] as const;

export type WorkspaceCodingCheck = (typeof WORKSPACE_CODING_CHECKS)[number];

export interface WorkspaceCodingCliRequest {
  text: string;
  requestedPaths: string[];
  diagnosticCodes: number[];
  requestId?: string;
  rootPath?: string;
  validatorId: "trusted-host-pnpm-validate.v1" | "docker-pnpm-validate.v1";
  checks: WorkspaceCodingCheck[];
  workspaceOptionArgs: string[];
}

export interface WorkspaceCodingTurnArgs {
  turnArgs: string[];
  codingRequest?: WorkspaceCodingCliRequest;
}

/** Splits explicit chat controls from the structured compiler selector. */
export function splitWorkspaceCodingTurnArgs(args: readonly string[]): WorkspaceCodingTurnArgs {
  if (!args.includes("--workspace-code")) return { turnArgs: [...args] };
  if (args.filter(arg => arg === "--workspace-code").length !== 1) {
    throw new Error("turn contains duplicate --workspace-code");
  }
  const turnArgs: string[] = [];
  const codingArgs: string[] = [];
  for (const arg of args) {
    if (arg === "--workspace-code") continue;
    if (isTurnOnlyOption(arg)) {
      turnArgs.push(arg);
      continue;
    }
    if (isWorkspaceCodingOption(arg)) {
      codingArgs.push(arg);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown workspace coding turn option: ${arg}`);
    turnArgs.push(arg);
    codingArgs.push(arg);
  }
  const codingRequest = parseWorkspaceCodingRequest(codingArgs);
  if (!codingRequest) throw new Error("--workspace-code requires a request and at least one --path");
  return { turnArgs, codingRequest };
}

export function parseWorkspaceCodingRequest(args: readonly string[]): WorkspaceCodingCliRequest | undefined {
  const textParts: string[] = [];
  const requestedPaths: string[] = [];
  const diagnosticCodes: number[] = [];
  const workspaceOptionArgs: string[] = [];
  let requestId: string | undefined;
  let rootPath: string | undefined;
  let validatorId: WorkspaceCodingCliRequest["validatorId"] = DEFAULT_WORKSPACE_CODING_VALIDATOR_ID;
  let checks: WorkspaceCodingCheck[] = [...WORKSPACE_CODING_CHECKS];
  let literalText = false;
  let validatorSeen = false;
  let checksSeen = false;
  const workspaceOptionsSeen = new Set<string>();
  for (const arg of args) {
    if (literalText) {
      textParts.push(arg);
      continue;
    }
    if (arg === "--") {
      literalText = true;
      continue;
    }
    if (arg.startsWith("--path=")) {
      if (requestedPaths.length >= WORKSPACE_CODING_REQUEST_MAX_PATHS) throw new Error(`workspace coding request exceeds ${WORKSPACE_CODING_REQUEST_MAX_PATHS} paths`);
      requestedPaths.push(workspacePathFlag(arg.slice("--path=".length)));
      continue;
    }
    if (arg.startsWith("--request-id=")) {
      if (requestId !== undefined) throw new Error("workspace coding request contains duplicate --request-id");
      requestId = boundedIdFlag(arg.slice("--request-id=".length), "--request-id");
      continue;
    }
    if (arg.startsWith("--diagnostic-code=")) {
      const value = Number(requiredFlagValue(arg.slice("--diagnostic-code=".length), "--diagnostic-code"));
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--diagnostic-code must be a positive integer");
      if (diagnosticCodes.includes(value)) throw new Error("workspace coding request contains duplicate diagnostic codes");
      diagnosticCodes.push(value);
      continue;
    }
    if (arg.startsWith("--root=")) {
      if (rootPath !== undefined) throw new Error("workspace coding request contains duplicate --root");
      rootPath = boundedRootFlag(arg.slice("--root=".length));
      continue;
    }
    if (arg.startsWith("--validator=")) {
      if (validatorSeen) throw new Error("workspace coding request contains duplicate --validator");
      validatorSeen = true;
      const value = requiredFlagValue(arg.slice("--validator=".length), "--validator");
      if (value !== "trusted-host-pnpm-validate.v1" && value !== "docker-pnpm-validate.v1") {
        throw new Error(`unknown workspace patch validator: ${value}`);
      }
      validatorId = value;
      continue;
    }
    if (arg.startsWith("--checks=")) {
      if (checksSeen) throw new Error("workspace coding request contains duplicate --checks");
      checksSeen = true;
      checks = validationChecks(arg.slice("--checks=".length));
      continue;
    }
    if (validateCodingWorkspaceOption(arg, workspaceOptionsSeen)) {
      workspaceOptionArgs.push(arg);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown workspace coding option: ${arg}`);
    textParts.push(arg);
  }
  const text = textParts.join(" ").trim();
  if (!text || requestedPaths.length === 0) return undefined;
  if (text.includes("\0")) throw new Error("workspace coding request must not contain NUL bytes");
  if (Buffer.byteLength(text, "utf8") > WORKSPACE_CODING_REQUEST_MAX_BYTES) {
    throw new Error(`workspace coding request exceeds ${WORKSPACE_CODING_REQUEST_MAX_BYTES} UTF-8 bytes`);
  }
  if (new Set(requestedPaths).size !== requestedPaths.length) throw new Error("workspace coding request contains duplicate paths");
  requestedPaths.sort(compareCanonical);
  diagnosticCodes.sort((left, right) => left - right);
  return { text, requestedPaths, diagnosticCodes, requestId, rootPath, validatorId, checks, workspaceOptionArgs };
}

export function defaultWorkspaceCodingRequestId(input: {
  workspaceId: string;
  expectedWorkspaceUpdatedAt: number;
  request: Pick<WorkspaceCodingCliRequest, "text" | "requestedPaths" | "diagnosticCodes" | "validatorId" | "checks">;
}): string {
  return `workspace_code_${createHash("sha256")
    .update(JSON.stringify({
      workspaceId: input.workspaceId,
      updatedAt: input.expectedWorkspaceUpdatedAt,
      text: input.request.text,
      paths: input.request.requestedPaths,
      diagnosticCodes: input.request.diagnosticCodes,
      validatorId: input.request.validatorId,
      checks: input.request.checks
    }))
    .digest("hex")
    .slice(0, 24)}`;
}

function workspacePathFlag(raw: string): string {
  const value = requiredFlagValue(raw, "--path");
  if ([...value].length > WORKSPACE_CODING_PATH_MAX_CHARS) throw new Error(`workspace coding path exceeds ${WORKSPACE_CODING_PATH_MAX_CHARS} characters`);
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`workspace coding path must be relative and slash-separated: ${value}`);
  }
  if (value.normalize("NFC") !== value || value.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`workspace coding path is unsafe: ${value}`);
  }
  return value;
}

function boundedIdFlag(raw: string, flag: string): string {
  const value = requiredFlagValue(raw, flag);
  if (value.includes("\0") || [...value].length > WORKSPACE_CODING_ID_MAX_CHARS) {
    throw new Error(`${flag} must contain at most ${WORKSPACE_CODING_ID_MAX_CHARS} characters without NUL bytes`);
  }
  return value;
}

function boundedRootFlag(raw: string): string {
  const value = requiredFlagValue(raw, "--root");
  if (value.includes("\0") || [...value].length > 32_768) throw new Error("--root is invalid or exceeds 32768 characters");
  return value;
}

function validationChecks(raw: string): WorkspaceCodingCheck[] {
  const value = requiredFlagValue(raw, "--checks");
  const parsed = value.split(",").map(item => item.trim());
  if (parsed.some(item => !item) || parsed.some(item => !WORKSPACE_CODING_CHECKS.includes(item as WorkspaceCodingCheck))) {
    throw new Error("workspace coding checks must be a comma-separated subset of compiler,typecheck,tests");
  }
  if (new Set(parsed).size !== parsed.length) throw new Error("workspace coding checks must not contain duplicates");
  const selected = new Set(parsed);
  return WORKSPACE_CODING_CHECKS.filter(check => selected.has(check));
}

function validateCodingWorkspaceOption(arg: string, seen: Set<string>): boolean {
  if (arg === "--no-unsupported") {
    rejectDuplicateOption("--no-unsupported", seen);
    return true;
  }
  const [flag, raw, ...extra] = arg.split("=");
  const bounds: Partial<Record<string, readonly [number, number]>> = {
    "--max-files": [1, WORKSPACE_CODING_MAX_FILES],
    "--max-file-bytes": [1_024, WORKSPACE_CODING_MAX_FILE_BYTES],
    "--max-depth": [0, WORKSPACE_CODING_MAX_DEPTH],
    "--max-document-bytes": [4_096, WORKSPACE_CODING_MAX_DOCUMENT_BYTES]
  };
  const bound = bounds[flag ?? ""];
  if (!bound) return false;
  rejectDuplicateOption(flag!, seen);
  const value = raw === undefined || extra.length > 0 ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < bound[0] || value > bound[1]) {
    throw new Error(`${flag} must be an integer from ${bound[0]} through ${bound[1]}`);
  }
  return true;
}

function isWorkspaceCodingOption(arg: string): boolean {
  return arg.startsWith("--path=")
    || arg.startsWith("--request-id=")
    || arg.startsWith("--diagnostic-code=")
    || arg.startsWith("--root=")
    || arg.startsWith("--validator=")
    || arg.startsWith("--checks=")
    || arg === "--no-unsupported"
    || arg.startsWith("--max-files=")
    || arg.startsWith("--max-file-bytes=")
    || arg.startsWith("--max-depth=")
    || arg.startsWith("--max-document-bytes=");
}

function isTurnOnlyOption(arg: string): boolean {
  return arg === "--web"
    || arg.startsWith("--session-id=")
    || arg.startsWith("--conversation-id=")
    || arg.startsWith("--target-language=")
    || arg.startsWith("--detail=")
    || arg.startsWith("--detail-profile=")
    || arg.startsWith("--web-limit=")
    || arg.startsWith("--web-max-pages=")
    || arg.startsWith("--web-max-bytes=")
    || arg.startsWith("--web-min-evidence=")
    || arg.startsWith("--web-min-lcb=");
}

function rejectDuplicateOption(flag: string, seen: Set<string>): void {
  if (seen.has(flag)) throw new Error(`workspace coding request contains duplicate ${flag}`);
  seen.add(flag);
}

function requiredFlagValue(raw: string, flag: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`invalid ${flag} value`);
  return value;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

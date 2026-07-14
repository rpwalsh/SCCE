import { describe, expect, it } from "vitest";
import {
  resolvePortablePackageScriptArgv,
  resolveTypeScriptCommandLane,
  verifyTypeScriptCommandLaneSourceBinding,
  type TypeScriptCommandLane,
  type TypeScriptCommandLaneInput,
  type TypeScriptCommandLaneWrapper
} from "../typescript-command-lane.js";

describe("TypeScript compiler command lane", () => {
  it("preserves the observed direct command while exposing only tsc arguments", () => {
    const input = command(`  tsc --project "configs/ts config.json" --pretty false  `);
    const result = resolveTypeScriptCommandLane(input);

    expect(result).toEqual({
      ok: true,
      lane: {
        schema: "scce.typescript.compiler_command_lane.v1",
        wrapper: "direct",
        observed: {
          executable: "tsc",
          args: ["--project", "configs/ts config.json", "--pretty", "false"],
          rawCommand: input.rawCommand,
          sourceSelector: input.sourceSelector,
          sourcePath: input.sourcePath,
          cwd: input.cwd
        },
        compilerExecutable: "tsc",
        normalizedTscArgs: ["--project", "configs/ts config.json", "--pretty", "false"],
        mode: "project",
        languageServiceCompatible: true,
        compatibilityReason: "typescript_language_service_project_mode"
      }
    });
  });

  it.each<[string, TypeScriptCommandLaneWrapper, string[]]>([
    ["pnpm exec tsc -p tsconfig.json", "pnpm_exec", ["-p", "tsconfig.json"]],
    ["pnpm exec -- tsc --noEmit", "pnpm_exec", ["--noEmit"]],
    ["npm exec tsc -p tsconfig.json", "npm_exec", ["-p", "tsconfig.json"]],
    ["npm exec -- tsc --noEmit", "npm_exec", ["--noEmit"]],
    ["npx --no-install tsc -p tsconfig.json", "npx_no_install", ["-p", "tsconfig.json"]],
    ["yarn exec tsc --noEmit", "yarn_exec", ["--noEmit"]]
  ])("resolves the allowed wrapper form %s", (rawCommand, wrapper, normalizedTscArgs) => {
    const result = resolveTypeScriptCommandLane(command(rawCommand));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane.wrapper).toBe(wrapper);
    expect(result.lane.normalizedTscArgs).toEqual(normalizedTscArgs);
    expect(result.lane.observed.args).toEqual(rawCommand.trim().split(/\s+/u).slice(1));
  });

  it.each([
    "tsc -b packages/a packages/b",
    "tsc --build tsconfig.build.json",
    "pnpm exec -- tsc --build=tsconfig.build.json"
  ])("marks build mode as incompatible with the LanguageService lane: %s", rawCommand => {
    const result = resolveTypeScriptCommandLane(command(rawCommand));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane.mode).toBe("build");
    expect(result.lane.languageServiceCompatible).toBe(false);
    expect(result.lane.compatibilityReason).toBe("typescript_build_mode_requires_solution_builder");
  });

  it.each([
    "tsc -p tsconfig.json && echo done",
    "tsc; echo done",
    "tsc | tee output.txt",
    "tsc > output.txt",
    "tsc $(echo --noEmit)",
    "tsc `echo --noEmit`",
    "tsc $TSC_ARGS",
    "tsc $$",
    "tsc %TSC_ARGS%",
    "tsc !TSC_ARGS!",
    "tsc -p configs/*.json",
    "tsc -p configs/tsconfig?.json",
    "tsc -p configs/[ab].json",
    "tsc -p ~/tsconfig.json",
    String.raw`tsc -p configs\windows\tsconfig.json`,
    "tsc ^--noEmit",
    "tsc '#not-portable'",
    "tsc\n--noEmit"
  ])("rejects shell syntax: %s", rawCommand => {
    expect(errorCode(rawCommand)).toBe("unsafe_shell_syntax");
  });

  it("treats quoted operator characters as literal argument content", () => {
    const result = resolveTypeScriptCommandLane(command(`tsc -p "configs/a;b.json"`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lane.normalizedTscArgs).toEqual(["-p", "configs/a;b.json"]);
  });

  it.each([
    "NODE_ENV=test tsc --noEmit",
    "env NODE_ENV=test tsc --noEmit",
    "cross-env NODE_ENV=test tsc --noEmit"
  ])("rejects environment assignment lanes: %s", rawCommand => {
    expect(errorCode(rawCommand)).toBe("environment_assignment");
  });

  it.each([
    "pnpm run typecheck",
    "pnpm typecheck",
    "npm run build",
    "npm run-script typecheck",
    "npm test",
    "yarn run tsc",
    "yarn typecheck"
  ])("rejects nested package scripts: %s", rawCommand => {
    expect(errorCode(rawCommand)).toBe("nested_script");
  });

  it.each([
    "npx tsc --noEmit",
    "pnpm dlx typescript --noEmit",
    "npm install typescript",
    "yarn dlx typescript",
    "bunx tsc --noEmit",
    "corepack pnpm exec tsc"
  ])("rejects installer or network-capable wrappers: %s", rawCommand => {
    expect(errorCode(rawCommand)).toBe("installer_wrapper");
  });

  it.each([
    "eslint src",
    "pnpm exec eslint src",
    "npm exec -- eslint src",
    "npx --no-install eslint src",
    "yarn exec eslint src"
  ])("rejects command lanes that do not select tsc: %s", rawCommand => {
    expect(errorCode(rawCommand)).toBe("missing_typescript_compiler");
  });

  it.each([
    ["tsc \"\"", "empty_argument"],
    ["tsc ''", "unsafe_shell_syntax"],
    [`tsc "unterminated`, "malformed_command"],
    ["tsc \\", "unsafe_shell_syntax"],
    ["tsc\u0000--noEmit", "malformed_command"],
    ["   ", "empty_command"]
  ])("rejects malformed or empty argv in %j", (rawCommand, expectedCode) => {
    expect(errorCode(rawCommand)).toBe(expectedCode);
  });

  it.each([
    { sourceSelector: "", sourcePath: "package.json", cwd: "." },
    { sourceSelector: "scripts.typecheck", sourcePath: "", cwd: "." },
    { sourceSelector: "scripts.typecheck", sourcePath: "package.json", cwd: "\u0000" }
  ])("rejects invalid source metadata without normalizing it", metadata => {
    const result = resolveTypeScriptCommandLane({ rawCommand: "tsc", ...metadata });
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_source_metadata" } });
  });
});

describe("portable package-script argv", () => {
  it("parses literal argv for shell:false execution", () => {
    expect(resolvePortablePackageScriptArgv(`vitest run "src/unit tests"`)).toEqual({
      ok: true,
      executable: "vitest",
      args: ["run", "src/unit tests"]
    });
  });

  it.each([`vitest "unterminated`, "vitest $TEST_ARGS", "vitest tests/*.test.ts", "vitest && echo done"])(
    "rejects non-portable package-script syntax: %s",
    rawCommand => expect(resolvePortablePackageScriptArgv(rawCommand)).toMatchObject({ ok: false })
  );
});

function command(rawCommand: string): TypeScriptCommandLaneInput {
  return {
    rawCommand,
    sourceSelector: "scripts.typecheck",
    sourcePath: "packages/example/package.json",
    cwd: "packages/example"
  };
}

function errorCode(rawCommand: string): string | undefined {
  const result = resolveTypeScriptCommandLane(command(rawCommand));
  return result.ok ? undefined : result.error.code;
}

describe("TypeScript compiler command lane source binding", () => {
  it("binds every resolved field to one exact scripts entry and source directory", () => {
    const rawCommand = "pnpm exec -- tsc -p tsconfig.build.json --noEmit";
    const lane = resolvedLane(command(rawCommand));
    const result = verifyTypeScriptCommandLaneSourceBinding({
      lane,
      sourceContent: JSON.stringify({ name: "fixture", scripts: { typecheck: rawCommand } })
    });

    expect(result).toEqual({
      ok: true,
      binding: {
        schema: "scce.typescript.compiler_command_lane_source_binding.v1",
        sourceSelector: "scripts.typecheck",
        scriptName: "typecheck",
        sourcePath: "packages/example/package.json",
        normalizedSourcePath: "packages/example/package.json",
        cwd: "packages/example",
        rawCommand,
        wrapper: "pnpm_exec",
        mode: "project",
        languageServiceCompatible: true
      }
    });
  });

  it("normalizes source path separators before proving its directory", () => {
    const rawCommand = "tsc --noEmit";
    const lane = resolvedLane({
      ...command(rawCommand),
      sourcePath: String.raw`packages\example\package.json`
    });
    const result = verifyTypeScriptCommandLaneSourceBinding({
      lane,
      sourceContent: JSON.stringify({ scripts: { typecheck: rawCommand } })
    });

    expect(result).toMatchObject({
      ok: true,
      binding: {
        sourcePath: String.raw`packages\example\package.json`,
        normalizedSourcePath: "packages/example/package.json",
        cwd: "packages/example"
      }
    });
  });

  it("binds a root package script to the root cwd", () => {
    const rawCommand = "npx --no-install tsc -b";
    const lane = resolvedLane({ ...command(rawCommand), sourcePath: "package.json", cwd: "." });
    const result = verifyTypeScriptCommandLaneSourceBinding({ lane, sourceContent: JSON.stringify({ scripts: { typecheck: rawCommand } }) });
    expect(result).toMatchObject({ ok: true, binding: { normalizedSourcePath: "package.json", cwd: ".", mode: "build", languageServiceCompatible: false } });
  });

  it.each([
    ["typecheck", "invalid_source_selector"],
    ["scripts.", "invalid_source_selector"],
    ["scripts.build.types", "ambiguous_source_selector"],
    ["scripts../typecheck", "ambiguous_source_selector"],
    [String.raw`scripts..\typecheck`, "ambiguous_source_selector"],
    ["scripts. ../typecheck", "ambiguous_source_selector"]
  ])("rejects ambiguous selector %j", (sourceSelector, expectedCode) => {
    const lane = resolvedLane({ ...command("tsc --noEmit"), sourceSelector });
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))).toBe(expectedCode);
  });

  it.each([
    ["not json", "invalid_source_json"],
    ["[]", "invalid_source_object"],
    ["null", "invalid_source_object"],
    [JSON.stringify({}), "missing_scripts_object"],
    [JSON.stringify({ scripts: [] }), "missing_scripts_object"],
    [JSON.stringify({ scripts: {} }), "missing_script"],
    [JSON.stringify({ scripts: { typecheck: ["tsc"] } }), "non_string_script"]
  ])("rejects an unprovable exact source artifact", (sourceContent, expectedCode) => {
    expect(bindingError(resolvedLane(command("tsc --noEmit")), sourceContent)).toBe(expectedCode);
  });

  it("requires byte-for-byte script text equality, including surrounding whitespace", () => {
    const lane = resolvedLane(command("  tsc --noEmit  "));
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))).toBe("source_script_mismatch");
  });

  it.each([
    "../package.json",
    "packages/../package.json",
    "./package.json",
    "/package.json",
    String.raw`C:\repo\package.json`,
    "packages//package.json"
  ])("rejects ambiguous or traversing source path %j", sourcePath => {
    const lane = resolvedLane({ ...command("tsc --noEmit"), sourcePath });
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))).toBe("ambiguous_source_path");
  });

  it("requires cwd to be the normalized directory of the source artifact", () => {
    const lane = resolvedLane({ ...command("tsc --noEmit"), cwd: "packages/other" });
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))).toBe("source_cwd_mismatch");
  });

  it("detects forged observed argv after independently resolving the source command", () => {
    const rawCommand = "npm exec -- tsc -p tsconfig.json";
    const lane = cloneLane(resolvedLane(command(rawCommand)));
    lane.observed.args = ["exec", "--", "tsc", "--noEmit"];
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: rawCommand } }))).toBe("observed_argv_mismatch");
  });

  it("detects a forged wrapper classification", () => {
    const rawCommand = "npm exec -- tsc --noEmit";
    const lane = cloneLane(resolvedLane(command(rawCommand)));
    lane.wrapper = "pnpm_exec";
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: rawCommand } }))).toBe("wrapper_mismatch");
  });

  it("detects forged normalized compiler argv", () => {
    const rawCommand = "tsc -p tsconfig.json";
    const lane = cloneLane(resolvedLane(command(rawCommand)));
    lane.normalizedTscArgs = ["--noEmit"];
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: rawCommand } }))).toBe("compiler_argv_mismatch");
  });

  it("detects forged compiler mode and compatibility", () => {
    const rawCommand = "tsc -b";
    const lane = cloneLane(resolvedLane(command(rawCommand)));
    lane.mode = "project";
    lane.languageServiceCompatible = true;
    lane.compatibilityReason = "typescript_language_service_project_mode";
    expect(bindingError(lane, JSON.stringify({ scripts: { typecheck: rawCommand } }))).toBe("mode_mismatch");
  });

  it("returns the independent resolver failure without executing unsafe source text", () => {
    const rawCommand = "tsc && echo unsafe";
    const lane = cloneLane(resolvedLane(command("tsc --noEmit")));
    lane.observed.rawCommand = rawCommand;
    expect(verifyTypeScriptCommandLaneSourceBinding({
      lane,
      sourceContent: JSON.stringify({ scripts: { typecheck: rawCommand } })
    })).toMatchObject({ ok: false, error: { code: "lane_reresolution_failed", causeCode: "unsafe_shell_syntax" } });
  });

  it("returns structured failures instead of throwing on untrusted runtime shapes", () => {
    expect(verifyTypeScriptCommandLaneSourceBinding({ lane: null, sourceContent: "{}" } as never)).toMatchObject({ ok: false, error: { code: "invalid_lane" } });
    expect(verifyTypeScriptCommandLaneSourceBinding({ lane: resolvedLane(command("tsc")), sourceContent: null } as never)).toMatchObject({ ok: false, error: { code: "invalid_source_content" } });
  });
});

function resolvedLane(input: TypeScriptCommandLaneInput): TypeScriptCommandLane {
  const result = resolveTypeScriptCommandLane(input);
  if (!result.ok) throw new Error(`test fixture did not resolve: ${result.error.code}`);
  return result.lane;
}

function cloneLane(lane: TypeScriptCommandLane): TypeScriptCommandLane {
  return structuredClone(lane);
}

function bindingError(lane: TypeScriptCommandLane, sourceContent: string): string | undefined {
  const result = verifyTypeScriptCommandLaneSourceBinding({ lane, sourceContent });
  return result.ok ? undefined : result.error.code;
}

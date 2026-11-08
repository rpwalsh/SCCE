// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. See LICENSE.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { compileSourceCodeFunctions } from "../../packages/adapters-node/src/source-code-function-learning.js";
import { evaluateProgramExpressionBindings, type ProgramExpression } from "../../packages/kernel/src/program-transformation-search.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = process.env.SCCE_SOLVER_PYTHON ?? "python";
const temporaryRoot = realpathSync(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, "scce-solver-check-"));
if (dirname(directory) !== temporaryRoot) throw new Error("solver test directory escaped its temporary root");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const argument = (index: number): ProgramExpression => ({ kind: "argument", index });
const literal = (value: number): ProgramExpression => ({ kind: "literal", value });
const binary = (operator: "add" | "subtract" | "multiply" | "divide" | "minimum" | "maximum", left: ProgramExpression, right: ProgramExpression): ProgramExpression => ({ kind: "binary", operator, left, right });
const bits = (value: number) => { const buffer = Buffer.alloc(8); buffer.writeDoubleBE(value); return buffer.toString("hex"); };
const number = (value: { bits: string }) => Buffer.from(value.bits, "hex").readDoubleBE();
const fullDomain = (arity: number) => ({ arguments: Array.from({ length: arity }, () => ({ kind: "finite_binary64" })) });
const exactDomain = (...values: number[]) => ({ arguments: values.map(value => ({ kind: "finite_binary64", valuesBits: [bits(value)] })) });

function compile(text: string, callable?: string) {
  const constructions = compileSourceCodeFunctions({ text, path: "source.ts", languageId: "typescript", sourceHash: createHash("sha256").update(text).digest("hex") });
  const row = callable ? constructions.find(value => value.callable.name === callable) : constructions[0];
  if (!row) throw new Error("existing source compiler rejected test source");
  expect(text.slice(row.sourceStart, row.sourceEnd)).toBe(row.sourceText);
  return row;
}

function verify(label: string, source: ReturnType<typeof compile>, candidate: unknown, domain: unknown, flags: string[] = []) {
  const sourcePath = join(directory, label + ".source.json");
  const candidatePath = join(directory, label + ".candidate.json");
  const domainPath = join(directory, label + ".domain.json");
  writeFileSync(sourcePath, JSON.stringify(source));
  writeFileSync(candidatePath, JSON.stringify(candidate));
  writeFileSync(domainPath, JSON.stringify(domain));
  const result = spawnSync(python, [join(root, "tools/solver-check/verify.py"), "--source-encoding", sourcePath, "--candidate", candidatePath,
    "--domain", domainPath, "--timeout-ms", "5000", "--rlimit", "10000000", "--memory-mb", "256", ...flags],
  { encoding: "utf8", timeout: 15000, maxBuffer: 1048576 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.stderr).toBe("");
  const receipt = JSON.parse(result.stdout);
  expect(receipt.schema).toBe("scce.solver_check_receipt.v1");
  expect(receipt.solver.packageVersion).toBe("4.16.0.0");
  expect(receipt.solver.lockedWheelSha256).toBe("eb5df383cb6a3d6b7767dbdca348ac71f6f41e82f76c9ac42002a1f55e35f462");
  expect(receipt.solver.packageNativeArtifacts.length).toBeGreaterThan(0);
  expect(receipt.solver.packageNativeArtifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(receipt.solver.requirementsLockSha256).toBe(createHash("sha256").update(readFileSync(join(root, "tools/solver-check/requirements.lock"))).digest("hex"));
  expect(receipt.developmentOnly).toBe(true);
  expect(receipt.scope.wholeProgramProof).toBe(false);
  const exits: Record<string, number> = { unsat: 0, sat: 1, unknown: 2, unsupported: 3, error: 4 };
  expect(result.status, result.stdout).toBe(exits[receipt.status]);
  if (process.env.SCCE_SOLVER_RECEIPTS_DIR) {
    const output = resolve(process.env.SCCE_SOLVER_RECEIPTS_DIR);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, label + ".receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return receipt;
}

function native(source: ReturnType<typeof compile>, arguments_: number[]) {
  const context: Record<string, (...arguments_: number[]) => number | boolean> = {};
  runInNewContext(ts.transpileModule(source.sourceText, { compilerOptions: { module: ts.ModuleKind.None } }).outputText, context, { timeout: 1000 });
  return context[source.callable.name]!(...arguments_);
}

describe("bounded development verification of existing SCCE source IR", () => {
  const corpus = readFileSync(join(root, "packages/kernel/src/functional-cognition.ts"), "utf8");
  const clamp = compile(corpus, "clamp");

  it("proves a different encoding of the real repository clamp within all finite binary64 arguments", () => {
    const candidate = binary("maximum", argument(1), binary("minimum", argument(0), argument(2)));
    const receipt = verify("real-clamp-equivalent", clamp, candidate, fullDomain(3));
    expect(receipt.status, JSON.stringify(receipt)).toBe("unsat");
    expect(receipt.domain).toEqual(fullDomain(3));
    expect(receipt.source.sourceHash).toBe(clamp.sourceHash);
    expect(receipt.querySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("finds a mutated real-source IR counterexample and independently executes both sides", () => {
    const candidate = binary("maximum", argument(1), binary("maximum", argument(2), argument(0)));
    const receipt = verify("real-clamp-mutated", clamp, candidate, fullDomain(3));
    expect(receipt.status, JSON.stringify(receipt)).toBe("sat");
    const arguments_ = receipt.counterexample.arguments.map(number);
    const actual = native(clamp, arguments_);
    const proposed = evaluateProgramExpressionBindings(candidate, arguments_, []);
    expect(typeof actual).toBe("number");
    expect(typeof proposed).toBe("number");
    expect(Object.is(actual, proposed)).toBe(false);
    expect(bits(actual as number)).toBe(receipt.counterexample.source.bits);
    expect(bits(proposed as number)).toBe(receipt.counterexample.candidate.bits);
    console.log(JSON.stringify({ check: "independent-node-v8-counterexample-replay", source: clamp.callable.name, argumentsBits: arguments_.map(bits),
      sourceBits: bits(actual as number), candidateExistingEvaluatorBits: bits(proposed as number) }));
  });

  it("rejects real-number reassociation using an actual binary64 rounding counterexample", () => {
    const source = compile("function grouped(a: number, b: number, c: number) { return (a + b) + c; }");
    const candidate = binary("add", argument(0), binary("add", argument(1), argument(2)));
    const receipt = verify("rounding-reassociation", source, candidate, exactDomain(1e16, -1e16, 1));
    expect(receipt.status).toBe("sat");
    const arguments_ = receipt.counterexample.arguments.map(number);
    expect(native(source, arguments_)).toBe(1);
    expect(evaluateProgramExpressionBindings(candidate, arguments_, [])).toBe(0);
    expect(receipt.counterexample.source.bits).toBe(bits(1));
    expect(receipt.counterexample.candidate.bits).toBe(bits(0));
  });

  it("preserves signed zero and gradual subnormal rounding instead of using a Real theory", () => {
    const source = compile("function identity(value: number) { return value; }");
    const receipt = verify("signed-zero", source, binary("add", argument(0), literal(0)), exactDomain(-0));
    expect(receipt.status).toBe("sat");
    expect(receipt.counterexample.source.bits).toBe(bits(-0));
    expect(receipt.counterexample.candidate.bits).toBe(bits(0));
    expect(Object.is(native(source, [-0]), -0)).toBe(true);
    const halve = compile("function halve(value: number) { return value / 2; }");
    const subnormal = verify("subnormal-rounding", halve, literal(0), exactDomain(Number.MIN_VALUE));
    expect(subnormal.status).toBe("unsat");
    expect(native(halve, [Number.MIN_VALUE])).toBe(0);
  });

  it("uses JavaScript min/max NaN propagation and signed-zero rules", () => {
    const source = compile("function lower(value: number) { return Math.min(value / value, 1); }");
    const nan = verify("nan-propagation", source, literal(1), exactDomain(0));
    expect(nan.status).toBe("sat");
    expect(nan.counterexample.source.numberText).toBe("NaN");
    expect(Number.isNaN(native(source, [0]) as number)).toBe(true);
    const minimum = compile("function lower(a: number, b: number) { return Math.min(a, b); }");
    const zeros = verify("minimum-signed-zero", minimum, binary("maximum", argument(0), argument(1)), exactDomain(0, -0));
    expect(zeros.status).toBe("sat");
    expect(zeros.counterexample.source.bits).toBe(bits(-0));
    expect(zeros.counterexample.candidate.bits).toBe(bits(0));
    expect(Object.is(native(minimum, [0, -0]), -0)).toBe(true);
    const overflow = compile("function overflow(value: number) { return value * 2; }");
    const infinity = verify("overflow-result", overflow, argument(0), exactDomain(Number.MAX_VALUE));
    expect(infinity.status).toBe("sat");
    expect(infinity.counterexample.source.numberText).toBe("+Infinity");
    expect(native(overflow, [Number.MAX_VALUE])).toBe(Infinity);
  });

  it("accepts source-owned binding DAGs, transformation candidates, Boolean equality and conditionals", () => {
    const source = compile("function midpoint(a: number, b: number) { const total = a + b; return total / 2; }");
    expect(source.bindings).toHaveLength(1);
    const candidate = { producedIr: binary("divide", binary("add", argument(0), argument(1)), literal(2)) };
    expect(verify("binding-dag", source, candidate, fullDomain(2)).status).toBe("unsat");
    const equal = compile("function equal(a: number, b: number) { return a === b; }");
    expect(verify("strict-zero-equality", equal, { kind: "value", value: true }, exactDomain(-0, 0)).status).toBe("unsat");
    const choose = compile("function select(value: number) { return value === 0 ? -value : value; }");
    const conditional = verify("conditional", choose, argument(0), exactDomain(0));
    expect(conditional.status).toBe("sat");
    expect(conditional.counterexample.source.bits).toBe(bits(-0));
  });

  it("reports a real solver timeout and a resource-limit unknown without claiming equivalence", () => {
    const source = compile("function grouped(a: number, b: number, c: number) { return (a * b) / c; }");
    const candidate = binary("multiply", argument(0), binary("divide", argument(1), argument(2)));
    const timeout = verify("timeout", source, candidate, fullDomain(3), ["--timeout-ms", "1"]);
    expect(timeout.status, JSON.stringify(timeout)).toBe("unknown");
    expect(timeout.reason).toMatch(/timeout|canceled/iu);
    expect(timeout).not.toHaveProperty("counterexample");
    const limited = verify("resource-limit", source, candidate, fullDomain(3), ["--rlimit", "1"]);
    expect(limited.status).toBe("unknown");
    expect(limited.reason).toMatch(/resource|rlimit/iu);
  });

  it("separates unsupported IR and languages from malformed or empty explicit domains", () => {
    const source = compile("function packageValue(value: number) { return [value]; }");
    const unsupported = verify("unsupported-sequence", source, argument(0), fullDomain(1));
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.reason).toContain("sequence");
    expect(unsupported).not.toHaveProperty("querySha256");
    const foreign = verify("unsupported-language", { ...clamp, languageId: "go" }, argument(0), fullDomain(3));
    expect(foreign.status).toBe("unsupported");
    const empty = verify("empty-domain", compile("function identity(value: number) { return value; }"), argument(0),
      { arguments: [{ kind: "finite_binary64", valuesBits: [] }] });
    expect(empty.status).toBe("error");
    expect(empty.reason).toContain("nonempty");
    const bounded = verify("explicit-interval", clamp, clamp, { arguments: [
      { kind: "finite_binary64", minimumBits: bits(-4), maximumBits: bits(4) },
      { kind: "finite_binary64", valuesBits: [bits(0)] }, { kind: "finite_binary64", valuesBits: [bits(3)] }
    ] });
    expect(bounded.status).toBe("unsat");
  });
});

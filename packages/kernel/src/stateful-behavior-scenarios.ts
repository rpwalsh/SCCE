import { canonicalStringify, createHasher } from "./primitives.js";
import { readSymbolicProgramRelation } from "./program-behavior-syntax.js";
import type { JsonValue } from "./types.js";

export interface StatefulBehaviorSourceSpan {
  readonly charStart: number;
  readonly charEnd: number;
}

export type StatefulBehaviorVerificationRole = "fit" | "held_out";

/** An identifier is deliberately opaque: this parser assigns it no method semantics. */
export interface StatefulBehaviorInvocation {
  readonly callableId: string;
  readonly arguments: JsonValue[];
  readonly sourceSpan: StatefulBehaviorSourceSpan;
}

export interface StatefulBehaviorAssertion {
  readonly invocation: StatefulBehaviorInvocation;
  readonly result: JsonValue;
  /** The source operator is retained as evidence; it is not interpreted as an English relation. */
  readonly relationSurface: string;
  readonly sourceSpan: StatefulBehaviorSourceSpan;
}

export interface StatefulBehaviorScenario {
  readonly invocations: StatefulBehaviorInvocation[];
  readonly assertion: StatefulBehaviorAssertion;
  readonly sourceSpan: StatefulBehaviorSourceSpan;
  readonly sourceHash: string;
  readonly verificationRole: StatefulBehaviorVerificationRole;
}

export interface StatefulBehaviorScenarioCorpus {
  readonly requestHash: string;
  readonly declaredCallableIds: string[];
  readonly scenarios: StatefulBehaviorScenario[];
}

/**
 * Extracts ordered, source-explicit stateful behavior examples. A declaration
 * is a call whose arguments are identifier-shaped parameters (for example
 * `put(key, value)`). Only a later call to one of those declared identifiers,
 * followed by a symbolic result operator and JSON value, can close a scenario.
 */
export function parseStatefulBehaviorScenarios(requestText: string): StatefulBehaviorScenarioCorpus | undefined {
  const text = requestText ?? "";
  const hasher = createHasher();
  const requestHash = `sha256:${hasher.digestHex(text)}`;
  const statements = splitStatements(text);
  const declarations = new Set<string>();
  for (const statement of statements) {
    const call = parseCall(statement.text, statement.start);
    if (call && isDeclarationArguments(call.inner)) declarations.add(call.callableId);
  }
  if (declarations.size === 0) return undefined;

  const scenarios: StatefulBehaviorScenario[] = [];
  let pending: StatefulBehaviorInvocation[] = [];
  let pendingStart: number | undefined;
  for (const statement of statements) {
    const parsed = parseCall(statement.text, statement.start);
    if (!parsed) continue;
    const relation = parseAssertion(parsed, declarations, statement.text, statement.start);
    if (relation) {
      const assertion: StatefulBehaviorAssertion = {
        invocation: relation.invocation,
        result: relation.result,
        relationSurface: relation.relationSurface,
        sourceSpan: { charStart: relation.invocation.sourceSpan.charStart, charEnd: relation.resultEnd }
      };
      const sourceStart = pendingStart ?? assertion.sourceSpan.charStart;
      const sourceSpan = { charStart: sourceStart, charEnd: assertion.sourceSpan.charEnd };
      const sourceHash = `sha256:${hasher.digestHex(canonicalStringify({ requestHash, sourceSpan, pending, assertion }))}`;
      scenarios.push({
        invocations: [...pending, assertion.invocation],
        assertion,
        sourceSpan,
        sourceHash,
        verificationRole: "fit"
      });
      pending = [];
      pendingStart = undefined;
      continue;
    }
    if (!isDeclarationArguments(parsed.inner) && declarations.has(parsed.callableId)) {
      pendingStart ??= parsed.sourceSpan.charStart;
      pending.push({ callableId: parsed.callableId, arguments: parsed.arguments, sourceSpan: parsed.sourceSpan });
    }
  }
  if (scenarios.length === 0) return undefined;
  if (scenarios.length >= 4) scenarios[scenarios.length - 1] = { ...scenarios[scenarios.length - 1]!, verificationRole: "held_out" };
  return { requestHash, declaredCallableIds: [...declarations].sort(), scenarios };
}

/** Alias with the corpus name used by ingestion callers. */
export const parseStatefulBehaviorScenarioCorpus = parseStatefulBehaviorScenarios;

interface Statement { text: string; start: number; }
interface ParsedCall { callableId: string; inner: string; arguments: JsonValue[]; sourceSpan: StatefulBehaviorSourceSpan; callEnd: number; }

function splitStatements(text: string): Statement[] {
  const result: Statement[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = ""; continue; }
    if (char === '"') { quote = char; continue; }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ";" || char === "\n" || char === "\r")) {
      if (text.slice(start, i).trim()) result.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) result.push({ text: text.slice(start), start });
  return result;
}

function parseCall(statement: string, statementStart: number): ParsedCall | undefined {
  const leading = statement.search(/\S/u);
  if (leading < 0) return undefined;
  const text = statement.slice(leading).replace(/[,.。]+\s*$/u, "").trimEnd();
  const match = /^([$\p{L}_][$\p{L}\p{N}_]*)\s*\(/u.exec(text);
  if (!match) return undefined;
  const open = match[0].length - 1;
  const balancedCall = readBalancedCall(text, open);
  if (!balancedCall) return undefined;
  let args: JsonValue[] = [];
  try {
    const parsed = JSON.parse(`[${balancedCall.inner}]`) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    args = parsed as JsonValue[];
  } catch {
    // Declaration parameters are opaque identifiers rather than JSON values;
    // concrete invocation arguments must still parse below when asserted.
    if (!isDeclarationArguments(balancedCall.inner)) return undefined;
  }
  const start = statementStart + leading;
  return { callableId: match[1]!, inner: balancedCall.inner, arguments: args, sourceSpan: { charStart: start, charEnd: start + balancedCall.end }, callEnd: start + balancedCall.end };
}

function parseAssertion(call: ParsedCall, declarations: ReadonlySet<string>, statement: string, statementStart: number): { invocation: StatefulBehaviorInvocation; result: JsonValue; relationSurface: string; resultEnd: number } | undefined {
  if (!declarations.has(call.callableId)) return undefined;
  const localCallEnd = call.callEnd - statementStart;
  const remainder = statement.slice(localCallEnd);
  const relationStart = remainder.search(/\S/u);
  if (relationStart < 0) return undefined;
  const relation = readSymbolicProgramRelation(remainder, relationStart);
  if (!relation) return undefined;
  const valueText = remainder.slice(relation.end).replace(/^\s+/u, "").replace(/[,.。]?\s*$/u, "").trim();
  if (!valueText) return undefined;
  let result: JsonValue;
  try { result = JSON.parse(valueText) as JsonValue; } catch { return undefined; }
  const invocation: StatefulBehaviorInvocation = { callableId: call.callableId, arguments: call.arguments, sourceSpan: call.sourceSpan };
  const valueOffset = remainder.indexOf(valueText);
  return { invocation, result, relationSurface: relation.surface, resultEnd: statementStart + localCallEnd + valueOffset + valueText.length };
}

function isDeclarationArguments(inner: string): boolean {
  const values = inner.split(",").map(value => value.trim()).filter(Boolean);
  return values.length > 0 && values.every(value => /^[$\p{L}_][$\p{L}\p{N}_]*$/u.test(value));
}

function readBalancedCall(text: string, open: number): { inner: string; end: number } | undefined {
  let depth = 0; let quote = false; let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quote = false; continue; }
    if (char === '"') { quote = true; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
  }
  return undefined;
}

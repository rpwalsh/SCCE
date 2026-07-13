import { createHash } from "node:crypto";
import type { ContentHash, FileArtifact } from "@scce/kernel";

export interface RepairDiagnosis {
  kind: "syntax" | "module-resolution" | "assertion" | "permission" | "timeout" | "unknown";
  severity: "info" | "warning" | "error";
  file?: string;
  line?: number;
  message: string;
}

export interface RepairResult {
  changed: boolean;
  artifacts: FileArtifact[];
  diagnoses: RepairDiagnosis[];
  applied: Array<{ path: string; rule: string; beforeHash: string; afterHash: string }>;
}

export function repairProgramArtifacts(artifacts: readonly FileArtifact[], diagnostics: string): RepairResult {
  const diagnoses = diagnose(diagnostics);
  const applied: RepairResult["applied"] = [];
  let next = artifacts.map(artifact => ({ ...artifact }));
  for (const diagnosis of diagnoses) {
    const repaired = applyDiagnosis(next, diagnosis);
    next = repaired.artifacts;
    applied.push(...repaired.applied);
  }
  return { changed: applied.length > 0, artifacts: next, diagnoses, applied };
}

export function diagnose(diagnostics: string): RepairDiagnosis[] {
  const out: RepairDiagnosis[] = [];
  const lines = diagnostics.split(/\r?\n/);
  for (const line of lines) {
    if (/SyntaxError/i.test(line)) out.push({ kind: "syntax", severity: "error", message: line.trim() || "syntax error" });
    if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(line)) out.push({ kind: "module-resolution", severity: "error", message: line.trim() });
    if (/AssertionError|not ok/i.test(line)) out.push({ kind: "assertion", severity: "error", message: line.trim() });
    if (/EACCES|EPERM|permission/i.test(line)) out.push({ kind: "permission", severity: "error", message: line.trim() });
    if (/timed out|timeout/i.test(line)) out.push({ kind: "timeout", severity: "error", message: line.trim() });
    const loc = /(src\/[^:\s]+|test\/[^:\s]+):(\d+)/.exec(line);
    if (loc && out.length) {
      const current = out[out.length - 1];
      const file = loc[1];
      const lineNumber = loc[2];
      if (current && file) current.file = file;
      if (current && lineNumber) current.line = Number(lineNumber);
    }
  }
  if (!out.length && diagnostics.trim()) out.push({ kind: "unknown", severity: "warning", message: diagnostics.trim().slice(0, 500) });
  return dedupeDiagnoses(out);
}

function applyDiagnosis(artifacts: FileArtifact[], diagnosis: RepairDiagnosis): { artifacts: FileArtifact[]; applied: RepairResult["applied"] } {
  const applied: RepairResult["applied"] = [];
  const next = artifacts.map(artifact => {
    if (!artifact.path.endsWith(".mjs") && !artifact.path.endsWith(".js")) return artifact;
    const beforeHash = String(artifact.contentHash);
    let content = artifact.content;
    let rule = "";
    if (diagnosis.kind === "syntax") {
      const repaired = repairSyntax(content);
      content = repaired.content;
      rule = repaired.rule;
    } else if (diagnosis.kind === "module-resolution") {
      const repaired = repairModuleResolution(content, artifacts);
      content = repaired.content;
      rule = repaired.rule;
    }
    if (rule && content !== artifact.content) {
      const afterHash = hash(content);
      applied.push({ path: artifact.path, rule, beforeHash, afterHash });
      return { ...artifact, content, contentHash: afterHash as ContentHash };
    }
    return artifact;
  });
  return { artifacts: next, applied };
}

function repairSyntax(content: string): { content: string; rule: string } {
  let out = content;
  if (!out.endsWith("\n")) out += "\n";
  out = out.replace(/\r\n?/g, "\n");
  out = out.replace(/,\s*([}\]])/g, "$1");
  out = balanceBraces(out);
  return { content: out, rule: "syntax-normalize-newlines-trailing-commas-braces" };
}

function repairModuleResolution(content: string, artifacts: readonly FileArtifact[]): { content: string; rule: string } {
  const paths = new Set(artifacts.map(artifact => artifact.path));
  let out = content.replace(/from\s+["'](\.\.?\/[^"']+)["']/g, (match, spec) => {
    if (spec.endsWith(".mjs") || spec.endsWith(".js")) return match;
    const candidate = spec.startsWith("../") ? spec.replace("../", "") : spec.replace("./", "src/");
    if (paths.has(`${candidate}.mjs`)) return match.replace(spec, `${spec}.mjs`);
    if (paths.has(`${candidate}.js`)) return match.replace(spec, `${spec}.js`);
    return match;
  });
  return { content: out, rule: out === content ? "" : "module-resolution-add-extension" };
}

function balanceBraces(content: string): string {
  const pairs: Array<[string, string]> = [["{", "}"], ["[", "]"], ["(", ")"]];
  let out = content;
  for (const [open, close] of pairs) {
    const opens = countChar(out, open);
    const closes = countChar(out, close);
    if (opens > closes) out += close.repeat(opens - closes);
  }
  return out;
}

function countChar(text: string, char: string): number {
  let count = 0;
  let inString: string | undefined;
  let escaped = false;
  for (const c of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if ((c === '"' || c === "'" || c === "`") && !inString) {
      inString = c;
      continue;
    }
    if (c === inString) {
      inString = undefined;
      continue;
    }
    if (!inString && c === char) count++;
  }
  return count;
}

function dedupeDiagnoses(items: RepairDiagnosis[]): RepairDiagnosis[] {
  const seen = new Set<string>();
  const out: RepairDiagnosis[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.file ?? ""}:${item.line ?? ""}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function hash(content: string): string {
  return `sha256_${createHash("sha256").update(content).digest("hex")}`;
}

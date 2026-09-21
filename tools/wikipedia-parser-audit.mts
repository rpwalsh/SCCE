// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readScceRuntimeConfig } from "../packages/adapters-node/src/config.js";
import { normalizeWikiText, resolveWikipediaCorpusTarget, streamWikipediaMultistream, type WikiNormalizationDiagnostics } from "../packages/adapters-node/src/wikipedia.js";
import { renderWikiLinks, renderWikiTemplates } from "../packages/adapters-node/src/wikipedia-markup.js";
import type { JsonValue, IngestedSourceFile } from "@scce/kernel";

const EXPECTED_DUMP = path.resolve("C:/Users/react/OneDrive/Documents/yopp/data/wiki/enwiki-latest-pages-articles-multistream.xml.bz2");
const EXPECTED_INDEX = path.resolve("C:/Users/react/OneDrive/Documents/yopp/data/wiki/enwiki-latest-pages-articles-multistream-index.txt");
const REPORT_PATH = path.resolve(".tmp/wiki-parser-audit-300.json");
const maxPages = readMaxPages(process.argv.slice(2));
const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
let report: Record<string, unknown>;

try {
  const configPath = process.env.SCCE_REHEARSAL_CONFIG ?? "scce.config.json";
  const config = await readScceRuntimeConfig(configPath);
  const configured = config.runtime.corpora?.wikipedia;
  const configuredDump = configured?.dumpPath ? path.resolve(configured.dumpPath) : undefined;
  const configuredIndex = configured?.indexPath ? path.resolve(configured.indexPath) : undefined;
  check("configured.dump-is-yopp-full-dump", configuredDump === EXPECTED_DUMP, `${configuredDump ?? "missing"}`);
  check("configured.index-is-matching-plain-index", configuredIndex === EXPECTED_INDEX, `${configuredIndex ?? "missing"}`);
  if (configuredDump !== EXPECTED_DUMP || configuredIndex !== EXPECTED_INDEX) throw new Error("refusing to audit a fallback or different Wikipedia input");

  const [dumpStat, indexStat] = await Promise.all([stat(EXPECTED_DUMP), stat(EXPECTED_INDEX)]);
  check("configured.dump-is-file", dumpStat.isFile(), EXPECTED_DUMP);
  check("configured.index-is-file", indexStat.isFile(), EXPECTED_INDEX);
  const corpus = resolveWikipediaCorpusTarget(config, EXPECTED_DUMP);
  check("resolved.dump-preserves-yopp-path", corpus?.dumpPath === EXPECTED_DUMP, corpus?.dumpPath ?? "missing");
  check("resolved.index-preserves-plain-index", corpus?.indexPath === EXPECTED_INDEX, corpus?.indexPath ?? "missing");
  if (!corpus || corpus.dumpPath !== EXPECTED_DUMP || corpus.indexPath !== EXPECTED_INDEX) throw new Error("resolved Wikipedia target did not preserve the configured dump/index pair");

  const audit = {
    pages: 0,
    rawBytes: 0,
    evidenceBytes: 0,
    clippedPages: 0,
    clippedChars: 0,
    malformedMarkupPages: 0,
    malformedMarkupConstructs: 0,
    malformedMarkupExamples: [] as Array<{ pageId: string; title: string; constructs: number; directNormalizerConstructs: number; templateConstructs: number; preprocessedTemplateConstructs: number; postCloseTemplateConstructs: number; linkConstructs: number; rawSourceFinding: ReturnType<typeof malformedSourceFinding>; preprocessedSourceFinding: ReturnType<typeof malformedSourceFinding>; rawLinkFinding: ReturnType<typeof linkSourceFinding>; preprocessedLinkFinding: ReturnType<typeof linkSourceFinding>; postCloseLinkFinding: ReturnType<typeof linkSourceFinding>; stageSnippets: Record<string, string>; refCandidates: Array<{ offset: number; excerpt: string }> }>,
    unsupportedTemplates: new Map<string, number>(),
    firstPage: undefined as { pageId: string; title: string } | undefined,
    lastPage: undefined as { pageId: string; title: string } | undefined,
    reachedEnd: undefined as boolean | undefined,
    stoppedAt: undefined as string | undefined
  };
  for await (const item of streamWikipediaMultistream({ ...corpus, maxPagesPerRun: maxPages })) {
    if (item.type === "file") {
      audit.pages++;
      audit.rawBytes += item.file.bytes.byteLength;
      audit.evidenceBytes += evidenceBytes(item.file);
      const metadata = object(item.file.metadata);
      const pageId = stringValue(metadata.pageId) ?? "";
      const title = stringValue(metadata.title) ?? "";
      if (!audit.firstPage) audit.firstPage = { pageId, title };
      audit.lastPage = { pageId, title };
      const normalization = object(metadata.normalization);
      const truncatedChars = numberValue(normalization.truncatedChars) ?? 0;
      if (truncatedChars > 0) {
        audit.clippedPages++;
        audit.clippedChars += truncatedChars;
      }
      const malformedConstructs = numberValue(normalization.malformedConstructs) ?? 0;
      if (malformedConstructs > 0) {
        audit.malformedMarkupPages++;
        audit.malformedMarkupConstructs += malformedConstructs;
        if (audit.malformedMarkupExamples.length < 20) {
          const directDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          normalizeWikiText(item.file.text, directDiagnostics);
          const templateDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          const linkDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          const renderedTemplates = renderWikiTemplates(item.file.text, templateDiagnostics);
          renderWikiLinks(renderedTemplates, linkDiagnostics);
          const preprocessedTemplateDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          const preprocessedSource = removeRefTagsAudit(removeDelimitedAudit(item.file.text, "<!--", "-->"));
          const preprocessedTemplates = renderWikiTemplates(preprocessedSource, preprocessedTemplateDiagnostics);
          const postCloseLinksDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          const renderedPreprocessedLinks = renderWikiLinks(preprocessedTemplates, postCloseLinksDiagnostics);
          const postCloseTemplateDiagnostics: WikiNormalizationDiagnostics = { unexpandedTemplateCount: 0, unexpandedTemplates: [], malformedConstructs: 0 };
          const postCloseTemplates = closeSeparatorsAudit(renderedPreprocessedLinks);
          renderWikiTemplates(postCloseTemplates, postCloseTemplateDiagnostics);
          const rawSourceFinding = malformedSourceFinding(item.file.text);
          const preprocessedSourceFinding = malformedSourceFinding(preprocessedSource);
          const rawLinkFinding = linkSourceFinding(item.file.text);
          const preprocessedLinkFinding = linkSourceFinding(preprocessedSource);
          const postCloseLinkFinding = linkSourceFinding(postCloseTemplates);
          audit.malformedMarkupExamples.push({ pageId, title, constructs: malformedConstructs, directNormalizerConstructs: directDiagnostics.malformedConstructs, templateConstructs: templateDiagnostics.malformedConstructs, preprocessedTemplateConstructs: preprocessedTemplateDiagnostics.malformedConstructs, postCloseTemplateConstructs: postCloseTemplateDiagnostics.malformedConstructs, linkConstructs: Math.max(linkDiagnostics.malformedConstructs, postCloseLinksDiagnostics.malformedConstructs), rawSourceFinding, preprocessedSourceFinding, rawLinkFinding, preprocessedLinkFinding, postCloseLinkFinding, stageSnippets: { raw: stageSnippet(item.file.text, "Left curly bracket"), preprocessed: stageSnippet(preprocessedSource, "Left curly bracket"), renderedTemplates: stageSnippet(renderedTemplates, "Left curly bracket"), preprocessedTemplates: stageSnippet(preprocessedTemplates, "Left curly bracket"), postCloseTemplates: stageSnippet(postCloseTemplates, "Left curly bracket") }, refCandidates: refCandidates(item.file.text) });
        }
      }
      for (const template of stringArray(normalization.unexpandedTemplates)) audit.unsupportedTemplates.set(template, (audit.unsupportedTemplates.get(template) ?? 0) + 1);
    } else if (item.type === "checkpoint") {
      const metadata = object(item.checkpoint.metadata);
      const reachedEnd = booleanValue(metadata.reachedEnd);
      if (reachedEnd !== undefined) audit.reachedEnd = reachedEnd;
      const stoppedAt = stringValue(metadata.stoppedAt);
      if (stoppedAt) audit.stoppedAt = stoppedAt;
    }
  }
  check("bounded-page-count", audit.pages === maxPages, `expected=${maxPages} actual=${audit.pages}`);
  check("bounded-reached-end-false", audit.reachedEnd === false, String(audit.reachedEnd));
  check("bounded-stop-cap", audit.stoppedAt === "maxPagesPerRun", audit.stoppedAt ?? "missing");
  const regressionPassed = audit.malformedMarkupExamples.every(example => example.rawSourceFinding.classification !== "bounded-parser-depth" || example.rawLinkFinding.classification !== "balanced-link-structure" || example.directNormalizerConstructs === 0);
  checks.push({ id: "no-raw-balanced-to-normalizer-malformed-regression", passed: regressionPassed, detail: regressionPassed ? "no bounded raw-balanced regression" : JSON.stringify(audit.malformedMarkupExamples) });
  const unsupportedTemplates = [...audit.unsupportedTemplates.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([template, count]) => ({ template, count }));
  report = {
    schema: "scce.wikipediaParserAudit.v1",
    status: checks.every(check => check.passed) ? "passed" : "failed",
    configPath: path.resolve(configPath),
    configuredInputs: {
      dumpPath: EXPECTED_DUMP,
      indexPath: EXPECTED_INDEX,
      dumpBytes: dumpStat.size,
      indexBytes: indexStat.size
    },
    cap: maxPages,
    pages: audit.pages,
    rawBytes: audit.rawBytes,
    evidenceBytes: audit.evidenceBytes,
    clipping: { pages: audit.clippedPages, chars: audit.clippedChars },
    malformedMarkup: { pages: audit.malformedMarkupPages, constructs: audit.malformedMarkupConstructs, examples: audit.malformedMarkupExamples },
    unsupportedTemplates,
    firstPage: audit.firstPage ?? null,
    lastPage: audit.lastPage ?? null,
    reachedEnd: audit.reachedEnd ?? null,
    stoppedAt: audit.stoppedAt ?? null,
    checks
  };
} catch (error) {
  report = {
    schema: "scce.wikipediaParserAudit.v1",
    status: "failed",
    cap: maxPages,
    checks,
    error: error instanceof Error ? error.message : String(error)
  };
}

await mkdir(path.dirname(REPORT_PATH), { recursive: true });
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "passed") process.exitCode = 1;

function evidenceBytes(file: IngestedSourceFile): number {
  return file.evidenceDerivative?.bytes.byteLength ?? Buffer.byteLength(file.text, "utf8");
}

function malformedSourceFinding(text: string): { kind: string; classification: string; excerpt: string; remainingTemplateDepth: number; maximumTemplateDepth: number } {
  let depth = 0;
  let maximumDepth = 0;
  let maximumAt = -1;
  const openPositions: number[] = [];
  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === "{{") {
      depth++;
      openPositions.push(index);
      if (depth > maximumDepth) { maximumDepth = depth; maximumAt = index; }
      index++;
    } else if (pair === "}}" && depth > 0) {
      depth--;
      openPositions.pop();
      index++;
    }
  }
  if (maximumDepth > 64) {
    const start = Math.max(0, maximumAt - 100);
    return { kind: "template-depth-limit", classification: "bounded-source-nesting", excerpt: text.slice(start, Math.min(text.length, maximumAt + 180)).replace(/\s+/gu, " "), remainingTemplateDepth: depth, maximumTemplateDepth: maximumDepth };
  }
  if (depth > 0) {
    const openAt = openPositions.at(-1) ?? 0;
    const start = Math.max(0, openAt - 100);
    return { kind: "unclosed-template", classification: "genuine-malformed-source", excerpt: text.slice(start, Math.min(text.length, openAt + 180)).replace(/\s+/gu, " "), remainingTemplateDepth: depth, maximumTemplateDepth: maximumDepth };
  }
  if (depth === 0) return { kind: "balanced-template-structure", classification: "bounded-parser-depth", excerpt: text.slice(0, 280).replace(/\s+/gu, " "), remainingTemplateDepth: depth, maximumTemplateDepth: maximumDepth };
  for (const [open, close, kind] of [["[[", "]]", "unclosed-link"], ["{{", "}}", "unclosed-template"]] as const) {
    const openAt = text.lastIndexOf(open);
    if (openAt >= 0 && text.lastIndexOf(close) < openAt) {
      const start = Math.max(0, openAt - 100);
      return { kind, classification: "genuine-malformed-source", excerpt: text.slice(start, Math.min(text.length, openAt + 180)).replace(/\s+/gu, " "), remainingTemplateDepth: depth, maximumTemplateDepth: maximumDepth };
    }
  }
  return { kind: "normalizer-depth-or-nested-construct", classification: "needs-review", excerpt: text.slice(0, 280).replace(/\s+/gu, " "), remainingTemplateDepth: depth, maximumTemplateDepth: maximumDepth };
}

function linkSourceFinding(text: string): { kind: string; classification: string; excerpt: string; remainingLinkDepth: number; maximumLinkDepth: number } {
  let depth = 0;
  let maximumDepth = 0;
  let maximumAt = -1;
  const openPositions: number[] = [];
  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2);
    if (pair === "[[") {
      depth++;
      openPositions.push(index);
      if (depth > maximumDepth) { maximumDepth = depth; maximumAt = index; }
      index++;
    } else if (pair === "]]" && depth > 0) {
      depth--;
      openPositions.pop();
      index++;
    }
  }
  if (depth === 0) return { kind: "balanced-link-structure", classification: "balanced-link-structure", excerpt: text.slice(0, 280).replace(/\s+/gu, " "), remainingLinkDepth: depth, maximumLinkDepth: maximumDepth };
  const openAt = openPositions.at(-1) ?? maximumAt;
  const start = Math.max(0, openAt - 100);
  return { kind: "unclosed-link", classification: "genuine-malformed-source", excerpt: text.slice(start, Math.min(text.length, openAt + 220)).replace(/\s+/gu, " "), remainingLinkDepth: depth, maximumLinkDepth: maximumDepth };
}

function removeDelimitedAudit(input: string, startNeedle: string, endNeedle: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf(startNeedle, cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start) + " ";
    const end = input.indexOf(endNeedle, start + startNeedle.length);
    if (end < 0) return out;
    cursor = end + endNeedle.length;
  }
  return out;
}

function removeRefTagsAudit(input: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const start = indexOfIgnoreCaseAudit(input, "<ref", cursor);
    if (start < 0) return out + input.slice(cursor);
    out += input.slice(cursor, start) + " ";
    const openEnd = input.indexOf(">", start);
    if (openEnd < 0) return out;
    const selfClosing = input.slice(start, openEnd + 1).includes("/>");
    if (selfClosing) {
      cursor = openEnd + 1;
      continue;
    }
    const close = indexOfIgnoreCaseAudit(input, "</ref>", openEnd + 1);
    cursor = close < 0 ? openEnd + 1 : close + "</ref>".length;
  }
  return out;
}

function closeSeparatorsAudit(text: string): string {
  return text
    .replace(/([([\u007b\u3010\uff08])\s*[;,\u003a\u3001\uff0c\uff1b\uff1a]+\s*/gu, "$1")
    .replace(/[;,\u003a\u3001\uff0c\uff1b\uff1a]\s*(?=[;,\u003a\u3001\uff0c\uff1b\uff1a])/gu, "")
    .replace(/\s+([;,\u003a\u3001\uff0c\uff1b\uff1a]|[.\u3002])/gu, "$1")
    .replace(/\(\s*\)/gu, "")
    .replace(/\[\s*\]/gu, "")
    .replace(/\{\s*\}/gu, "")
    .replace(/\u3010\s*\u3011/gu, "")
    .replace(/\uff08\s*\uff09/gu, "");
}

function indexOfIgnoreCaseAudit(input: string, needle: string, start: number): number {
  const lowerNeedle = needle.toLocaleLowerCase();
  for (let index = Math.max(0, start); index <= input.length - needle.length; index++) if (input.slice(index, index + needle.length).toLocaleLowerCase() === lowerNeedle) return index;
  return -1;
}

function refCandidates(text: string): Array<{ offset: number; excerpt: string }> {
  const out: Array<{ offset: number; excerpt: string }> = [];
  for (const match of text.matchAll(/<ref/giu)) {
    const offset = match.index ?? 0;
    out.push({ offset, excerpt: text.slice(Math.max(0, offset - 80), Math.min(text.length, offset + 300)).replace(/\s+/gu, " ") });
    if (out.length >= 20) break;
  }
  return out;
}

function stageSnippet(text: string, marker: string): string {
  const offset = text.indexOf(marker);
  if (offset < 0) return "";
  return text.slice(Math.max(0, offset - 120), Math.min(text.length, offset + marker.length + 180)).replace(/\s+/gu, " ");
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stringValue(value: JsonValue | undefined): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: JsonValue | undefined): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function booleanValue(value: JsonValue | undefined): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function stringArray(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }

function readMaxPages(args: readonly string[]): number {
  const raw = args.find(arg => arg.startsWith("--max-pages="))?.slice("--max-pages=".length) ?? "300";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--max-pages must be a positive integer");
  return value;
}

function check(id: string, passed: boolean, detail: string): void {
  checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

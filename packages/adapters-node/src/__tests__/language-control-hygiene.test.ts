import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanLanguageControlHygiene } from "../language-control-hygiene.js";

describe("language control hygiene scanner", () => {
  it("keeps live brain lookup off raw text scans", async () => {
    const source = await readFile(path.resolve("packages/adapters-node/src/postgres.ts"), "utf8");

    expect(source).not.toContain("representation_json::text ILIKE");
    expect(source).not.toContain("metadata_json::text ILIKE");
    expect(source).not.toContain("text_content ILIKE");
    expect(source).not.toContain("boundedTopicPatterns");
    expect(source).toContain("WHERE features &&");
    expect(source).toContain("array_position($1::text[], feature)");
    expect(source).not.toContain("source_node_id=ANY($1) OR target_node_id=ANY($1)");
    expect(source).toContain("WITH ORDINALITY AS seed(seed_id, seed_ord)");
    expect(source).toContain("WHERE source_node_id=seeds.seed_id");
    expect(source).toContain("WHERE target_node_id=seeds.seed_id");
    expect(source).toContain("ROW_NUMBER() OVER (PARTITION BY id ORDER BY seed_ord");
    expect(source).toContain("cleanFeature.startsWith(\"tri:\")");
    expect(source).toContain("cleanFeature.startsWith(\"bi:\")");
    expect(source).toContain("cleanFeature.slice(4)].length >= 5");
  });

  it("keeps cognitive answer routing free of canned demo bypasses", async () => {
    const runtimePaths = [
      "kernel.ts",
      "production-turn-runtime.ts",
      "learned-graph-prior-runtime.ts",
      "local-evidence-runtime.ts",
      "runtime-graph-retrieval.ts",
      "runtime-motion.ts",
      "surface-language-runtime.ts",
      "candidate-construct-binding.ts",
      "candidate-proof-policy.ts",
      "evaluation-runtime-bypass.ts",
      "turn-request-control.ts"
    ];
    const runtime = (await Promise.all(runtimePaths.map(file =>
      readFile(path.resolve("packages/kernel/src", file), "utf8")
    ))).join("\n");
    const kernel = await readFile(path.resolve("packages/kernel/src/kernel.ts"), "utf8");
    const questionCognitiveEdge = await readFile(path.resolve("packages/kernel/src/question-cognitive-edge.ts"), "utf8");
    const mouth = await readFile(path.resolve("packages/kernel/src/mouth.ts"), "utf8");
    const languageMemory = await readFile(path.resolve("packages/kernel/src/language-memory-runtime.ts"), "utf8");
    const surfaceRealizer = await readFile(path.resolve("packages/kernel/src/surface-realizer.ts"), "utf8");

    expect(runtime).not.toContain("fastCognitiveAnswerTurn");
    expect(runtime).not.toContain("hotLearnedPriorAnswer");
    expect(runtime).not.toContain("hot-prior.");
    expect(runtime).not.toContain("Ada Lovelace was a nineteenth-century");
    expect(runtime).not.toContain("For the original Star Trek");
    expect(runtime).not.toContain("input.selectedEvidence.length || kernelNumber(input.brainMarker.importedDirectEvidenceCount)");
    expect(runtime).toContain("const directEvidenceCount = input.selectedEvidence.length;");
    expect(runtime).toContain("constructGraph: spokenConstructGraph");
    expect(kernel).toContain("withBufferedEventWrites");
    expect(runtime).toContain("graphSliceCache");
    expect(runtime).toContain("afterTurnMaintenanceDeferred");
    for (const forbidden of [
      "calendarResidueUnit",
      "pluralBiographyClass",
      "narrowBiographyPredicate",
      "identityPredicate",
      "lowValueBiographyCatalogFact",
      "january",
      "february",
      "march",
      "april",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
      "birth place",
      "death place",
      "mathematician",
      "physicist",
      "programmer"
    ]) {
      expect(runtime).not.toContain(forbidden);
      expect(questionCognitiveEdge).not.toContain(forbidden);
    }
    expect(mouth).not.toContain("const selected = workspaceDraftCandidate ??");
    expect(mouth).not.toContain("function preserveSurfaceExtent(text: string, _maxLength?: number): string");
    expect(mouth).not.toContain(hygienePhrase("This", "brain", "does", "not", "have", "answer-grade", "support"));
    expect(mouth).not.toContain(hygienePhrase("I", "do", "not", "have", "enough", "support"));
    expect(languageMemory).not.toContain(hygienePhrase("The", "answer", "path", "emphasizes"));
    expect(languageMemory).not.toContain(hygienePhrase("Relation", "roles", "and", "active", "memory", "labels", "shape"));
    expect(languageMemory).not.toContain(hygienePhrase("Role", "weight,", "graph", "proximity"));
    expect(languageMemory).not.toContain(hygienePhrase("It", "stays", "bounded", "until", "matching", "source", "evidence", "is", "attached"));
    expect(languageMemory).not.toContain(hygienePhrase("In", "short:"));
    expect(mouth).toContain("selectedCandidate?: CandidateSurface");
    expect(mouth).toContain("const selectedKernelCandidate");
    expect(mouth).toContain("const selected = plannerSelectedCandidate ??");
    expect(mouth).toContain("kernelCandidateCanPreempt");
    expect(mouth).toContain("extentRequiredSurfaces");
    expect(mouth).toContain("candidate:generated:rhetorical-lattice");
    expect(languageMemory).toContain("export type RhetoricalMove");
    expect(languageMemory).toContain("export interface ParagraphPlan");
    expect(languageMemory).toContain("export interface SentencePlan");
    expect(languageMemory).toContain("export interface ClauseCandidate");
    expect(languageMemory).toContain("export interface SentenceLattice");
    expect(languageMemory).toContain("export interface ProseCandidate");
    expect(languageMemory).toContain("export interface ProseCriticResult");
    expect(languageMemory).toContain("generateRhetoricalSentenceLattice");
    expect(languageMemory).toContain("rhetoricalSentenceLattice");
    expect(surfaceRealizer).not.toContain("surface.point=");
    expect(surfaceRealizer).not.toContain("surface.limit=");
    expect(surfaceRealizer).not.toContain("surface.grounding=");
  });

  it("fails prompt-text routing in runtime source", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/router.ts", [
        "export function route(prompt: string): string {",
        "  if (prompt.includes(\"poem\")) return \"surface.profile.3\";",
        "  return \"surface.profile.1\";",
        "}"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(true);
      expect(result.issues.some(issue => issue.ruleId === "prompt_text_router")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails regex-based prompt-text routing in runtime source", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/regex-router.ts", [
        "export function routeText(text: string): string {",
        "  if (/summarize/u.test(text)) return \"surface.profile.3\";",
        "  if (text.match(/brief/u)) return \"surface.profile.1\";",
        "  return \"surface.profile.2\";",
        "}"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(true);
      expect(result.issues.filter(issue => issue.ruleId === "prompt_text_router").length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails display detail branches, display operation labels, loose section classifiers, and canned surfaces", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/bad-runtime.ts", [
        "declare function operation(kind: string, path: string): unknown;",
        "declare function candidate(text: string): unknown;",
        "export function detail(value: string): string {",
        "  if (value === \"brief\") return \"surface.detail.profile.0\";",
        "  if (value === \"detailed\") return \"surface.detail.profile.2\";",
        "  return \"surface.detail.profile.1\";",
        "}",
        "export function legacy(input: { detailLevel?: string }): unknown {",
        "  return { legacyDetailSignal: input.detailLevel };",
        "}",
        "export function parseCorrection(ownerFeedback: string): string | undefined {",
        "  if (/brief/u.test(ownerFeedback)) return \"surface.detail.profile.0\";",
        "  return undefined;",
        "}",
        "export function repair(): unknown {",
        "  return operation(\"explain\", \"README.md\");",
        "}",
        "export function classify(lower: string): string {",
        "  if (lower.includes(\"code\")) return \"learned_program_prior\";",
        "  return \"learned_language_prior\";",
        "}",
        "export function speak(): unknown {",
        "  return candidate(\"I cannot answer that right now\");",
        "}"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      const rules = result.issues.map(issue => issue.ruleId);
      expect(result.failed).toBe(true);
      expect(rules).toContain("display_string_branch");
      expect(rules).toContain("legacy_detail_signal_runtime");
      expect(rules).toContain("regex_correction_parser");
      expect(rules).toContain("operation_display_label");
      expect(rules).toContain("loose_section_classifier");
      expect(rules).toContain("runtime_canned_surface");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts opaque profile data without display-string branches", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/profiles.ts", [
        "export const profile = {",
        "  id: \"surface.detail.profile.1\",",
        "  vector: [0.48, 0.2],",
        "  maxSentenceCount: 4",
        "};"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(false);
      expect(result.issueCount).toBe(0);
      expect(result.scannedFiles).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts structured diagnostics and non-routing syntax that shares control words", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/structured-runtime.ts", [
        "export async function acquire(input: { ownerInput: { text: string } }, deps: { connectors: { search(text: string, limit: number): Promise<unknown> } }): Promise<void> {",
        "  await deps.connectors.search(input.ownerInput.text, 3);",
        "}",
        "export function decode(row: { requestedAuthority?: string }): string | undefined {",
        "  return typeof row.requestedAuthority === \"string\" && [\"factual\", \"creative\"].includes(row.requestedAuthority) ? row.requestedAuthority : undefined;",
        "}",
        "export function scoreCandidate(requestedAuthority: string, surfaceMass: number): number {",
        "  if (requestedAuthority === \"creative\") return surfaceMass;",
        "  return 0;",
        "}",
        "export function rejectNeutralizedTest(content: string): boolean {",
        "  const neutralized = /(?:test|describe)\\.(?:skip|todo)/u;",
        "  return neutralized.test(content);",
        "}",
        "export const parserOptions = { sheetStubs: false };",
        "export const risks = [{ id: \"gap\", level: \"info\", message: \"No spectral gap is reported because its assumptions were not established.\", evidence: {} }];",
        "// Unrelated answer families are not reopened as a fallback.",
        "export function bindEvidence(fallbackEvidenceIds: string[], evidence: unknown): unknown {",
        "  return boundEvidenceSurface(fallbackEvidenceIds, evidence);",
        "}",
        "declare function boundEvidenceSurface(ids: string[], evidence: unknown): unknown;"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(false);
      expect(result.issues).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails request-echo fallbacks, stringly surface routing, and canned Mouth messages", async () => {
    const root = await tempRepo();
    try {
      await writeSource(root, "packages/kernel/src/stringly-mouth.ts", [
        "export function runtimeMotionFocusSurface(requestText: string): string {",
        "  const fallback = requestText.trim();",
        "  return fallback;",
        "}",
        "export function route(candidate: { style: string }): number {",
        "  if (candidate.style === \"creative\") return 1;",
        "  return 0;",
        "}",
        "export function speak(): { message: string } {",
        "  return { message: \"I cannot answer this request\" };",
        "}"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      const rules = result.issues.map(issue => issue.ruleId);
      expect(rules).toContain("runtime_surface_fallback");
      expect(rules).toContain("display_string_branch");
      expect(rules).toContain("runtime_canned_surface");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails blocked architecture terminology in runtime source", async () => {
    const root = await tempRepo();
    try {
      const blocked = `${fromCodes([110, 101, 117, 114, 97, 108])} ${fromCodes([119, 101, 105, 103, 104, 116])}`;
      await writeSource(root, "packages/kernel/src/bad-term.ts", [
        "export const trace = {",
        `  label: "${blocked}"`,
        "};"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(true);
      expect(result.issues.some(issue => issue.ruleId === "blocked_term")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails unserious operator-grant and runtime extent terminology in runtime source", async () => {
    const root = await tempRepo();
    try {
      const legacyGrant = `${fromCodes([115, 101, 115, 115, 105, 111, 110])}_${fromCodes([121, 111, 108, 111])}`;
      const extentTerm = `${fromCodes([116, 111, 107, 101, 110])} ${fromCodes([98, 117, 100, 103, 101, 116])}`;
      await writeSource(root, "packages/kernel/src/bad-runtime-terms.ts", [
        "export const session = {",
        `  mode: "${legacyGrant}",`,
        `  limit: "${extentTerm}"`,
        "};"
      ].join("\n"));

      const result = await scanLanguageControlHygiene({ root });
      expect(result.failed).toBe(true);
      expect(result.issues.filter(issue => issue.ruleId === "blocked_term").length).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function hygienePhrase(...parts: readonly string[]): string {
  return parts.join(" ");
}

async function tempRepo(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "scce-hygiene-"));
}

async function writeSource(root: string, rel: string, content: string): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${content}\n`, "utf8");
}

function fromCodes(codes: readonly number[]): string {
  return String.fromCharCode(...codes);
}

import type { EvidenceId, EvidenceSpan, Hasher, JsonValue, SemanticEntailmentResult } from "./types.js";
import { canonicalStringify, clamp01, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { extensionOf, normalizePath, sourceCodeFileFactsFromJson, sourceRepositoryFactsFromJson, type SourceCodeFileFacts, type SourceRepositoryFacts } from "./source-code-graph.js";
import { engineeringCorpusProjectionFromMetadata, type EngineeringCorpusProjection } from "./engineering-corpus.js";
import { repoSnapshotToEngineeringContext, type RepoSnapshot } from "./developer-intelligence.js";

export type CodeLanguage = string;

export type CodeSignalKind = string;

export interface CodeSignal {
  id: string;
  kind: CodeSignalKind;
  language: CodeLanguage;
  text: string;
  normalized: string;
  features: string[];
  evidenceId: EvidenceId;
  sourceVersionId: string;
  alpha: number;
  confidence: number;
  metadata: JsonValue;
}

export interface CodeIdiom {
  id: string;
  language: CodeLanguage;
  label: string;
  support: number;
  evidenceIds: EvidenceId[];
  codeSymbols: string[];
  constraints: string[];
}

export interface CodeDependencyHypothesis {
  id: string;
  packageName: string;
  language: CodeLanguage;
  importedBy: EvidenceId[];
  support: number;
  risk: number;
  purpose: string;
}

export interface CodeEditOperation {
  id: string;
  kind: "create" | "modify" | "delete" | "verify" | "explain";
  path: string;
  language: CodeLanguage;
  intent: string;
  preconditions: string[];
  postconditions: string[];
  evidenceIds: EvidenceId[];
  confidence: number;
  risk: number;
}

export interface CodeKnowledgeGraph {
  id: string;
  languages: Array<{ language: CodeLanguage; weight: number; evidenceIds: EvidenceId[] }>;
  signals: CodeSignal[];
  idioms: CodeIdiom[];
  dependencies: CodeDependencyHypothesis[];
  editPriors: CodeEditOperation[];
  engineeringCorpora: Array<{
    id: string;
    rootUri: string;
    summary: EngineeringCorpusProjection["summary"];
    capabilities: Array<{ kind: string; support: number; confidence: number }>;
    plannerHints: EngineeringCorpusProjection["plannerHints"];
  }>;
  repositoryShape: {
    files: Array<{ pathHint: string; language: CodeLanguage; role: string; evidenceIds: EvidenceId[]; confidence: number }>;
    hasTests: boolean;
    hasConfig: boolean;
    hasApiSurface: boolean;
    hasUiSurface: boolean;
  };
  confidence: number;
  audit: JsonValue;
}

export interface CodeBlueprintFile {
  path: string;
  language: CodeLanguage;
  role: "source" | "test" | "config" | "doc";
  purpose: string;
  imports: string[];
  exports: string[];
  invariants: string[];
  evidenceIds: EvidenceId[];
}

export interface CodeImplementationBlueprint {
  id: string;
  target: string;
  runtime: {
    packageManager: string;
    entrypoint: string;
    build: { command: string; args: string[]; cwd: string };
    test: { command: string; args: string[]; cwd: string };
  };
  files: CodeBlueprintFile[];
  operations: CodeEditOperation[];
  validation: Array<{ id: string; command: string; args: string[]; expects: string[]; evidenceIds: EvidenceId[] }>;
  repairPolicy: Array<{ diagnostic: string; recognizer: string; operation: string; confidence: number }>;
  sourceCoupling: number;
  unbackedSynthesisRisk: number;
  audit: JsonValue;
}

const CODE_INTENT = {
  DATABASE: "scce.code.intent.001",
  TOOL: "scce.code.intent.002",
  INGESTION: "scce.code.intent.003",
  UI: "scce.code.intent.004",
  REPAIR: "scce.code.intent.005",
  DOMAIN: "scce.code.intent.006"
} as const;

const CODE_PURPOSE = {
  PROGRAM_GRAPH: "scce.code.purpose.001",
  EDIT_PLAN: "scce.code.purpose.002",
  PROGRAM_INSPECTOR: "scce.code.purpose.003",
  REPAIR_POLICY: "scce.code.purpose.004",
  AUDIT_NOTE: "scce.code.purpose.005",
  DIAGNOSTICS: "scce.code.purpose.006",
  DEP_UI: "scce.code.dep.001",
  DEP_POSTGRES: "scce.code.dep.002",
  DEP_SCHEMA: "scce.code.dep.003",
  DEP_HTTP: "scce.code.dep.004",
  DEP_BROWSER: "scce.code.dep.005",
  DEP_SOURCE_IMPORT: "scce.code.dep.999"
} as const;

const CODE_CONSTRAINT = {
  IMPORT_DECLARED: "scce.code.constraint.001",
  MIGRATION_BACKED: "scce.code.constraint.002",
  TEST_BEHAVIOR: "scce.code.constraint.003",
  ROUTE_CONTRACTS: "scce.code.constraint.004",
  LOCAL_STYLE: "scce.code.constraint.005",
  PROOF_SELECTED: "scce.code.constraint.006",
  SOURCE_VERSIONS_PRESENT: "scce.code.constraint.007",
  APPROVAL_BEFORE_MUTATION: "scce.code.constraint.008",
  PATH_CONTAINED: "scce.code.constraint.009",
  DIAGNOSTICS_PERSISTED: "scce.code.constraint.010",
  REPAIR_DOES_NOT_SUPPRESS: "scce.code.constraint.011",
  JSON_PARSEABLE: "scce.code.constraint.012",
  NO_SECRET_MATERIAL: "scce.code.constraint.013",
  EVIDENCE_IDS_EXPLICIT: "scce.code.constraint.014",
  OPERATIONS_HAVE_PRECONDITIONS: "scce.code.constraint.015",
  RISK_EXPLICIT: "scce.code.constraint.016",
  STANDARD_LIBRARY_ONLY: "scce.code.constraint.017",
  READ_ONLY: "scce.code.constraint.018",
  APPROVAL_EXTERNAL: "scce.code.constraint.019",
  DIAGNOSTIC_CLASSES_EXPLICIT: "scce.code.constraint.020",
  REPAIR_REQUIRES_REVIEW: "scce.code.constraint.021",
  SOURCE_COUPLING_STATED: "scce.code.constraint.022",
  UNBACKED_SYNTHESIS_RISK_STATED: "scce.code.constraint.023",
  BUILD_NOT_PRECLAIMED: "scce.code.constraint.024",
  EXPECTED_DIAGNOSTICS_NAMED: "scce.code.constraint.025",
  GRAPH_AVAILABLE: "scce.code.constraint.026",
  REVIEWABLE_BEFORE_COMMIT: "scce.code.constraint.027"
} as const;

export function createCodeLearningEngine(options: { hasher: Hasher }) {
  return {
    learn(input: { requestText: string; evidence: EvidenceSpan[]; entailment: SemanticEntailmentResult }): CodeKnowledgeGraph {
      const signals = input.evidence.flatMap(span => signalsFromEvidence(span, options.hasher));
      const engineeringCorpora = engineeringCorporaFromEvidence(input.evidence, options.hasher);
      const languages = languageWeights(signals, input.evidence);
      const idioms = deriveIdioms(signals, options.hasher);
      const dependencies = deriveDependencies(signals, options.hasher);
      const repositoryShape = inferRepositoryShape(signals, input.evidence);
      const signalFeatures = signals.flatMap(signal => signal.features.slice(0, 32));
      const evidenceFeatures = input.evidence.flatMap(span => span.features.slice(0, 32));
      const sourceCoupling = signalFeatures.length && evidenceFeatures.length ? weightedJaccard(signalFeatures, evidenceFeatures) : mean(signals.map(signal => signal.confidence));
      const editPriors = inferEditPriors({ evidence: input.evidence, signals, repositoryShape, entailment: input.entailment, hasher: options.hasher });
      const confidence = clamp01(0.22 + 0.28 * input.entailment.support + 0.22 * sourceCoupling + 0.18 * mean(signals.map(signal => signal.confidence)) + 0.1 * Math.min(1, input.evidence.length / 12) - 0.25 * input.entailment.contradiction);
      const id = `code_knowledge_${options.hasher.digestHex(canonicalStringify({ signals: signals.map(signal => signal.id), languages, sourceCoupling })).slice(0, 40)}`;
      return {
        id,
        languages,
        signals,
        idioms,
        dependencies,
        editPriors,
        engineeringCorpora: engineeringCorpora.map(corpus => ({
          id: corpus.id,
          rootUri: corpus.rootUri,
          summary: corpus.summary,
          capabilities: corpus.capabilities.map(capability => ({ kind: capability.kind, support: capability.support, confidence: capability.confidence })),
          plannerHints: corpus.plannerHints
        })),
        repositoryShape,
        confidence,
        audit: toJsonValue({
          id,
          confidence,
          sourceCoupling,
          languages,
          signalCount: signals.length,
          idioms: idioms.slice(0, 24),
          dependencies: dependencies.slice(0, 24),
          engineeringCorpora: engineeringCorpora.map(corpus => ({
            id: corpus.id,
            rootUri: corpus.rootUri,
            summary: corpus.summary,
            primaryLanguages: corpus.plannerHints.primaryLanguages,
            commands: {
              build: corpus.plannerHints.buildCommands.length,
              validation: corpus.plannerHints.validationCommands.length,
              runtime: corpus.plannerHints.runtimeCommands.length
            },
            capabilities: corpus.capabilities.map(capability => capability.kind)
          })),
          repositoryShape,
          editPriorCount: editPriors.length
        })
      };
    },

    blueprint(input: { target: string; requestText: string; graph: CodeKnowledgeGraph; entailment: SemanticEntailmentResult }): CodeImplementationBlueprint {
      const primary = input.graph.languages[0]?.language ?? targetLanguage(input.target);
      const sourceCoupling = couplingFromGraph(input.graph);
      const risk = clamp01(0.72 - 0.42 * input.graph.confidence + 0.22 * input.entailment.contradiction + (input.graph.signals.length ? 0 : 0.35));
      const files = blueprintFiles({ target: input.target, language: primary, graph: input.graph, risk });
      const operations = blueprintOperations({ files, graph: input.graph, target: input.target, risk, hasher: options.hasher });
      const runtime = runtimeForBlueprint(primary, input.target);
      const validation = [
        { id: "syntax-surface", command: runtime.build.command, args: runtime.build.args, expects: ["parser accepts emitted source files"], evidenceIds: evidenceIdsForGraph(input.graph).slice(0, 24) },
        { id: "self-check", command: runtime.test.command, args: runtime.test.args, expects: ["manifest is parseable", "edit operations have preconditions", "repair policy is attached"], evidenceIds: evidenceIdsForGraph(input.graph).slice(0, 24) }
      ];
      const repairPolicy = [
        { diagnostic: "syntax", recognizer: "parser location and nearest file operation", operation: "repair emitted hunk while preserving blueprint invariants", confidence: clamp01(0.55 + input.graph.confidence * 0.25) },
        { diagnostic: "type", recognizer: "missing symbol, incompatible call, unresolved import", operation: "map symbol to learned idiom/import graph and update contract edge", confidence: clamp01(0.48 + input.graph.confidence * 0.3) },
        { diagnostic: "dependency", recognizer: "module not found, package restore failure", operation: "prefer learned dependency hypothesis or bundled standard-library substitute", confidence: clamp01(0.5 + mean(input.graph.dependencies.map(dep => dep.support)) * 0.3) },
        { diagnostic: "semantic", recognizer: "test contradicts proof boundary or requested behavior", operation: "reopen proof obligations before changing code", confidence: clamp01(0.58 + input.entailment.faithfulnessLcb * 0.25) }
      ];
      const id = `code_blueprint_${options.hasher.digestHex(canonicalStringify({ target: input.target, graph: input.graph.id, files, operations })).slice(0, 40)}`;
      return {
        id,
        target: input.target,
        runtime,
        files,
        operations,
        validation,
        repairPolicy,
        sourceCoupling,
        unbackedSynthesisRisk: risk,
        audit: toJsonValue({
          id,
          target: input.target,
          primaryLanguage: primary,
          sourceCoupling,
          unbackedSynthesisRisk: risk,
          files: files.map(file => ({ path: file.path, role: file.role, language: file.language, invariants: file.invariants })),
          operations: operations.map(op => ({ id: op.id, kind: op.kind, path: op.path, confidence: op.confidence, risk: op.risk })),
          validation,
          repairPolicy
        })
      };
    }
  };
}

function signalsFromEvidence(span: EvidenceSpan, hasher: Hasher): CodeSignal[] {
  const text = boundedText(span.text || span.textPreview, 24000);
  const facts = sourceFactsFromSpan(span);
  const repositoryFacts = repositoryFactsFromSpan(span);
  const engineeringCorpus = engineeringCorpusFromSpan(span, hasher);
  const candidates = engineeringCorpus
    ? [...candidatesFromEngineeringCorpus(engineeringCorpus), ...(repositoryFacts ? candidatesFromRepositoryFacts(repositoryFacts) : facts ? candidatesFromFacts(facts) : [])]
    : repositoryFacts ? candidatesFromRepositoryFacts(repositoryFacts) : facts ? candidatesFromFacts(facts) : structuralCandidatesFromSpan(span, text);
  return candidates.slice(0, 80).map((candidate, index) => {
    const language = candidate.language ?? languageForEvidence(span, facts, repositoryFacts);
    const normalized = normalizeSignal(candidate.text);
    const id = `code_signal_${hasher.digestHex(`${span.id}:${index}:${candidate.kind}:${normalized}`).slice(0, 40)}`;
    const features = sourceFeatures([candidate.kind, language, candidate.text, normalized], 96);
    const confidence = clamp01(0.35 + span.alpha * 0.35 + (candidate.kind === "import" || candidate.kind === "schema" ? 0.14 : 0.08) + (span.status === "promoted" ? 0.12 : 0));
    return {
      id,
      kind: candidate.kind,
      language,
      text: candidate.text,
      normalized,
      features,
      evidenceId: span.id,
      sourceVersionId: String(span.sourceVersionId),
      alpha: span.alpha,
      confidence,
      metadata: candidate.metadata ?? {}
    };
  });
}

type CodeSignalCandidate = { kind: CodeSignalKind; text: string; metadata?: JsonValue; language?: CodeLanguage };

function candidatesFromEngineeringCorpus(corpus: EngineeringCorpusProjection): CodeSignalCandidate[] {
  const out: CodeSignalCandidate[] = [];
  out.push({ kind: "engineering-corpus", text: corpus.rootUri, metadata: corpus.audit, language: "source.repository" });
  for (const language of corpus.languages.slice(0, 32)) {
    out.push({
      kind: "language-profile",
      text: language.language,
      language: language.language,
      metadata: toJsonValue({
        id: language.id,
        weight: language.weight,
        fileCount: language.fileCount,
        capabilityIds: language.capabilityIds,
        entrypoints: language.entrypoints
      })
    });
    for (const capabilityId of language.capabilityIds.slice(0, 16)) {
      out.push({ kind: "capability", text: capabilityId, language: language.language, metadata: toJsonValue({ source: "engineering-language-profile", language: language.language }) });
    }
  }
  for (const file of corpus.files.slice(0, 512)) {
    out.push({
      kind: "file",
      text: file.path,
      language: file.language,
      metadata: toJsonValue({
        id: file.id,
        roleIds: file.roles.map(role => role.roleId),
        moduleScore: file.moduleScore,
        entrypointScore: file.entrypointScore,
        validationScore: file.validationScore,
        generatedScore: file.generatedScore
      })
    });
    for (const role of file.roles.slice(0, 6)) out.push({ kind: "file-role", text: role.roleId, language: file.language, metadata: toJsonValue({ file: file.path, role }) });
  }
  for (const command of corpus.commands.slice(0, 128)) {
    out.push({
      kind: commandSignalKindFromEngineering(command.kind),
      text: command.scriptName,
      language: "source.command",
      metadata: toJsonValue({ package: command.packageName, script: { name: command.scriptName, command: command.command }, command })
    });
  }
  for (const dep of corpus.dependencies.slice(0, 256)) {
    out.push({
      kind: "import",
      text: dep.name,
      language: dep.importEvidence[0] ? languageForCorpusPath(corpus, dep.importEvidence[0].path) : "source.dependency",
      metadata: toJsonValue({ dependency: dep, source: "engineering-corpus" })
    });
  }
  for (const symbol of corpus.symbols.slice(0, 256)) {
    out.push({
      kind: symbol.exported ? "export" : "symbol",
      text: symbol.name,
      language: symbol.language,
      metadata: toJsonValue({ symbol, source: "engineering-corpus" })
    });
  }
  for (const route of corpus.routes.slice(0, 128)) out.push({ kind: "route", text: `${route.method} ${route.path}`, language: languageForCorpusPath(corpus, route.filePath), metadata: toJsonValue({ route, source: "engineering-corpus" }) });
  for (const test of corpus.tests.slice(0, 128)) out.push({ kind: "test", text: test.name ?? test.id, language: test.language, metadata: toJsonValue({ test, source: "engineering-corpus" }) });
  for (const capability of corpus.capabilities.slice(0, 64)) {
    out.push({ kind: "capability", text: capability.kind, language: "source.capability", metadata: toJsonValue({ capability, source: "engineering-corpus" }) });
  }
  return out;
}

function commandSignalKindFromEngineering(kind: string): CodeSignalKind {
  if (kind === "eng.command.validation") return "script.validation";
  if (kind === "eng.command.build") return "script.build";
  if (kind === "eng.command.runtime") return "script.runtime";
  if (kind === "eng.command.lint") return "script.lint";
  return "script";
}

function languageForCorpusPath(corpus: EngineeringCorpusProjection, path: string): CodeLanguage {
  return corpus.files.find(file => file.path === path)?.language ?? "source.dependency";
}

function candidatesFromRepositoryFacts(facts: SourceRepositoryFacts): CodeSignalCandidate[] {
  const out: CodeSignalCandidate[] = [];
  out.push({ kind: "repository", text: facts.normalizedRootUri, metadata: facts.audit });
  for (const manager of facts.workspace.packageManagers) out.push({ kind: "package-manager", text: manager, metadata: { rootUri: facts.normalizedRootUri } });
  for (const pkg of facts.packages) {
    out.push({ kind: "package", text: pkg.name ?? pkg.manifestPath, metadata: toJsonValue(pkg) });
    for (const script of pkg.scripts) out.push({ kind: scriptSignalKind(script.name, script.command), text: script.name, metadata: toJsonValue({ package: pkg.name, script }) });
    for (const dep of pkg.dependencies) out.push({ kind: "import", text: dep.name, metadata: toJsonValue({ package: pkg.name, dependency: dep }) });
  }
  for (const file of facts.files.slice(0, 512)) {
    const language = repositoryFileLanguage(file);
    out.push({ kind: "file", text: file.normalizedPath, metadata: toJsonValue(file), language });
    for (const languageEvidence of file.languageEvidence.slice(0, 8)) out.push({ kind: "language-evidence", text: `${languageEvidence.kind}:${languageEvidence.value}`, metadata: toJsonValue({ file: file.normalizedPath, languageEvidence }), language });
    for (const role of file.roleEvidence.slice(0, 8)) out.push({ kind: "file-role", text: role.roleId, metadata: toJsonValue({ file: file.normalizedPath, role }), language });
  }
  for (const name of Object.keys(facts.distributions.imports).slice(0, 512)) out.push({ kind: "import", text: name, metadata: toJsonValue({ count: facts.distributions.imports[name], source: "repository-distribution" }) });
  return out;
}

function candidatesFromFacts(facts: SourceCodeFileFacts): CodeSignalCandidate[] {
  const out: CodeSignalCandidate[] = [];
  for (const declaration of facts.declarations) out.push({ kind: declaration.exported ? "export" : "symbol", text: declaration.name, metadata: toJsonValue(declaration) });
  for (const item of facts.imports) out.push({ kind: "import", text: item.moduleSpecifier, metadata: toJsonValue(item) });
  for (const item of facts.exports) for (const name of item.exportedNames) out.push({ kind: "export", text: name, metadata: toJsonValue(item) });
  for (const route of facts.routes) out.push({ kind: "route", text: `${route.method} ${route.path}`, metadata: toJsonValue(route) });
  for (const test of facts.tests) out.push({ kind: "test", text: test.name ?? test.id, metadata: toJsonValue(test) });
  for (const pattern of facts.patterns) out.push({ kind: "source-pattern", text: `${pattern.kind}:${pattern.label}`, metadata: toJsonValue(pattern) });
  for (const dep of facts.packageFacts?.dependencies ?? []) out.push({ kind: "import", text: dep.name, metadata: toJsonValue(dep) });
  for (const script of facts.packageFacts?.scripts ?? []) out.push({ kind: "config", text: script.name, metadata: toJsonValue(script) });
  if (!out.length) out.push({ kind: "idiom", text: facts.normalizedPath, metadata: facts.audit });
  return out;
}

function structuralCandidatesFromSpan(span: EvidenceSpan, text: string): CodeSignalCandidate[] {
  const path = provenanceUri(span);
  const ext = path ? extensionOf(path) : "";
  const candidates: Array<{ kind: CodeSignalKind; text: string; metadata?: JsonValue }> = [];
  if (path) candidates.push({ kind: "file", text: normalizePath(path), metadata: { source: "evidence-provenance" } });
  if (ext) candidates.push({ kind: "language-evidence", text: ext, metadata: { source: "path-extension" } });
  for (const codeSymbol of structuralCodeSymbols(text).slice(0, 24)) candidates.push({ kind: "code-symbol-shape", text: codeSymbol, metadata: { source: "bounded-structural-scan" } });
  if (!candidates.length) candidates.push({ kind: "text-window", text: text.slice(0, 220), metadata: { source: "bounded-evidence" } });
  return candidates;
}

function repositoryFileLanguage(file: SourceRepositoryFacts["files"][number]): CodeLanguage {
  const strongest = file.languageEvidence[0];
  return strongest ? `${strongest.kind}:${strongest.value}` : file.mediaType ? `media-type:${file.mediaType}` : "und";
}

function deriveIdioms(signals: readonly CodeSignal[], hasher: Hasher): CodeIdiom[] {
  const groups = new Map<string, CodeSignal[]>();
  for (const signal of signals) {
    const key = `${signal.language}:${signal.kind}:${signal.normalized.split("/")[0] ?? signal.normalized}`;
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [language = "unknown", kind = "idiom"] = key.split(":");
      const codeSymbols = [...new Set(group.flatMap(signal => signal.features.filter(feature => feature.startsWith("sym:")).slice(0, 12)))].slice(0, 40);
      const support = clamp01(mean(group.map(signal => signal.confidence)) * Math.min(1, group.length / 3));
      return {
        id: `code_idiom_${hasher.digestHex(`${key}:${group.map(signal => signal.id).join("|")}`).slice(0, 40)}`,
        language: asLanguage(language),
        label: `${language}:${kind}`,
        support,
        evidenceIds: [...new Set(group.map(signal => signal.evidenceId))],
        codeSymbols,
        constraints: constraintsForIdiom(kind)
      };
    })
    .sort((a, b) => b.support - a.support)
    .slice(0, 64);
}

function deriveDependencies(signals: readonly CodeSignal[], hasher: Hasher): CodeDependencyHypothesis[] {
  const imports = signals.filter(signal => signal.kind === "import");
  const groups = new Map<string, CodeSignal[]>();
  for (const signal of imports) {
    const pkg = packageName(signal.normalized);
    if (!pkg || pkg.startsWith(".") || pkg.startsWith("/")) continue;
    groups.set(pkg, [...(groups.get(pkg) ?? []), signal]);
  }
  return [...groups.entries()].map(([pkg, group]) => {
    const support = clamp01(mean(group.map(signal => signal.confidence)) * Math.min(1, group.length / 2));
    return {
      id: `code_dep_${hasher.digestHex(`${pkg}:${group.map(signal => signal.id).join("|")}`).slice(0, 40)}`,
      packageName: pkg,
      language: group[0]?.language ?? "unknown",
      importedBy: [...new Set(group.map(signal => signal.evidenceId))],
      support,
      risk: clamp01(0.7 - support * 0.45 + (pkg.startsWith("@") ? 0.05 : 0)),
      purpose: purposeForPackage(pkg)
    };
  }).sort((a, b) => b.support - a.support).slice(0, 48);
}

function inferRepositoryShape(signals: readonly CodeSignal[], evidence: readonly EvidenceSpan[]): CodeKnowledgeGraph["repositoryShape"] {
  const manifestFiles = evidence.flatMap(span => filesFromRepositoryFacts(span)).slice(0, 2000);
  const evidenceFiles = evidence.slice(0, 80).map(span => {
    const meta = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
    const uri = typeof meta.uri === "string" ? meta.uri : `evidence/${String(span.id).slice(0, 12)}.txt`;
    const language = languageForEvidence(span, sourceFactsFromSpan(span), repositoryFactsFromSpan(span));
    return { pathHint: uri, language, role: roleForPath(uri, signals), evidenceIds: [span.id], confidence: clamp01(0.4 + span.alpha * 0.4 + (span.status === "promoted" ? 0.12 : 0)) };
  });
  const files = dedupeShapeFiles([...manifestFiles, ...evidenceFiles]);
  return {
    files,
    hasTests: signals.some(signal => signal.kind === "test") || files.some(file => includesAny(file.pathHint.toLocaleLowerCase(), ["test", "spec"])),
    hasConfig: signals.some(signal => signal.kind === "config") || files.some(file => file.role.includes("configuration") || sourceConfigPath(file.pathHint)),
    hasApiSurface: signals.some(signal => signal.kind === "route") || signals.some(signal => includesAny(signal.normalized, ["router", "server", "controller", "endpoint"])),
    hasUiSurface: files.some(file => file.role.includes("presentation")) || signals.some(signal => signal.kind === "file-role" && signal.text.includes("presentation"))
  };
}

function inferEditPriors(input: {
  evidence: EvidenceSpan[];
  signals: CodeSignal[];
  repositoryShape: CodeKnowledgeGraph["repositoryShape"];
  entailment: SemanticEntailmentResult;
  hasher: Hasher;
}): CodeEditOperation[] {
  const wantsUi = input.repositoryShape.hasUiSurface;
  const wantsDb = input.repositoryShape.hasConfig || input.signals.some(signal => signal.language === "sql");
  const wantsTool = input.repositoryShape.hasApiSurface || input.signals.some(signal => signal.kind === "route" || signal.kind === "import");
  const wantsIngest = input.repositoryShape.files.some(file => file.language === "markdown" || file.language === "json");
  const wantsRepair = input.repositoryShape.hasTests || input.signals.some(signal => signal.kind === "diagnostic" || signal.kind === "test");
  const selected = [
    wantsDb ? CODE_INTENT.DATABASE : undefined,
    wantsTool ? CODE_INTENT.TOOL : undefined,
    wantsIngest ? CODE_INTENT.INGESTION : undefined,
    wantsUi ? CODE_INTENT.UI : undefined,
    wantsRepair ? CODE_INTENT.REPAIR : undefined
  ].flatMap(value => value ? [String(value)] : []);
  const intents: string[] = selected.length ? selected : [CODE_INTENT.DOMAIN];
  return intents.map((intent, index) => {
    const path = pathForIntent(intent, input.repositoryShape, index);
    const language = languageForPath(path);
    const support = supportForIntent(intent, input.signals, input.evidence);
    const risk = clamp01(0.42 + input.entailment.contradiction * 0.25 + (support < 0.25 ? 0.24 : 0) - input.entailment.support * 0.16);
    return {
      id: `code_edit_${input.hasher.digestHex(`${intent}:${path}:${index}:${input.entailment.proof.id}`).slice(0, 40)}`,
      kind: input.repositoryShape.files.some(file => samePathFamily(file.pathHint, path)) ? "modify" : "create",
      path,
      language,
      intent,
      preconditions: [CODE_CONSTRAINT.PROOF_SELECTED, CODE_CONSTRAINT.SOURCE_VERSIONS_PRESENT, CODE_CONSTRAINT.APPROVAL_BEFORE_MUTATION],
      postconditions: [CODE_CONSTRAINT.PATH_CONTAINED, CODE_CONSTRAINT.DIAGNOSTICS_PERSISTED, CODE_CONSTRAINT.REPAIR_DOES_NOT_SUPPRESS],
      evidenceIds: input.evidence.slice(0, 24).map(span => span.id),
      confidence: clamp01(0.32 + support * 0.4 + input.entailment.support * 0.2),
      risk
    };
  });
}

function blueprintFiles(input: { target: string; language: CodeLanguage; graph: CodeKnowledgeGraph; risk: number }): CodeBlueprintFile[] {
  const evidenceIds = evidenceIdsForGraph(input.graph).slice(0, 40);
  const files: CodeBlueprintFile[] = [
    {
      path: "program.graph.json",
      language: "json",
      role: "config",
      purpose: CODE_PURPOSE.PROGRAM_GRAPH,
      imports: [],
      exports: [],
      invariants: [CODE_CONSTRAINT.JSON_PARSEABLE, CODE_CONSTRAINT.NO_SECRET_MATERIAL, CODE_CONSTRAINT.EVIDENCE_IDS_EXPLICIT],
      evidenceIds
    },
    {
      path: "implementation.plan.json",
      language: "json",
      role: "config",
      purpose: CODE_PURPOSE.EDIT_PLAN,
      imports: [],
      exports: [],
      invariants: [CODE_CONSTRAINT.OPERATIONS_HAVE_PRECONDITIONS, CODE_CONSTRAINT.PATH_CONTAINED, CODE_CONSTRAINT.RISK_EXPLICIT],
      evidenceIds
    },
    {
      path: "src/program-inspector.ts",
      language: input.language,
      role: "source",
      purpose: CODE_PURPOSE.PROGRAM_INSPECTOR,
      imports: [],
      exports: ["loadProgramGraph", "validateProgramGraph", "planRepairs", "scoreDiagnostics"],
      invariants: [CODE_CONSTRAINT.STANDARD_LIBRARY_ONLY, CODE_CONSTRAINT.READ_ONLY, CODE_CONSTRAINT.APPROVAL_EXTERNAL],
      evidenceIds
    },
    {
      path: "repair.policy.json",
      language: "json",
      role: "config",
      purpose: CODE_PURPOSE.REPAIR_POLICY,
      imports: [],
      exports: [],
      invariants: [CODE_CONSTRAINT.DIAGNOSTIC_CLASSES_EXPLICIT, CODE_CONSTRAINT.REPAIR_REQUIRES_REVIEW],
      evidenceIds
    },
    {
      path: "README.md",
      language: "markdown",
      role: "doc",
      purpose: CODE_PURPOSE.AUDIT_NOTE,
      imports: [],
      exports: [],
      invariants: [CODE_CONSTRAINT.SOURCE_COUPLING_STATED, CODE_CONSTRAINT.UNBACKED_SYNTHESIS_RISK_STATED],
      evidenceIds
    }
  ];
  if (input.graph.repositoryShape.hasTests || input.risk > 0.45) {
    files.push({
      path: "diagnostics.expected.json",
      language: "json",
      role: "test",
      purpose: CODE_PURPOSE.DIAGNOSTICS,
      imports: [],
      exports: [],
      invariants: [CODE_CONSTRAINT.BUILD_NOT_PRECLAIMED, CODE_CONSTRAINT.EXPECTED_DIAGNOSTICS_NAMED],
      evidenceIds
    });
  }
  return files;
}

function blueprintOperations(input: { files: CodeBlueprintFile[]; graph: CodeKnowledgeGraph; target: string; risk: number; hasher: Hasher }): CodeEditOperation[] {
  const base = input.graph.editPriors.length ? input.graph.editPriors : input.files.map(file => ({
    id: "",
    kind: "create" as const,
    path: file.path,
    language: file.language,
    intent: file.purpose,
    preconditions: file.invariants.slice(0, 2),
    postconditions: file.invariants.slice(2),
    evidenceIds: file.evidenceIds,
    confidence: clamp01(0.45 + input.graph.confidence * 0.25),
    risk: input.risk
  }));
  return base.map((op, index) => ({
    ...op,
    id: op.id || `code_op_${input.hasher.digestHex(`${input.target}:${op.kind}:${op.path}:${index}`).slice(0, 40)}`,
    preconditions: op.preconditions.length ? op.preconditions : [CODE_CONSTRAINT.GRAPH_AVAILABLE],
    postconditions: op.postconditions.length ? op.postconditions : [CODE_CONSTRAINT.REVIEWABLE_BEFORE_COMMIT]
  }));
}

function runtimeForBlueprint(language: CodeLanguage, target: string): CodeImplementationBlueprint["runtime"] {
  const targetRuntime = target.startsWith("target:") ? target.slice("target:".length) : target;
  const base = {
    packageManager: "source-derived",
    entrypoint: "program.graph.json",
    build: { command: "source-derived", args: ["build", targetRuntime || language], cwd: "." },
    test: { command: "source-derived", args: ["validate", targetRuntime || language], cwd: "." }
  };
  return base;
}

function couplingFromGraph(graph: CodeKnowledgeGraph): number {
  const graphFeatures = graph.signals.flatMap(signal => signal.features.slice(0, 48));
  const evidenceFeatures = graph.signals.flatMap(signal => signal.features.slice(48, 96));
  return graphFeatures.length ? weightedJaccard(graphFeatures, evidenceFeatures.length ? evidenceFeatures : graphFeatures) : graph.confidence;
}

function languageWeights(signals: readonly CodeSignal[], evidence: readonly EvidenceSpan[]): CodeKnowledgeGraph["languages"] {
  const weights = new Map<CodeLanguage, { weight: number; evidenceIds: Set<EvidenceId> }>();
  for (const signal of signals) {
    const current = weights.get(signal.language) ?? { weight: 0, evidenceIds: new Set<EvidenceId>() };
    current.weight += signal.confidence * Math.max(0.2, signal.alpha);
    current.evidenceIds.add(signal.evidenceId);
    weights.set(signal.language, current);
  }
  if (weights.size === 0) {
    for (const span of evidence.slice(0, 20)) {
      const language = languageForEvidence(span, sourceFactsFromSpan(span), repositoryFactsFromSpan(span));
      const current = weights.get(language) ?? { weight: 0, evidenceIds: new Set<EvidenceId>() };
      current.weight += span.alpha || 0.1;
      current.evidenceIds.add(span.id);
      weights.set(language, current);
    }
  }
  const repositoryAggregate = weights.get("source.repository");
  if (repositoryAggregate && [...weights.keys()].some(language => language !== "source.repository")) {
    repositoryAggregate.weight *= 0.15;
    weights.set("source.repository", repositoryAggregate);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value.weight, 0) || 1;
  return [...weights.entries()]
    .map(([language, value]) => ({ language, weight: clamp01(value.weight / total), evidenceIds: [...value.evidenceIds] }))
    .sort((a, b) => b.weight - a.weight);
}

function languageForEvidence(span: EvidenceSpan, facts: SourceCodeFileFacts | undefined, repositoryFacts?: SourceRepositoryFacts): CodeLanguage {
  if (repositoryFacts) return "source.repository";
  const evidence = facts?.languageEvidence[0];
  if (evidence) return `${evidence.kind}:${evidence.value}`;
  const path = provenanceUri(span);
  const ext = path ? extensionOf(path) : "";
  if (ext) return `extension:${ext}`;
  return span.mediaType ? `media-type:${span.mediaType}` : "und";
}

function targetLanguage(target: string): CodeLanguage {
  const trimmed = target.trim();
  return trimmed ? `target:${trimmed.slice(0, 80)}` : "und";
}

function languageForPath(path: string): CodeLanguage {
  const ext = extensionOf(path);
  return ext ? `extension:${ext}` : "und";
}

function asLanguage(value: string): CodeLanguage {
  return value.trim() || "und";
}

function roleForPath(pathHint: string, signals: readonly CodeSignal[]): string {
  const lower = pathHint.toLowerCase();
  if (lower.includes("test") || lower.includes("spec")) return "test";
  if (sourceConfigPath(lower)) return "config";
  if (lower.includes("readme") || lower.includes("docs") || lower.endsWith(".md") || lower.endsWith(".txt")) return "doc";
  if (signals.some(signal => signal.kind === "route")) return "api";
  return "source";
}

function pathForIntent(intent: string, shape: CodeKnowledgeGraph["repositoryShape"], index: number): string {
  const existing = shape.files.find(file => intent === roleIntent(file.role) || (intent === CODE_INTENT.DATABASE && includesAny(file.pathHint.toLocaleLowerCase(), ["sql", "schema", "postgres", "migration"])));
  if (existing) return existing.pathHint;
  if (intent === CODE_INTENT.DATABASE) return "packages/adapters-node/src/postgres.ts";
  if (intent === CODE_INTENT.TOOL) return "packages/adapters-node/src/connectors.ts";
  if (intent === CODE_INTENT.INGESTION) return "packages/adapters-node/src/files.ts";
  if (intent === CODE_INTENT.UI) return "packages/ui/src/App.tsx";
  if (intent === CODE_INTENT.REPAIR) return "packages/kernel/src/program-repair-kernel.ts";
  return `src/domain-${index + 1}.ts`;
}

function supportForIntent(intent: string, signals: readonly CodeSignal[], evidence: readonly EvidenceSpan[]): number {
  const features = [`intent:${intent}`];
  const signalFeatures = signals.flatMap(signal => signal.features);
  const lexical = signalFeatures.length ? weightedJaccard(features, signalFeatures) : 0;
  return clamp01(0.25 * lexical + 0.45 * mean(signals.map(signal => signal.confidence)) + 0.3 * Math.min(1, evidence.length / 16));
}

function roleIntent(role: string): string {
  if (role === "api") return CODE_INTENT.TOOL;
  if (role === "config") return CODE_INTENT.DATABASE;
  if (role === "test") return CODE_INTENT.REPAIR;
  if (role === "doc") return CODE_INTENT.INGESTION;
  return CODE_INTENT.DOMAIN;
}

function samePathFamily(left: string, right: string): boolean {
  const l = normalizePath(left).toLowerCase();
  const r = normalizePath(right).toLowerCase();
  return l === r || l.endsWith(`/${r}`) || r.endsWith(`/${l.split("/").pop() ?? l}`);
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function purposeForPackage(pkg: string): string {
  const lower = pkg.toLocaleLowerCase();
  if (includesAny(lower, ["react", "vue", "svelte"])) return CODE_PURPOSE.DEP_UI;
  if (includesAny(lower, ["pg", "postgres", "sql"])) return CODE_PURPOSE.DEP_POSTGRES;
  if (includesAny(lower, ["zod", "joi", "yup"])) return CODE_PURPOSE.DEP_SCHEMA;
  if (includesAny(lower, ["express", "fastify", "hono", "koa"])) return CODE_PURPOSE.DEP_HTTP;
  if (includesAny(lower, ["playwright", "puppeteer"])) return CODE_PURPOSE.DEP_BROWSER;
  return CODE_PURPOSE.DEP_SOURCE_IMPORT;
}

function sourceConfigPath(pathHint: string): boolean {
  const lower = pathHint.toLocaleLowerCase();
  const file = basenameLike(lower);
  if (lower.includes("config")) return true;
  if (file.includes("lock")) return true;
  if (file.includes("workspace")) return true;
  return [".json", ".yaml", ".yml", ".toml", ".xml", ".ini"].some(ext => file.endsWith(ext));
}

function basenameLike(pathHint: string): string {
  const normalized = normalizePath(pathHint);
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function constraintsForIdiom(kind: string): string[] {
  if (kind === "import") return [CODE_CONSTRAINT.IMPORT_DECLARED];
  if (kind === "schema") return [CODE_CONSTRAINT.MIGRATION_BACKED];
  if (kind === "test") return [CODE_CONSTRAINT.TEST_BEHAVIOR];
  if (kind === "route") return [CODE_CONSTRAINT.ROUTE_CONTRACTS];
  return [CODE_CONSTRAINT.LOCAL_STYLE];
}

function evidenceIdsForGraph(graph: CodeKnowledgeGraph): EvidenceId[] {
  return [...new Set([
    ...graph.signals.map(signal => signal.evidenceId),
    ...graph.idioms.flatMap(idiom => idiom.evidenceIds),
    ...graph.dependencies.flatMap(dep => dep.importedBy),
    ...graph.editPriors.flatMap(op => op.evidenceIds)
  ])];
}

function boundedText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.floor(maxChars * 0.7))}\n...\n${text.slice(-Math.floor(maxChars * 0.3))}`;
}

function normalizeSignal(value: string): string {
  return collapseWhitespace(value).toLocaleLowerCase().slice(0, 240);
}

function sourceFactsFromSpan(span: EvidenceSpan): SourceCodeFileFacts | undefined {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
  const metadata = provenance.metadata && typeof provenance.metadata === "object" && !Array.isArray(provenance.metadata) ? provenance.metadata as Record<string, JsonValue> : {};
  return sourceCodeFileFactsFromJson(metadata.sourceCode);
}

function repositoryFactsFromSpan(span: EvidenceSpan): SourceRepositoryFacts | undefined {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
  const metadata = provenance.metadata && typeof provenance.metadata === "object" && !Array.isArray(provenance.metadata) ? provenance.metadata as Record<string, JsonValue> : {};
  return sourceRepositoryFactsFromJson(metadata.repositoryFacts);
}

function engineeringCorporaFromEvidence(evidence: readonly EvidenceSpan[], hasher: Hasher): EngineeringCorpusProjection[] {
  const byId = new Map<string, EngineeringCorpusProjection>();
  for (const span of evidence) {
    const corpus = engineeringCorpusFromSpan(span, hasher);
    if (corpus && !byId.has(corpus.id)) byId.set(corpus.id, corpus);
  }
  return [...byId.values()].sort((a, b) => b.summary.plannerReadiness - a.summary.plannerReadiness || a.rootUri.localeCompare(b.rootUri)).slice(0, 16);
}

function engineeringCorpusFromSpan(span: EvidenceSpan, hasher: Hasher): EngineeringCorpusProjection | undefined {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
  const metadata = provenance.metadata && typeof provenance.metadata === "object" && !Array.isArray(provenance.metadata) ? provenance.metadata as Record<string, JsonValue> : {};
  const developerSnapshot = repoSnapshotFromJson(metadata.developerIntelligence);
  if (developerSnapshot) return repoSnapshotToEngineeringContext(developerSnapshot);
  return engineeringCorpusProjectionFromMetadata(metadata, hasher, [span.id], String(span.sourceVersionId));
}

function repoSnapshotFromJson(value: JsonValue | undefined): RepoSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.developer-intelligence.snapshot.v1" || typeof record.id !== "string" || typeof record.rootUri !== "string") return undefined;
  return record as unknown as RepoSnapshot;
}

function filesFromRepositoryFacts(span: EvidenceSpan): CodeKnowledgeGraph["repositoryShape"]["files"] {
  const facts = repositoryFactsFromSpan(span);
  if (!facts) return [];
  return facts.files.slice(0, 2000).map(file => ({
    pathHint: file.normalizedPath,
    language: file.languageEvidence[0] ? `${file.languageEvidence[0].kind}:${file.languageEvidence[0].value}` : file.mediaType ? `media-type:${file.mediaType}` : "und",
    role: file.roleEvidence[0]?.roleId ?? "source.role.unresolved",
    evidenceIds: [span.id],
    confidence: clamp01(0.45 + span.alpha * 0.35 + (file.parserId ? 0.14 : 0.04))
  }));
}

function dedupeShapeFiles(files: CodeKnowledgeGraph["repositoryShape"]["files"]): CodeKnowledgeGraph["repositoryShape"]["files"] {
  const byPath = new Map<string, CodeKnowledgeGraph["repositoryShape"]["files"][number]>();
  for (const file of files) {
    const key = normalizePath(file.pathHint);
    const existing = byPath.get(key);
    if (!existing || file.confidence > existing.confidence) byPath.set(key, { ...file, pathHint: key || file.pathHint });
  }
  return [...byPath.values()].sort((a, b) => b.confidence - a.confidence || a.pathHint.localeCompare(b.pathHint)).slice(0, 2000);
}

function scriptSignalKind(name: string, command: string): CodeSignalKind {
  const lower = `${name} ${command}`.toLocaleLowerCase();
  if (includesAny(lower, ["test", "vitest", "jest", "mocha"])) return "script.validation";
  if (includesAny(lower, ["build", "compile", "tsc"])) return "script.build";
  if (includesAny(lower, ["lint", "eslint", "biome"])) return "script.lint";
  if (includesAny(lower, ["start", "serve", "dev"])) return "script.runtime";
  return "script";
}

function provenanceUri(span: EvidenceSpan): string | undefined {
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, JsonValue> : {};
  return typeof provenance.uri === "string" ? provenance.uri : undefined;
}

function sourceFeatures(parts: readonly string[], limit: number): string[] {
  const features = new Set<string>();
  for (const part of parts) {
    const codeSymbols = structuralCodeSymbols(part);
    for (const codeSymbol of codeSymbols) features.add(`sym:${codeSymbol}`);
    for (let i = 0; i < codeSymbols.length - 1; i++) features.add(`bi:${codeSymbols[i]}|${codeSymbols[i + 1]}`);
  }
  return [...features].sort().slice(0, limit);
}

function structuralCodeSymbols(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let kind = "";
  const flush = () => {
    if (current) out.push(`${kind}:${current.slice(0, 64)}`);
    current = "";
    kind = "";
  };
  for (const ch of text.normalize("NFC")) {
    const nextKind = codeCharKind(ch);
    if (nextKind === "space") {
      flush();
      continue;
    }
    if (kind && nextKind !== kind) flush();
    kind = nextKind;
    current += ch;
    if (current.length >= 64) flush();
    if (out.length >= 256) break;
  }
  flush();
  return out;
}

function codeCharKind(ch: string): string {
  if (ch.trim() === "") return "space";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 48 && cp <= 57) return "number";
  if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95 || cp === 36) return "identifier";
  if ("./\\:-_@".includes(ch)) return "path";
  if ("()[]{}<>".includes(ch)) return "delimiter";
  if ("'\"`".includes(ch)) return "quote";
  if ("+-*%=!&|^~?,;".includes(ch)) return "operator";
  return "unicode";
}

function collapseWhitespace(text: string): string {
  let out = "";
  let spacing = false;
  for (const ch of text.trim()) {
    if (ch.trim() === "") {
      if (!spacing) out += " ";
      spacing = true;
    } else {
      out += ch;
      spacing = false;
    }
  }
  return out;
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

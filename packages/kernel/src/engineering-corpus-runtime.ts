import { clamp01, mean, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";
import type { EngineeringCommandCandidate, EngineeringCorpusProjection } from "./engineering-corpus.js";

export interface EngineeringCorpusRuntimeView {
  id: string;
  rootUri: string;
  summary: EngineeringCorpusProjection["summary"];
  capabilities: Array<{ kind: string; support: number; confidence: number }>;
  plannerHints: EngineeringCorpusProjection["plannerHints"];
}

export interface EngineeringRuntimeCommandRank {
  command: EngineeringCommandCandidate;
  score: number;
  reasons: string[];
}

export interface EngineeringRuntimeEntrypointRank {
  path: string;
  language: string;
  score: number;
  corpusId: string;
  evidenceIds: string[];
  reasons: string[];
}

export interface EngineeringRuntimeLanguageRank {
  language: string;
  score: number;
  corpusIds: string[];
  reasons: string[];
}

export interface EngineeringRuntimeCapabilitySupport {
  kind: string;
  support: number;
  confidence: number;
  corpusIds: string[];
  evidence: string[];
}

export interface EngineeringRuntimeRequestProfile {
  requestSymbols: string[];
  requestedCapabilities: Array<{ kind: string; score: number; reason: string }>;
  commandPreferences: string[];
  pathSignals: string[];
  audit: JsonValue;
}

export interface EngineeringCorpusRuntime {
  corpora: EngineeringCorpusRuntimeView[];
  summary: {
    corpusCount: number;
    commandCount: number;
    entrypointCount: number;
    capabilityCount: number;
    plannerReadiness: number;
  };
  requestProfile(input: { requestText: string; capabilities?: readonly string[] }): EngineeringRuntimeRequestProfile;
  packageManagers(): string[];
  rankCommands(input: { requestText?: string; preferredKinds?: readonly string[]; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeCommandRank[];
  rankEntrypoints(input: { requestText?: string; language?: string; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeEntrypointRank[];
  rankLanguages(input: { requestText?: string; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeLanguageRank[];
  capabilitySupport(input: { capabilities?: readonly string[]; requestText?: string }): EngineeringRuntimeCapabilitySupport[];
  audit(): JsonValue;
}

export function createEngineeringCorpusRuntime(corpora: readonly EngineeringCorpusRuntimeView[]): EngineeringCorpusRuntime {
  const unique = dedupeCorpora(corpora);
  const summary = {
    corpusCount: unique.length,
    commandCount: unique.reduce((sum, corpus) => sum + allCommands(corpus).length, 0),
    entrypointCount: unique.reduce((sum, corpus) => sum + corpus.plannerHints.entrypoints.length, 0),
    capabilityCount: unique.reduce((sum, corpus) => sum + corpus.capabilities.length, 0),
    plannerReadiness: mean(unique.map(corpus => corpus.summary.plannerReadiness))
  };

  function requestProfile(input: { requestText: string; capabilities?: readonly string[] }): EngineeringRuntimeRequestProfile {
    const requestSymbols = sourceSymbols(input.requestText).slice(0, 128);
    const capabilitySignals = requestedCapabilities(requestSymbols, input.capabilities ?? []);
    const commandPreferences = commandPreferencesFrom(requestSymbols, capabilitySignals.map(item => item.kind));
    const pathSignals = pathSignalsFrom(input.requestText);
    return {
      requestSymbols,
      requestedCapabilities: capabilitySignals,
      commandPreferences,
      pathSignals,
      audit: toJsonValue({
        requestSymbolCount: requestSymbols.length,
        requestedCapabilities: capabilitySignals,
        commandPreferences,
        pathSignals
      })
    };
  }

  function packageManagers(): string[] {
    return [...new Set(unique.flatMap(corpus => corpus.plannerHints.packageManagers).map(packageManagerCommandName).filter(Boolean))]
      .sort((a, b) => packageManagerRank(a) - packageManagerRank(b) || a.localeCompare(b));
  }

  function rankCommands(input: { requestText?: string; preferredKinds?: readonly string[]; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeCommandRank[] {
    const profile = requestProfile({ requestText: input.requestText ?? "", capabilities: input.capabilities });
    const preferredKinds = input.preferredKinds?.length ? input.preferredKinds : profile.commandPreferences;
    const commands = unique.flatMap(corpus => allCommands(corpus).map(command => ({ command, corpus })));
    return commands
      .map(item => {
        const preferred = preferredKinds.length ? preferredScore(plannerScriptKind(item.command.kind), preferredKinds) : 0.25;
        const symbolScore = commandSymbolScore(item.command, profile.requestSymbols);
        const capabilityScore = commandCapabilityScore(item.command, input.capabilities ?? profile.requestedCapabilities.map(cap => cap.kind));
        const managerScore = item.command.managerEvidence.length ? 0.12 : 0;
        const score = clamp01(0.42 * preferred + 0.22 * item.command.confidence + 0.14 * symbolScore + 0.12 * capabilityScore + managerScore + 0.1 * item.corpus.summary.plannerReadiness);
        return {
          command: item.command,
          score,
          reasons: compactReasons([
            `kind=${item.command.kind}`,
            preferred > 0 ? `preferred=${preferred.toFixed(3)}` : "",
            symbolScore > 0 ? `requestSymbols=${symbolScore.toFixed(3)}` : "",
            capabilityScore > 0 ? `capability=${capabilityScore.toFixed(3)}` : "",
            managerScore > 0 ? "managerEvidence" : "",
            `confidence=${item.command.confidence.toFixed(3)}`
          ])
        };
      })
      .sort((a, b) => b.score - a.score || commandKindRank(plannerScriptKind(a.command.kind)) - commandKindRank(plannerScriptKind(b.command.kind)) || a.command.scriptName.localeCompare(b.command.scriptName))
      .slice(0, input.limit ?? 24);
  }

  function rankEntrypoints(input: { requestText?: string; language?: string; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeEntrypointRank[] {
    const profile = requestProfile({ requestText: input.requestText ?? "", capabilities: input.capabilities });
    const entries = unique.flatMap(corpus => corpus.plannerHints.entrypoints.map(entry => ({ corpus, entry })));
    return entries
      .map(({ corpus, entry }) => {
        const languageScore = input.language && entry.language === input.language ? 0.32 : input.language ? languageCompatibility(input.language, entry.language) * 0.18 : 0.12;
        const pathScore = pathSymbolScore(entry.path, profile.requestSymbols, profile.pathSignals);
        const capabilityScore = entrypointCapabilityScore(entry.path, input.capabilities ?? profile.requestedCapabilities.map(cap => cap.kind));
        const score = clamp01(0.34 * entry.score + languageScore + 0.16 * pathScore + 0.12 * capabilityScore + 0.14 * corpus.summary.plannerReadiness);
        return {
          path: entry.path,
          language: entry.language,
          score,
          corpusId: corpus.id,
          evidenceIds: entry.evidenceIds.map(String),
          reasons: compactReasons([
            `entrypoint=${entry.score.toFixed(3)}`,
            languageScore > 0 ? `language=${languageScore.toFixed(3)}` : "",
            pathScore > 0 ? `path=${pathScore.toFixed(3)}` : "",
            capabilityScore > 0 ? `capability=${capabilityScore.toFixed(3)}` : "",
            `corpus=${corpus.summary.plannerReadiness.toFixed(3)}`
          ])
        };
      })
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, input.limit ?? 24);
  }

  function rankLanguages(input: { requestText?: string; capabilities?: readonly string[]; limit?: number }): EngineeringRuntimeLanguageRank[] {
    const profile = requestProfile({ requestText: input.requestText ?? "", capabilities: input.capabilities });
    const groups = new Map<string, { scores: number[]; corpusIds: Set<string>; reasons: string[] }>();
    for (const corpus of unique) {
      for (const language of corpus.plannerHints.primaryLanguages) {
        const entrypoints = corpus.plannerHints.entrypoints.filter(entry => entry.language === language);
        const entryScore = mean(entrypoints.map(entry => entry.score));
        const capabilityScore = corpusCapabilityScore(corpus, input.capabilities ?? profile.requestedCapabilities.map(cap => cap.kind));
        const symbolScore = symbolOverlap(sourceSymbols(language), profile.requestSymbols);
        const score = clamp01(0.26 * corpus.summary.plannerReadiness + 0.24 * scorePresence(entrypoints.length) + 0.2 * entryScore + 0.18 * capabilityScore + 0.12 * symbolScore);
        const current = groups.get(language) ?? { scores: [], corpusIds: new Set<string>(), reasons: [] };
        current.scores.push(score);
        current.corpusIds.add(corpus.id);
        current.reasons.push(`corpus=${corpus.id}:score=${score.toFixed(3)}`);
        groups.set(language, current);
      }
    }
    return [...groups.entries()]
      .map(([language, value]) => ({
        language,
        score: clamp01(mean(value.scores)),
        corpusIds: [...value.corpusIds],
        reasons: value.reasons.slice(0, 8)
      }))
      .sort((a, b) => b.score - a.score || a.language.localeCompare(b.language))
      .slice(0, input.limit ?? 16);
  }

  function capabilitySupport(input: { capabilities?: readonly string[]; requestText?: string }): EngineeringRuntimeCapabilitySupport[] {
    const profile = requestProfile({ requestText: input.requestText ?? "", capabilities: input.capabilities });
    const requested = new Set([...(input.capabilities ?? []), ...profile.requestedCapabilities.map(capability => capability.kind)]);
    const groups = new Map<string, { support: number[]; confidence: number[]; corpusIds: Set<string>; evidence: Set<string> }>();
    for (const corpus of unique) {
      for (const capability of corpus.capabilities) {
        if (requested.size && !requested.has(capability.kind) && !looselyMatchesCapability(capability.kind, requested)) continue;
        const current = groups.get(capability.kind) ?? { support: [], confidence: [], corpusIds: new Set<string>(), evidence: new Set<string>() };
        current.support.push(capability.support);
        current.confidence.push(capability.confidence);
        current.corpusIds.add(corpus.id);
        current.evidence.add(corpus.rootUri);
        groups.set(capability.kind, current);
      }
    }
    return [...groups.entries()]
      .map(([kind, value]) => ({
        kind,
        support: clamp01(mean(value.support)),
        confidence: clamp01(mean(value.confidence)),
        corpusIds: [...value.corpusIds],
        evidence: [...value.evidence].slice(0, 16)
      }))
      .sort((a, b) => b.support - a.support || b.confidence - a.confidence || a.kind.localeCompare(b.kind));
  }

  function audit(): JsonValue {
    return toJsonValue({
      summary,
      corpora: unique.map(corpus => ({
        id: corpus.id,
        rootUri: corpus.rootUri,
        summary: corpus.summary,
        commandCount: allCommands(corpus).length,
        entrypointCount: corpus.plannerHints.entrypoints.length,
        capabilityCount: corpus.capabilities.length
      }))
    });
  }

  return { corpora: unique, summary, requestProfile, packageManagers, rankCommands, rankEntrypoints, rankLanguages, capabilitySupport, audit };
}

export function plannerScriptKind(kind: string): string {
  if (kind === "eng.command.build") return "script.build";
  if (kind === "eng.command.validation") return "script.validation";
  if (kind === "eng.command.runtime") return "script.runtime";
  if (kind === "eng.command.lint") return "script.lint";
  return kind.startsWith("script") ? kind : "script";
}

export function packageManagerCommandName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLocaleLowerCase();
  const colon = lower.indexOf(":");
  const head = colon > 0 ? lower.slice(0, colon) : lower;
  if (head === "manifest") return "source-script";
  return safeCommandSymbol(head) || "source-script";
}

function requestedCapabilities(symbols: readonly string[], explicit: readonly string[]): Array<{ kind: string; score: number; reason: string }> {
  const out = new Map<string, { kind: string; score: number; reason: string }>();
  for (const capability of explicit) out.set(capability, { kind: capability, score: 1, reason: "explicit" });
  const joined = symbols.join(" ");
  const add = (kind: string, score: number, reason: string) => {
    const existing = out.get(kind);
    if (!existing || score > existing.score) out.set(kind, { kind, score, reason });
  };
  if (wordLike(joined, "interactive") || wordLike(joined, "ui") || wordLike(joined, "browser") || wordLike(joined, "website")) add("eng.capability.presentation_surface", 0.84, "request.surface");
  if (wordLike(joined, "api") || wordLike(joined, "server") || wordLike(joined, "route") || wordLike(joined, "endpoint")) add("eng.capability.interface_surface", 0.78, "request.interface");
  if (wordLike(joined, "test") || wordLike(joined, "verify") || wordLike(joined, "validate")) add("eng.capability.validation", 0.82, "request.validation");
  if (wordLike(joined, "module") || wordLike(joined, "library") || wordLike(joined, "function")) add("eng.capability.module_authoring", 0.72, "request.module");
  if (wordLike(joined, "dependency") || wordLike(joined, "package") || wordLike(joined, "import")) add("eng.capability.dependency_binding", 0.72, "request.dependency");
  if (wordLike(joined, "command") || wordLike(joined, "cli") || wordLike(joined, "run")) add("eng.capability.command_execution", 0.74, "request.command");
  return [...out.values()].sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
}

function commandPreferencesFrom(symbols: readonly string[], capabilities: readonly string[]): string[] {
  const joined = symbols.join(" ");
  const out: string[] = [];
  if (wordLike(joined, "build") || wordLike(joined, "compile")) out.push("script.build");
  if (wordLike(joined, "test") || wordLike(joined, "verify") || wordLike(joined, "validate") || capabilities.includes("eng.capability.validation")) out.push("script.validation");
  if (wordLike(joined, "run") || wordLike(joined, "serve") || wordLike(joined, "start") || wordLike(joined, "interactive")) out.push("script.runtime");
  if (wordLike(joined, "lint") || wordLike(joined, "format")) out.push("script.lint");
  if (!out.includes("script.build")) out.push("script.build");
  if (!out.includes("script.validation")) out.push("script.validation");
  return [...new Set(out)];
}

function pathSignalsFrom(text: string): string[] {
  const out = new Set<string>();
  let current = "";
  const flush = () => {
    if (current.includes("/") || current.includes(".") || current.includes("\\")) out.add(current);
    current = "";
  };
  for (const ch of text.normalize("NFKC")) {
    if (ch.trim() === "") {
      flush();
      continue;
    }
    if (isPathChar(ch)) current += ch;
    else flush();
  }
  flush();
  return [...out].slice(0, 32);
}

function allCommands(corpus: EngineeringCorpusRuntimeView): EngineeringCommandCandidate[] {
  return uniqueCommands([
    ...corpus.plannerHints.buildCommands,
    ...corpus.plannerHints.validationCommands,
    ...corpus.plannerHints.runtimeCommands,
    ...corpus.plannerHints.lintCommands
  ]);
}

function uniqueCommands(commands: readonly EngineeringCommandCandidate[]): EngineeringCommandCandidate[] {
  const byKey = new Map<string, EngineeringCommandCandidate>();
  for (const command of commands) {
    const key = `${command.kind}\u001f${command.scriptName}\u001f${command.command}\u001f${command.manifestPath}`;
    const existing = byKey.get(key);
    if (!existing || command.confidence > existing.confidence) byKey.set(key, command);
  }
  return [...byKey.values()];
}

function dedupeCorpora(corpora: readonly EngineeringCorpusRuntimeView[]): EngineeringCorpusRuntimeView[] {
  const byId = new Map<string, EngineeringCorpusRuntimeView>();
  for (const corpus of corpora) if (!byId.has(corpus.id)) byId.set(corpus.id, corpus);
  return [...byId.values()].sort((a, b) => b.summary.plannerReadiness - a.summary.plannerReadiness || a.rootUri.localeCompare(b.rootUri));
}

function preferredScore(kind: string, preferredKinds: readonly string[]): number {
  const index = preferredKinds.indexOf(kind);
  return index < 0 ? 0 : clamp01(1 - index / Math.max(1, preferredKinds.length));
}

function commandSymbolScore(command: EngineeringCommandCandidate, symbols: readonly string[]): number {
  const commandSymbols = sourceSymbols([command.kind, command.scriptName, command.command, command.packageName ?? ""].join(" "));
  return symbolOverlap(commandSymbols, symbols);
}

function commandCapabilityScore(command: EngineeringCommandCandidate, capabilities: readonly string[]): number {
  const kind = plannerScriptKind(command.kind);
  let score = 0;
  if (kind === "script.validation" && capabilities.some(capability => capability.includes("validation"))) score += 1;
  if (kind === "script.build" && capabilities.some(capability => capability.includes("module") || capability.includes("presentation") || capability.includes("interface"))) score += 0.72;
  if (kind === "script.runtime" && capabilities.some(capability => capability.includes("presentation") || capability.includes("interface") || capability.includes("command"))) score += 0.82;
  if (kind === "script.lint" && capabilities.some(capability => capability.includes("validation"))) score += 0.42;
  return clamp01(score);
}

function entrypointCapabilityScore(path: string, capabilities: readonly string[]): number {
  const symbols = sourceSymbols(path);
  let score = 0;
  if (capabilities.some(capability => capability.includes("presentation")) && symbols.some(symbol => symbol === "app" || symbol === "main" || symbol === "index")) score += 0.72;
  if (capabilities.some(capability => capability.includes("interface")) && symbols.some(symbol => symbol === "server" || symbol === "route" || symbol === "api")) score += 0.68;
  if (capabilities.some(capability => capability.includes("module")) && symbols.some(symbol => symbol === "index" || symbol === "mod" || symbol === "lib")) score += 0.58;
  if (capabilities.some(capability => capability.includes("command")) && symbols.some(symbol => symbol === "cli" || symbol === "command" || symbol === "main")) score += 0.64;
  return clamp01(score);
}

function corpusCapabilityScore(corpus: EngineeringCorpusRuntimeView, capabilities: readonly string[]): number {
  if (!capabilities.length) return mean(corpus.capabilities.map(capability => capability.support));
  const scores: number[] = [];
  for (const wanted of capabilities) {
    const direct = corpus.capabilities.find(capability => capability.kind === wanted);
    if (direct) scores.push(direct.support * direct.confidence);
    else {
      const loose = corpus.capabilities.filter(capability => capability.kind.includes(wanted) || wanted.includes(capability.kind));
      if (loose.length) scores.push(mean(loose.map(capability => capability.support * 0.6)));
    }
  }
  return clamp01(mean(scores));
}

function pathSymbolScore(path: string, requestSymbols: readonly string[], pathSignals: readonly string[]): number {
  const pathSymbols = sourceSymbols(path);
  const symbolScore = symbolOverlap(pathSymbols, requestSymbols);
  const signalScore = pathSignals.some(signal => normalizePathLike(signal) === normalizePathLike(path) || normalizePathLike(path).endsWith(normalizePathLike(signal))) ? 1 : 0;
  return clamp01(0.7 * symbolScore + 0.3 * signalScore);
}

function languageCompatibility(left: string, right: string): number {
  if (left === right) return 1;
  const leftSymbols = sourceSymbols(left);
  const rightSymbols = sourceSymbols(right);
  return symbolOverlap(leftSymbols, rightSymbols);
}

function looselyMatchesCapability(kind: string, requested: Set<string>): boolean {
  for (const value of requested) {
    if (kind.includes(value) || value.includes(kind)) return true;
    const kindTail = tailSymbol(kind);
    const valueTail = tailSymbol(value);
    if (kindTail && kindTail === valueTail) return true;
  }
  return false;
}

function sourceSymbols(text: string): string[] {
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current) out.push(current.toLocaleLowerCase());
    current = "";
  };
  for (const ch of text.normalize("NFKC")) {
    if (identifierLike(ch)) current += ch;
    else flush();
    if (out.length >= 512) break;
  }
  flush();
  return [...new Set(out)].slice(0, 512);
}

function symbolOverlap(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let hits = 0;
  for (const item of left) if (rightSet.has(item)) hits++;
  return clamp01(hits / Math.sqrt(left.length * right.length));
}

function packageManagerRank(value: string): number {
  if (value === "source-script") return 9;
  if (value === "source-derived" || value === "source.unresolved") return 10;
  return 1;
}

function commandKindRank(kind: string): number {
  if (kind === "script.build") return 1;
  if (kind === "script.validation") return 2;
  if (kind === "script.runtime") return 3;
  if (kind === "script.lint") return 4;
  return 10;
}

function normalizePathLike(path: string): string {
  return path.split("\\").join("/").toLocaleLowerCase();
}

function tailSymbol(value: string): string {
  const dot = value.lastIndexOf(".");
  const colon = value.lastIndexOf(":");
  const slash = value.lastIndexOf("/");
  const index = Math.max(dot, colon, slash);
  return index >= 0 ? value.slice(index + 1) : value;
}

function compactReasons(reasons: readonly string[]): string[] {
  return reasons.filter(Boolean).slice(0, 12);
}

function scorePresence(value: number): number {
  return value <= 0 ? 0 : value >= 8 ? 1 : Math.log2(value + 1) / 3;
}

function safeCommandSymbol(value: string): string {
  const out: string[] = [];
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= 48 && cp <= 57 || cp >= 97 && cp <= 122) out.push(char);
    else if ((char === "-" || char === "_" || char === ".") && out.length) out.push(char);
  }
  return out.join("");
}

function isPathChar(char: string): boolean {
  if (identifierLike(char)) return true;
  return char === "." || char === "/" || char === "\\" || char === "-" || char === "_";
}

function identifierLike(char: string): boolean {
  if (!char) return false;
  const cp = char.codePointAt(0) ?? 0;
  return cp === 95 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function wordLike(text: string, word: string): boolean {
  let index = text.indexOf(word);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1] ?? "";
    const after = text[index + word.length] ?? "";
    if (!identifierLike(before) && !identifierLike(after)) return true;
    index = text.indexOf(word, index + 1);
  }
  return false;
}

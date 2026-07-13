import type {
  ArtifactEmissionRecord,
  FileArtifact,
  JsonValue,
  ProgramDependencyRecord,
  ProgramFileRecord,
  ProgramGraph,
  ProgramGraphRecord,
  ProgramHydrationContract,
  ProgramSymbolRecord,
  ProgramValidationRecord
} from "./types.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";

export interface ProgramHydrationInput {
  program: Omit<ProgramGraph, "hydration">;
  sourcePlanId: string;
  evidenceIds?: readonly string[];
  risks?: readonly string[];
}

export function createProgramHydrationContract(input: ProgramHydrationInput): ProgramHydrationContract {
  const evidenceIds = [...new Set(input.evidenceIds ?? evidenceIdsFromNodes(input.program.nodes))];
  const packageDeps = packageDependencies(input.program.files);
  const fileRecords = input.program.files.map(file => fileRecord(input.program, file, evidenceIds));
  const symbolRecords = fileRecords.flatMap(file => file.symbols.map(symbol => symbolRecord(input.program.id, file.path, symbol, file.exports.includes(symbol), evidenceIds)));
  const dependencies = dependencyRecords(input.program.id, fileRecords, packageDeps, evidenceIds);
  const missing = dependencies.filter(dep => dep.missing).map(dep => dep.packageName);
  const validations = validationRecords(input.program, evidenceIds, input.risks ?? [], missing);
  const emissions = input.program.files.map(file => emissionRecord(input.program.id, file, input.sourcePlanId, evidenceIds));
  const diagnostics = diagnosticsFor(input.program, fileRecords, dependencies, validations, emissions, evidenceIds);
  return {
    schema: "scce.program.hydration.v1",
    program: programRecord(input.program, evidenceIds),
    files: fileRecords,
    symbols: symbolRecords,
    dependencies,
    validations,
    emissions,
    diagnostics,
    valid: diagnostics.length === 0
  };
}

export function validateProgramHydrationContract(contract: ProgramHydrationContract): { valid: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (contract.schema !== "scce.program.hydration.v1") diagnostics.push("program.hydration.schema");
  if (!contract.program.programId) diagnostics.push("program.hydration.program_id");
  if (!contract.program.entrypointPath) diagnostics.push("program.hydration.entrypoint_path");
  if (!contract.program.provenanceEvidenceIds.length) diagnostics.push("program.hydration.program_provenance");
  if (!contract.files.length) diagnostics.push("program.hydration.files");
  if (!contract.files.some(file => file.entrypoint)) diagnostics.push("program.hydration.entrypoint_file");
  if (new Set(contract.files.map(file => file.path)).size !== contract.files.length) diagnostics.push("program.hydration.duplicate_file_path");
  for (const file of contract.files) {
    if (!file.contentHash) diagnostics.push(`program.hydration.file_hash:${file.path}`);
    if (!file.mediaType) diagnostics.push(`program.hydration.file_media:${file.path}`);
    if (!file.provenanceEvidenceIds.length) diagnostics.push(`program.hydration.file_provenance:${file.path}`);
  }
  if (!contract.validations.length) diagnostics.push("program.hydration.validations");
  for (const validation of contract.validations) {
    if (!validCommand(validation.command)) diagnostics.push(`program.hydration.validation_command:${validation.validationId}`);
    if (!validation.evidenceIds.length) diagnostics.push(`program.hydration.validation_provenance:${validation.validationId}`);
    if (!validation.commandSource) diagnostics.push(`program.hydration.validation_command_source:${validation.validationId}`);
  }
  if (!contract.emissions.length) diagnostics.push("program.hydration.emissions");
  if (contract.emissions.length !== contract.files.length) diagnostics.push("program.hydration.emission_file_count");
  for (const emission of contract.emissions) {
    if (!emission.filePath || !emission.contentHash) diagnostics.push(`program.hydration.emission_record:${emission.artifactId}`);
    if (!emission.provenanceEvidenceIds.length) diagnostics.push(`program.hydration.emission_provenance:${emission.artifactId}`);
  }
  if (!contract.valid && !contract.diagnostics.length) diagnostics.push("program.hydration.invalid_without_diagnostics");
  return { valid: diagnostics.length === 0 && contract.valid, diagnostics: [...contract.diagnostics, ...diagnostics] };
}

/** Reconstructs the hydration records from the ProgramGraph's actual bytes and
 * compares the complete identity, rather than trusting its attached records. */
export function validateProgramGraphHydration(program: ProgramGraph): { valid: boolean; diagnostics: string[] } {
  const hydration = program.hydration;
  if (!hydration) return { valid: false, diagnostics: ["program.hydration.missing"] };
  const diagnostics = [...validateProgramHydrationContract(hydration).diagnostics];
  const sourcePlanIds = [...new Set(hydration.emissions.map(emission => emission.sourcePlanId))];
  if (sourcePlanIds.length !== 1) diagnostics.push("program.hydration.source_plan_identity");
  const hydrationNodeIds = new Set(program.nodes.filter(node => node.kind === "program_hydration_contract").map(node => node.id));
  const baseProgram: Omit<ProgramGraph, "hydration"> = {
    id: program.id,
    language: program.language,
    packageManager: program.packageManager,
    entrypoint: program.entrypoint,
    nodes: program.nodes.filter(node => !hydrationNodeIds.has(node.id)),
    edges: program.edges.filter(edge => edge.relation !== "hydrates_as"
      && !hydrationNodeIds.has(edge.source)
      && !hydrationNodeIds.has(edge.target)),
    files: program.files,
    build: program.build,
    test: program.test
  };
  if (sourcePlanIds.length === 1) {
    const risks = [...new Set(hydration.validations.flatMap(validation => validation.riskIds))];
    const reconstructed = createProgramHydrationContract({
      program: baseProgram,
      sourcePlanId: sourcePlanIds[0]!,
      evidenceIds: hydration.program.provenanceEvidenceIds,
      risks
    });
    if (canonicalStringify(reconstructed) !== canonicalStringify(hydration)) {
      diagnostics.push("program.hydration.graph_identity_mismatch");
    }
  }
  return { valid: diagnostics.length === 0, diagnostics: [...new Set(diagnostics)] };
}

function programRecord(program: Omit<ProgramGraph, "hydration">, evidenceIds: readonly string[]): ProgramGraphRecord {
  return {
    programId: program.id,
    languageId: program.language,
    packageManagerId: program.packageManager,
    entrypointPath: program.entrypoint,
    buildCommand: program.build,
    testCommand: program.test,
    nodeCount: program.nodes.length,
    edgeCount: program.edges.length,
    fileCount: program.files.length,
    provenanceEvidenceIds: [...evidenceIds]
  };
}

function fileRecord(program: Omit<ProgramGraph, "hydration">, file: FileArtifact, evidenceIds: readonly string[]): ProgramFileRecord {
  const imports = importsFromSource(file.content);
  const exports = exportsFromSource(file.content);
  const symbols = symbolsFromSource(file.content);
  return {
    programId: program.id,
    artifactId: file.artifactId,
    path: file.path,
    role: file.role,
    mediaType: file.mediaType,
    contentHash: file.contentHash,
    byteLength: utf8Length(file.content),
    imports,
    exports,
    symbols,
    entrypoint: normalizePath(program.entrypoint) === normalizePath(file.path),
    provenanceEvidenceIds: [...evidenceIds]
  };
}

function symbolRecord(programId: string, filePath: string, symbol: string, exported: boolean, evidenceIds: readonly string[]): ProgramSymbolRecord {
  return {
    programId,
    symbolId: `program.symbol.${hashText(`${filePath}:${symbol}`)}`,
    filePath,
    symbolKind: symbolKind(symbol),
    exportKind: exported ? "program.symbol.exported" : "program.symbol.local",
    provenanceEvidenceIds: [...evidenceIds]
  };
}

function dependencyRecords(programId: string, files: readonly ProgramFileRecord[], packageDeps: ReadonlySet<string>, evidenceIds: readonly string[]): ProgramDependencyRecord[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    for (const imported of file.imports) {
      const packageName = packageNameFromImport(imported);
      if (!packageName || packageName.startsWith(".") || packageName.startsWith("/") || packageName.startsWith("node:")) continue;
      groups.set(packageName, [...(groups.get(packageName) ?? []), file.path]);
    }
  }
  return [...groups.entries()]
    .map(([packageName, importedBy]) => ({
      programId,
      packageName,
      dependencyKind: packageDeps.has(packageName) ? "program.dependency.declared" : "program.dependency.missing",
      importedBy: [...new Set(importedBy)],
      evidenceIds: [...evidenceIds],
      missing: !packageDeps.has(packageName),
      risk: packageDeps.has(packageName) ? 0.08 : 0.62
    }))
    .sort((a, b) => Number(b.missing) - Number(a.missing) || a.packageName.localeCompare(b.packageName));
}

function validationRecords(program: Omit<ProgramGraph, "hydration">, evidenceIds: readonly string[], risks: readonly string[], missingDependencies: readonly string[]): ProgramValidationRecord[] {
  const expectedFiles = program.files.map(file => file.path);
  const staticChecks = [
    "program.validation.path_contained",
    "program.validation.entrypoint_present",
    "program.validation.imports_declared",
    "program.validation.hydration_contract"
  ];
  return [
    {
      programId: program.id,
      validationId: `${program.id}:build`,
      command: program.build,
      commandSource: commandSource(program.build),
      expectedFiles,
      staticChecks,
      riskIds: [...risks],
      missingDependencies: [...missingDependencies],
      evidenceIds: [...evidenceIds]
    },
    {
      programId: program.id,
      validationId: `${program.id}:test`,
      command: program.test,
      commandSource: commandSource(program.test),
      expectedFiles,
      staticChecks: [...staticChecks, "program.validation.test_file_present"],
      riskIds: [...risks],
      missingDependencies: [...missingDependencies],
      evidenceIds: [...evidenceIds]
    }
  ];
}

function emissionRecord(programId: string, file: FileArtifact, sourcePlanId: string, evidenceIds: readonly string[]): ArtifactEmissionRecord {
  return {
    programId,
    artifactId: file.artifactId,
    filePath: file.path,
    emissionKind: `program.emission.${file.role}`,
    contentHash: file.contentHash,
    sourcePlanId,
    provenanceEvidenceIds: [...evidenceIds]
  };
}

function diagnosticsFor(
  program: Omit<ProgramGraph, "hydration">,
  files: readonly ProgramFileRecord[],
  dependencies: readonly ProgramDependencyRecord[],
  validations: readonly ProgramValidationRecord[],
  emissions: readonly ArtifactEmissionRecord[],
  evidenceIds: readonly string[]
): string[] {
  const diagnostics: string[] = [];
  if (!program.entrypoint) diagnostics.push("program.validation.entrypoint_path_missing");
  if (!files.length) diagnostics.push("program.validation.files_missing");
  if (!files.some(file => file.entrypoint)) diagnostics.push("program.validation.entrypoint_missing");
  if (!evidenceIds.length) diagnostics.push("program.validation.provenance_missing");
  for (const dep of dependencies) if (dep.missing) diagnostics.push(`program.validation.dependency_missing:${dep.packageName}`);
  if (!validCommand(program.build)) diagnostics.push("program.validation.build_command_missing");
  if (!validCommand(program.test)) diagnostics.push("program.validation.test_command_missing");
  if (!validations.length) diagnostics.push("program.validation.plan_missing");
  if (!emissions.length) diagnostics.push("program.validation.emissions_missing");
  if (emissions.length !== files.length) diagnostics.push("program.validation.emission_file_count");
  for (const file of files) if (!safePath(file.path)) diagnostics.push(`program.validation.path_unsafe:${file.path}`);
  return diagnostics;
}

function commandSource(command: { command: string }): string {
  return command.command === "source-derived" ? "program.validation.command.source_derived" : "program.validation.command.observed";
}

function importsFromSource(source: string): string[] {
  const imports = new Set<string>();
  for (const line of splitLines(source)) {
    const trimmed = line.trimStart();
    if (startsWithWord(trimmed, "import")) {
      const fromIndex = wordIndex(trimmed, "from");
      const quoted = fromIndex >= 0 ? firstQuoted(trimmed.slice(fromIndex + 4)) : firstQuoted(trimmed.slice(6));
      if (quoted) imports.add(quoted);
      continue;
    }
    if (startsWithWord(trimmed, "export")) {
      const fromIndex = wordIndex(trimmed, "from");
      const quoted = fromIndex >= 0 ? firstQuoted(trimmed.slice(fromIndex + 4)) : undefined;
      if (quoted) imports.add(quoted);
    }
    const dynamicIndex = trimmed.indexOf("import(");
    if (dynamicIndex >= 0) {
      const quoted = firstQuoted(trimmed.slice(dynamicIndex + 7));
      if (quoted) imports.add(quoted);
    }
  }
  return [...imports].sort();
}

function exportsFromSource(source: string): string[] {
  const exports = new Set<string>();
  for (const line of splitLines(source)) {
    const trimmed = line.trimStart();
    if (!startsWithWord(trimmed, "export")) continue;
    const after = trimmed.slice(6).trimStart();
    const declaration = readDeclarationName(after);
    if (declaration) exports.add(declaration);
    if (after.startsWith("{")) for (const name of namesInBraceList(after)) exports.add(name);
  }
  return [...exports].sort();
}

function symbolsFromSource(source: string): string[] {
  const symbols = new Set<string>();
  for (const line of splitLines(source)) {
    const declaration = readDeclarationName(line.trimStart());
    if (declaration) symbols.add(declaration);
  }
  return [...symbols].sort();
}

function readDeclarationName(text: string): string | undefined {
  let cursor = 0;
  if (startsWithWord(text, "async")) cursor = skipSpaces(text, 5);
  for (const word of ["function", "class", "interface", "type", "const", "let", "var"]) {
    if (!startsWithWord(text.slice(cursor), word)) continue;
    const start = skipSpaces(text, cursor + word.length);
    return readIdentifier(text, start)?.value;
  }
  return undefined;
}

function packageDependencies(files: readonly FileArtifact[]): Set<string> {
  const out = new Set<string>();
  const pkg = files.find(file => normalizePath(file.path) === "package.json");
  if (!pkg) return out;
  const parsed = parseJsonObject(pkg.content);
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const record = jsonRecord(parsed?.[key]);
    for (const name of Object.keys(record)) out.add(name);
  }
  return out;
}

function packageNameFromImport(value: string): string {
  const clean = value.trim();
  if (clean.startsWith("@")) {
    const pieces = clean.split("/");
    return pieces.length >= 2 ? `${pieces[0]}/${pieces[1]}` : clean;
  }
  return clean.split("/")[0] ?? clean;
}

function namesInBraceList(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.indexOf("}", start + 1);
  if (start < 0 || end < 0) return [];
  return text.slice(start + 1, end)
    .split(",")
    .map(part => readIdentifier(part.trimStart())?.value)
    .filter((item): item is string => Boolean(item));
}

function firstQuoted(text: string): string | undefined {
  for (let index = 0; index < text.length; index++) {
    const ch = text[index] ?? "";
    if (ch !== "\"" && ch !== "'") continue;
    let value = "";
    for (let cursor = index + 1; cursor < text.length; cursor++) {
      const current = text[cursor] ?? "";
      if (current === ch) return value;
      if (current === "\\" && cursor + 1 < text.length) {
        value += text[cursor + 1];
        cursor++;
      } else {
        value += current;
      }
    }
  }
  return undefined;
}

function startsWithWord(text: string, word: string): boolean {
  if (!text.startsWith(word)) return false;
  const after = text[word.length] ?? "";
  return !isIdentifierLike(after);
}

function wordIndex(text: string, word: string): number {
  let index = text.indexOf(word);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1] ?? "";
    const after = text[index + word.length] ?? "";
    if (!isIdentifierLike(before) && !isIdentifierLike(after)) return index;
    index = text.indexOf(word, index + word.length);
  }
  return -1;
}

function readIdentifier(text: string, start = 0): { value: string; end: number } | undefined {
  const first = text[start] ?? "";
  if (!isIdentifierStart(first)) return undefined;
  let end = start + 1;
  while (end < text.length && isIdentifierLike(text[end] ?? "")) end++;
  return { value: text.slice(start, end), end };
}

function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    out.push(text.slice(start, end));
    start = index + 1;
  }
  out.push(text.slice(start));
  return out;
}

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (index < text.length && (text[index] ?? "").trim() === "") index++;
  return index;
}

function isIdentifierStart(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function isIdentifierLike(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return isIdentifierStart(char) || cp >= 48 && cp <= 57;
}

function symbolKind(symbol: string): string {
  if (symbol.length > 0 && symbol[0] === symbol[0]?.toLocaleUpperCase()) return "program.symbol.type";
  return "program.symbol.value";
}

function parseJsonObject(text: string): Record<string, JsonValue> | undefined {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    return jsonRecord(parsed);
  } catch {
    return undefined;
  }
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function evidenceIdsFromNodes(nodes: readonly { metadata: JsonValue }[]): string[] {
  const out = new Set<string>();
  for (const node of nodes) {
    const metadata = jsonRecord(node.metadata);
    const evidence = metadata.evidenceIds;
    if (Array.isArray(evidence)) for (const item of evidence) if (typeof item === "string") out.add(item);
  }
  return [...out];
}

function validCommand(command: { command: string; args: string[] }): boolean {
  return Boolean(command.command && command.args.length);
}

function safePath(value: string): boolean {
  const normalized = normalizePath(value);
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.includes("../") && normalized.indexOf(":") < 0;
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function hydrationSummary(contract: ProgramHydrationContract): JsonValue {
  return toJsonValue({
    schema: contract.schema,
    programId: contract.program.programId,
    fileCount: contract.files.length,
    symbolCount: contract.symbols.length,
    dependencyCount: contract.dependencies.length,
    validationCount: contract.validations.length,
    emissionCount: contract.emissions.length,
    valid: contract.valid,
    diagnosticCount: contract.diagnostics.length,
    risk: clamp01(contract.diagnostics.length / Math.max(1, contract.files.length + contract.dependencies.length))
  });
}

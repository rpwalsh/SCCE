import ts from "typescript";
import {
  basename,
  clamp01,
  createSourceCodeFileFacts,
  extensionOf,
  normalizePath,
  sourceSpan,
  type Hasher,
  type SourceCodeCall,
  type SourceCodeDeclaration,
  type SourceCodeExport,
  type SourceCodeFileFacts,
  type SourceCodeImport,
  type SourceCodePattern,
  type SourceCodeRoute,
  type SourceCodeTest,
  type SourcePackageFacts
} from "@scce/kernel";

export interface NodeSourceCodeFactsInput {
  absolutePath: string;
  uri: string;
  mediaType: string;
  text: string;
  sha256: string;
  hasher: Hasher;
}

export function extractNodeSourceCodeFacts(input: NodeSourceCodeFactsInput): SourceCodeFileFacts | undefined {
  const normalized = normalizePath(input.uri);
  if (isIgnoredSourcePath(normalized)) return undefined;
  const parser = parserFor(normalized, input.mediaType);
  const packageFacts = parseManifestFacts(normalized, input.text);
  if (parser.id === "typescript-compiler-api") {
    return factsFromTypeScript({ ...input, normalized, packageFacts });
  }
  if (!packageFacts && !isProbablySourceLike(normalized, input.mediaType, input.text)) return undefined;
  return factsFromStructuralSource({ ...input, normalized, packageFacts, parser });
}

function factsFromTypeScript(input: NodeSourceCodeFactsInput & { normalized: string; packageFacts?: SourcePackageFacts }): SourceCodeFileFacts {
  const sourceFile = ts.createSourceFile(input.normalized, input.text, ts.ScriptTarget.Latest, true, scriptKindFor(input.normalized));
  const declarations: SourceCodeDeclaration[] = [];
  const imports: SourceCodeImport[] = [];
  const exports: SourceCodeExport[] = [];
  const calls: SourceCodeCall[] = [];
  const routes: SourceCodeRoute[] = [];
  const tests: SourceCodeTest[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) imports.push(importFromNode(input, sourceFile, node));
    else if (ts.isExportDeclaration(node)) exports.push(exportFromNode(input, sourceFile, node));
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      const declaration = declarationFromNode(input, sourceFile, node);
      if (declaration) declarations.push(declaration);
    } else if (ts.isVariableStatement(node)) {
      declarations.push(...variableDeclarationsFromStatement(input, sourceFile, node));
    } else if (ts.isCallExpression(node)) {
      const call = callFromNode(input, sourceFile, node);
      calls.push(call);
      const route = routeFromCall(input, sourceFile, node, call);
      if (route) routes.push(route);
      const test = testFromCall(input, sourceFile, node, call);
      if (test) tests.push(test);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return createSourceCodeFileFacts({
    path: input.uri,
    mediaType: input.mediaType,
    text: input.text,
    contentHash: `sha256_${input.sha256}`,
    parser: { id: "typescript-compiler-api", version: ts.version, ok: true, diagnostics: [] },
    languageEvidence: [{ kind: "parser", value: "typescript-compiler-api", source: "adapter", confidence: 0.92 }],
    roleEvidence: roleEvidenceFromTsFacts({ declarations, imports, routes, tests }),
    declarations,
    imports,
    exports,
    calls: calls.slice(0, 2048),
    routes,
    tests,
    patterns: patternsFromFacts({ declarations, imports, calls, routes, tests, path: input.uri, text: input.text, hasher: input.hasher }),
    packageFacts: input.packageFacts,
    hasher: input.hasher
  });
}

function factsFromStructuralSource(input: NodeSourceCodeFactsInput & { normalized: string; packageFacts?: SourcePackageFacts; parser: SourceCodeFileFacts["parser"] }): SourceCodeFileFacts {
  const lines = splitLines(input.text);
  const declarations = genericDeclarations(input, lines);
  const imports = genericImports(input, lines);
  const calls = genericCalls(input, lines).slice(0, 4096);
  const tests = genericTests(input, lines);
  const patterns = genericPatterns(input, lines, { declarations, imports, calls, tests });
  return createSourceCodeFileFacts({
    path: input.uri,
    mediaType: input.mediaType,
    text: input.text,
    contentHash: `sha256_${input.sha256}`,
    parser: input.parser,
    roleEvidence: roleEvidenceFromStructuralFacts({ declarations, imports, calls, tests, patterns }),
    declarations,
    imports,
    calls,
    tests,
    patterns,
    packageFacts: input.packageFacts,
    hasher: input.hasher
  });
}

function importFromNode(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.ImportDeclaration): SourceCodeImport {
  const moduleSpecifier = stringLiteralText(node.moduleSpecifier) ?? "";
  const importedNames: string[] = [];
  const clause = node.importClause;
  if (clause?.name) importedNames.push(clause.name.text);
  if (clause?.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) importedNames.push(clause.namedBindings.name.text);
    else for (const element of clause.namedBindings.elements) importedNames.push(element.name.text);
  }
  return {
    id: sourceId(input.hasher, input.uri, "import", moduleSpecifier, node.pos, node.end),
    moduleSpecifier,
    importedNames,
    typeOnly: Boolean(clause?.isTypeOnly),
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    metadata: { syntaxKind: ts.SyntaxKind[node.kind] }
  };
}

function exportFromNode(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.ExportDeclaration): SourceCodeExport {
  const exportedNames: string[] = [];
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) exportedNames.push(element.name.text);
  }
  return {
    id: sourceId(input.hasher, input.uri, "export", exportedNames, node.pos, node.end),
    exportedNames,
    moduleSpecifier: node.moduleSpecifier ? stringLiteralText(node.moduleSpecifier) : undefined,
    defaultExport: false,
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    metadata: { syntaxKind: ts.SyntaxKind[node.kind] }
  };
}

function declarationFromNode(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.DeclarationStatement): SourceCodeDeclaration | undefined {
  const name = declarationName(node);
  if (!name) return undefined;
  return {
    id: sourceId(input.hasher, input.uri, "declaration", name, node.kind, node.pos, node.end),
    name,
    kind: declarationKind(node),
    exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
    defaultExport: hasModifier(node, ts.SyntaxKind.DefaultKeyword),
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    signature: compactNodeText(sourceFile, node),
    metadata: { syntaxKind: ts.SyntaxKind[node.kind] }
  };
}

function variableDeclarationsFromStatement(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.VariableStatement): SourceCodeDeclaration[] {
  const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
  const out: SourceCodeDeclaration[] = [];
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    out.push({
      id: sourceId(input.hasher, input.uri, "variable", declaration.name.text, declaration.pos, declaration.end),
      name: declaration.name.text,
      kind: initializerKind(declaration.initializer),
      exported,
      defaultExport: false,
      span: sourceSpan(sourceFile.text, declaration.getStart(sourceFile), declaration.getEnd()),
      signature: compactNodeText(sourceFile, declaration),
      metadata: { declarationListFlags: ts.NodeFlags[node.declarationList.flags] ?? String(node.declarationList.flags) }
    });
  }
  return out;
}

function callFromNode(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.CallExpression): SourceCodeCall {
  const callee = calleeText(node.expression);
  return {
    id: sourceId(input.hasher, input.uri, "call", callee, node.pos, node.end),
    callee,
    argumentKinds: node.arguments.map(argumentKind),
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    metadata: { syntaxKind: ts.SyntaxKind[node.kind] }
  };
}

function routeFromCall(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.CallExpression, call: SourceCodeCall): SourceCodeRoute | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  const method = node.expression.name.text;
  if (!isHttpRegistrationMethod(method)) return undefined;
  const first = node.arguments[0];
  const routePath = first ? stringLiteralText(first) : undefined;
  if (!routePath) return undefined;
  return {
    id: sourceId(input.hasher, input.uri, "route", method, routePath, node.pos, node.end),
    protocol: "http",
    method: method.toLocaleUpperCase(),
    path: routePath,
    handlerHint: handlerHint(node.arguments[1]),
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    metadata: { callee: call.callee }
  };
}

function testFromCall(input: NodeSourceCodeFactsInput, sourceFile: ts.SourceFile, node: ts.CallExpression, call: SourceCodeCall): SourceCodeTest | undefined {
  const callee = terminalName(call.callee);
  if (!(callee === "test" || callee === "it" || callee === "describe")) return undefined;
  const first = node.arguments[0];
  return {
    id: sourceId(input.hasher, input.uri, "test", call.callee, node.pos, node.end),
    name: first ? stringLiteralText(first) : undefined,
    runnerHint: callee,
    span: sourceSpan(sourceFile.text, node.getStart(sourceFile), node.getEnd()),
    metadata: { callee: call.callee }
  };
}

function roleEvidenceFromTsFacts(input: { declarations: SourceCodeDeclaration[]; imports: SourceCodeImport[]; routes: SourceCodeRoute[]; tests: SourceCodeTest[] }) {
  const out: Array<{ roleId: string; source: string; confidence: number; evidence: string[] }> = [];
  if (input.routes.length) out.push({ roleId: "source.role.interface", source: "typescript-ast", confidence: 0.86, evidence: input.routes.slice(0, 12).map(route => `${route.method} ${route.path}`) });
  if (input.tests.length) out.push({ roleId: "source.role.test", source: "typescript-ast", confidence: 0.86, evidence: input.tests.slice(0, 12).map(test => test.name ?? test.id) });
  if (input.declarations.some(item => item.exported)) out.push({ roleId: "source.role.module", source: "typescript-ast", confidence: 0.72, evidence: input.declarations.filter(item => item.exported).slice(0, 12).map(item => item.name) });
  if (input.imports.some(item => item.moduleSpecifier.includes("react"))) out.push({ roleId: "source.role.presentation", source: "typescript-ast", confidence: 0.68, evidence: ["react-import"] });
  return out;
}

function roleEvidenceFromStructuralFacts(input: { declarations: SourceCodeDeclaration[]; imports: SourceCodeImport[]; calls: SourceCodeCall[]; tests: SourceCodeTest[]; patterns: SourceCodePattern[] }) {
  const out: Array<{ roleId: string; source: string; confidence: number; evidence: string[] }> = [];
  if (input.tests.length) out.push({ roleId: "source.role.test", source: "structural-source", confidence: 0.74, evidence: input.tests.slice(0, 12).map(test => test.name ?? test.id) });
  if (input.declarations.length) out.push({ roleId: "source.role.module", source: "structural-source", confidence: 0.64, evidence: input.declarations.slice(0, 12).map(item => item.name) });
  if (input.imports.length) out.push({ roleId: "source.role.dependency_boundary", source: "structural-source", confidence: 0.58, evidence: input.imports.slice(0, 12).map(item => item.moduleSpecifier) });
  if (input.calls.some(call => includesAny(call.callee.toLocaleLowerCase(), ["render", "view", "component", "html"]))) out.push({ roleId: "source.role.presentation", source: "structural-source", confidence: 0.48, evidence: input.calls.slice(0, 12).map(item => item.callee) });
  if (input.patterns.length) out.push({ roleId: "source.role.patterned", source: "structural-source", confidence: 0.5, evidence: input.patterns.slice(0, 12).map(item => item.label) });
  return out;
}

interface CodeLine {
  text: string;
  lineNumber: number;
  start: number;
  end: number;
  lexemes: CodeLexeme[];
}

interface CodeLexeme {
  text: string;
  kind: string;
  start: number;
  end: number;
}

function splitLines(text: string): CodeLine[] {
  const lines: CodeLine[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
      const line = text.slice(start, end);
      lines.push({ text: line, lineNumber, start, end, lexemes: lexLine(line, start) });
      start = i + 1;
      lineNumber++;
    }
  }
  const line = text.slice(start);
  lines.push({ text: line, lineNumber, start, end: text.length, lexemes: lexLine(line, start) });
  return lines;
}

function lexLine(line: string, offset: number): CodeLexeme[] {
  const lexemes: CodeLexeme[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    const absolute = offset + i;
    if (ch.trim() === "") {
      i++;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const read = readQuoted(line, i);
      lexemes.push({ text: read.value, kind: "string", start: absolute, end: offset + read.end });
      i = read.end;
      continue;
    }
    if (isIdentifierStart(ch)) {
      let end = i + 1;
      while (end < line.length && isIdentifierContinue(line[end] ?? "")) end++;
      lexemes.push({ text: line.slice(i, end), kind: "identifier", start: absolute, end: offset + end });
      i = end;
      continue;
    }
    if (isNumberChar(ch)) {
      let end = i + 1;
      while (end < line.length && (isNumberChar(line[end] ?? "") || line[end] === ".")) end++;
      lexemes.push({ text: line.slice(i, end), kind: "number", start: absolute, end: offset + end });
      i = end;
      continue;
    }
    lexemes.push({ text: ch, kind: punctuationKind(ch), start: absolute, end: absolute + 1 });
    i++;
  }
  return lexemes;
}

function genericDeclarations(input: NodeSourceCodeFactsInput, lines: readonly CodeLine[]): SourceCodeDeclaration[] {
  const declarations: SourceCodeDeclaration[] = [];
  for (const line of lines.slice(0, 12000)) {
    const lexemes = line.lexemes;
    const prefix = prefixFormDeclaration(lexemes);
    if (prefix) {
      declarations.push(declaration(input, prefix.name, `syntax.prefix-form:${prefix.head}`, line, prefix.lexeme.start, prefix.lexeme.end));
      continue;
    }
    const signature = functionLikeDeclaration(lexemes);
    if (signature) declarations.push(declaration(input, signature.name.text, "syntax.callable-signature", line, signature.name.start, signature.name.end));
    const block = namedBlockDeclaration(lexemes);
    if (block) declarations.push(declaration(input, block.name.text, "syntax.named-block", line, block.name.start, block.name.end));
  }
  return dedupeByName(declarations).slice(0, 2048);
}

function genericImports(input: NodeSourceCodeFactsInput, lines: readonly CodeLine[]): SourceCodeImport[] {
  const imports: SourceCodeImport[] = [];
  for (const line of lines.slice(0, 12000)) {
    const lexemes = line.lexemes;
    if (!lexemes.length) continue;
    const spec = importSpecifier(lexemes);
    if (!spec) continue;
    imports.push({
      id: sourceId(input.hasher, input.uri, "import", spec.value, line.lineNumber),
      moduleSpecifier: spec.value,
      importedNames: spec.names,
      typeOnly: false,
      span: sourceSpan(input.text, spec.start, spec.end),
      metadata: { structural: true, line: line.lineNumber }
    });
  }
  return uniqueBy(imports, item => item.moduleSpecifier).slice(0, 2048);
}

function genericCalls(input: NodeSourceCodeFactsInput, lines: readonly CodeLine[]): SourceCodeCall[] {
  const calls: SourceCodeCall[] = [];
  for (const line of lines.slice(0, 16000)) {
    const lexemes = line.lexemes;
    for (let i = 0; i < lexemes.length - 1; i++) {
      const lexeme = lexemes[i];
      const next = lexemes[i + 1];
      if (!lexeme || !next) continue;
      if (lexeme.kind === "identifier" && next.text === "(" && !isControlWord(lexeme.text) && !isDeclarationWord(lexeme.text)) {
        calls.push({
          id: sourceId(input.hasher, input.uri, "call", lexeme.text, lexeme.start, lexeme.end),
          callee: lexeme.text,
          argumentKinds: argumentKinds(lexemes, i + 2),
          span: sourceSpan(input.text, lexeme.start, next.end),
          metadata: { structural: true, line: line.lineNumber }
        });
      }
      if (lexeme.text === "(" && next.kind === "identifier" && !isDeclarationWord(next.text)) {
        calls.push({
          id: sourceId(input.hasher, input.uri, "prefix-call", next.text, lexeme.start, next.end),
          callee: next.text,
          argumentKinds: argumentKinds(lexemes, i + 2),
          span: sourceSpan(input.text, lexeme.start, next.end),
          metadata: { structural: true, line: line.lineNumber, prefixForm: true }
        });
      }
    }
  }
  return uniqueBy(calls, item => `${item.callee}:${item.span?.lineStart}`).slice(0, 4096);
}

function genericTests(input: NodeSourceCodeFactsInput, lines: readonly CodeLine[]): SourceCodeTest[] {
  const tests: SourceCodeTest[] = [];
  for (const line of lines.slice(0, 16000)) {
    const lexemes = line.lexemes;
    for (let i = 0; i < lexemes.length; i++) {
      const lexeme = lexemes[i];
      if (!lexeme || lexeme.kind !== "identifier") continue;
      const lower = lexeme.text.toLocaleLowerCase();
      if (!(lower === "test" || lower === "it" || lower === "describe" || lower === "assert" || lower === "deftest" || lower === "fact")) continue;
      const name = nextStringOrIdentifier(lexemes, i + 1)?.text;
      tests.push({
        id: sourceId(input.hasher, input.uri, "test", lower, name ?? line.lineNumber),
        name,
        runnerHint: lower,
        span: sourceSpan(input.text, lexeme.start, lexeme.end),
        metadata: { structural: true, line: line.lineNumber }
      });
    }
  }
  return tests.slice(0, 512);
}

function genericPatterns(
  input: NodeSourceCodeFactsInput,
  lines: readonly CodeLine[],
  facts: { declarations: SourceCodeDeclaration[]; imports: SourceCodeImport[]; calls: SourceCodeCall[]; tests: SourceCodeTest[] }
): SourceCodePattern[] {
  const groups = new Map<string, { kind: string; label: string; lexemes: string[]; count: number; start?: number; end?: number }>();
  const add = (kind: string, label: string, lexemes: string[], start?: number, end?: number) => {
    const key = `${kind}:${label}:${lexemes.join("|")}`;
    const current = groups.get(key) ?? { kind, label, lexemes, count: 0, start, end };
    current.count++;
    groups.set(key, current);
  };
  for (const line of lines.slice(0, 3000)) {
    const lexemes = line.lexemes.filter(lexeme => lexeme.kind !== "string" && lexeme.kind !== "number").slice(0, 18);
    if (lexemes.length >= 3) add("line.shape", lexemes.map(lexeme => lexeme.kind).join("."), lexemes.map(lexeme => lexeme.text), lexemes[0]?.start, lexemes[lexemes.length - 1]?.end);
    const delimiters = delimiterProfile(line.lexemes);
    if (delimiters.length) add("delimiter.profile", delimiters.join(""), delimiters, line.start, line.end);
  }
  for (const item of facts.declarations.slice(0, 256)) add("declaration.form", item.kind, [item.name, item.kind], item.span?.charStart, item.span?.charEnd);
  for (const item of facts.imports.slice(0, 256)) add("import.form", item.moduleSpecifier, [item.moduleSpecifier], item.span?.charStart, item.span?.charEnd);
  for (const item of facts.calls.slice(0, 512)) add("call.frame", item.callee, [item.callee, ...item.argumentKinds.slice(0, 8)], item.span?.charStart, item.span?.charEnd);
  for (const item of facts.tests.slice(0, 128)) add("test.form", item.runnerHint ?? "test", [item.runnerHint ?? "test", item.name ?? ""], item.span?.charStart, item.span?.charEnd);
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    .slice(0, 1024)
    .map(group => ({
      id: sourceId(input.hasher, input.uri, "pattern", group.kind, group.label, group.lexemes, group.count),
      kind: group.kind,
      label: group.label,
      codeSymbols: group.lexemes.slice(0, 32),
      span: group.start === undefined || group.end === undefined ? undefined : sourceSpan(input.text, group.start, group.end),
      support: clamp01(group.count / 12),
      metadata: { count: group.count, structural: true }
    }));
}

function patternsFromFacts(input: {
  declarations: SourceCodeDeclaration[];
  imports: SourceCodeImport[];
  calls: SourceCodeCall[];
  routes: SourceCodeRoute[];
  tests: SourceCodeTest[];
  path: string;
  text: string;
  hasher: Hasher;
}): SourceCodePattern[] {
  const patterns: SourceCodePattern[] = [];
  const add = (kind: string, label: string, lexemes: string[], support: number, span?: { charStart: number; charEnd: number }) => {
    patterns.push({
      id: sourceId(input.hasher, input.path, "pattern", kind, label, lexemes),
      kind,
      label,
      codeSymbols: lexemes,
      span: span ? sourceSpan(input.text, span.charStart, span.charEnd) : undefined,
      support,
      metadata: { source: "typescript-compiler-api" }
    });
  };
  for (const item of input.declarations.slice(0, 512)) add("declaration.form", item.kind, [item.kind, item.name], item.exported ? 0.82 : 0.62, item.span);
  for (const item of input.imports.slice(0, 512)) add("import.form", item.typeOnly ? "type-import" : "runtime-import", [item.moduleSpecifier, ...item.importedNames.slice(0, 8)], item.typeOnly ? 0.46 : 0.72, item.span);
  for (const item of input.calls.slice(0, 512)) add("call.frame", item.callee, [item.callee, ...item.argumentKinds.slice(0, 8)], 0.42, item.span);
  for (const item of input.routes.slice(0, 256)) add("route.form", `${item.method} ${item.path}`, [item.protocol, item.method, item.path], 0.78, item.span);
  for (const item of input.tests.slice(0, 256)) add("test.form", item.runnerHint ?? "test", [item.runnerHint ?? "test", item.name ?? ""], 0.7, item.span);
  return patterns;
}

function parseManifestFacts(normalizedPath: string, text: string): SourcePackageFacts | undefined {
  const ext = extensionOf(normalizedPath);
  if (ext === ".json") return parseJsonManifestFacts(text);
  if (ext === ".toml" || ext === ".ini") return parseSectionedKeyValueManifestFacts(text, normalizedPath);
  if (ext === ".xml") return parseXmlLikeManifestFacts(text, normalizedPath);
  if (looksLikeDependencyList(normalizedPath, text)) return parseLineListManifestFacts(text, normalizedPath);
  return undefined;
}

function parseJsonManifestFacts(text: string): SourcePackageFacts | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const scripts = objectRecord(parsed.scripts);
    const dependencies = Object.entries(parsed)
      .filter(([key, value]) => key.toLocaleLowerCase().includes("depend") && value && typeof value === "object" && !Array.isArray(value))
      .flatMap(([scope, value]) => dependencyFacts(value as Record<string, unknown>, scope));
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      scripts: Object.entries(scripts).filter(([, command]) => typeof command === "string").map(([name, command]) => ({
        name,
        command: String(command),
        roleEvidence: scriptRoleEvidence(name, String(command))
      })),
      dependencies
    };
  } catch {
    return undefined;
  }
}

function parseSectionedKeyValueManifestFacts(text: string, normalizedPath: string): SourcePackageFacts | undefined {
  const lines = textLines(text);
  let section = "";
  let name: string | undefined;
  let version: string | undefined;
  const dependencies: SourcePackageFacts["dependencies"] = [];
  const scripts: SourcePackageFacts["scripts"] = [];
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    const pair = keyValue(line);
    if (!pair) continue;
    const sectionLower = section.toLocaleLowerCase();
    const keyLower = pair.key.toLocaleLowerCase();
    if (!name && keyLower === "name") name = unquote(pair.value);
    else if (!version && keyLower === "version") version = unquote(pair.value);
    if (sectionLower.includes("depend")) dependencies.push({ name: pair.key, scope: section || "dependencies", version: unquote(pair.value) });
    if (sectionLower.includes("script") || sectionLower.includes("command")) scripts.push({ name: pair.key, command: unquote(pair.value), roleEvidence: scriptRoleEvidence(pair.key, unquote(pair.value)) });
    for (const quoted of quotedValues(line)) {
      const dep = dependencyNameFromRequirement(quoted);
      if (dep && sectionLower.includes("depend")) dependencies.push({ name: dep, scope: section || "dependencies" });
    }
  }
  return name || version || scripts.length || dependencies.length ? { name: name ?? basename(normalizedPath), version, scripts, dependencies } : undefined;
}

function parseXmlLikeManifestFacts(text: string, normalizedPath: string): SourcePackageFacts | undefined {
  const dependencies: SourcePackageFacts["dependencies"] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start < 0) break;
    const end = text.indexOf(">", start);
    const tag = text.slice(start, end < 0 ? text.length : end + 1);
    const tagName = xmlTagName(tag);
    const tagLower = tagName.toLocaleLowerCase();
    const name = attributeValue(tag, "Include") ?? attributeValue(tag, "Update") ?? attributeValue(tag, "name") ?? attributeValue(tag, "Name") ?? attributeValue(tag, "artifactId");
    const version = attributeValue(tag, "Version");
    if (name && (tagLower.includes("package") || tagLower.includes("dependency") || tagLower.includes("reference"))) dependencies.push({ name, scope: tagName || "xml-reference", version });
    index = end < 0 ? text.length : end + 1;
  }
  return dependencies.length ? { name: basename(normalizedPath), scripts: [], dependencies } : undefined;
}

function parseLineListManifestFacts(text: string, normalizedPath: string): SourcePackageFacts | undefined {
  const dependencies = textLines(text)
    .map(line => dependencyNameFromRequirement(stripComment(line).trim()))
    .filter((name): name is string => Boolean(name))
    .map(name => ({ name, scope: "line-list" }));
  return dependencies.length ? { name: basename(normalizedPath), scripts: [], dependencies } : undefined;
}

function dependencyFacts(deps: Record<string, unknown> | undefined, scope: string): Array<{ name: string; scope: string; version?: string }> {
  return Object.entries(deps ?? {}).map(([name, version]) => ({ name, scope, version: typeof version === "string" ? version : undefined }));
}

function scriptRoleEvidence(name: string, command: string) {
  const lower = `${name} ${command}`.toLocaleLowerCase();
  const out: Array<{ roleId: string; source: string; confidence: number; evidence: string[] }> = [];
  if (lower.includes("test") || lower.includes("vitest") || lower.includes("jest")) out.push({ roleId: "source.role.validation", source: "package-script", confidence: 0.76, evidence: [name] });
  if (lower.includes("build") || lower.includes("tsc")) out.push({ roleId: "source.role.build", source: "package-script", confidence: 0.74, evidence: [name] });
  if (lower.includes("lint")) out.push({ roleId: "source.role.lint", source: "package-script", confidence: 0.72, evidence: [name] });
  if (lower.includes("dev") || lower.includes("serve") || lower.includes("start")) out.push({ roleId: "source.role.runtime", source: "package-script", confidence: 0.64, evidence: [name] });
  return out;
}

function prefixFormDeclaration(lexemes: readonly CodeLexeme[]): { head: string; name: string; lexeme: CodeLexeme } | undefined {
  if (lexemes.length < 4) return undefined;
  const open = lexemes[0];
  const head = lexemes[1];
  const name = lexemes[2];
  if (!open || !head || !name) return undefined;
  if (open.text !== "(" || head.kind !== "identifier" || name.kind !== "identifier") return undefined;
  const lower = head.text.toLocaleLowerCase();
  if (!(lower.includes("def") || lower.includes("declare") || lower.includes("module") || lower.includes("type"))) return undefined;
  return { head: head.text, name: name.text, lexeme: head };
}

function declaration(input: NodeSourceCodeFactsInput, name: string, kind: string, line: CodeLine, start: number, end: number): SourceCodeDeclaration {
  return {
    id: sourceId(input.hasher, input.uri, "declaration", kind, name, line.lineNumber),
    name,
    kind,
    exported: line.lexemes.some(lexeme => lexeme.kind === "identifier" && lexeme.text.toLocaleLowerCase() === "export"),
    defaultExport: line.lexemes.some(lexeme => lexeme.kind === "identifier" && lexeme.text.toLocaleLowerCase() === "default"),
    span: sourceSpan(input.text, start, end),
    signature: line.text.trim().slice(0, 280),
    metadata: { structural: true, line: line.lineNumber }
  };
}

function functionLikeDeclaration(lexemes: readonly CodeLexeme[]): { name: CodeLexeme } | undefined {
  for (let i = 0; i < lexemes.length - 2; i++) {
    const current = lexemes[i];
    const next = lexemes[i + 1];
    if (!current || !next) continue;
    if (current.kind !== "identifier" || next.text !== "(") continue;
    if (isControlWord(current.text) || isDeclarationWord(current.text)) continue;
    const close = matchingClose(lexemes, i + 1, "(", ")");
    const after = close >= 0 ? lexemes[close + 1] : undefined;
    if (!after || after.text === "{" || after.text === ":" || after.text === "=" || after.text === "=>") return { name: current };
  }
  return undefined;
}

function namedBlockDeclaration(lexemes: readonly CodeLexeme[]): { name: CodeLexeme } | undefined {
  for (let i = 0; i < lexemes.length - 1; i++) {
    const lexeme = lexemes[i];
    const next = lexemes[i + 1];
    if (!lexeme || !next) continue;
    if (lexeme.kind === "identifier" && next.text === "{" && !isControlWord(lexeme.text)) return { name: lexeme };
  }
  return undefined;
}

function matchingClose(lexemes: readonly CodeLexeme[], openIndex: number, openText: string, closeText: string): number {
  let depth = 0;
  for (let i = openIndex; i < lexemes.length; i++) {
    const lexeme = lexemes[i];
    if (!lexeme) continue;
    if (lexeme.text === openText) depth++;
    if (lexeme.text === closeText) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function dedupeByName<T extends { name: string; kind?: string }>(items: readonly T[]): T[] {
  return uniqueBy(items, item => `${item.kind ?? ""}:${item.name}`);
}

function uniqueBy<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function importSpecifier(lexemes: readonly CodeLexeme[]): { value: string; names: string[]; start: number; end: number } | undefined {
  const firstIdentifier = lexemes.find(lexeme => lexeme.kind === "identifier");
  if (!firstIdentifier) return undefined;
  const head = firstIdentifier.text.toLocaleLowerCase();
  const syntaxLooksImportLike = head.includes("import") || head.includes("include") || head.includes("require") || head === "use" || head.includes("load") || head.includes("using");
  if (!syntaxLooksImportLike) return undefined;
  const stringLexeme = lexemes.find(lexeme => lexeme.kind === "string");
  if (stringLexeme) return { value: unquote(stringLexeme.text), names: identifierNames(lexemes).slice(1, 12), start: firstIdentifier.start, end: stringLexeme.end };
  const fromIndex = lexemes.findIndex(lexeme => lexeme.kind === "identifier" && lexeme.text.toLocaleLowerCase() === "from");
  const spec = fromIndex >= 0 ? nextIdentifier(lexemes, fromIndex + 1) : nextIdentifier(lexemes, 1);
  return spec ? { value: spec.text, names: identifierNames(lexemes).slice(1, 12), start: firstIdentifier.start, end: spec.end } : undefined;
}

function identifierNames(lexemes: readonly CodeLexeme[]): string[] {
  return lexemes.filter(lexeme => lexeme.kind === "identifier").map(lexeme => lexeme.text);
}

function argumentKinds(lexemes: readonly CodeLexeme[], start: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    if (current) out.push(current);
    current = "";
  };
  for (let i = start; i < lexemes.length; i++) {
    const lexeme = lexemes[i];
    if (!lexeme) continue;
    if (lexeme.text === "(" || lexeme.text === "[" || lexeme.text === "{") depth++;
    if (lexeme.text === ")" || lexeme.text === "]" || lexeme.text === "}") {
      if (depth <= 0) {
        flush();
        break;
      }
      depth--;
    }
    if (depth === 0 && lexeme.text === ",") {
      flush();
      continue;
    }
    if (!current && lexeme.kind !== "operator" && lexeme.text !== ",") current = lexeme.kind;
  }
  flush();
  return out.slice(0, 24);
}

function isControlWord(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  return lower === "if" || lower === "for" || lower === "while" || lower === "switch" || lower === "catch" || lower === "return" || lower === "throw";
}

function isDeclarationWord(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  return lower.includes("import") || lower.includes("include") || lower.includes("require") || lower.includes("export") || lower.includes("using");
}

function nextStringOrIdentifier(lexemes: readonly CodeLexeme[], start: number): CodeLexeme | undefined {
  for (let i = start; i < lexemes.length; i++) {
    const lexeme = lexemes[i];
    if (lexeme && (lexeme.kind === "string" || lexeme.kind === "identifier")) return lexeme;
  }
  return undefined;
}

function delimiterProfile(lexemes: readonly CodeLexeme[]): string[] {
  const out: string[] = [];
  for (const lexeme of lexemes) {
    if (lexeme.kind === "delimiter" || lexeme.kind === "operator") out.push(lexeme.text);
    if (out.length >= 16) break;
  }
  return out;
}

function textLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const end = i > start && text[i - 1] === "\r" ? i - 1 : i;
      out.push(text.slice(start, end));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function stripComment(line: string): string {
  const markers = ["#", "//", ";"];
  let end = line.length;
  for (const marker of markers) {
    const index = line.indexOf(marker);
    if (index >= 0 && index < end) end = index;
  }
  return line.slice(0, end);
}

function keyValue(line: string): { key: string; value: string } | undefined {
  const equals = line.indexOf("=");
  const colon = line.indexOf(":");
  const splitAt = equals >= 0 && (colon < 0 || equals < colon) ? equals : colon;
  if (splitAt <= 0) return undefined;
  const key = line.slice(0, splitAt).trim();
  const value = line.slice(splitAt + 1).trim();
  return key ? { key, value } : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" || first === "'" || first === "`") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function attributeValue(tag: string, name: string): string | undefined {
  const keys = [name, name.toLocaleLowerCase(), name.toLocaleUpperCase()];
  for (const key of keys) {
    const start = tag.indexOf(key);
    if (start < 0) continue;
    let index = start + key.length;
    while (index < tag.length && tag[index]?.trim() === "") index++;
    if (tag[index] !== "=") continue;
    index++;
    while (index < tag.length && tag[index]?.trim() === "") index++;
    const quote = tag[index];
    if (quote !== "\"" && quote !== "'") continue;
    const end = tag.indexOf(quote, index + 1);
    if (end > index) return tag.slice(index + 1, end);
  }
  return undefined;
}

function dependencyNameFromRequirement(value: string): string | undefined {
  const trimmed = unquote(value).trim();
  if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith("#")) return undefined;
  const out: string[] = [];
  for (const char of trimmed) {
    const cp = char.codePointAt(0) ?? 0;
    const valid = cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || char === "_" || char === "-" || char === "." || char === "@" || char === "/";
    if (!valid) break;
    out.push(char);
  }
  const name = out.join("");
  return name.length >= 1 ? name : undefined;
}

function quotedValues(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch !== "\"" && ch !== "'") {
      i++;
      continue;
    }
    const read = readQuoted(line, i);
    out.push(unquote(read.value));
    i = read.end;
  }
  return out;
}

function readQuoted(line: string, start: number): { value: string; end: number } {
  const quote = line[start] ?? "";
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return { value: line.slice(start, i + 1), end: i + 1 };
    i++;
  }
  return { value: line.slice(start), end: line.length };
}

function isIdentifierStart(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && ch.trim() !== "";
}

function isIdentifierContinue(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return isIdentifierStart(ch) || cp >= 48 && cp <= 57 || ch === "-" || ch === "." || ch === ":";
}

function isNumberChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 48 && cp <= 57;
}

function punctuationKind(ch: string): string {
  if ("()[]{}<>".includes(ch)) return "delimiter";
  if ("+-*%=!&|^~?:.".includes(ch)) return "operator";
  return "punctuation";
}

function nextIdentifier(lexemes: readonly CodeLexeme[], start: number): CodeLexeme | undefined {
  for (let i = start; i < lexemes.length; i++) {
    const lexeme = lexemes[i];
    if (lexeme?.kind === "identifier") return lexeme;
  }
  return undefined;
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function xmlTagName(tag: string): string {
  let index = tag.startsWith("</") ? 2 : tag.startsWith("<") ? 1 : 0;
  const out: string[] = [];
  while (index < tag.length) {
    const ch = tag[index] ?? "";
    if (!isIdentifierContinue(ch)) break;
    out.push(ch);
    index++;
  }
  return out.join("");
}

function looksLikeDependencyList(normalizedPath: string, text: string): boolean {
  const file = basename(normalizedPath).toLocaleLowerCase();
  if (file.includes("depend") || file.includes("lock") || file.includes("require")) return true;
  let dependencyLike = 0;
  for (const line of textLines(text).slice(0, 200)) {
    const name = dependencyNameFromRequirement(stripComment(line).trim());
    if (name) dependencyLike++;
  }
  return dependencyLike >= 5;
}

function looksStructurallyLikeSource(text: string): boolean {
  const lines = textLines(text).slice(0, 400);
  let lexemeLines = 0;
  let structuralLines = 0;
  for (const line of lines) {
    const lexemes = lexLine(line, 0);
    if (lexemes.some(lexeme => lexeme.kind === "identifier")) lexemeLines++;
    if (lexemes.some(lexeme => lexeme.kind === "delimiter" || lexeme.kind === "operator")) structuralLines++;
  }
  return lexemeLines >= 3 && structuralLines >= 2;
}

function parserFor(normalizedPath: string, mediaType: string): SourceCodeFileFacts["parser"] {
  if (isTypeScriptParseable(normalizedPath, mediaType)) return { id: "typescript-compiler-api", version: ts.version, ok: true, diagnostics: [] };
  return { id: "structural-source-facts", ok: true, diagnostics: [] };
}

function scriptKindFor(normalizedPath: string): ts.ScriptKind {
  const ext = extensionOf(normalizedPath);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isTypeScriptParseable(normalizedPath: string, mediaType: string): boolean {
  const ext = extensionOf(normalizedPath);
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext) || mediaType.includes("typescript") || mediaType.includes("javascript");
}

function isProbablySourceLike(normalizedPath: string, mediaType: string, text: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (parseManifestFacts(normalizedPath, text)) return true;
  return looksStructurallyLikeSource(text);
}

function isIgnoredSourcePath(normalizedPath: string): boolean {
  const parts = normalizedPath.split("/").map(part => part.toLocaleLowerCase());
  return parts.includes("node_modules") || parts.includes(".git") || parts.includes("dist") || parts.includes("build") || parts.includes(".cache");
}

function declarationName(node: ts.DeclarationStatement): string | undefined {
  const maybe = node as ts.DeclarationStatement & { name?: ts.PropertyName };
  return maybe.name && ts.isIdentifier(maybe.name) ? maybe.name.text : undefined;
}

function declarationKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return "syntax.function";
  if (ts.isClassDeclaration(node)) return "syntax.class";
  if (ts.isInterfaceDeclaration(node)) return "syntax.interface";
  if (ts.isTypeAliasDeclaration(node)) return "syntax.type-alias";
  if (ts.isEnumDeclaration(node)) return "syntax.enum";
  return "syntax.declaration";
}

function initializerKind(initializer: ts.Expression | undefined): string {
  if (!initializer) return "syntax.variable";
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return "syntax.function";
  if (ts.isClassExpression(initializer)) return "syntax.class";
  if (ts.isObjectLiteralExpression(initializer)) return "syntax.object";
  if (ts.isArrayLiteralExpression(initializer)) return "syntax.array";
  return "syntax.value";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind));
}

function stringLiteralText(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function compactNodeText(sourceFile: ts.SourceFile, node: ts.Node): string {
  const text = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
  return lines.join(" ").slice(0, 280);
}

function calleeText(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${calleeText(expression.expression)}.${expression.name.text}`;
  if (ts.isElementAccessExpression(expression)) return `${calleeText(expression.expression)}[]`;
  return ts.SyntaxKind[expression.kind] ?? "syntax.expression";
}

function argumentKind(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return "syntax.string-literal";
  if (ts.isNumericLiteral(node)) return "syntax.numeric-literal";
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return "syntax.boolean-literal";
  if (ts.isObjectLiteralExpression(node)) return "syntax.object-literal";
  if (ts.isArrayLiteralExpression(node)) return "syntax.array-literal";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "syntax.function";
  if (ts.isIdentifier(node)) return "syntax.identifier";
  return ts.SyntaxKind[node.kind] ?? "syntax.expression";
}

function isHttpRegistrationMethod(method: string): boolean {
  return ["get", "post", "put", "patch", "delete", "all", "use", "head", "options"].includes(method.toLocaleLowerCase());
}

function handlerHint(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return calleeText(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return "syntax.inline-function";
  return undefined;
}

function terminalName(value: string): string {
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(index + 1) : value;
}

function sourceId(hasher: Hasher, ...parts: unknown[]): string {
  return `source_fact_${hasher.digestHex(JSON.stringify(parts)).slice(0, 40)}`;
}

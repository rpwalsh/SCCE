// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import ts from "typescript";
import { pathGlobMatches } from "./path-glob.js";
import type { OwnedContractSnapshotFile } from "./source-owned-contract-compiler.js";
import { SOURCE_OWNED_ASSERTION_FRAMEWORK_MODULES } from "./source-owned-test-contracts.js";

export interface ContractClosureInventoryFile { readonly path: string; readonly byteLength: number; readonly contentHash?: string }
export interface ContractClosureBudget { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number; readonly files: Map<string, OwnedContractSnapshotFile>; usedBytes: number }
export interface TypeScriptContractClosure {
  readonly testPath: string; readonly configPath?: string; readonly files: readonly OwnedContractSnapshotFile[];
  readonly complete: boolean; readonly reasons: readonly string[];
}
export function hasSourceOwnedTestImport(text: string, name: string): boolean {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  return source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && (statement.moduleSpecifier.text === "node:test" || statement.moduleSpecifier.text === "vitest" && !statement.importClause?.isTypeOnly
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some(element => !element.isTypeOnly && ["test", "it"].includes(element.propertyName?.text ?? element.name.text))));
}

/** Resolves compiler reads against one declared owner inventory and a shared decoded-byte ledger. */
export async function collectTypeScriptContractClosure(input: {
  readonly root: string; readonly testPath: string; readonly inventory: readonly ContractClosureInventoryFile[];
  readonly budget: ContractClosureBudget; readonly load: (relativePath: string) => Promise<OwnedContractSnapshotFile | undefined>;
}): Promise<TypeScriptContractClosure> {
  if ([input.budget.maxFiles,input.budget.maxFileBytes,input.budget.maxTotalBytes].some(value=>!Number.isSafeInteger(value)||value<=0)
    || !Number.isSafeInteger(input.budget.usedBytes)||input.budget.usedBytes<0||input.budget.usedBytes>input.budget.maxTotalBytes||input.budget.files.size>input.budget.maxFiles) throw new Error("invalid source contract closure resource budget");
  const root = path.resolve(input.root);
  const invalid=input.inventory.find(file=>!file.path||file.path.includes("\\")||file.path.includes("\u0000")||path.isAbsolute(file.path)||file.path!==path.posix.normalize(file.path)||file.path.split("/").some(part=>part===".."||part==="."||!part));
  if(invalid)return{testPath:input.testPath,files:[],complete:false,reasons:[`inventory_path_outside_scope:${invalid.path}`]};
  const known = new Map(input.inventory.map(file => [key(path.resolve(root, file.path)), file]));
  const selected = new Set<string>(), reasons = new Set<string>(), requested = new Set<string>();
  const relative = (fileName: string): string | undefined => known.get(key(fileName))?.path;
  const load = async (name: string): Promise<boolean> => {
    const row = known.get(key(path.resolve(root, name)));
    if (!row) { reasons.add(`dependency_outside_inventory:${name}`); return false; }
    selected.add(row.path);
    if (input.budget.files.has(row.path)) return true;
    if (row.byteLength > input.budget.maxFileBytes) { reasons.add(`max_file_bytes:${row.path}`); return false; }
    if (input.budget.files.size >= input.budget.maxFiles) { reasons.add(`max_files:${row.path}`); return false; }
    if (input.budget.usedBytes + row.byteLength > input.budget.maxTotalBytes) { reasons.add(`max_total_bytes:${row.path}`); return false; }
    const file = await input.load(row.path);
    if (!file) { reasons.add(`canonical_owner_unavailable:${row.path}`); return false; }
    if (file.bytes.byteLength !== row.byteLength) { reasons.add(`canonical_byte_length_changed:${row.path}`); return false; }
    input.budget.files.set(row.path, file); input.budget.usedBytes += file.bytes.byteLength;
    return true;
  };
  const read = (fileName: string): string | undefined => {
    const name = relative(fileName); if (!name) return undefined;
    selected.add(name);
    const file = input.budget.files.get(name);
    if (!file) { requested.add(name); return undefined; }
    return Buffer.from(file.bytes).toString("utf8");
  };
  const directories = new Set<string>();
  for (const file of input.inventory) for (let directory = path.dirname(path.resolve(root, file.path)); directory.startsWith(root); directory = path.dirname(directory)) {
    directories.add(key(directory)); if (directory === root) break;
  }
  const host: ts.ParseConfigHost & ts.ModuleResolutionHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, fileExists: name => known.has(key(name)), readFile: read,
    directoryExists: name => directories.has(key(name)), getCurrentDirectory: () => root,
    getDirectories:name=>[...directories].filter(directory=>key(path.dirname(directory))===key(name)).sort(),
    readDirectory: (directory, extensions, excludes, includes, depth) => input.inventory.filter(file => {
      const name = path.relative(directory, path.resolve(root, file.path)).replace(/\\/gu, "/");
      return name !== ".." && !name.startsWith("../") && !path.isAbsolute(name)
        && (depth === undefined || name.split("/").length - 1 <= depth)
        && (!extensions?.length || extensions.some(extension => name.endsWith(extension)))
        && (!includes?.length || includes.some(pattern => pathGlobMatches(name, pattern)))
        && !excludes?.some(pattern => pathGlobMatches(name, pattern));
    }).map(file => path.resolve(root, file.path)).sort()
  };
  let configPath: string | undefined;
  for (let directory = path.dirname(path.resolve(root, input.testPath)); ; directory = path.dirname(directory)) {
    const candidate = relative(path.join(directory, "tsconfig.json")); if (candidate) { configPath = candidate; break; }
    if (directory === root || path.dirname(directory) === directory) break;
  }
  if (!configPath) return { testPath: input.testPath, files: [], complete: false, reasons: ["project_config_unavailable"] };
  await load(input.testPath); await load(configPath);
  const configs = new Set([configPath]), parsedConfigs = new Map<string, ts.ParsedCommandLine>();
  let changed = true;
  while (changed && reasons.size === 0) {
    changed = false; requested.clear();
    for (const config of [...configs].sort()) {
      const text = read(path.resolve(root, config)); if (text === undefined) continue;
      const json = ts.parseConfigFileTextToJson(config, text);
      if (json.error) { reasons.add(`invalid_project_config:${config}`); continue; }
      const parsed = ts.parseJsonConfigFileContent(json.config, host, path.dirname(path.resolve(root, config)), undefined, path.resolve(root, config));
      parsedConfigs.set(config, parsed);
      for (const reference of parsed.projectReferences ?? []) {
        const referenceConfig = relative(reference.path) ?? relative(path.join(reference.path, "tsconfig.json"));
        if (!referenceConfig) reasons.add(`project_reference_unavailable:${reference.path}`);
        else if (!configs.has(referenceConfig)) { configs.add(referenceConfig); requested.add(referenceConfig); }
      }
      for (const fileName of parsed.fileNames) if (/\.d\.[cm]?ts$/u.test(fileName)) { const name = relative(fileName); if (name && !selected.has(name)) requested.add(name); }
      for(const typeRoot of parsed.options.typeRoots??[])if(!directories.has(key(typeRoot)))reasons.add(`type_root_unavailable:${typeRoot}`);
      for (const type of ts.getAutomaticTypeDirectiveNames(parsed.options,host)) {
        const found = ts.resolveTypeReferenceDirective(type, path.resolve(root, config), parsed.options, host).resolvedTypeReferenceDirective;
        const name = found?.resolvedFileName ? relative(found.resolvedFileName) : undefined;
        if (!name && !requested.size) reasons.add(`type_dependency_unavailable:${type}`); else if (name && !selected.has(name)) requested.add(name);
      }
      if (!requested.size) for (const diagnostic of parsed.errors) reasons.add(`project_config_diagnostic:${config}:${diagnostic.code}`);
    }
    for (const name of [...requested].sort()) if (await load(name)) changed = true;
    if (changed || reasons.size) continue;
    for (const name of [...selected].sort()) {
      if (!/\.[cm]?[jt]sx?$/u.test(name)) continue;
      const file = input.budget.files.get(name); if (!file) continue;
      for (let directory = path.dirname(path.resolve(root, name)); ; directory = path.dirname(directory)) {
        const manifest = relative(path.join(directory, "package.json"));
        if (manifest) { if (!selected.has(manifest)) requested.add(manifest); break; }
        if (directory === root || path.dirname(directory) === directory) break;
      }
      const source = ts.createSourceFile(name, Buffer.from(file.bytes).toString("utf8"), ts.ScriptTarget.Latest, true);
      const applicable = [...parsedConfigs].filter(([config]) => name.startsWith(path.posix.dirname(config) === "." ? "" : `${path.posix.dirname(config)}/`))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1] ?? parsedConfigs.get(configPath)!;
      const modules = new Set<string>();
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) modules.add(node.moduleSpecifier.text);
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) modules.add(node.moduleReference.expression.text);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) modules.add(node.arguments[0]!.text);
        node.forEachChild(visit);
      }; visit(source);
      for (const directive of source.typeReferenceDirectives) {
        const found = ts.resolveTypeReferenceDirective(directive.fileName, path.resolve(root, name), applicable.options, host).resolvedTypeReferenceDirective;
        const target = found?.resolvedFileName ? relative(found.resolvedFileName) : undefined;
        if (!target && !requested.size) reasons.add(`type_dependency_unavailable:${directive.fileName}`); else if (target && !selected.has(target)) requested.add(target);
      }
      for (const directive of source.referencedFiles) { const target = relative(path.resolve(root, path.dirname(name), directive.fileName)); if (!target) reasons.add(`reference_dependency_unavailable:${directive.fileName}`); else if (!selected.has(target)) { requested.add(target); } }
      for (const module of modules) {
        if (SOURCE_OWNED_ASSERTION_FRAMEWORK_MODULES.some(framework=>framework===module)) continue;
        const resolved = ts.resolveModuleName(module, path.resolve(root, name), applicable.options, host).resolvedModule;
        const target = resolved && relative(resolved.resolvedFileName);
        if (!target && !requested.size) reasons.add(`module_dependency_unavailable:${name}:${module}`); else if (target && !selected.has(target)) requested.add(target);
      }
    }
    for (const name of [...requested].sort()) if (await load(name)) changed = true;
  }
  return { testPath: input.testPath, configPath, files: [...selected].sort().flatMap(name => { const file = input.budget.files.get(name); return file ? [file] : []; }), complete: reasons.size === 0, reasons: [...reasons].sort() };
}
function key(name: string): string { const absolute = path.resolve(name); return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase(); }

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Which exported symbols the running system actually reaches, walked from the real entry points: server routes and
// startup, the CLI, the production turn runtime, the kernel, the adapters, the VS Code extension, the workbench, and
// the maintenance and evaluation tools. Writes docs/RUNTIME_REACHABILITY.json and prints the counts.
//
// It matches names as words in reachable source, not through the type system, so it is a lower bound on what is
// unreached: a symbol whose name also appears as a method or local elsewhere reads as reached. Treat the orphan list as
// a work queue to verify one by one, never as a delete list.
import fs from "node:fs";
import path from "node:path";
const repo = process.cwd().split(String.fromCharCode(92)).join("/");
const files = [];
const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, e.name).replace(/\\/g, "/"); if (e.isDirectory()) { if (e.name === "node_modules" || e.name === "dist") continue; walk(full); } else if (/\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(full); } };
walk(`${repo}/packages`);
const src = files.filter(f => !/__tests__|\.test\.|\/test\//.test(f));
const text = new Map(src.map(f => [f, fs.readFileSync(f, "utf8")]));
const word = name => new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\b");
const isBarrel = f => /\/src\/index\.ts$/.test(f);

const importsOf = new Map();
for (const f of src) {
  const out = new Set();
  for (const m of text.get(f).matchAll(/from\s+"(\.[^"]+)"/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\.js$/, ".ts");
    for (const candidate of [base, base + "/index.ts", base.replace(/\.ts$/, "") + "/index.ts"]) if (text.has(candidate)) { out.add(candidate); break; }
  }
  importsOf.set(f, out);
}
const exportRe = /^export\s+(?:async\s+)?(?:function\*?|const|let|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
// An `export function` inside a template literal is generated code this repo emits, not a symbol this repo exports.
const insideTemplateLiteral = (body, index) => {
  let backticks = 0;
  for (let i = 0; i < index; i++) {
    if (body[i] !== "`") continue;
    if (i > 0 && body[i - 1] === String.fromCharCode(92)) continue;
    backticks++;
  }
  return backticks % 2 === 1;
};
const exportsOf = new Map(src.map(f => [
  f,
  [...text.get(f).matchAll(exportRe)].filter(m => !insideTemplateLiteral(text.get(f), m.index ?? 0)).map(m => m[1])
]));
const definedIn = new Map();
for (const f of src) for (const name of exportsOf.get(f)) if (!definedIn.has(name)) definedIn.set(name, f);

const entries = ["packages/server/src/index.ts", "packages/server/src/routes.ts", "packages/server/src/startup.ts", "packages/cli/src/index.ts", "packages/kernel/src/production-turn-runtime.ts", "packages/kernel/src/kernel.ts", "packages/kernel/src/scce-runtime.ts", "packages/adapters-node/src/runtime.ts", "packages/adapters-node/src/workspace-runtime.ts", "packages/vscode/src/extension.ts", "packages/ui/src/index.ts"].map(p => `${repo}/${p}`).filter(p => text.has(p));
const reachable = new Set();
const stack = [...entries];
while (stack.length) {
  const f = stack.pop();
  if (reachable.has(f)) continue;
  reachable.add(f);
  for (const next of importsOf.get(f) ?? []) if (!isBarrel(next) || entries.includes(next)) stack.push(next);
  for (const m of text.get(f).matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@scce\/[a-z-]+"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(" as ")[0].trim();
      const target = definedIn.get(name);
      if (target) stack.push(target);
    }
  }
}
// Maintenance tools and harness adapters are real entry points too: they run from package.json scripts against the
// built packages, so a symbol only they call is wired, not orphaned.
const toolText = [];
const walkTools = dir => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name).replace(/\\/g, "/");
    if (e.isDirectory()) { if (e.name === "node_modules") continue; walkTools(full); }
    else if (e.name.endsWith(".mjs") || e.name.endsWith(".cjs") || e.name.endsWith(".js")) toolText.push(fs.readFileSync(full, "utf8"));
  }
};
walkTools(repo + "/tools");
const toolSource = toolText.join(String.fromCharCode(10));

const namedBy = new Map();
for (const f of reachable) {
  const t = text.get(f);
  for (const g of src) {
    if (g === f || isBarrel(g)) continue;
    for (const name of exportsOf.get(g)) {
      const key = g + "#" + name;
      if (!namedBy.has(key) && word(name).test(t)) namedBy.set(key, path.relative(repo, f).replace(/\\/g, "/"));
    }
  }
}
const rows = [];
for (const f of src) {
  if (isBarrel(f)) continue;
  const rel = path.relative(repo, f).replace(/\\/g, "/");
  const body = text.get(f);
  for (const name of exportsOf.get(f)) rows.push({ name, file: rel, caller: namedBy.get(f + "#" + name) ?? "", usedInOwnFile: body.split(word(name)).length - 1 > 1 });
}
// This file's own deliberately-unwired reasons name the very symbols they explain, and the match below reads any
// mention in tools/ as a caller -- so recording a reason silently marked the symbol reached. The reason block is
// cut out of the text being searched, or the report congratulates itself for documenting a gap.
// Comments and the deliberately-unwired reasons name the very symbols they discuss, and a mention in tools/ counts
// as a caller, so writing about a gap silently closed it -- twice, before this was noticed. Both are stripped.
const COMMENT_BLOCK = new RegExp("/\\*[\\s\\S]*?\\*/", "gu");
const COMMENT_LINE = new RegExp("(^|[^:])//.*$", "gmu");
// Line-based, not a brace-matching regex: the reasons themselves quote code containing braces, so `[^}]*` stopped at
// the first one and left the symbol names it was meant to remove in the text being searched.
const stripReasonBlock = source => {
  const lines = source.split(String.fromCharCode(10));
  const start = lines.findIndex(line => line.startsWith("const DELIBERATELY_UNWIRED = {"));
  if (start < 0) return source;
  const end = lines.findIndex((line, index) => index > start && line === "};");
  if (end < 0) return source;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join(String.fromCharCode(10));
};
const toolSourceForMatching = stripReasonBlock(toolSource)
  .replace(COMMENT_BLOCK, "")
  .replace(COMMENT_LINE, "$1");
for (const row of rows) if (!row.caller && word(row.name).test(toolSourceForMatching)) row.caller = "tools/";
const orphans = rows.filter(r => !r.caller && !r.usedInOwnFile);
const internalOnly = rows.filter(r => !r.caller && r.usedInOwnFile);
console.log("exports", rows.length, "reached", rows.length - orphans.length - internalOnly.length, "internal-only", internalOnly.length, "ORPHANS", orphans.length);
// A one-line re-export of another symbol is a named compatibility surface, not an unfinished capability.
const B = String.fromCharCode(92);
const aliasPattern = "(?:function|const)" + B + "s+NAME[^{]*" + B + "{" + B + "s*return" + B + "s+[A-Za-z_$][" + B + "w$]*" + B + "(";
for (const orphan of orphans) {
  const body = text.get(`${repo}/${orphan.file}`) ?? "";
  orphan.alias = new RegExp(aliasPattern.replace("NAME", orphan.name)).test(body);
}
// Deliberately unwired, with the reason recorded here rather than a call site invented to satisfy a count.
// An entry earns a place in this list only when wiring it would be wrong or when it waits on capability that does
// not exist yet -- never because finding its caller was inconvenient.
const DELIBERATELY_UNWIRED = {
  structuredSurface: "Produces the exact form judge.ts's looksLikeStructuredTelemetry penalises: raw JSON carrying scce.surface.candidate.v1 reaching an answer is what that guard exists to catch. Artifacts are file-shaped (FileArtifact), so there is no structured-surface channel for it either. Wiring it would create surfaces the judge is built to downrank.",
  sparseDot: "The only scorer over a SparseVector is the FTRL ranker, which already walks the entries to build the per-entry contribution breakdown its audit records, then sums that. Routing the sum through sparseDot would recompute every weight and throw the breakdown away, so the call site that looks right is strictly worse than what is there.",
  addMatrix: "Dense matrix arithmetic with no dense consumer left. The kernel's Laplacian path is sparse (graphLaplacian over CsrMatrix), and the heat/diffusion operators step vector-wise, so the natural-looking uses would materialise a dense matrix per step to replace an O(nnz) vector update.",
  scaleMatrix: "Same as addMatrix: the diffusion operators apply eta to the vector delta each step rather than scaling a matrix, and scaling one per step to match would allocate n^2 per iteration for no gain.",
  csrScale: "graphLaplacian builds the normalized and random-walk forms directly from the adjacency rather than by scaling an existing CSR, so nothing in the sparse path needs a scaled copy; adding one would mean building a matrix to hand to a function that already computes what it needs.",
  createBulkIngestBatches: "Plans byte-range batches for a bulk-copy load path that does not exist: ingestion streams per file and writes per source version inside a transaction, so there is no caller to hand a batch plan to. Building that path is the ingest-throughput work (roughly 400-500 pages/hour today, ~6s per page in writes), a measured performance project rather than a wiring, and inventing a caller here would plan batches nothing executes.",
  createCanonicalJson: "A factory returning { stringify: canonicalStringify } over a pure function every caller imports directly. There is no alternate canonical-JSON implementation to swap in and canonical form is a contract rather than a policy, so introducing an injection port to consume it would add indirection that enables nothing.",
  createAlignmentEngine: "An IBM Model 1-style lexical aligner that trains from a parallel corpus of sentence pairs, and this system has no parallel corpus to train it on. The production translation lane is translationEngine.plan, which writes its own TranslationAlignmentRecords from each turn (putTranslationAlignment, production-turn-runtime) and reads them back as priorAlignments, so alignments accumulate from the system's own translations rather than from a bilingual corpus. Wiring this engine would add a second, competing alignment trainer fed by nothing.",
  clusterLanguageProfiles: "Merges MultilingualLanguageProfile records sharing a sourceClusterId. The production translation lane carries LanguageProfile from language memory, a different type built by a different path, so there is no set of these profiles anywhere in the runtime to cluster -- only translation.ts's own pairwise buildLanguageProfile calls, which produce exactly two and share no cluster.",
  createEvaluationCacheKey: "Binds brain, corpus, source and build hashes alongside the condition, which is the sealed harness's durable cache contract. The in-process graph-slice cache holds none of those and is namespaced by currentEvaluationCacheOwner instead; supplying blanks for the four identity hashes to reach this function would weaken a stronger contract to satisfy a count.",
  scoreRelationPotential: "Validates the model on every call, which is right for a single score and wrong for the only production use: scoreGraphEdgesWithRelationPotential freezes the model once and scores every edge against it. Routing that loop through here would re-validate per edge. Relation promotion, the other place a potential score would fit, decides by description length rather than by this model.",
  createPredictionConstruct: "Requires a predictedSurface, and nothing in the runtime produces one. The turn computes forecast states and envelopes over the alpha trace, which are numeric, and turning a forecast into a stated surface needs the construction grammar that has never promoted from this corpus. The missing half is generation, not a call site.",
  predictionConstructNode: "Projects a PredictionConstruct into a construct graph node, so it cannot be reached before a prediction construct exists; see createPredictionConstruct."
};
for (const orphan of orphans) {
  const reason = DELIBERATELY_UNWIRED[orphan.name];
  if (reason) orphan.deliberatelyUnwired = reason;
}
// An export the codebase itself marks @deprecated is a named compatibility surface being kept for callers, not
// unfinished capability. The structural check above only catches `return otherFunction(`, so it misses the two
// shapes this repository actually uses -- an object-literal wrapper (createPersonalizedPerronFrobenius returns
// { rank, rankDetailed }) and a forwarding method. The tag is explicit and deliberate, so it is the better signal.
for (const orphan of orphans) {
  if (orphan.alias) continue;
  const body = text.get(`${repo}/${orphan.file}`) ?? "";
  const declaration = new RegExp("@deprecated[^*]*(?:[*](?!/)[^*]*)*[*]/[\\s\\S]{0,160}?(?:function|const)\\s+" + orphan.name + "\\b", "u");
  orphan.alias = declaration.test(body);
}
const aliases = orphans.filter(o => o.alias).length;
const contracts = orphans.filter(o => /^[A-Z][A-Z0-9_]+$/.test(o.name)).length;
const legacy = orphans.filter(o => /scce2|\/v2-/i.test(o.file)).length;
// A symbol the host calls, not us: the VS Code extension host owns activate/deactivate and nothing in this
// repository may call them. Counting them as unfinished capability asks for a call site that would be a bug.
for (const orphan of orphans) orphan.hostContract = /packages[/]vscode[/]/.test(orphan.file) && /^(activate|deactivate)$/.test(orphan.name);
// A helper a test imports is reached, just not from a runtime entry point. Verified by finding the import rather
// than trusting the name, so a ForTest suffix on something no test uses still counts as unfinished.
const testSources = files.filter(file => /__tests__|[.]test[.]ts$/.test(file)).map(file => fs.readFileSync(file, "utf8")).join(String.fromCharCode(10));
// Imported by name in a test, not merely mentioned in one. A word-match here would count any test that happens to
// use the same identifier for a local, which is the exact false positive that makes the orphan count a lower bound
// everywhere else; understating unfinished work is the more damaging direction of that error.
const importedByName = (source, name) => new RegExp(
  "import[^;]*[{,]\\s*" + name + "\\s*[,}][^;]*from", "u").test(source);
for (const orphan of orphans) orphan.testOnly = !orphan.hostContract && importedByName(testSources, orphan.name);
const hostContracts = orphans.filter(o => o.hostContract).length;
// Every count below partitions the same set -- the orphans left after contracts, aliases, legacy and host
// contracts are removed. Counting test-only over all orphans instead double-counted the ones that are also
// aliases or constants, and the no-caller remainder went negative.
const classified = orphan => orphan.alias || orphan.hostContract || /^[A-Z][A-Z0-9_]+$/.test(orphan.name) || /scce2|[/]v2-/i.test(orphan.file);
const unwiredSet = orphans.filter(orphan => !classified(orphan));
const testOnly = unwiredSet.filter(o => o.testOnly).length;
const deliberate = unwiredSet.filter(o => o.deliberatelyUnwired).length;
const noCallerAnywhere = unwiredSet.filter(o => !o.testOnly && !o.deliberatelyUnwired).length;
console.log("of which contracts", contracts, "aliases", aliases, "legacy/migration", legacy, "host contracts", hostContracts, "test-only", testOnly, "unwired", unwiredSet.length, "of which no caller anywhere", noCallerAnywhere, "deliberately unwired", deliberate);
fs.writeFileSync(`${repo}/docs/RUNTIME_REACHABILITY.json`, JSON.stringify({
 generatedAt: new Date().toISOString(),
 method: "word-match over source reachable from the real entry points; a name shared with a method or local elsewhere reads as reached, so the orphan count is a lower bound",
 totals: {
  exports: rows.length,
  reached: rows.length - orphans.length - internalOnly.length,
  internalHelpersOnly: internalOnly.length,
  orphans: orphans.length,
  declaredConstants: contracts,
  compatibilityAliases: aliases,
  legacyMigration: legacy,
  hostContracts,
  testOnlyHelpers: testOnly,
  implementedButUncalled: unwiredSet.length,
  ofWhichCoveredByTestsOnly: testOnly,
  ofWhichNoCallerAnywhere: noCallerAnywhere,
  ofWhichDeliberatelyUnwired: deliberate
 },
 orphans
}, null, 1));
const by = new Map();
for (const o of orphans) if (!/^[A-Z][A-Z0-9_]+$/.test(o.name) && !/scce2|\/v2-/i.test(o.file)) by.set(o.file, [...(by.get(o.file) ?? []), o.name]);
for (const [f, n] of [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 200)) console.log(String(n.length).padStart(2), f.replace("packages/", "").replace("/src/", "/"), "::", n.join(", "));

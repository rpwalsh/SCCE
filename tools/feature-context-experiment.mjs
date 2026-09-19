// Does handing induce() a corpus-wide feature context buy time, and what does it do to the model?
// Three arms over the same real scce4 documents:
//   A  today's path: population supplied, context derived from the batch (two lattice passes)
//   B  new path: population AND corpus context supplied (one lattice pass, priors route)
//   C  control: nothing supplied, induce fits everything (what ingest did before consolidation)
import { readScceRuntimeConfig, createNodeRuntime } from "../packages/adapters-node/dist/index.js";
import {
  createLanguageInductionEngine,
  createBoundaryFeatureContextAccumulator,
  observeLatticesForFeatureContext,
  compileAccumulatedBoundaryFeatureContext,
  buildSurfaceLattice,
  evidenceToLanguageDocument,
  boundedInductionDocuments,
  loadFittedPopulation,
  createHasher
} from "../packages/kernel/dist/index.js";

const config = await readScceRuntimeConfig(process.env.SCCE_CONFIG ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const hasher = createHasher();

const wanted = Number(process.argv[2] ?? 60);
const docs = [];
let afterId;
while (docs.length < wanted) {
  const page = await runtime.storage.evidence.listPromotedEvidenceSpans({
    limit: 200, ...(afterId ? { afterId } : {})
  });
  if (!page.length) break;
  afterId = String(page[page.length - 1].id);
  for (const span of page) {
    if (!span.text.trim()) continue;
    const bounded = boundedInductionDocuments([evidenceToLanguageDocument(span)])[0];
    if (bounded) docs.push(bounded);
    if (docs.length >= wanted) break;
  }
  if (page.length < 200) break;
}
const fitted = await loadFittedPopulation(runtime.storage.segmentationPopulations);
if (!fitted) throw new Error("no consolidated population on file; run scce db consolidate first");
console.log(`${docs.length} documents, population ${fitted.id.slice(0, 44)}`);

// The corpus-wide context: accumulated over a WIDER slice than the batch being induced, which is the point.
const wideDocs = [];
afterId = undefined;
while (wideDocs.length < docs.length * 4) {
  const page = await runtime.storage.evidence.listPromotedEvidenceSpans({
    limit: 200, ...(afterId ? { afterId } : {})
  });
  if (!page.length) break;
  afterId = String(page[page.length - 1].id);
  for (const span of page) {
    if (!span.text.trim()) continue;
    const bounded = boundedInductionDocuments([evidenceToLanguageDocument(span)])[0];
    if (bounded) wideDocs.push(bounded);
    if (wideDocs.length >= docs.length * 4) break;
  }
  if (page.length < 200) break;
}
const accumulator = createBoundaryFeatureContextAccumulator();
for (let index = 0; index < wideDocs.length; index += 20) {
  const window = wideDocs.slice(index, index + 20);
  observeLatticesForFeatureContext(accumulator, window.map(doc => buildSurfaceLattice({
    documentId: doc.id, text: doc.text, sourceVersionId: doc.sourceVersionId,
    evidenceIds: doc.evidenceIds, hasher
  })));
}
const corpusContext = compileAccumulatedBoundaryFeatureContext(accumulator, hasher);
console.log(
  `corpus context: ${corpusContext.sourceDocumentCount} documents, `
  + `${Object.keys(corpusContext.documentCountBySurfaceFormClass).length} classes, `
  + `${Object.keys(corpusContext.classCountByBoundaryContext).length} contexts`
);

function run(label, options) {
  const engine = createLanguageInductionEngine({ hasher });
  const started = Date.now();
  const model = engine.induce({ documents: docs.map(d => ({ ...d })), ...options });
  const ms = Date.now() - started;
  const units = model.ngrams.length;
  const shape = {
    ms,
    ngrams: units,
    symbols: model.symbolCount,
    vocabulary: model.vocabularySize,
    constructions: model.graphBoundConstructions.length,
    frames: model.semanticFrames?.length ?? 0,
    // The segmentation itself, as the set of distinct n-gram symbols -- this is what a change in features moves.
    symbolDigest: hasher.digestHex(JSON.stringify(
      [...new Set(model.ngrams.map(n => n.symbol))].sort()
    )).slice(0, 16)
  };
  // Tokens per type: the corpus's own compression ratio. Fewer tokens for the same text at equal or smaller
  // vocabulary is a shorter description, which is the criterion this codebase selects on everywhere else.
  const ratio = (shape.symbols / Math.max(1, shape.vocabulary)).toFixed(3);
  console.log(`${label.padEnd(34)} ${String(ms).padStart(7)}ms  tokens=${String(shape.symbols).padStart(6)}  vocab=${String(shape.vocabulary).padStart(5)}  tokens/type=${ratio}  constructions=${String(shape.constructions).padStart(4)}`);
  return shape;
}

const a = run("A batch context (today)", { fittedPopulation: fitted });
const b = run("B corpus context (one pass)", { fittedPopulation: fitted, boundaryFeatureContext: corpusContext });
const c = run("C no population (pre-consolidation)", {});

console.log("");
console.log(`time  B vs A: ${(b.ms / a.ms).toFixed(2)}x   B vs C: ${(b.ms / c.ms).toFixed(2)}x`);
console.log(`segmentation identical A==B: ${a.symbolDigest === b.symbolDigest}`);
console.log(`tokens B-A: ${b.symbols - a.symbols} (${(100*(b.symbols-a.symbols)/a.symbols).toFixed(1)}%)   vocab B-A: ${b.vocabulary - a.vocabulary}`);
console.log(`tokens/type  A ${(a.symbols/a.vocabulary).toFixed(3)}  B ${(b.symbols/b.vocabulary).toFixed(3)}  C ${(c.symbols/c.vocabulary).toFixed(3)}`);
process.exit(0);

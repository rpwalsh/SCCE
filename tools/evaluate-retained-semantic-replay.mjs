// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Read-only: evaluates a corpus-compiled relation plan against retained source evidence.
import { createPostgresStorageAdapter, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { constructionSourceExampleStorageJson as exactJson } from "../packages/kernel/dist/construction-source-example-storage.js";
import { createHasher } from "../packages/kernel/dist/primitives.js";
import { lexicalSurfaceSymbols, sentenceSegments } from "../packages/kernel/dist/semantic-induction-factors.js";
import { compileRelationHypothesisModel, inferRelationHypotheses } from "../packages/kernel/dist/relation-hypothesis.js";
import { compileSemanticRelationReplayV2, replaySemanticRelationsFromTrainingV2 }
  from "../packages/kernel/dist/semantic-relation-replay-v2.js";

const args = Object.fromEntries(process.argv.slice(2).map(raw => {
  const [key, ...rest] = raw.replace(/^--/u, "").split("="); return [key, rest.join("=")];
}));
const configPath = args.config ?? ".scce/brain-5gb-20261111-r004.json";
const sourceSystem = args.source ?? "gutenberg";
const limit = Number(args.limit ?? 64);
const title = args.title ?? "a clockwork orange (novel)";
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw Error("limit must be 1..512");
const hasher = createHasher();

function factorsFromEvidence(rows) {
  const documents = rows.map(row => ({ id: row.id, sourceId: row.source_id, evidenceIds: [row.id],
    trust: Number(row.alpha), sourceWindow: { ownerDocumentId: row.source_version_id,
      startUtf16: Number(row.char_start), endUtf16: Number(row.char_start) + row.text.length } }));
  const sentences = rows.flatMap((row, documentIndex) => sentenceSegments(row.text, hasher).map((sentence, ordinal) => ({
    documentIndex, sentence, symbols: lexicalSurfaceSymbols(sentence, `${row.id}.retained.${ordinal}`, hasher)
      .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char))), hypotheses: []
  })));
  const material = { schema: "scce.semantic_induction_factors.v1", maxFrames: 2048, trackSourceWindows: true,
    lexicalClasses: [], documents, sentences };
  return { ...material, digest: hasher.digestHex(exactJson(material)) };
}

function targetFactors(row) {
  const sentence = sentenceSegments(row.text_preview, hasher)[0];
  if (!sentence) throw Error("target evidence has no sentence");
  const symbols = lexicalSurfaceSymbols(sentence, row.id, hasher)
    .filter(symbol => ![...symbol].every(char => /\p{Punctuation}/u.test(char)));
  const material = { schema: "scce.semantic_induction_factors.v1", maxFrames: 16, trackSourceWindows: true,
    lexicalClasses: [], documents: [{ id: row.id, sourceId: row.source_id, evidenceIds: [row.id],
      trust: Number(row.alpha), sourceWindow: { ownerDocumentId: row.source_version_id,
        startUtf16: Number(row.char_start), endUtf16: Number(row.char_start) + sentence.length } }],
    sentences: [{ documentIndex: 0, sentence, symbols, hypotheses: [] }] };
  return { ...material, digest: hasher.digestHex(exactJson(material)) };
}

const config = await readScceRuntimeConfig(configPath);
const storage = createPostgresStorageAdapter({ ...config.database, informationAccess: config.security?.informationAccess });
try {
  const retained = await storage.query(`SELECT evidence.id,evidence.source_id,evidence.source_version_id,
      evidence.char_start,evidence.alpha,CASE WHEN octet_length(blob.content)>0 THEN blob.content
        ELSE substring(parent.content FROM (blob.range_start+1)::integer FOR (blob.range_end-blob.range_start)::integer) END AS content,
      blob.byte_length
    FROM ${storage.table("evidence_spans")} evidence JOIN ${storage.table("blobs")} blob
      ON blob.content_hash=evidence.content_hash
    LEFT JOIN ${storage.table("blobs")} parent ON parent.content_hash=blob.range_parent_hash
    WHERE evidence.status='promoted' AND evidence.provenance_json->>'sourceSystem'=$1
    ORDER BY evidence.source_id,evidence.char_start,evidence.id LIMIT $2`, [sourceSystem, limit]);
  const corpus = retained.map(row => ({ ...row, text: row.content.toString("utf8") }));
  if (!corpus.length) throw Error(`retained corpus unavailable: ${sourceSystem}`);
  const training = factorsFromEvidence(corpus);
  const evidence = (await storage.query(`SELECT id,source_id,source_version_id,char_start,text_preview,alpha
    FROM ${storage.table("evidence_spans")} WHERE lower(source_title)=lower($1) ORDER BY char_start LIMIT 1`, [title]))[0];
  if (!evidence) throw Error(`target evidence unavailable: ${title}`);
  const target = targetFactors(evidence);
  const plan = compileSemanticRelationReplayV2({ factors: training, hasher });
  const result = replaySemanticRelationsFromTrainingV2({ trainingFactors: training, targetFactors: target, hasher });
  const originalModel = compileRelationHypothesisModel({ hasher, observations: training.sentences.map(row => ({
    sourceId: training.documents[row.documentIndex].sourceId, symbols: row.symbols,
    evidenceIds: training.documents[row.documentIndex].evidenceIds
  })) });
  const originalHypotheses = inferRelationHypotheses({ symbols: target.sentences[0].symbols, model: originalModel,
    candidate: surface => /\p{Letter}/u.test(surface) });
  const wanted = new Set(["a", "by", "is", "write", "writer", "writes", "wrote", "written"]);
  console.log(JSON.stringify({ training: { sourceSystem, requestedEvidenceSpans: limit, loadedEvidenceSpans: corpus.length,
    retainedBytes: corpus.reduce((sum, row) => sum + Number(row.byte_length), 0),
    documents: training.documents.length, sentences: training.sentences.length },
  target: { title, sentence: target.sentences[0].sentence, symbols: target.sentences[0].symbols },
  selectedStatistics: plan.statistics.filter(row => wanted.has(row.surface.toLowerCase())),
  originalHypotheses: originalHypotheses.slice(0, 8).map(row => ({ surface: row.surface, posterior: row.posterior })),
  relations: result.relations.map(row => ({ predicate: row.predicate.surface,
    roles: row.roles.map(role => role.surface), confidence: row.confidence })),
  abstained: result.abstainedSentenceIndices }, null, 2));
} finally {
  await storage.close();
}

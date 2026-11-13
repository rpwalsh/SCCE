import { createHmac } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonical, safeRelative } from '../protocol.mjs';
import { sha256Bytes } from '../../sealed-eval/harness/lib/util.mjs';
import { generateClozeQuestions } from '../../sealed-eval/harness/generate-cloze-questions.mjs';
import { containedFile } from '../adapters/native-contract.mjs';
import { retainedSourceBindings } from '../adapters/retained-sources.mjs';

export async function loadRetainedCorpus(manifestFile) {
  manifestFile = path.resolve(manifestFile);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (manifest.schemaVersion !== '1.0' || typeof manifest.language !== 'string' || !manifest.language
    || !Array.isArray(manifest.documents) || !manifest.documents.length) throw new Error('Invalid retained corpus manifest');
  const documents = [], ids = new Set();
  for (const document of manifest.documents) {
    if (!document || typeof document.documentId !== 'string' || !document.documentId || ids.has(document.documentId)
      || !safeRelative(document.path) || !/^[a-f0-9]{64}$/u.test(document.sha256) || document.language !== manifest.language) throw new Error('Invalid retained corpus document identity');
    ids.add(document.documentId);
    const file = await containedFile(path.dirname(manifestFile), document.path), bytes = await readFile(file);
    if (sha256Bytes(bytes) !== document.sha256 || bytes.length !== document.sizeBytes) throw new Error('Retained corpus document hash differs');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Retained corpus text differs from UTF-8 bytes');
    const owner = document.metadata;
    const binding = { id: document.documentId, sourceId: owner?.sourceId, sourceVersionId: owner?.sourceVersionId,
      contentHash: `sha256_${document.sha256}`, canonicalUri: owner?.canonicalUri, evidenceIds: owner?.evidenceIds };
    retainedSourceBindings({ steps: [{ sources: [{ id: binding.id, text }] }] }, {
      operation: 'turn', requestedAuthority: 'factual', retainedSources: { schema: 'scce.blind-retained-sources.v1', sources: [binding] } });
    documents.push({ ...document, file, text, binding });
  }
  return { manifestFile, manifest, documents,
    inventory: { schema: 'scce.blind-retained-cloze-inventory.v1', formalLanguages: [], naturalLanguages: [manifest.language],
      cells: [{ category: 'corpus_facts', language: manifest.language, grading: 'semantic' }],
      scope: 'Retained-source cloze retrieval only; not general factual reasoning, chat, creative, coding, or action qualification.' } };
}

export async function createRetainedPool(options) {
  if (!Number.isSafeInteger(options.count) || options.count < 1 || !options.seed) throw new Error('Retained cloze selection requires a positive count and post-freeze seed');
  const corpus = await loadRetainedCorpus(options.retainedCorpusFile);
  const generated = await generateClozeQuestions({ corpusManifest: corpus.manifestFile, perDocument: options.count, seed: options.seed });
  const documents = new Map(corpus.documents.map(document => [document.documentId, document]));
  const rank = value => createHmac('sha256', options.seed).update(canonical(value)).digest('hex');
  const candidates = generated.questions.filter(question => question.category === 'cloze').map(question => {
    const provenance = generated.provenance.find(row => row.questionId === question.questionId);
    const document = documents.get(provenance?.documentId);
    if (!document || document.text.slice(provenance.answerStart, provenance.answerEnd) !== provenance.answer
      || question.gold.acceptedAnswers.length !== 1 || question.gold.acceptedAnswers[0] !== provenance.answer) throw new Error('Retained cloze provenance differs');
    return { question, provenance, document, id: rank([document.sha256, question.questionId]) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (candidates.length < options.count) throw new Error('Insufficient retained source cloze candidates; no synthetic questions substituted');
  const rows = candidates.slice(0, options.count).map(({ question, provenance, document, id }) => {
    const contract = { schema: 'scce.blind-native-task.v1', operation: 'turn', maxPublicAttempts: 1,
      writablePaths: [], publicChecks: [], approvals: [], requestedAuthority: 'factual', answerMode: 'answer_or_abstain',
      responseInstruction: 'Return only the missing source span for the blank. Preserve its exact spelling.',
      retainedSources: { schema: 'scce.blind-retained-sources.v1', sources: [document.binding] } };
    const packet = { outputContract: canonical(contract), steps: [{ prompt: question.prompt, sources: [{ id: document.documentId, text: document.text }], files: {} }] };
    if (Buffer.byteLength(canonical(packet)) > options.budgets.caseBytes) throw new Error('Retained public packet exceeds shared case byte budget');
    return { id, category: 'corpus_facts', language: corpus.manifest.language, grading: 'semantic', public: packet,
      private: { kind: 'semantic', expected: [{ status: 'answered', answer: provenance.answer }],
        family: 'retained_source_cloze', provenance: { ...provenance, documentSha256: document.sha256 } } };
  });
  await mkdir(options.privateRoot, { recursive: true });
  const poolFile = path.join(options.privateRoot, 'pool.jsonl');
  await writeFile(poolFile, rows.map(canonical).join('\n') + '\n', { flag: 'wx' });
  return { poolFile, cases: rows.length, familyCounts: { retained_source_cloze: rows.length } };
}

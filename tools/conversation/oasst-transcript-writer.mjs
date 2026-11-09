// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify, sha256Bytes } from '../sealed-eval/harness/lib/util.mjs';
import { fileHash } from '../blind-comparison/protocol.mjs';
import { validateDeclaredTranscriptSource } from '../../packages/kernel/dist/dialogue-communicative-act-learning.js';

/** Output framing only: eligibility and source-path selection belong to prepareOasst. */
export function createOasstTranscriptWriter({ out, locale, packing, signal }) {
  const documents = []; let current, ordinal = 0;
  const encoded = document => Buffer.from(`${stableStringify(document)}\n`);
  async function emit(document, descriptor) {
    signal?.throwIfAborted(); validateDeclaredTranscriptSource(document);
    const bytes = encoded(document);
    if (packing && (bytes.length > packing.maxSerializedBytes || Buffer.byteLength(document.text) > packing.maxTextBytes)) throw Error('Complete source path exceeds declared packing bounds');
    const relativePath = `train/${locale}/${packing ? `oasst-${String(ordinal++).padStart(6, '0')}` : descriptor.id}.json`;
    const file = path.join(out, relativePath); await writeFile(file, bytes, { flag: 'wx' });
    const sha256 = await fileHash(file);
    if (sha256 !== sha256Bytes(bytes)) throw Error('Prepared transcript changed during publication');
    documents.push({ locale, relativePath, sha256, ...descriptor.identity, turns: document.turns.length,
      codePoints: [...document.text].length, textSha256: sha256Bytes(Buffer.from(document.text)),
      ...(packing ? { sourcePaths: document.sourceMetadata.conversations.length, serializedBytes: bytes.length, textBytes: Buffer.byteLength(document.text) } : {}) });
  }
  function append(base, document, rawMetadata) {
    const prefix = base.text ? `${base.text}\n\n` : '', pointOffset = [...prefix].length, turnOffset = base.turns.length;
    const turns = document.turns.map((turn, index) => ({ ...turn, index: turnOffset + index,
      startCodePoint: pointOffset + turn.startCodePoint, endCodePoint: pointOffset + turn.endCodePoint,
      sourceRecordId: document.sourceMetadata.lineage[index].id, sourceFamilyId: document.sourceMetadata.rootMessageId,
      ...(turn.replyToTurnIndex === undefined ? {} : { replyToTurnIndex: turnOffset + turn.replyToTurnIndex }) }));
    const lineage = document.sourceMetadata.lineage.map((row, index) => ({ ...row,
      preparedDocumentCodePointRange: row.normalizedDocumentCodePointRange,
      normalizedDocumentCodePointRange: [turns[index].startCodePoint, turns[index].endCodePoint], rawSourceMetadata: rawMetadata[index] }));
    return { ...base, text: prefix + document.text, turns: [...base.turns, ...turns], sourceMetadata: { ...base.sourceMetadata,
      lineage: [...base.sourceMetadata.lineage, ...lineage], conversations: [...base.sourceMetadata.conversations, {
        rootMessageId: document.sourceMetadata.rootMessageId, replyMessageId: document.sourceMetadata.replyMessageId,
        turnRange: [turnOffset, turnOffset + document.turns.length], textRange: [pointOffset, pointOffset + [...document.text].length],
        transcriptSha256: sha256Bytes(encoded(document)) }] } };
  }
  function empty(document) {
    // The archive/capture/license identity is shared once per canonical output
    // source. Each message's raw fields occur once in its owned lineage entry.
    const { rootMessageId, replyMessageId, lineage, ...shared } = document.sourceMetadata;
    return { schema: document.schema, text: '', turns: [], sourceMetadata: { ...shared,
      packing: { schema: 'scce.oasst_transcript_packing.v1', ...packing, interConversationReplyEdges: false }, conversations: [], lineage: [] } };
  }
  return {
    documents,
    async add(document, rawMetadata) {
      if (!packing) {
        const { rootMessageId, replyMessageId } = document.sourceMetadata;
        await emit(document, { id: sha256Bytes(Buffer.from(stableStringify([rootMessageId, replyMessageId]))), identity: { rootMessageId, replyMessageId } }); return;
      }
      current ??= empty(document);
      let next = append(current, document, rawMetadata);
      if (encoded(next).length > packing.maxSerializedBytes || Buffer.byteLength(next.text) > packing.maxTextBytes) {
        if (current.turns.length) await emit(current, { identity: {} });
        current = empty(document); next = append(current, document, rawMetadata);
        if (encoded(next).length > packing.maxSerializedBytes || Buffer.byteLength(next.text) > packing.maxTextBytes) throw Error('Complete source path exceeds declared packing bounds');
      }
      current = next;
    },
    async finish() { if (current?.turns.length) { await emit(current, { identity: {} }); current = undefined; } return documents; }
  };
}

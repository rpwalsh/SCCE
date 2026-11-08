// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, SOURCE_REFERENCE_BINDING_SCHEMA, toJsonValue, type SourceReferenceBindingDeclaration } from "@scce/kernel";
import type { LanguageCorpusTrainingInput } from "./language-corpus-trainer.js";

export interface CorefUDSourceOwner {
  corpusId: string;
  sourceUri: string;
  artifactSha256: string;
  declaredLicense: string;
  attribution: string;
  sourceOrigin: "human-corpus" | "test-authored-fixture";
}

export interface CorefUDSourceIssue {
  code: string;
  documentId: string;
  line: number;
  sourceEntityId?: string;
}

interface Word {
  id: string; form: string; misc: Record<string, string>; line: number;
  tags: Record<string, string>; start?: number; end?: number; unsupported?: string;
}
interface Sentence { id: string; text?: string; words: Word[]; line: number }
interface OpenMention { entity: string; rawEntity: string; start: number; line: number; tags: Record<string, string>; discontinuous: boolean }
interface Mention extends OpenMention { end: number }

/** Decode declared annotations only; no surface equality, annotation tags or token order infer a referent. */
export function readCorefUDSource(input: { text: string; owner: CorefUDSourceOwner }) {
  const hasher = createHasher();
  if (hasher.digestHex(input.text) !== input.owner.artifactSha256) throw new Error("coreference artifact hash does not match its source owner");
  const documents: Array<ReturnType<typeof projectDocument>> = [];
  const seenDocuments = new Set<string>();
  let fields: string[] = [];
  let documentId: string | undefined;
  let sentences: Sentence[] = [];
  let sentence: Sentence = { id: "", words: [], line: 1 };
  const flushSentence = () => { if (sentence.words.length || sentence.text !== undefined) sentences.push(sentence); sentence = { id: "", words: [], line: sentence.line }; };
  const flushDocument = () => {
    flushSentence();
    if (sentences.length) {
      if (!documentId) throw new Error("coreference annotations require an explicit source document id");
      if (seenDocuments.has(documentId)) throw new Error(`duplicate source document id: ${documentId}`);
      seenDocuments.add(documentId);
      documents.push(projectDocument(documentId, sentences, fields, input.owner));
    }
    sentences = [];
  };
  for (const [index, raw] of input.text.split(/\r?\n/u).entries()) {
    const line = index + 1;
    if (!raw) { flushSentence(); sentence.line = line + 1; continue; }
    const global = /^# global\.Entity = (.+)$/u.exec(raw);
    if (global) { fields = global[1]!.split("-"); continue; }
    const nextDocument = /^# newdoc id = (.+)$/u.exec(raw);
    if (nextDocument) { flushDocument(); documentId = nextDocument[1]!; continue; }
    const id = /^# sent_id = (.+)$/u.exec(raw);
    if (id) { sentence.id = id[1]!; continue; }
    const text = /^# text = (.*)$/u.exec(raw);
    if (text) { sentence.text = text[1]!.normalize("NFC"); continue; }
    if (raw.startsWith("#")) continue;
    const columns = raw.split("\t");
    if (columns.length !== 10) throw new Error(`invalid CoNLL-U column count at source line ${line}`);
    sentence.words.push({ id: columns[0]!, form: columns[1]!.normalize("NFC"), line,
      misc: attributes(columns[9]!), tags: { lemma: columns[2]!, upos: columns[3]!, xpos: columns[4]!, feats: columns[5]!, head: columns[6]!, deprel: columns[7]!, deps: columns[8]! } });
  }
  flushDocument();
  return { schema: "scce.corefud_source_projection.v1" as const, inputKind: "source-annotated-only" as const,
    rawTextInference: "unavailable" as const, owner: input.owner, documents };
}

export type CorefUDSourceDocument = ReturnType<typeof readCorefUDSource>["documents"][number];

/** Keep the original annotation artifact distinct from its exact NFC document projection. */
export function prepareCorefUDSourceTrainingMaterial(document: CorefUDSourceDocument):
  Pick<LanguageCorpusTrainingInput, "text" | "sourceUri" | "mediaType" | "corpusMetadata" | "acquisitionProvenance"> {
  if (createHasher().digestHex(document.text) !== document.declaration.sourceTextHash) throw new Error("coreference projected source text changed");
  return { text: document.text, sourceUri: document.sourceUri, mediaType: "text/plain",
    corpusMetadata: toJsonValue({ sourceMetadata: { sourceReferenceBindings: document.declaration,
      coreferenceSource: { schema: "scce.corefud_source_projection.v1", inputKind: "source-annotated-only",
        originalArtifact: document.owner, originalDocumentId: document.documentId,
        transformId: "scce.corefud_nfc_sentence_projection.v1", projectedTextHash: document.declaration.sourceTextHash,
        issues: document.issues, unlinkedAnnotations: document.unlinkedAnnotations, rawTextInference: "unavailable" } } }),
    acquisitionProvenance: toJsonValue({ originalArtifact: document.owner, originalDocumentId: document.documentId }) };
}

/** Artifact revisions and alternate file splits cannot make the same original document held out. */
export function assertCorefUDSourceDisjoint(training: readonly CorefUDSourceDocument[], heldOut: readonly CorefUDSourceDocument[]): void {
  const identities = new Set(training.map(document => JSON.stringify([document.corpusId, document.documentId])));
  for (const document of heldOut) if (identities.has(JSON.stringify([document.corpusId, document.documentId]))) throw new Error(`coreference source-document overlap: ${document.corpusId}/${document.documentId}`);
}

function attributes(text: string): Record<string, string> {
  if (text === "_") return {};
  return Object.fromEntries(text.split("|").map(part => { const split = part.indexOf("="); return split < 0 ? [part, ""] : [part.slice(0, split), part.slice(split + 1)]; }));
}

function projectDocument(documentId: string, sentences: Sentence[], fields: string[], owner: CorefUDSourceOwner) {
  const hasher = createHasher();
  const issues: CorefUDSourceIssue[] = [];
  const issue = (code: string, line: number, sourceEntityId?: string) => issues.push({ code, documentId, line, ...(sourceEntityId ? { sourceEntityId } : {}) });
  if (!fields.includes("eid") && !fields.includes("GRP")) throw new Error("coreference annotations require their declared Entity field schema");
  const entityField = fields.includes("eid") ? fields.indexOf("eid") : fields.indexOf("GRP");
  let text = "";
  let unrepresentedSurfaceAnnotation = false;
  const words: Word[] = [];
  for (const sentence of sentences) {
    if (sentence.text === undefined) throw new Error(`source sentence has no exact text: ${documentId}/${sentence.id}`);
    if (text) text += "\n";
    const base = text.length;
    text += sentence.text;
    const spans = new Map<string, { start: number; end: number }>();
    const multiwordChildren = new Set<string>();
    let cursor = 0;
    let aligned = true;
    for (const word of sentence.words) {
      if (/^\d+\.\d+$/u.test(word.id)) { word.unsupported = "empty_node"; continue; }
      if (multiwordChildren.has(word.id)) { word.unsupported = "multiword_boundary"; continue; }
      const range = /^(\d+)-(\d+)$/u.exec(word.id);
      if (range) for (let child = Number(range[1]); child <= Number(range[2]); child++) multiwordChildren.add(String(child));
      while (cursor < sentence.text.length && /\s/u.test(sentence.text[cursor]!)) cursor++;
      if (!sentence.text.startsWith(word.form, cursor)) { aligned = false; break; }
      if (!range) spans.set(word.id, { start: base + cursor, end: base + cursor + word.form.length });
      cursor += word.form.length;
    }
    if (aligned && sentence.text.slice(cursor).trim()) aligned = false;
    if (!aligned) issue("source_text_alignment_failed", sentence.line);
    for (const word of sentence.words) {
      if (/^\d+-\d+$/u.test(word.id)) {
        if (word.misc.Entity !== undefined) { unrepresentedSurfaceAnnotation = true; issue("entity_on_multiword_surface", word.line); }
        continue;
      }
      const span = aligned ? spans.get(word.id) : undefined;
      if (span) Object.assign(word, span);
      if (!aligned) word.unsupported = "source_text_alignment_failed";
      words.push(word);
    }
  }
  const open = new Map<string, OpenMention[]>();
  const mentions: Mention[] = [];
  const incomplete = new Set<string>();
  const declared = new Set<string>();
  let unlinkedAnnotations = 0;
  const baseEntity = (entity: string) => entity.replace(/\[\d+\/\d+\]$/u, "");
  const isUnlinked = (entity: string) => entity === "NOCOREF" || entity.startsWith("NOCOREF:");
  const close = (rawEntity: string, end: number, line: number) => {
    const active = open.get(rawEntity)?.pop();
    if (active) mentions.push({ ...active, end });
    else { incomplete.add(baseEntity(rawEntity)); issue("orphan_entity_close", line, baseEntity(rawEntity)); }
  };
  for (const [index, word] of words.entries()) {
    const marker = word.misc.Entity;
    if (marker === undefined) continue;
    let cursor = 0;
    while (cursor < marker.length) {
      if (marker[cursor] === "(") {
        const from = ++cursor;
        while (cursor < marker.length && marker[cursor] !== "(" && marker[cursor] !== ")") cursor++;
        const values = marker.slice(from, cursor).split("-");
        const rawEntity = values[entityField];
        if (!rawEntity) throw new Error(`empty declared entity id at source line ${word.line}`);
        const entity = baseEntity(rawEntity);
        const sourceTags = Object.fromEntries(fields.map((field, at) => [field, values[at] ?? ""]));
        const active = { entity, rawEntity, start: index, line: word.line, tags: sourceTags, discontinuous: entity !== rawEntity };
        open.set(rawEntity, [...(open.get(rawEntity) ?? []), active]);
        if (isUnlinked(entity)) unlinkedAnnotations++;
        else declared.add(entity);
        if (marker[cursor] === ")") { close(rawEntity, index, word.line); cursor++; }
      } else {
        const end = marker.indexOf(")", cursor);
        if (end < 0) throw new Error(`unclosed Entity marker syntax at source line ${word.line}`);
        close(marker.slice(cursor, end), index, word.line);
        cursor = end + 1;
      }
    }
  }
  for (const active of open.values()) for (const mention of active) {
    incomplete.add(mention.entity); issue("unclosed_entity_mention", mention.line, mention.entity);
  }
  const points = new Map<number, number>();
  let unit = 0, point = 0;
  for (const character of text) { points.set(unit, point++); unit += character.length; }
  points.set(unit, point);
  const sourceUri = owner.sourceUri + "#newdoc=" + encodeURIComponent(documentId);
  const referentId = (entity: string) => "source.referent." + hasher.digestHex(JSON.stringify([sourceUri, entity]));
  const projected = mentions.flatMap((mention, index) => {
    if (isUnlinked(mention.entity)) return [];
    const first = words[mention.start]!, last = words[mention.end]!;
    const unsupported = mention.discontinuous ? "discontinuous_mention"
      : words.slice(mention.start, mention.end + 1).some(word => word.unsupported === "empty_node") ? "empty_node_mention"
      : first.unsupported ?? last.unsupported;
    if (unsupported || first.start === undefined || last.end === undefined) {
      incomplete.add(mention.entity); issue(unsupported ?? "missing_exact_mention_span", mention.line, mention.entity); return [];
    }
    return [{ id: "source.mention." + hasher.digestHex(JSON.stringify([sourceUri, mention.rawEntity, mention.start, mention.end, index])),
      referentId: referentId(mention.entity), startCodePoint: points.get(first.start)!, endCodePoint: points.get(last.end)!,
      scopeIds: [sourceUri], sourceTags: toJsonValue({ annotationSchema: "CorefUD-1.0", entity: mention.tags,
        sourceEntityId: mention.entity, sourceLine: mention.line,
        tokens: words.slice(mention.start, mention.end + 1).map(word => ({ form: word.form, ...word.tags, misc: word.misc })) }) }];
  });
  const bySpan = new Map<string, typeof projected>();
  for (const occurrence of projected) {
    const key = `${occurrence.startCodePoint}:${occurrence.endCodePoint}`;
    bySpan.set(key, [...(bySpan.get(key) ?? []), occurrence]);
  }
  const rejected = new Set<string>();
  for (const group of bySpan.values()) if (group.length > 1) {
    for (const occurrence of group) rejected.add(occurrence.id);
    for (const entity of declared) if (group.some(occurrence => occurrence.referentId === referentId(entity))) {
      incomplete.add(entity); issue("ambiguous_or_duplicate_annotation_span", 0, entity);
    }
  }
  const occurrences = projected.filter(occurrence => !rejected.has(occurrence.id));
  const declaration: SourceReferenceBindingDeclaration = { schema: SOURCE_REFERENCE_BINDING_SCHEMA, coordinateSpace: "unicode_code_point",
      sourceTextHash: hasher.digestHex(text), basis: { kind: "source_annotated" as const, annotationSchema: "CorefUD-1.0",
        annotationId: owner.sourceUri + "#artifact=" + owner.artifactSha256 + "&newdoc=" + encodeURIComponent(documentId) },
      completeReferentIds: [...declared].filter(entity => !unrepresentedSurfaceAnnotation && !incomplete.has(entity)).map(referentId), occurrences };
  return { corpusId: owner.corpusId, documentId, sourceUri, text, issues, unlinkedAnnotations, owner, declaration };
}

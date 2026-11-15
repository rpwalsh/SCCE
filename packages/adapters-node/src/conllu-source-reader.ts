// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export interface ConlluWord {
  id: string; form: string; misc: Record<string, string>; line: number; tags: Record<string, string>;
  start?: number; end?: number; unsupported?: string; sourceRange: { start: number; end: number };
}
export interface ConlluSentence { id: string; text?: string; textSourceRange?: { start: number; end: number }; words: ConlluWord[]; line: number }
export interface ConlluDocument { id?: string; sentences: ConlluSentence[]; entityFields: string[] }

export function conlluAttributes(text: string): Record<string, string> {
  return text === "_" ? {} : Object.fromEntries(text.split("|").map(part => {
    const split = part.indexOf("=");
    return split < 0 ? [part, ""] : [part.slice(0, split), part.slice(split + 1)];
  }));
}

/** Preserve source token annotations and coordinates without inferring missing tags. */
export function readConlluDocuments(text: string): ConlluDocument[] {
  const documents: ConlluDocument[] = [];
  let document: ConlluDocument = { sentences: [], entityFields: [] };
  let sentence: ConlluSentence = { id: "", words: [], line: 1 };
  const flushSentence = () => {
    if (sentence.words.length || sentence.text !== undefined) document.sentences.push(sentence);
    sentence = { id: "", words: [], line: sentence.line };
  };
  const flushDocument = () => {
    flushSentence();
    if (document.sentences.length) documents.push(document);
    document = { sentences: [], entityFields: [...document.entityFields] };
  };
  let start = 0, lineNumber = 0;
  for (const rawLine of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)) {
    if (!rawLine[0] && rawLine.index === text.length) break;
    lineNumber++;
    const raw = rawLine[0].replace(/[\r\n]+$/u, "");
    start = rawLine.index!;
    if (!raw) { flushSentence(); sentence.line = lineNumber + 1; continue; }
    const global = /^# global\.Entity = (.+)$/u.exec(raw);
    if (global) { document.entityFields = global[1]!.split("-"); continue; }
    const newDocument = /^# newdoc id = (.+)$/u.exec(raw);
    if (newDocument) { flushDocument(); document.id = newDocument[1]!; continue; }
    const id = /^# sent_id = (.+)$/u.exec(raw);
    if (id) { sentence.id = id[1]!; continue; }
    const surface = /^# text = (.*)$/u.exec(raw);
    if (surface) { sentence.text = surface[1]!.normalize("NFC"); sentence.textSourceRange = { start, end: start + raw.length }; continue; }
    if (raw.startsWith("#")) continue;
    const columns = raw.split("\t");
    if (columns.length !== 10) throw new Error(`invalid CoNLL-U column count at source line ${lineNumber}`);
    sentence.words.push({ id: columns[0]!, form: columns[1]!.normalize("NFC"), line: lineNumber,
      sourceRange: { start, end: start + raw.length }, misc: conlluAttributes(columns[9]!),
      tags: { lemma: columns[2]!, upos: columns[3]!, xpos: columns[4]!, feats: columns[5]!, head: columns[6]!, deprel: columns[7]!, deps: columns[8]! } });
  }
  flushDocument();
  return documents;
}

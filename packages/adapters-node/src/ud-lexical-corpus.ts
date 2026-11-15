// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, lexicalLookupUnits, LEXICAL_GRAMMAR_SCHEMA, LEXICAL_GRAMMAR_RECIPE, SOURCE_QUESTION_FRAME_SCHEMA, SOURCE_QUESTION_FRAME_RECIPE, toJsonValue,
  type InformationLabel, type LexicalGrammarForm, type ScceStorage, type SourceVersionId } from "@scce/kernel";
import { conlluAttributes, readConlluDocuments, type ConlluSentence } from "./conllu-source-reader.js";
import { assertLexicalCorpusCapacity, persistLexicalCorpus, type SourceLexicalPattern } from "./lexical-corpus-store.js";

export function readUdLexicalGrammar(text: string): { languageText: string; patterns: SourceLexicalPattern[] } {
  const documents = readConlluDocuments(text);
  const groups = new Map<string, { lemma: string; partOfSpeech: string; forms: Map<string, LexicalGrammarForm>;
    ranges: Map<string,{ start: number; end: number }>; count: number }>();
  for (const document of documents) for (const sentence of document.sentences) for (const word of sentence.words) {
    if (!/^\d+$/u.test(word.id) || word.tags.lemma === "_" || word.tags.upos === "_") continue;
    const lemma = word.tags.lemma!, partOfSpeech = word.tags.upos!, key = canonicalStringify([lemma, partOfSpeech]);
    const group = groups.get(key) ?? { lemma, partOfSpeech, forms: new Map<string, LexicalGrammarForm>(), ranges: new Map<string,{start:number;end:number}>(), count: 0 };
    const features = conlluAttributes(word.tags.feats!), dependency = word.tags.deprel!;
    const formKey = canonicalStringify([word.form, features, dependency]);
    const form = group.forms.get(formKey) ?? { surface: word.form, features, dependency, count: 0 };
    form.count++; group.forms.set(formKey, form); group.count++;
    const witness=group.ranges.get(formKey);
    if(!witness||word.sourceRange.start<witness.start)group.ranges.set(formKey,word.sourceRange);
    groups.set(key, group);
  }
  const questionFrames = new Map<string, SourceLexicalPattern>();
  for (const document of documents) for (const sentence of document.sentences) {
    const frame = copularQuestionFrame(sentence);
    if (!frame) continue;
    const key = canonicalStringify([frame.prefix, frame.suffix]), previous = questionFrames.get(key);
    if (previous) previous.support++;
    else questionFrames.set(key, { key: `question:${key}`, support: 1,
      ranges: [...sentence.words.map(word => word.sourceRange), ...(sentence.textSourceRange ? [sentence.textSourceRange] : [])],
      patternJson: toJsonValue({ schema: SOURCE_QUESTION_FRAME_SCHEMA, componentRecipe: SOURCE_QUESTION_FRAME_RECIPE,
        ...frame, lexicalUnits: [...new Set(lexicalLookupUnits(`${frame.prefix} ${frame.suffix}`))] }) });
  }
  return { languageText: documents.flatMap(document => document.sentences.map(sentence => sentence.text
    ?? sentence.words.filter(word => /^\d+$/u.test(word.id)).map(word => word.form).join(" "))).join("\n"),
    patterns: [...[...groups].map(([key, group]) => ({ key, support: group.count, ranges: [...group.ranges.values()],
      patternJson: toJsonValue({ schema: LEXICAL_GRAMMAR_SCHEMA, componentRecipe: LEXICAL_GRAMMAR_RECIPE,
        lemma: group.lemma, partOfSpeech: group.partOfSpeech, forms: [...group.forms.values()],
        lexicalUnits: [...new Set([group.lemma, ...[...group.forms.values()].map(form => form.surface)].flatMap(lexicalLookupUnits))] }) })), ...questionFrames.values()] };
}

function copularQuestionFrame(sentence: ConlluSentence): { prefix: string; suffix: string } | undefined {
  if (!sentence.text) return undefined;
  const words = sentence.words.filter(word => /^\d+$/u.test(word.id));
  const roots = words.filter(word => word.tags.head === "0" && word.tags.upos === "PRON"
    && conlluAttributes(word.tags.feats!).PronType === "Int");
  if (roots.length !== 1) return undefined;
  const root = roots[0]!;
  if (!words.some(word => word.tags.head === root.id && word.tags.deprel === "cop")) return undefined;
  const subjects = words.filter(word => word.tags.head === root.id && word.tags.deprel === "nsubj");
  if (subjects.length !== 1) return undefined;
  const argument = new Set([subjects[0]!.id]);
  for (;;) {
    const before = argument.size;
    for (const word of words) if (argument.has(word.tags.head!)) argument.add(word.id);
    if (argument.size === before) break;
  }
  const positioned: Array<{ word: typeof root; start: number; end: number }> = [];
  let cursor = 0;
  for (const word of words) {
    const start = sentence.text.indexOf(word.form, cursor);
    if (start < 0) return undefined;
    positioned.push({ word, start, end: start + word.form.length }); cursor = start + word.form.length;
  }
  const selected = positioned.filter(item => argument.has(item.word.id));
  const start = selected[0]!.start, end = selected.at(-1)!.end;
  if (positioned.some(item => item.start >= start && item.end <= end && !argument.has(item.word.id))) return undefined;
  return { prefix: sentence.text.slice(0, start), suffix: sentence.text.slice(end) };
}

export async function ingestUdLexicalCorpus(input: { storage: ScceStorage; text: string; sourceUri: string; lexiconId: string;
  language: string; license: string; informationLabel: InformationLabel; maxSourceBytes: number; updatedAt?: number; batchSize?: number;
  retainedSourceVersionId?: SourceVersionId;
  onProgress?: (value: { patterns: number; totalPatterns: number; evidence: number }) => void }) {
  assertLexicalCorpusCapacity(input.text,input);
  const parsed = readUdLexicalGrammar(input.text);
  return persistLexicalCorpus({ ...input, ...parsed });
}

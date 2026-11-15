// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { lexicalLookupUnits, LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE, toJsonValue, type InformationLabel, type LexicalSense, type ScceStorage, type SourceVersionId } from "@scce/kernel";
import { assertLexicalCorpusCapacity, persistLexicalCorpus } from "./lexical-corpus-store.js";

interface XmlBlock { attributes: Record<string, string>; text: string; start: number; end: number }
interface LexicalEntry { lemma: string; forms: string[]; block: XmlBlock }

function xmlText(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos);/giu, (_all, number: string | undefined, name: string | undefined) => {
    if (number) return String.fromCodePoint(Number.parseInt(number.startsWith("x") ? number.slice(1) : number, number.startsWith("x") ? 16 : 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name!.toLowerCase()]!;
  });
}

function attributes(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
    .map(match => [match[1]!, xmlText(match[2] ?? match[3] ?? "")]));
}

function blocks(text: string, tag: string): XmlBlock[] {
  return [...text.matchAll(new RegExp(`<${tag}\\b([^>]*)>[\\s\\S]*?<\\/${tag}>`, "gu"))]
    .map(match => ({ attributes: attributes(match[1]!), text: match[0], start: match.index!, end: match.index! + match[0].length }));
}

/** WN-LMF declarations supply word senses and forms directly, in the resource's own language. */
export function readWordnetLmf(text: string): { lexiconId: string; language: string; license: string;
  senses: Array<{ sense: LexicalSense; block: XmlBlock; entryBlocks: XmlBlock[] }> } {
  const headers = [...text.matchAll(/<Lexicon\b([^>]*)>/gu)];
  if (headers.length !== 1) throw new Error("ingest one WN-LMF lexicon per source artifact");
  const header = attributes(headers[0]![1]!);
  if (!header.id || !header.language || !header.license) throw new Error("WN-LMF lexicon needs id, language and license");
  const lexiconId = [header.id, header.version].filter(Boolean).join(":");
  const entries = new Map<string, LexicalEntry>();
  for (const block of blocks(text, "LexicalEntry")) {
    const lemma = /<Lemma\b([^>]*)\/?\s*>/u.exec(block.text);
    const spelling = lemma && attributes(lemma[1]!).writtenForm;
    if (!block.attributes.id || !spelling) throw new Error("WN-LMF lexical entry is missing its identity or lemma");
    const forms = [...block.text.matchAll(/<Form\b([^>]*)\/?\s*>/gu)]
      .map(match => attributes(match[1]!).writtenForm).filter((value): value is string => Boolean(value));
    entries.set(block.attributes.id, { lemma: spelling, forms, block });
  }
  const senses = blocks(text, "Synset").map(block => {
    const id = block.attributes.id;
    const members = (block.attributes.members ?? "").split(/\s+/u).filter(Boolean).map(member => {
      const entry = entries.get(member);
      if (!entry) throw new Error(`WN-LMF sense ${id} has an absent lexical entry ${member}`);
      return entry;
    });
    if (!id || !members.length || !block.attributes.partOfSpeech) throw new Error("WN-LMF synset is incomplete");
    const values = (tag: string) => blocks(block.text, tag).map(value => xmlText(value.text
      .replace(new RegExp(`^<${tag}\\b[^>]*>|<\\/${tag}>$`, "gu"), "")).trim());
    const relations = [...block.text.matchAll(/<SynsetRelation\b([^>]*)\/?\s*>/gu)].map(match => attributes(match[1]!))
      .map(relation => {
        if (!relation.relType || !relation.target) throw new Error(`WN-LMF relation in ${id} is incomplete`);
        return { type: relation.relType, target: relation.target };
      });
    const sense: LexicalSense = { id, lexiconId, language: header.language!, partOfSpeech: block.attributes.partOfSpeech,
      ...(block.attributes.ili ? { ili: block.attributes.ili } : {}),
      entries: members.map(({ lemma, forms }) => ({ lemma, forms })), definitions: values("Definition"), examples: values("Example"), relations };
    return { sense, block, entryBlocks: members.map(member => member.block) };
  });
  if (!senses.length) throw new Error("WN-LMF source contains no senses");
  return { lexiconId, language: header.language, license: header.license, senses };
}

export async function ingestWordnetCorpus(input: { storage: ScceStorage; text: string; sourceUri: string; updatedAt?: number;
  informationLabel: InformationLabel; maxSourceBytes: number;
  retainedSourceVersionId?: SourceVersionId;
  batchSize?: number; onProgress?: (value: { patterns: number; totalPatterns: number; evidence: number }) => void }) {
  assertLexicalCorpusCapacity(input.text,input);
  const parsed = readWordnetLmf(input.text);
  return persistLexicalCorpus({ ...input, mediaType: "application/xml", lexiconId: parsed.lexiconId, language: parsed.language, license: parsed.license,
    languageText: parsed.senses.flatMap(({ sense }) => [...sense.definitions, ...sense.examples]).join("\n"),
    patterns: parsed.senses.map(({ sense, block, entryBlocks }) => ({ key: sense.id, support: sense.entries.length,
      ranges: [block, ...entryBlocks].map(range => ({ start: range.start, end: range.end })),
      patternJson: toJsonValue({ ...sense, senseId: sense.id, schema: LEXICAL_SENSE_SCHEMA, componentRecipe: LEXICAL_SENSE_RECIPE,
        lexicalUnits: [...new Set(sense.entries.flatMap(entry => [entry.lemma, ...entry.forms]).flatMap(lexicalLookupUnits))] }) })) });
}

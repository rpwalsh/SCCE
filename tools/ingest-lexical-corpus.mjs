#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPostgresStorageAdapter, ingestWordnetCorpus, ingestUdLexicalCorpus, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { readBoundedLexicalCorpusSource } from "../packages/adapters-node/dist/lexical-corpus-store.js";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value) throw new Error("usage: node tools/ingest-lexical-corpus.mjs --config FILE --source FILE --uri SOURCE_URL --max-source-bytes BYTES [--format wordnet|conllu] [--report FILE]");
  args.set(name.slice(2), value);
}
for (const name of ["config", "source", "uri", "max-source-bytes"]) if (!args.has(name)) throw new Error(`missing --${name}`);
const maxSourceBytes=Number(args.get("max-source-bytes"));
if(!Number.isSafeInteger(maxSourceBytes)||maxSourceBytes<=0)throw new Error("--max-source-bytes must be a positive integer; this parser requires the entire source within that capacity");
const startedAt = new Date().toISOString();
const format = args.get("format") ?? "wordnet";
if (!["wordnet", "conllu"].includes(format)) throw new Error("--format must be wordnet or conllu");
if (format === "conllu") for (const name of ["lexicon-id", "language", "license"]) if (!args.has(name)) throw new Error(`missing --${name}`);
const text=await readBoundedLexicalCorpusSource({path:resolve(args.get("source")),maxSourceBytes});
const config = await readScceRuntimeConfig(args.get("config"));
const storage = createPostgresStorageAdapter({ url: config.database.url, schema: config.database.schema,
  ssl: config.database.ssl, informationAccess: config.security.informationAccess });
try {
  await storage.migrate();
  let previousProgress = Date.now();
  const ingest = format === "wordnet" ? ingestWordnetCorpus : ingestUdLexicalCorpus;
  const result = await ingest({ storage, text, sourceUri: args.get("uri"), maxSourceBytes,informationLabel:config.security.defaultSourceInformationLabel,
    lexiconId: args.get("lexicon-id"), language: args.get("language"), license: args.get("license"),
    onProgress(value) {
      if (Date.now() - previousProgress >= 10000 || value.patterns === value.totalPatterns) {
        console.log(JSON.stringify({ stage: "lexical-import", ...value }));
        previousProgress = Date.now();
      }
    } });
  const report = { format, startedAt, completedAt: new Date().toISOString(), source: resolve(args.get("source")), sourceUri: args.get("uri"), ...result };
  const destination = args.get("report") ?? `.scce/verification/lexical-import-${Date.now()}.json`;
  await mkdir(dirname(resolve(destination)), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await storage.close(); }

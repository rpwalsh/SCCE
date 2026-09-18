#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What identity discovery actually measured, and how close it came to measuring something else.
//
//   node tools/closed-class-report.mjs [config] [--near=25]
//
// Reports the discovery population, the families found and their support, each identity's closed class with
// document frequencies, and -- the part no stored record keeps -- the terms that fell just BELOW the inclusion
// boundary. majorityClosedClass keeps a word carried by more than half the documents and discards the rest, so
// the rejected side is invisible in the identity record. If the accepted list looks like function words but
// the next terms down are article topics, the boundary is real; if the near-misses look like the accepted
// list, the population is still too small to separate them.
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const configPath = process.argv.slice(2).find(a => !a.startsWith("--")) ?? "scce.config.json";
const nearCount = Number(args.get("near") ?? 25);

const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/index.js")).href);
const kernel = await import(pathToFileURL(path.resolve("packages/kernel/dist/index.js")).href);
const { createNodeRuntime, readScceRuntimeConfig } = adapters;
const { isLanguageWordSymbol } = kernel;
// Not re-exported from the kernel index; imported from its own module so the family label is the one
// discovery itself assigns rather than a second guess at it.
const identityRuntime = await import(pathToFileURL(path.resolve("packages/kernel/dist/language-identity-runtime.js")).href);
const { corpusFamilyForSource } = identityRuntime;

const config = await readScceRuntimeConfig(configPath);
const runtime = createNodeRuntime(config);
const store = runtime.storage.languageIdentities;

// The same population discovery reads, through the same interface, so this is a check and not a second opinion.
const rows = [];
let afterId = "";
for (;;) {
  const page = await store.listProfileSignatures({ afterId, limit: 4000 });
  if (!page.length) break;
  rows.push(...page);
  afterId = page[page.length - 1].id;
}

const dominantScript = scripts => [...(scripts ?? [])]
  .filter(row => row.mass >= 0.08)
  .sort((a, b) => b.mass - a.mass)[0]?.script ?? "script:unknown";

const byScript = new Map();
const familySupport = new Map();
for (const row of rows) {
  const script = dominantScript(row.scripts);
  if (!byScript.has(script)) byScript.set(script, []);
  byScript.get(script).push(row);
  const family = corpusFamilyForSource({ sourceSystem: row.sourceSystem, sourceUri: row.sourceUri }, undefined);
  familySupport.set(family, (familySupport.get(family) ?? 0) + 1);
}

process.stdout.write(`documents considered      ${rows.length}\n`);
process.stdout.write(`scripts found             ${byScript.size}\n`);
process.stdout.write(`families discovered       ${familySupport.size}\n`);
for (const [family, count] of [...familySupport].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${family.padEnd(34)} ${String(count).padStart(7)} documents\n`);
}

const stored = await store.listIdentities();
process.stdout.write(`\nstored identities         ${stored.length}\n`);
for (const identity of stored) {
  process.stdout.write(`  ${identity.id.slice(-8)}  ${identity.script.padEnd(14)} closedClass=${identity.closedClass.length} families=${identity.families.length}\n`);
}

// Document frequency over the word symbols each document carries, which is exactly what majorityClosedClass
// counts. Recomputed here so the boundary can be seen from both sides.
for (const [script, pool] of [...byScript].sort((a, b) => b[1].length - a[1].length)) {
  const frequency = new Map();
  for (const row of pool) {
    const seen = new Set();
    for (const [word] of row.topContinuation ?? []) {
      if (!isLanguageWordSymbol(word) || seen.has(word)) continue;
      seen.add(word);
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const ranked = [...frequency].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const boundary = pool.length / 2;
  const accepted = ranked.filter(([, count]) => count > boundary);
  const rejected = ranked.filter(([, count]) => count <= boundary);
  const share = count => (count / pool.length).toFixed(3);

  process.stdout.write(`\n=== ${script}: ${pool.length} documents, boundary = carried by more than ${boundary} of them\n`);
  process.stdout.write(`closed-class size         ${accepted.length}\n`);
  process.stdout.write(`\n  ACCEPTED (document frequency)\n`);
  for (const [word, count] of accepted.slice(0, 60)) {
    process.stdout.write(`    ${word.padEnd(20)} ${String(count).padStart(6)}  ${share(count)}\n`);
  }
  process.stdout.write(`\n  JUST BELOW THE BOUNDARY (the next ${nearCount} down, which no stored record keeps)\n`);
  for (const [word, count] of rejected.slice(0, nearCount)) {
    process.stdout.write(`    ${word.padEnd(20)} ${String(count).padStart(6)}  ${share(count)}\n`);
  }
}

await runtime.storage.close?.();

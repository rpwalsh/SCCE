#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Finds deciding constants that are written inline instead of declared in the calibration registry.
//
// A number written inline cannot be audited, cannot be searched, and cannot be fitted: the field operators ran ten
// iterative steps per activation for the life of the system on four such numbers, and no coverage report could see
// them. This lists the rest.
//
// It reports CANDIDATES, not violations. A cost bound (a scan limit, a byte budget) is legitimately inline; a
// modeling parameter is not. The distinction is judgement, so this ranks and a person decides.
//
//   node tools/undeclared-constants.mjs [--min=2] [--path=packages/kernel/src]
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const root = flag("path", "packages/kernel/src");
const minHits = Number(flag("min", 2));

const files = [];
const walk = dir => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "calibrations") continue;
      walk(full);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
  }
};
walk(root);

// A deciding constant reads as a comparison or a weight. Array indices, 0, 1, -1 and obvious identity values are
// excluded: they are structure, not judgement.
const COMPARISON = /([<>]=?|===|!==)\s*(-?\d+\.\d+|-?0?\.\d+|-?[2-9]\d*|-?1\d+)/g;
const MULTIPLIER = /\*\s*(0?\.\d+)/g;
const NAMED_UNJUSTIFIED = /\b(?:threshold|floor|ceiling|weight|damping|decay|ratio|bound|cap|limit|steps|iterations)\b\s*[:=]\s*(-?\d+\.?\d*)/gi;

const hits = new Map();
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const declared = source.includes("calibrated(");
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // A line that already reads the registry is declared by definition.
    if (line.includes("calibrated(")) continue;
    for (const pattern of [COMPARISON, MULTIPLIER, NAMED_UNJUSTIFIED]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line))) {
        const value = match[match.length - 1];
        if (["0", "1", "-1", "2", "0.0", "1.0", "100"].includes(value)) continue;
        const key = path.relative(".", file).replace(/\\/g, "/");
        const row = hits.get(key) ?? { file: key, declared, samples: [], count: 0 };
        row.count += 1;
        if (row.samples.length < 4) row.samples.push({ line: index + 1, value, text: trimmed.slice(0, 96) });
        hits.set(key, row);
      }
    }
  }
}

const ranked = [...hits.values()].filter(row => row.count >= minHits).sort((left, right) => right.count - left.count);
console.log(`# Undeclared constant candidates\n`);
console.log(`Scanned ${files.length} files under ${root}. ${ranked.length} carry ${minHits} or more.\n`);
console.log(`A cost bound is legitimately inline. A modeling parameter is not. This ranks; a person decides.\n`);
console.log("| file | inline | reads registry | example |");
console.log("| --- | ---: | :---: | --- |");
for (const row of ranked.slice(0, 30)) {
  const sample = row.samples[0];
  console.log(`| ${row.file} | ${row.count} | ${row.declared ? "yes" : "NO"} | \`${String(sample?.text ?? "").replace(/\|/g, "/")}\` |`);
}
const undeclaredFiles = ranked.filter(row => !row.declared);
const totalInline = ranked.reduce((sum, row) => sum + row.count, 0);
// Coverage against the declared registry, so the number moves when someone declares a constant or adds one.
const registry = readFileSync("packages/kernel/src/calibrations/public-calibrations.ts", "utf8");
const declared = registry.match(/^\s*"[a-z_]+\.[a-z_0-9]+":/gim)?.length ?? 0;
const coverage = declared + totalInline > 0 ? (declared / (declared + totalInline)) * 100 : 100;
console.log(`\n**${undeclaredFiles.length} files carry deciding constants and never read the registry at all.**`);
console.log(`Total inline candidates: ${totalInline}. Declared calibrations: ${declared}.`);
console.log(`\nDECLARED_COVERAGE ${coverage.toFixed(1)}%`);
console.log(`\nA number written inline cannot be audited, searched or fitted. Reading code to find them is the smell`);
console.log(`this replaces: run this, and declare whatever turns out to be a modeling parameter rather than a cost bound.`);

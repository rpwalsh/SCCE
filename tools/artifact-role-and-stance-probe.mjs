#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// What a repository declares about its own files, and which propositions inside them are exhibited rather than
// asserted. Offline and read-only: it touches no database and runs the same producers the ingestor runs.
//
//   node tools/artifact-role-and-stance-probe.mjs <repo-root> [--files=<n>]
//   node tools/artifact-role-and-stance-probe.mjs <repo-root> --proposition="July 20, 1969" --in=<file>
//
// Built for T34: the engine cited `answerhood-gate.test.ts` to a user as provenance for when Apollo 11 landed.
// The declared role answers which files a project says are tests; the stance answers whether one sentence in one
// of them is the source speaking. Both are needed, and neither is a name heuristic.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const root = path.resolve(args.find(arg => !arg.startsWith("--")) ?? ".");
const flag = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const fileBudget = Number(flag("files") ?? 40);
const proposition = flag("proposition");
const inFile = flag("in");

const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/index.js")).href);
const { createProjectDeclarationIndex, measureExhibitedContent, readProjectArtifactDeclarations } = adapters;

const declarations = await readProjectArtifactDeclarations(root);
console.log(`root                : ${root}`);
console.log(`manifests read      : ${declarations.manifests.join(", ") || "(none)"}`);
for (const item of declarations.declarations) console.log(`  declared          : ${item.role} <- ${item.manifest}#${item.key} = ${item.pattern}`);
for (const item of declarations.unreadable) console.log(`  unreadable        : ${item.manifest}#${item.key} :: ${item.reason}`);

if (proposition && inFile) {
  const absolute = path.resolve(root, inFile);
  const text = await readFile(absolute, "utf8");
  const measurement = measureExhibitedContent({ uri: path.relative(root, absolute).replace(/\\/gu, "/"), mediaType: "text/typescript", text });
  const utf16 = text.indexOf(proposition);
  if (utf16 < 0) {
    console.log(`\nproposition absent from ${inFile}`);
  } else {
    const start = [...text.slice(0, utf16)].length;
    const end = start + [...proposition].length;
    const exhibited = measurement.ranges.some(range => start >= range[0] && end <= range[1]);
    console.log(`\n${exhibited ? "EXHIBITED" : "asserted "} ${JSON.stringify(proposition)} in ${inFile} at code points [${start},${end})`);
  }
  process.exit(0);
}

const index = createProjectDeclarationIndex({ stopAt: root });
const files = await sample(root, fileBudget);
const byRole = new Map();
console.log("");
for (const absolute of files) {
  const relative = path.relative(root, absolute).replace(/\\/gu, "/");
  const resolution = await index.roleFor(absolute);
  byRole.set(resolution.role, (byRole.get(resolution.role) ?? 0) + 1);
  let share = "unmeasured";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/iu.test(relative)) {
    const text = await readFile(absolute, "utf8");
    const measurement = measureExhibitedContent({ uri: relative, mediaType: "text/typescript", text });
    if (measurement.measured && measurement.textLength) {
      const covered = measurement.ranges.reduce((sum, range) => sum + (range[1] - range[0]), 0);
      share = (covered / measurement.textLength).toFixed(3);
    }
  }
  console.log(`${resolution.role.padEnd(18)} ${resolution.declaredBy.padEnd(17)} exhibited=${String(share).padEnd(10)} ${relative}`);
}
console.log(`\nroles over ${files.length} sampled files: ${[...byRole].map(([role, count]) => `${role}=${count}`).join(" ")}`);

/** Deterministic breadth-first sample, sorted per directory, so two runs report the same files. */
async function sample(from, budget) {
  const out = [];
  const queue = [from];
  while (queue.length && out.length < budget) {
    const current = queue.shift();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (out.length >= budget) break;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "dist") queue.push(next);
      } else if (entry.isFile() && (await stat(next)).size > 0) out.push(next);
    }
  }
  return out;
}

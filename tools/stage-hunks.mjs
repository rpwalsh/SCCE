// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Stage only this lane's hunks out of a shared working tree, by old-file start line. `git add <file>` in a tree
// several lanes are editing sweeps their uncommitted work into your commit; that happened twice tonight.
//
//   git diff -U2 -- <file> > /tmp/all.patch
//   node tools/stage-hunks.mjs /tmp/all.patch /tmp/mine.patch 121 126 191   # the @@ -N start lines that are yours
//   git apply --cached --recount /tmp/mine.patch
//
// The written patch always ends in exactly one newline: an empty trailing line reads as a malformed hunk body and
// git rejects the whole patch with "corrupt patch at line N".
import fs from 'node:fs';
const [, , patchFile, outFile, ...wanted] = process.argv;
const want = new Set(wanted.map(Number));
const lines = fs.readFileSync(patchFile, 'utf8').split('\n');
const out = [];
let header = [];
let inHunk = false;
let keep = false;
let headerWritten = false;
for (const line of lines) {
  if (line.startsWith('diff --git ')) { header = [line]; inHunk = false; keep = false; headerWritten = false; continue; }
  if (!inHunk && (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file') || line.startsWith('old mode') || line.startsWith('new mode') || line.startsWith('deleted file'))) { header.push(line); continue; }
  if (line.startsWith('@@')) {
    const m = /^@@ -(\d+)/.exec(line);
    inHunk = true;
    keep = m ? want.has(Number(m[1])) : false;
    if (keep) {
      if (!headerWritten) { out.push(...header); headerWritten = true; }
      out.push(line);
    }
    continue;
  }
  if (inHunk && keep) out.push(line);
}
fs.writeFileSync(outFile, out.join('\n').replace(/\n+$/u, '') + '\n');
console.log('hunks kept:', out.filter(l => l.startsWith('@@')).length);

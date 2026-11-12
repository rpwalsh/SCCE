// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copiedRequestRoleSpans } from "../packages/kernel/dist/conversational-frame-walk.js";
import { surfaceSentenceRanges } from "../packages/kernel/dist/surface-linguistics.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const defaults = {
  prefixUnits: 2,
  sourceNeighborUnits: 0,
  minimumCopiedLexicalUnits: 0,
  minimumArgumentCoveragePermille: 0,
  minimumSingleCopyCoveragePermille: 0,
  minimumSourceFamilies: 4,
  maximumRecordsPerCohort: 32,
  maximumCohortsPerGroup: 1,
  maximumOutputFiles: 1024,
  maximumFileBytes: 2 * 1024 * 1024,
  maximumOutputBytes: 256 * 1024 * 1024
};

export async function layoutExtractiveQaCohorts({ inputDir, outputDir, limits = {} }) {
  const caps = { ...defaults, ...limits };
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < (["sourceNeighborUnits", "minimumCopiedLexicalUnits", "minimumArgumentCoveragePermille", "minimumSingleCopyCoveragePermille"].includes(name) ? 0 : 1)) throw new Error(`invalid ${name}`);
  }
  if (caps.maximumRecordsPerCohort < caps.minimumSourceFamilies) {
    throw new Error("maximumRecordsPerCohort must cover minimumSourceFamilies");
  }

  const inputRoot = resolve(inputDir);
  const manifestBytes = await readFile(join(inputRoot, "manifest.json"));
  const sourceManifest = JSON.parse(manifestBytes.toString("utf8"));
  if (sourceManifest.schema !== "scce.extractive_qa_preparation.v1" || !Array.isArray(sourceManifest.outputs)) {
    throw new Error("canonical extractive-QA preparation manifest required");
  }

  const groups = new Map();
  let inspectedPairs = 0;
  for (const output of sourceManifest.outputs) {
    if (typeof output.path !== "string" || !Number.isSafeInteger(output.bytes) || typeof output.sha256 !== "string") {
      throw new Error("invalid prepared transcript manifest entry");
    }
    const bytes = await readFile(join(inputRoot, output.path));
    if (bytes.length !== output.bytes || sha256(bytes) !== output.sha256) {
      throw new Error(`prepared transcript integrity mismatch: ${output.path}`);
    }
    const document = JSON.parse(bytes.toString("utf8"));
    if (document.schema !== "scce.dialogue_transcript.v1" || typeof document.text !== "string" || !Array.isArray(document.turns)) {
      throw new Error(`invalid prepared transcript: ${output.path}`);
    }
    const points = [...document.text];
    const turns = new Map(document.turns.map(turn => [turn.index, turn]));
    for (const reply of document.turns) {
      if (reply.commitmentScope !== "external" || reply.replyToTurnIndex === undefined
        || !Array.isArray(reply.supportingSourceRanges) || reply.supportingSourceRanges.length !== 1) continue;
      const request = turns.get(reply.replyToTurnIndex), range = reply.supportingSourceRanges[0], answer = range.answerRange;
      if (!request || typeof request.surface !== "string" || typeof reply.surface !== "string" || !answer
        || typeof reply.sourceRecordId !== "string" || typeof reply.sourceFamilyId !== "string") continue;
      const context = points.slice(range.startCodePoint, range.endCodePoint).join("");
      const answerStart = answer.startCodePoint - range.startCodePoint;
      const answerEnd = answer.endCodePoint - range.startCodePoint;
      if (answerStart < 0 || answerEnd <= answerStart || [...context].slice(answerStart, answerEnd).join("") !== reply.surface) {
        throw new Error(`answer range ownership mismatch: ${reply.sourceRecordId}`);
      }
      const prefix = lexicalPrefix(request.surface, caps.prefixUnits);
      if (prefix.length !== caps.prefixUnits) continue;
      const correspondence = measuredCorrespondence(request.surface, context, answerStart, answerEnd, caps.prefixUnits);
      if (!correspondence || correspondence.maximumCopiedLexicalUnits < caps.minimumCopiedLexicalUnits
        || correspondence.argumentCoveragePermille < caps.minimumArgumentCoveragePermille
        || correspondence.singleCopyCoveragePermille < caps.minimumSingleCopyCoveragePermille) continue;
      const [beforeAnswer, afterAnswer] = sourceNeighborSignature(context, answerStart, answerEnd, caps.sourceNeighborUnits);
      const sourceNeighbors = correspondence.answerOrder === "after_copy" ? [beforeAnswer, []]
        : correspondence.answerOrder === "before_copy" ? [[], afterAnswer] : [beforeAnswer, afterAnswer];
      const answerBoundary = answerBoundarySignature(context, answerEnd);
      const key = JSON.stringify([prefix, sourceNeighbors, correspondence.answerOrder, answerBoundary]), rows = groups.get(key) ?? [];
      rows.push({ question: request.surface, answer: reply.surface, context, answerStart, answerEnd,
        sourceRecordId: reply.sourceRecordId, sourceFamilyId: reply.sourceFamilyId });
      groups.set(key, rows); inspectedPairs++;
    }
  }

  const target = resolve(outputDir), parent = dirname(target);
  await mkdir(parent, { recursive: true });
  try { await stat(target); throw new Error("output path already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const stage = await mkdtemp(join(parent, `.${basename(target)}.stage-`));
  const outputs = [];
  let totalOutputBytes = 0, qualifiedPairs = 0;
  try {
    await mkdir(join(stage, "transcripts"));
    const qualified = [...groups.entries()].flatMap(([key, rows]) => {
      const selected = selectIndependentRows(rows, caps.maximumRecordsPerCohort * caps.maximumCohortsPerGroup);
      const cohorts = [];
      for (let offset = 0; offset < selected.length; offset += caps.maximumRecordsPerCohort) {
        const chunk = selected.slice(offset, offset + caps.maximumRecordsPerCohort);
        if (new Set(chunk.map(row => row.sourceFamilyId)).size >= caps.minimumSourceFamilies) {
          cohorts.push({ key, selected: chunk, cohortIndex: offset / caps.maximumRecordsPerCohort });
        }
      }
      return cohorts;
    }).sort((left, right) => left.key.localeCompare(right.key) || left.cohortIndex - right.cohortIndex);
    if (qualified.length > caps.maximumOutputFiles) throw new Error("cohorts exceed maximumOutputFiles");

    for (const [index, cohort] of qualified.entries()) {
      let selected = cohort.selected;
      let document = cohortDocument(selected, sourceManifest, manifestBytes);
      let encoded = `${JSON.stringify(document)}\n`;
      while (Buffer.byteLength(encoded) > caps.maximumFileBytes && selected.length > caps.minimumSourceFamilies) {
        selected = selected.slice(0, -1);
        document = cohortDocument(selected, sourceManifest, manifestBytes);
        encoded = `${JSON.stringify(document)}\n`;
      }
      const size = Buffer.byteLength(encoded);
      if (size > caps.maximumFileBytes) throw new Error(`cohort cannot fit maximumFileBytes: ${cohort.key}`);
      if (totalOutputBytes + size > caps.maximumOutputBytes) throw new Error("cohorts exceed maximumOutputBytes");
      const path = `transcripts/${String(index).padStart(6, "0")}.json`;
      await writeFile(join(stage, path), encoded, "utf8");
      const [requestPrefixUnits, sourceNeighborUnits, answerOrder, answerBoundary] = JSON.parse(cohort.key);
      outputs.push({ path, bytes: size, sha256: sha256(encoded), requestPrefixUnits, sourceNeighborUnits, answerOrder, answerBoundary,
        cohortIndex: cohort.cohortIndex,
        records: selected.length, sourceFamilies: new Set(selected.map(row => row.sourceFamilyId)).size });
      totalOutputBytes += size; qualifiedPairs += selected.length;
    }
    const manifest = {
      schema: "scce.extractive_qa_cohort_layout.v1",
      sourceManifestSha256: sha256(manifestBytes),
      source: sourceManifest.source,
      layout: { method: "leading_unicode_lexical_units.v4", prefixUnits: caps.prefixUnits,
        sourceNeighborUnits: caps.sourceNeighborUnits,
        minimumCopiedLexicalUnits: caps.minimumCopiedLexicalUnits,
        minimumArgumentCoveragePermille: caps.minimumArgumentCoveragePermille,
        minimumSingleCopyCoveragePermille: caps.minimumSingleCopyCoveragePermille,
        minimumSourceFamilies: caps.minimumSourceFamilies, maximumRecordsPerCohort: caps.maximumRecordsPerCohort },
      cohortExpansion: { maximumCohortsPerGroup: caps.maximumCohortsPerGroup },
      inspectedPairs, qualifiedPairs, groupsObserved: groups.size, cohorts: outputs.length,
      outputs, totalOutputBytes, limits: caps
    };
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(stage, target);
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function lexicalPrefix(surface, count) {
  return [...surface.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)].slice(0, count).map(match => match[0]);
}

function sourceNeighborSignature(surface, answerStart, answerEnd, count) {
  if (count === 0) return [];
  const units = [...surface.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map(match => ({
    surface: match[0],
    start: [...surface.slice(0, match.index)].length,
    end: [...surface.slice(0, match.index + match[0].length)].length
  }));
  return [
    units.filter(unit => unit.end <= answerStart).slice(-count).map(unit => unit.surface),
    units.filter(unit => unit.start >= answerEnd).slice(0, count).map(unit => unit.surface)
  ];
}

function answerBoundarySignature(surface, answerEnd) {
  const points = [...surface];
  const next = [...surface.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)]
    .map(match => [...surface.slice(0, match.index)].length)
    .find(start => start >= answerEnd);
  return points.slice(answerEnd, next ?? points.length).join("");
}

function measuredCorrespondence(request, context, answerStart, answerEnd, requestPrefixUnits) {
  const containing = surfaceSentenceRanges(context).flatMap(range => {
    const start = [...context.slice(0, range.startUtf16)].length;
    const end = [...context.slice(0, range.endUtf16)].length;
    return answerStart >= start && answerEnd <= end ? [{ range, start }] : [];
  });
  if (containing.length !== 1) return undefined;
  const raw = context.slice(containing[0].range.startUtf16, containing[0].range.endUtf16);
  const clause = raw.trim(), leading = [...raw.slice(0, raw.length - raw.trimStart().length)].length;
  const clauseStart = containing[0].start + leading;
  const localAnswerStart = answerStart - clauseStart, localAnswerEnd = answerEnd - clauseStart;
  const roles = copiedRequestRoleSpans(request, clause, "literal") ?? [];
  const copies = roles.filter(role => !(role.startCodePoint < localAnswerEnd && role.endCodePoint > localAnswerStart))
    .map(role => ({ ...role, surface: [...clause].slice(role.startCodePoint, role.endCodePoint).join("") }))
    .filter(role => occurrences(request, role.surface) === 1);
  if (!copies.length) return undefined;
  const requestUnits = [...request.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map(match => ({
    surface: match[0], start: [...request.slice(0, match.index)].length,
    end: [...request.slice(0, match.index + match[0].length)].length
  }));
  const argumentUnits = requestUnits.slice(requestPrefixUnits), covered = new Set();
  let singleCopyCoveragePermille = 0;
  for (const copy of copies) {
    const utf16 = request.indexOf(copy.surface);
    if (utf16 < 0) continue;
    const start = [...request.slice(0, utf16)].length, end = start + [...copy.surface].length;
    let copyUnits = 0;
    argumentUnits.forEach((unit, index) => {
      if (unit.start >= start && unit.end <= end) { covered.add(index); copyUnits++; }
    });
    if (argumentUnits.length) singleCopyCoveragePermille = Math.max(singleCopyCoveragePermille,
      Math.floor(copyUnits * 1000 / argumentUnits.length));
  }
  return {
    maximumCopiedLexicalUnits: Math.max(...copies.map(copy => lexicalPrefix(copy.surface, Number.MAX_SAFE_INTEGER).length)),
    argumentCoveragePermille: argumentUnits.length ? Math.floor(covered.size * 1000 / argumentUnits.length) : 0,
    singleCopyCoveragePermille,
    answerOrder: copies.some(copy => copy.endCodePoint <= localAnswerStart) ? "after_copy"
      : copies.some(copy => copy.startCodePoint >= localAnswerEnd) ? "before_copy" : "mixed"
  };
}

function occurrences(surface, value) {
  let count = 0;
  for (let index = surface.indexOf(value); index >= 0; index = surface.indexOf(value, index + 1)) count++;
  return count;
}

function selectIndependentRows(rows, maximum) {
  const ordered = [...rows].sort((left, right) => sha256(left.sourceRecordId).localeCompare(sha256(right.sourceRecordId))
    || left.sourceRecordId.localeCompare(right.sourceRecordId));
  const firstByFamily = new Map();
  for (const row of ordered) if (!firstByFamily.has(row.sourceFamilyId)) firstByFamily.set(row.sourceFamilyId, row);
  const selected = [...firstByFamily.values()].slice(0, maximum);
  const selectedIds = new Set(selected.map(row => row.sourceRecordId));
  for (const row of ordered) {
    if (selected.length >= maximum) break;
    if (!selectedIds.has(row.sourceRecordId)) { selected.push(row); selectedIds.add(row.sourceRecordId); }
  }
  return selected;
}

function cohortDocument(rows, sourceManifest, manifestBytes) {
  let text = "";
  const turns = [];
  for (const row of rows) {
    if (text) text += "\n";
    const requestStart = [...text].length;
    text += `${row.question}\n`;
    const replyStart = [...text].length;
    text += `${row.answer}\n`;
    const contextStart = [...text].length;
    text += row.context;
    const contextEnd = [...text].length;
    const requestIndex = turns.length;
    turns.push({ index: requestIndex, speakerId: "human.question", sourceRecordId: row.sourceRecordId,
      sourceFamilyId: row.sourceFamilyId, surface: row.question, startCodePoint: requestStart,
      endCodePoint: requestStart + [...row.question].length, requestAuthority: "factual" });
    turns.push({ index: requestIndex + 1, speakerId: "human.answer", sourceRecordId: row.sourceRecordId,
      sourceFamilyId: row.sourceFamilyId, surface: row.answer, startCodePoint: replyStart,
      endCodePoint: replyStart + [...row.answer].length, replyToTurnIndex: requestIndex, commitmentScope: "external",
      supportingSourceRanges: [{ startCodePoint: contextStart, endCodePoint: contextEnd,
        answerRange: { startCodePoint: contextStart + row.answerStart, endCodePoint: contextStart + row.answerEnd } }] });
  }
  return { schema: "scce.dialogue_transcript.v1", sourceMetadata: { ...sourceManifest.source,
    layout: "leading_unicode_lexical_units.v1", sourceManifestSha256: sha256(manifestBytes) }, text, turns };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index], value = process.argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`invalid option ${flag ?? ""}`);
    values.set(flag.slice(2), value);
  }
  const result = await layoutExtractiveQaCohorts({
    inputDir: values.get("input") ?? ".scce/corpus-bootstrap/squad-v2",
    outputDir: values.get("output") ?? ".scce/corpus-bootstrap/squad-v2-cohorts",
    limits: {
      prefixUnits: Number(values.get("prefix-units") ?? defaults.prefixUnits),
      sourceNeighborUnits: Number(values.get("source-neighbor-units") ?? defaults.sourceNeighborUnits),
      minimumCopiedLexicalUnits: Number(values.get("minimum-copied-units") ?? defaults.minimumCopiedLexicalUnits),
      minimumArgumentCoveragePermille: Number(values.get("minimum-argument-coverage-permille") ?? defaults.minimumArgumentCoveragePermille),
      minimumSingleCopyCoveragePermille: Number(values.get("minimum-single-copy-coverage-permille") ?? defaults.minimumSingleCopyCoveragePermille),
      minimumSourceFamilies: Number(values.get("minimum-source-families") ?? defaults.minimumSourceFamilies),
      maximumRecordsPerCohort: Number(values.get("maximum-records") ?? defaults.maximumRecordsPerCohort),
      maximumCohortsPerGroup: Number(values.get("maximum-cohorts-per-group") ?? defaults.maximumCohortsPerGroup),
      maximumOutputFiles: Number(values.get("maximum-files") ?? defaults.maximumOutputFiles),
      maximumFileBytes: Number(values.get("maximum-file-bytes") ?? defaults.maximumFileBytes),
      maximumOutputBytes: Number(values.get("maximum-output-bytes") ?? defaults.maximumOutputBytes)
    }
  });
  process.stdout.write(`${JSON.stringify({ inspectedPairs: result.inspectedPairs, qualifiedPairs: result.qualifiedPairs,
    groupsObserved: result.groupsObserved, cohorts: result.cohorts, totalOutputBytes: result.totalOutputBytes })}\n`);
}

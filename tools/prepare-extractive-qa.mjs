// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const digest = value => createHash("sha256").update(value).digest("hex");
const defaults = { maxInputBytes: 128 * 1024 * 1024, maxOutputFileBytes: 2 * 1024 * 1024,
  maxOutputBytes: 512 * 1024 * 1024, maxOutputFiles: 1024 };

/** Preserve human extractive annotations and shared context ownership, without assigning an ontology. */
export async function prepareExtractiveQa({ inputPath, outputDir, metadata, limits = {} }) {
  const caps = { ...defaults, ...limits };
  for (const [name, value] of Object.entries(caps)) if (!Number.isSafeInteger(value) || value < 1) throw Error(`invalid ${name}`);
  const provenance = typeof metadata === "string" ? JSON.parse(await readFile(metadata, "utf8")) : metadata;
  if (!provenance || provenance.authorship !== "human_authored" || provenance.split !== "train"
    || typeof provenance.source !== "string" || !provenance.source || typeof provenance.dataset !== "string"
    || typeof provenance.sourceLicense !== "string" || !/^[a-f0-9]{64}$/u.test(provenance.sha256)) throw Error("pinned human training source metadata required");
  const info = await stat(inputPath); if (info.size > caps.maxInputBytes) throw Error("input exceeds maxInputBytes");
  const bytes = await readFile(inputPath);
  if (digest(bytes) !== provenance.sha256) throw Error("source SHA-256 mismatch");
  const source = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(source.data)) throw Error("extractive QA article array required");
  const target = resolve(outputDir), parent = dirname(target);
  await mkdir(parent, { recursive: true });
  try { await stat(target); throw Error("output path already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const stage = await mkdtemp(join(parent, `.${basename(target)}.stage-`));
  const sourceMetadata = { dataset: provenance.dataset, sourceUri: provenance.source, sourceSha256: provenance.sha256,
    license: provenance.sourceLicense, authorship: provenance.authorship, split: provenance.split };
  const empty = () => ({ schema: "scce.dialogue_transcript.v1", sourceMetadata, text: "", turns: [] });
  let shard = empty(), totalOutputBytes = 0, paragraphs = 0, questions = 0, prepared = 0, unanswerable = 0, ambiguousAnnotations = 0;
  const ids = new Set(), outputs = [];
  const encoded = document => JSON.stringify(document) + "\n";
  const append = entry => {
    const separator = shard.text ? "\n" : "", base = [...shard.text].length + separator.length, turnBase = shard.turns.length;
    return { ...shard, text: shard.text + separator + entry.text, turns: [...shard.turns, ...entry.turns.map(turn => ({ ...turn,
      index: turn.index + turnBase, startCodePoint: turn.startCodePoint + base, endCodePoint: turn.endCodePoint + base,
      ...(turn.replyToTurnIndex === undefined ? {} : { replyToTurnIndex: turn.replyToTurnIndex + turnBase }),
      ...(turn.supportingSourceRanges ? { supportingSourceRanges: turn.supportingSourceRanges.map(range => ({
        startCodePoint: range.startCodePoint + base, endCodePoint: range.endCodePoint + base })) } : {}) }))] };
  };
  const flush = async () => {
    if (!shard.turns.length) return;
    if (outputs.length >= caps.maxOutputFiles) throw Error("output exceeds maxOutputFiles");
    const text = encoded(shard), size = Buffer.byteLength(text);
    if (totalOutputBytes + size > caps.maxOutputBytes) throw Error("output exceeds maxOutputBytes");
    const path = `transcripts/${String(outputs.length).padStart(6, "0")}.json`;
    await writeFile(join(stage, path), text, "utf8");
    outputs.push({ path, bytes: size, sha256: digest(text) }); totalOutputBytes += size; shard = empty();
  };
  try {
    await mkdir(join(stage, "transcripts"));
    for (const article of source.data) {
      if (typeof article.title !== "string" || !Array.isArray(article.paragraphs)) throw Error("invalid article identity or paragraphs");
      const sourceFamilyId = `source.article.${digest(JSON.stringify([provenance.sha256, article.title]))}`;
      for (const paragraph of article.paragraphs) {
        paragraphs++;
        if (typeof paragraph.context !== "string" || !Array.isArray(paragraph.qas)) throw Error("invalid paragraph context or QA records");
        const contextPoints = [...paragraph.context], context = paragraph.context.normalize("NFC"), turns = [];
        let text = "";
        for (const qa of paragraph.qas) {
          questions++;
          if (typeof qa.id !== "string" || !qa.id || ids.has(qa.id) || typeof qa.question !== "string" || !qa.question.trim()
            || typeof qa.is_impossible !== "boolean" || !Array.isArray(qa.answers)) throw Error("invalid or repeated original QA identity");
          ids.add(qa.id);
          if (qa.is_impossible || !qa.answers.length) { unanswerable++; continue; }
          for (const answer of qa.answers) if (typeof answer.text !== "string" || !answer.text.trim() || !Number.isSafeInteger(answer.answer_start)
            || answer.answer_start < 0 || contextPoints.slice(answer.answer_start, answer.answer_start + [...answer.text].length).join("") !== answer.text) throw Error(`invalid original answer offset: ${qa.id}`);
          if (new Set(qa.answers.map(answer => JSON.stringify([answer.answer_start, answer.text]))).size !== 1) { ambiguousAnnotations++; continue; }
          const question = qa.question.normalize("NFC"), reply = qa.answers[0].text.normalize("NFC"), start = [...text].length;
          turns.push({ index: turns.length, speakerId: "human.question", sourceRecordId: qa.id, sourceFamilyId,
            surface: question, startCodePoint: start, endCodePoint: start + [...question].length });
          text += question + "\n";
          const replyStart = [...text].length;
          turns.push({ index: turns.length, speakerId: "human.answer", sourceRecordId: qa.id, sourceFamilyId, surface: reply,
            startCodePoint: replyStart, endCodePoint: replyStart + [...reply].length, replyToTurnIndex: turns.length - 1, commitmentScope: "external" });
          text += reply + "\n"; prepared++;
        }
        if (!turns.length) continue;
        const startCodePoint = [...text].length; text += context;
        for (const turn of turns) if (turn.commitmentScope === "external") turn.supportingSourceRanges = [{ startCodePoint, endCodePoint: [...text].length }];
        const entry = { text, turns }; let candidate = append(entry);
        if (Buffer.byteLength(encoded(candidate)) > caps.maxOutputFileBytes && shard.turns.length) { await flush(); candidate = append(entry); }
        if (Buffer.byteLength(encoded(candidate)) > caps.maxOutputFileBytes) throw Error("paragraph cannot fit maxOutputFileBytes");
        shard = candidate;
      }
    }
    await flush();
    const manifest = { schema: "scce.extractive_qa_preparation.v1", source: sourceMetadata, sourceBytes: bytes.length,
      preparation: { transcriptDirectory: "transcripts", paragraphs, questions, prepared, unanswerable, ambiguousAnnotations,
        holdoutPartition: "original_article", contextCopiesPerParagraph: 1 }, limits: caps, outputs, totalOutputBytes };
    await writeFile(join(stage, "manifest.json"), encoded(manifest));
    await rename(stage, target); return manifest;
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = {}, limits = {};
    const names = { "--input": "inputPath", "--output-dir": "outputDir", "--metadata": "metadata" };
    const capNames = { "--max-input-bytes": "maxInputBytes", "--max-file-bytes": "maxOutputFileBytes", "--max-output-bytes": "maxOutputBytes", "--max-files": "maxOutputFiles" };
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!value || !names[flag] && !capNames[flag]) throw Error(`invalid option ${flag}`);
      if (names[flag]) options[names[flag]] = value; else limits[capNames[flag]] = Number(value);
    }
    const result = await prepareExtractiveQa({ ...options, limits });
    console.log(JSON.stringify({ ...result.preparation, files: result.outputs.length, totalOutputBytes: result.totalOutputBytes }));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const DECLARED_TRANSCRIPT_SCHEMA = "scce.dialogue_transcript.v1";
export const PREPARATION_MANIFEST_SCHEMA = "scce.dialogue_preparation_manifest.v1";
export const DEFAULT_PREPARATION_LIMITS = Object.freeze({
  maxInputBytes: 32 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxOutputFileBytes: 2 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxOutputFiles: 64,
  maxRecords: 20_000
});

const EMPTY_DOCUMENT_BYTES = Buffer.byteLength(JSON.stringify({
  schema: DECLARED_TRANSCRIPT_SCHEMA,
  text: "",
  turns: []
}), "utf8");
const DOCUMENT_FIXED_BYTES = EMPTY_DOCUMENT_BYTES + Buffer.byteLength("\n", "utf8");

/** Convert categorized instruction rows to the kernel's existing declared transcript format. */
export async function prepareInstructionDialogue({ inputPath, outputDir, metadata, limits = {} }) {
  if (!inputPath || !outputDir) throw new Error("inputPath and outputDir are required");
  const sourceMetadata = typeof metadata === "string"
    ? JSON.parse(await readFile(metadata, "utf8"))
    : metadata;
  validateSourceMetadata(sourceMetadata);

  const caps = { ...DEFAULT_PREPARATION_LIMITS, ...limits };
  validateLimits(caps);
  const resolvedOutputDir = resolve(outputDir);
  const parent = resolve(dirname(resolvedOutputDir));
  await mkdir(parent, { recursive: true });
  try {
    await stat(resolvedOutputDir);
    throw new Error(`output path already exists: ${resolvedOutputDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const stageDir = await mkdtemp(join(parent, `.${basename(resolvedOutputDir)}.stage-`));
  const transcriptDirectory = "transcripts";
  const sourceHash = createHash("sha256");
  let inputBytes = 0;
  let inputLineNumber = 0;
  let blankLinesSkipped = 0;
  let recordsPrepared = 0;
  let totalOutputBytes = 0;
  let outputIndex = 0;
  let shard = emptyShard();
  const outputs = [];
  const categoryCounts = new Map();
  let input;

  try {
    await mkdir(join(stageDir, transcriptDirectory));
    input = createReadStream(inputPath);
    input.on("data", chunk => {
      inputBytes += chunk.byteLength;
      sourceHash.update(chunk);
      if (inputBytes > caps.maxInputBytes) input.destroy(new Error(`input exceeds maxInputBytes (${caps.maxInputBytes})`));
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      inputLineNumber++;
      if (!line.trim()) {
        blankLinesSkipped++;
        continue;
      }
      const inputRecordBytes = Buffer.byteLength(line, "utf8");
      if (inputRecordBytes > caps.maxRecordBytes) {
        throw new Error(`record at line ${inputLineNumber} exceeds maxRecordBytes (${caps.maxRecordBytes})`);
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON at line ${inputLineNumber}`);
      }
      const category = validateInstructionRow(row, inputLineNumber, sourceMetadata.categoryCommitmentScopes);
      const commitmentScope = sourceMetadata.categoryCommitmentScopes[category];
      let entry = makeTranscriptEntry(row, category, commitmentScope, shard);
      let candidateBytes = shardDocumentByteLength(shard, entry);
      if (candidateBytes > caps.maxOutputFileBytes && shard.records > 0) {
        await flushShard();
        entry = makeTranscriptEntry(row, category, commitmentScope, shard);
        candidateBytes = shardDocumentByteLength(shard, entry);
      }
      if (candidateBytes > caps.maxOutputFileBytes) {
        throw new Error(`record at line ${inputLineNumber} cannot fit maxOutputFileBytes (${caps.maxOutputFileBytes})`);
      }
      if (recordsPrepared + 1 > caps.maxRecords) {
        throw new Error(`input exceeds maxRecords (${caps.maxRecords})`);
      }
      shard = appendEntry(shard, entry, candidateBytes);
      recordsPrepared++;
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    await flushShard();

    const manifest = {
      schema: PREPARATION_MANIFEST_SCHEMA,
      source: {
        dataset: sourceMetadata.dataset,
        uri: sourceMetadata.uri,
        pinnedRevision: sourceMetadata.pinnedRevision,
        rawJsonlFile: basename(inputPath),
        rawJsonlSha256: sourceHash.digest("hex"),
        rawJsonlBytes: inputBytes,
        license: sourceMetadata.license,
        attribution: sourceMetadata.attribution,
        shareAlikeNotice: sourceMetadata.shareAlikeNotice,
        changeNotice: sourceMetadata.changeNotice
      },
      preparation: {
        transcriptSchema: DECLARED_TRANSCRIPT_SCHEMA,
        transcriptDirectory,
        categoryCommitmentScopes: sortedRecord(sourceMetadata.categoryCommitmentScopes),
        recordsPrepared,
        blankLinesSkipped,
        categoryCounts: sortedRecord(Object.fromEntries(categoryCounts)),
        limits: caps
      },
      outputs
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (totalOutputBytes + manifestBytes.byteLength > caps.maxOutputBytes) {
      throw new Error(`outputs exceed maxOutputBytes (${caps.maxOutputBytes})`);
    }
    await writeFile(join(stageDir, "manifest.json"), manifestBytes, { flag: "wx" });
    totalOutputBytes += manifestBytes.byteLength;
    const safeStageDir = assertDirectChildPath(stageDir, parent, "staging directory");
    const safeOutputDir = assertDirectChildPath(resolvedOutputDir, parent, "output directory");
    await rename(safeStageDir, safeOutputDir);
    return { ...manifest, totalOutputBytes };
  } catch (error) {
    input?.destroy();
    assertDirectChildPath(resolvedOutputDir, parent, "output directory");
    const safeStageDir = assertDirectChildPath(stageDir, parent, "staging directory");
    await rm(safeStageDir, { recursive: true, force: true });
    throw error;
  }

  async function flushShard() {
    if (!shard.records) return;
    if (outputs.length + 1 >= caps.maxOutputFiles) {
      throw new Error(`outputs exceed maxOutputFiles (${caps.maxOutputFiles})`);
    }
    const name = `dialogue-${String(outputIndex + 1).padStart(5, "0")}.json`;
    const serialized = `${JSON.stringify({ schema: DECLARED_TRANSCRIPT_SCHEMA, text: shard.text, turns: shard.turns })}\n`;
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength !== shard.documentBytes || bytes.byteLength > caps.maxOutputFileBytes) {
      throw new Error("transcript shard byte accounting mismatch");
    }
    if (totalOutputBytes + bytes.byteLength > caps.maxOutputBytes) {
      throw new Error(`outputs exceed maxOutputBytes (${caps.maxOutputBytes})`);
    }
    await writeFile(join(stageDir, transcriptDirectory, name), bytes, { flag: "wx" });
    outputIndex++;
    totalOutputBytes += bytes.byteLength;
    outputs.push({
      path: `transcripts/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      records: shard.records
    });
    shard = emptyShard();
  }
}

function validateSourceMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid source metadata");
  for (const key of ["dataset", "uri", "pinnedRevision", "license", "attribution", "shareAlikeNotice", "changeNotice"]) {
    if (typeof metadata[key] !== "string" || !metadata[key].trim()) throw new Error(`source metadata requires ${key}`);
  }
  if (!/^[0-9a-f]{40}$/iu.test(metadata.pinnedRevision) || !metadata.uri.includes(metadata.pinnedRevision)) {
    throw new Error("source metadata URI must include its full pinnedRevision");
  }
  const scopes = metadata.categoryCommitmentScopes;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes) || !Object.keys(scopes).length) {
    throw new Error("source metadata requires categoryCommitmentScopes");
  }
  for (const [category, scope] of Object.entries(scopes)) {
    if (!category.trim() || (scope !== "conversation" && scope !== "external")) {
      throw new Error(`invalid commitment scope mapping for category ${category}`);
    }
  }
}

function validateLimits(limits) {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer`);
  }
}

function validateInstructionRow(row, lineNumber, categoryScopes) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`invalid instruction record at line ${lineNumber}`);
  for (const key of ["instruction", "response", "context", "category"]) {
    if (typeof row[key] !== "string") throw new Error(`record at line ${lineNumber} requires string ${key}`);
  }
  if (!row.instruction.trim() || !row.response.trim()) throw new Error(`record at line ${lineNumber} has empty instruction or response`);
  if (!Object.hasOwn(categoryScopes, row.category)) throw new Error(`unmapped category at line ${lineNumber}: ${row.category}`);
  return row.category;
}

function makeTranscriptEntry(row, category, commitmentScope, currentShard) {
  const instruction = row.instruction.normalize("NFC");
  const response = row.response.normalize("NFC");
  const context = row.context.normalize("NFC");
  const includeContext = Boolean(context.trim());
  const fragment = `${instruction}\n${response}${includeContext ? `\n${context}` : ""}`;
  const separator = currentShard.records ? "\n" : "";
  const codePointBase = currentShard.codePoints + [...separator].length;
  const instructionLength = [...instruction].length;
  const responseLength = [...response].length;
  const instructionIndex = currentShard.turns.length;
  const instructionTurn = {
    index: instructionIndex,
    speakerId: "user",
    surface: instruction,
    startCodePoint: codePointBase,
    endCodePoint: codePointBase + instructionLength
  };
  const responseStart = codePointBase + instructionLength + 1;
  const responseTurn = {
    index: instructionIndex + 1,
    speakerId: "assistant",
    surface: response,
    startCodePoint: responseStart,
    endCodePoint: responseStart + responseLength,
    replyToTurnIndex: instructionIndex,
    commitmentScope,
    ...(includeContext ? {
      supportingSourceRanges: [{
        startCodePoint: responseStart + responseLength + 1,
        endCodePoint: responseStart + responseLength + 1 + [...context].length,
        surface: context
      }]
    } : {})
  };
  return {
    separator,
    fragment,
    turns: [instructionTurn, responseTurn],
    category,
    codePointsAdded: [...separator].length + [...fragment].length,
    textPayloadBytesAdded: jsonStringPayloadBytes(separator + fragment),
    turnPayloadBytesAdded: Buffer.byteLength(JSON.stringify(instructionTurn), "utf8")
      + Buffer.byteLength(JSON.stringify(responseTurn), "utf8")
      + (currentShard.turns.length ? 2 : 1)
  };
}

function emptyShard() {
  return { text: "", turns: [], records: 0, codePoints: 0, textPayloadBytes: 0, turnPayloadBytes: 0, documentBytes: DOCUMENT_FIXED_BYTES };
}

function shardDocumentByteLength(shard, entry) {
  return DOCUMENT_FIXED_BYTES
    + shard.textPayloadBytes
    + entry.textPayloadBytesAdded
    + shard.turnPayloadBytes
    + entry.turnPayloadBytesAdded;
}

function appendEntry(shard, entry, documentBytes) {
  return {
    text: `${shard.text}${entry.separator}${entry.fragment}`,
    turns: [...shard.turns, ...entry.turns],
    records: shard.records + 1,
    codePoints: shard.codePoints + entry.codePointsAdded,
    textPayloadBytes: shard.textPayloadBytes + entry.textPayloadBytesAdded,
    turnPayloadBytes: shard.turnPayloadBytes + entry.turnPayloadBytesAdded,
    documentBytes
  };
}

function jsonStringPayloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function sortedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function assertDirectChildPath(candidate, parent, label) {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  const childPath = relative(resolvedParent, resolvedCandidate);
  if (!childPath || childPath === "." || isAbsolute(childPath) || childPath === ".."
    || childPath.startsWith(`..${sep}`) || childPath.includes(sep)) {
    throw new Error(`${label} must resolve to a direct child of the staging parent`);
  }
  return resolvedCandidate;
}

function parseArgs(argv) {
  const options = {};
  const limits = {};
  const limitFlags = {
    "--max-input-bytes": "maxInputBytes",
    "--max-record-bytes": "maxRecordBytes",
    "--max-file-bytes": "maxOutputFileBytes",
    "--max-output-bytes": "maxOutputBytes",
    "--max-files": "maxOutputFiles",
    "--max-records": "maxRecords"
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    const value = argv[++index];
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--input") options.inputPath = value;
    else if (flag === "--output-dir") options.outputDir = value;
    else if (flag === "--metadata") options.metadata = value;
    else if (limitFlags[flag]) limits[limitFlags[flag]] = Number(value);
    else throw new Error(`unknown option: ${flag}`);
  }
  return { ...options, limits };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node tools/prepare-instruction-dialogue.mjs --input <source.jsonl> --output-dir <fresh-dir> --metadata <source-metadata.json> [--max-file-bytes N] [--max-output-bytes N] [--max-files N]");
    } else {
      const result = await prepareInstructionDialogue(options);
      console.log(JSON.stringify({ trainingRoot: resolve(options.outputDir, result.preparation.transcriptDirectory), recordsPrepared: result.preparation.recordsPrepared, outputs: result.outputs.length, totalOutputBytes: result.totalOutputBytes }));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A local language model as a reference system, so the sealed set is answered by the thing SCCE claims to replace.
//
// BM25 is a weak comparator for an abstention claim: a bag-of-words retriever has no mechanism for declining, so
// beating it 8/0 on the unanswerable probes says less than it appears to. A language model does have that mechanism --
// it can be told, in its own prompt, that "I don't know" is an acceptable and preferred answer when the material does
// not contain one -- and whether it uses it is the measurement worth having.
//
// Two conditions, because they are different claims:
//
//   closed_book  the model alone. What it already knows about these documents, with no retrieval.
//   rag          the model given the same sealed corpus, retrieved the same way the BM25 reference retrieves it.
//                This is the system SCCE is actually an alternative to: retrieval plus a model.
//
// The model is local and declared. It is a reference system inside the evaluation harness and never part of SCCE's
// runtime; `tools/no-hidden-model-check.mjs` continues to fail the build on any model dependency reachable from the
// product, and this file is not.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { availableParallelism } from "node:os";
import { argsMap, readJson, sha256Bytes } from "../lib/util.mjs";

const args = argsMap();
const manifestPath = args.get("corpus-manifest") ?? process.env.SCCE_EVAL_CORPUS_MANIFEST;
if (!manifestPath) throw new Error("Missing corpus manifest");
const mode = args.get("mode") ?? "rag";
if (mode !== "rag" && mode !== "closed_book") throw new Error(`unsupported mode: ${mode}`);
const model = args.get("model") ?? process.env.SCCE_EVAL_OLLAMA_MODEL ?? "qwen2.5:3b";
const endpoint = args.get("endpoint") ?? process.env.SCCE_EVAL_OLLAMA_URL ?? "http://127.0.0.1:11434";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname)) throw new Error("The local baseline requires a loopback Ollama endpoint");
const device = args.get("device") ?? "auto";
if (!["cpu", "gpu", "auto"].includes(device)) throw new Error(`unsupported device: ${device}`);
const integerOption = (name, fallback, minimum = 1) => {
  const value = Number(args.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid --${name}`);
  return value;
};
const options = {
  temperature: 0, top_p: 1, seed: integerOption("seed", 20260906, 0),
  num_predict: integerOption("num-predict", 96), num_ctx: integerOption("num-ctx", 4096),
  num_thread: integerOption("threads", availableParallelism()),
  ...(device === "cpu" ? { num_gpu: 0 } : device === "gpu" ? { num_gpu: 999 } : {})
};
const keepAlive = args.get("keep-alive") ?? "30m";
const passages = Math.max(1, Math.min(8, Number(args.get("passages") ?? 3)));
const timeoutMs = Math.max(1_000, Number(args.get("request-timeout-ms") ?? 120_000));
const [version, tags] = await Promise.all([ollamaJson("/api/version"), ollamaJson("/api/tags")]);
const modelIdentity = tags.models?.find(row => row.name === model || row.model === model);
if (!modelIdentity?.digest) throw new Error(`Requested model is not installed locally: ${model}`);
const runtimeMetadata = {
  baseline: `ollama-${mode}`, model, digest: modelIdentity.digest, details: modelIdentity.details,
  ollamaVersion: version.version, requestedDevice: device, options, keepAlive, endpoint
};

const manifest = await readJson(manifestPath);
const base = path.dirname(path.resolve(manifestPath));
const docs = [];
for (const document of manifest.documents) {
  const bytes = await readFile(path.resolve(base, document.path));
  if (document.sha256 && sha256Bytes(bytes) !== document.sha256) throw new Error(`Corpus digest mismatch: ${document.documentId}`);
  const text = bytes.toString("utf8");
  docs.push({ ...document, bytes, text, tokens: tokenize(text) });
}

// The retrieval half of the RAG condition is the BM25 reference's own retrieval, verbatim in behaviour, so the two
// reference systems differ in exactly one thing: what reads the retrieved passage.
const documentCount = docs.length;
const documentFrequency = new Map();
for (const document of docs) for (const token of new Set(document.tokens)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
const averageLength = docs.reduce((sum, document) => sum + document.tokens.length, 0) / Math.max(1, documentCount);

const INSTRUCTIONS = [
  "You are answering questions about a fixed set of documents.",
  "Answer with the exact missing text only, copied verbatim from the material, and nothing else.",
  "Do not explain, restate the question, or add punctuation that is not part of the answer.",
  "If the material does not contain the answer, reply with exactly: I don't know.",
  "Replying \"I don't know\" is the correct and preferred answer whenever the material does not support one."
].join(" ");

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  const question = JSON.parse(line);
  try {
    const retrieved = mode === "rag" ? retrieve(question.prompt) : [];
    const generated = await ask(question.prompt, retrieved);
    const answer = generated.answer;
    // The model's own refusal, recognised structurally: a reply whose entire content is a declination. Nothing else
    // in the reply is interpreted, and a declination buried inside an answer is still an answer.
    const declined = isDeclination(answer);
    process.stdout.write(`${JSON.stringify({
      status: declined ? "abstained" : "ok",
      answer: declined ? "" : answer,
      citations: declined ? [] : retrieved.map(row => row.citation),
      metadata: { ...runtimeMetadata, passages: retrieved.length, rawReply: answer.slice(0, 400), inference: generated.inference, residency: generated.residency }
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "error",
      answer: "",
      citations: [],
      metadata: { ...runtimeMetadata, error: String(error && error.message ? error.message : error).slice(0, 300) }
    })}\n`);
  }
}

function tokenize(value) {
  return String(value).normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function bm25(queryTokens, documentTokens) {
  const frequency = new Map();
  for (const token of documentTokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    const n = documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (documentCount - n + 0.5) / (n + 0.5));
    const f = frequency.get(token) ?? 0;
    score += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * documentTokens.length / Math.max(1, averageLength)));
  }
  return score;
}

function bestWindow(text, queryTokens) {
  const sentences = [...text.matchAll(/[^.!?\n]+[.!?]?/gu)].map(match => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  let best = sentences[0] ?? { text, start: 0, end: text.length };
  let score = -1;
  for (const sentence of sentences) {
    const present = new Set(tokenize(sentence.text));
    const overlap = queryTokens.filter(token => present.has(token)).length;
    if (overlap > score) { score = overlap; best = sentence; }
  }
  // A window rather than a lone sentence: a model answering from one clipped sentence is being tested on the
  // retriever's precision, not on its own reading.
  const start = Math.max(0, best.start - 600);
  const end = Math.min(text.length, best.end + 600);
  return { text: text.slice(start, end), start: best.start, end: best.end };
}

function retrieve(prompt) {
  const queryTokens = tokenize(prompt);
  return docs
    .map(document => ({ document, score: bm25(queryTokens, document.tokens) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, passages)
    .map(({ document }) => {
      const window = bestWindow(document.text, queryTokens);
      const startByte = Buffer.byteLength(document.text.slice(0, window.start), "utf8");
      const endByte = Buffer.byteLength(document.text.slice(0, window.end), "utf8");
      const slice = document.bytes.subarray(startByte, endByte);
      return {
        passage: window.text,
        citation: {
          documentId: document.documentId,
          startByte,
          endByte,
          sha256: sha256Bytes(slice),
          quotedText: slice.toString("utf8")
        }
      };
    });
}

async function ask(prompt, retrieved) {
  const material = retrieved.length
    ? `Material:\n${retrieved.map((row, index) => `[${index + 1}] ${row.passage}`).join("\n\n")}\n\n`
    : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `${INSTRUCTIONS}\n\n${material}Question: ${prompt}\nAnswer:`,
        stream: false,
        keep_alive: keepAlive,
        // Deterministic decoding: a reference system that answers differently on a re-run cannot be re-measured.
        options
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`ollama ${response.status}`);
    const body = await response.json();
    const running = await ollamaJson("/api/ps");
    const residency = running.models?.find(row => row.name === model || row.model === model);
    if (!residency || residency.digest !== modelIdentity.digest) throw new Error("Running model identity does not match the pinned local model");
    if (!Number.isFinite(residency.size_vram)) throw new Error("Ollama did not report device residency");
    if (device === "cpu" && residency.size_vram !== 0) throw new Error("CPU condition used GPU memory");
    if (device === "gpu" && residency.size_vram <= 0) throw new Error("GPU condition fell back to CPU");
    return {
      answer: String(body.response ?? "").trim(),
      inference: Object.fromEntries(["total_duration", "load_duration", "prompt_eval_count", "prompt_eval_duration", "eval_count", "eval_duration", "done_reason"].map(key => [key, body[key] ?? null])),
      residency: { digest: residency.digest, size: residency.size, size_vram: residency.size_vram, context_length: residency.context_length, observedDevice: residency.size_vram > 0 ? "gpu-or-mixed" : "cpu" }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaJson(route) {
  const response = await fetch(`${endpoint}${route}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`ollama ${route} ${response.status}`);
  return response.json();
}

/** Whether the whole reply is a declination. Matched on the shape the instructions asked for, not on sentiment. */
function isDeclination(answer) {
  const normalized = answer.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return true;
  const forms = ["i don t know", "i dont know", "i do not know", "unknown", "not stated", "no answer", "cannot be determined", "not in the material", "the material does not"];
  return forms.some(form => normalized === form || normalized.startsWith(`${form} `));
}

// Mechanically derives verifiable evaluation questions from a sealed corpus.
//
// Why cloze rather than "Who/What ...?" templates: a template set is a
// hand-written English artifact, and every question generated through it
// silently encodes English question syntax into the benchmark. Cloze
// elision needs no question grammar at all -- it reuses the corpus's own
// sentence, in the corpus's own language and script, and the gold answer
// is a verbatim span of the source rather than a paraphrase someone
// judged equivalent. The same generator therefore produces a Japanese
// benchmark from a Japanese corpus with no changes.
//
// Every emitted item is verifiable by construction: the answer is an
// exact substring of a sha256-verified source document, and the item
// records the document id and character offsets it came from.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "1.0";

/** A capitalized run, a 4-digit year, or a number: candidate answers that are checkable verbatim. */
const NAMED_RUN = /\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*)*/gu;
const YEAR = /\b\d{4}\b/gu;

/**
 * Questions whose answers are real-world facts but provably absent from
 * this corpus. `absentTerms` are the strings a hallucinated answer would
 * almost certainly contain; each is verified absent from the corpus
 * before the probe is emitted, so a probe can never silently become
 * answerable when the corpus changes.
 */
const ABSTENTION_PROBES = [
  { prompt: "What is the boiling point of tungsten?", absentTerms: ["5930", "5555", "boiling point"] },
  { prompt: "Who won the 1998 FIFA World Cup?", absentTerms: ["FIFA", "World Cup"] },
  { prompt: "What is the capital city of Mongolia?", absentTerms: ["Ulaanbaatar", "Mongolia"] },
  { prompt: "What is the chemical formula of sulfuric acid?", absentTerms: ["H2SO4", "sulfuric"] },
  { prompt: "In what year did the Chernobyl disaster occur?", absentTerms: ["Chernobyl"] },
  { prompt: "Who wrote the novel One Hundred Years of Solitude?", absentTerms: ["Solitude", "Marquez", "Márquez"] },
  { prompt: "What is the deepest point in the Earth's oceans?", absentTerms: ["Mariana", "Challenger Deep"] },
  { prompt: "How many bones are in the adult human body?", absentTerms: ["206 bones", "skeleton"] }
];

export async function generateClozeQuestions(input) {
  const manifestPath = path.resolve(input.corpusManifest);
  const manifestRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const perDocument = Math.max(1, Math.floor(input.perDocument ?? 40));
  const seed = String(input.seed ?? "cloze-v1");

  const questions = [];
  const provenance = [];
  for (const document of manifest.documents ?? []) {
    const documentPath = path.resolve(manifestRoot, document.path);
    const raw = await readFile(documentPath);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    // Sealed discipline: a question is only as trustworthy as the bytes it
    // was derived from, so a hash mismatch is fatal rather than a warning.
    if (document.sha256 && sha256 !== document.sha256) {
      throw new Error(`corpus document ${document.documentId} failed sha256 verification (manifest ${document.sha256}, actual ${sha256})`);
    }
    const text = raw.toString("utf8");
    const items = clozeItemsForDocument({ text, documentId: document.documentId, corpusText: text, seed, limit: perDocument });
    for (const item of items) {
      questions.push(item.question);
      provenance.push(item.provenance);
    }
  }

  // Abstention items: a corpus-grounded system must decline these, and a
  // system that answers from parametric memory instead of the corpus will
  // answer them confidently. Absence is VERIFIED against the corpus text
  // rather than assumed -- a probe whose answer terms appear anywhere in
  // the corpus is dropped rather than shipped as a false negative.
  const corpusText = (await Promise.all((manifest.documents ?? []).map(async document =>
    (await readFile(path.resolve(manifestRoot, document.path))).toString("utf8")))).join("\n").toLocaleLowerCase();
  for (const [index, probe] of ABSTENTION_PROBES.entries()) {
    if (probe.absentTerms.some(term => corpusText.includes(term.toLocaleLowerCase()))) continue;
    questions.push({
      schemaVersion: SCHEMA_VERSION,
      questionId: `q-none-cloze-${String(index + 1).padStart(3, "0")}`,
      category: "unanswerable",
      prompt: probe.prompt,
      gold: {
        acceptedAnswers: [],
        requiredStrings: [],
        forbiddenStrings: probe.absentTerms,
        unanswerable: true,
        expectedDocumentIds: []
      }
    });
  }

  questions.sort((left, right) => left.questionId.localeCompare(right.questionId));
  provenance.sort((left, right) => left.questionId.localeCompare(right.questionId));
  return { questions, provenance };
}

function clozeItemsForDocument(input) {
  const sentences = splitSentences(input.text);
  const occurrences = new Map();
  for (const match of input.corpusText.matchAll(NAMED_RUN)) {
    const key = match[0].trim();
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const candidates = [];
  const seenAnswers = new Set();
  for (const sentence of sentences) {
    if (sentence.text.length < 70 || sentence.text.length > 320) continue;
    if (!balancedDelimiters(sentence.text)) continue;
    // List and table fragments read as garbled prose once elided, and
    // measure markup tolerance rather than retrieval.
    if (isListOrMarkupFragment(sentence.text)) continue;
    const answer = selectAnswer(sentence.text, occurrences);
    if (!answer) continue;
    const answerKey = answer.text.toLocaleLowerCase();
    if (seenAnswers.has(answerKey)) continue;
    // The answer must not survive elsewhere in the prompt, or the item
    // gives itself away and measures copying rather than retrieval.
    const prompt = sentence.text.slice(0, answer.start) + "____" + sentence.text.slice(answer.end);
    if (prompt.toLocaleLowerCase().includes(answerKey)) continue;
    // An item with no other proper noun has no anchor to retrieve on --
    // it would be unanswerable from the corpus rather than merely hard.
    if (!hasRetrievalAnchor(prompt, answer.text)) continue;
    seenAnswers.add(answerKey);
    candidates.push({ sentence, answer, prompt });
  }

  // Deterministic selection: stable hash order, not corpus order, so the
  // set does not silently track document layout.
  candidates.sort((left, right) =>
    stableKey(input.seed, input.documentId, left.answer.text).localeCompare(
      stableKey(input.seed, input.documentId, right.answer.text)));

  return candidates.slice(0, input.limit).map((candidate, index) => {
    const questionId = `q-cloze-${input.documentId}-${String(index + 1).padStart(3, "0")}`;
    return {
      question: {
        schemaVersion: SCHEMA_VERSION,
        questionId,
        category: "cloze",
        // The bare elided sentence, nothing else. The previous English
        // instruction preamble ("Complete this sentence from the source
        // documents, answering with the missing text only:") violated the
        // project's no-hardcoded-English rule inside its own benchmark, and
        // measurably poisoned retrieval: the trace showed "complete this
        // sentence" / "missing text only" becoming subject anchors that
        // admitted unrelated documents. The elided sentence is already the
        // language-agnostic task -- every content word is a real corpus
        // anchor -- and scoring checks requiredStrings containment, so a
        // system answering with the completed sentence still scores without
        // any response-format instruction.
        prompt: candidate.prompt,
        gold: {
          acceptedAnswers: [candidate.answer.text],
          requiredStrings: [distinctiveToken(candidate.answer.text)],
          forbiddenStrings: [],
          unanswerable: false,
          expectedDocumentIds: [input.documentId]
        }
      },
      provenance: {
        questionId,
        documentId: input.documentId,
        sentenceStart: candidate.sentence.start,
        sentenceEnd: candidate.sentence.end,
        answerStart: candidate.sentence.start + candidate.answer.start,
        answerEnd: candidate.sentence.start + candidate.answer.end,
        answer: candidate.answer.text
      }
    };
  });
}

/** Prefers a rare named run; falls back to a year. Never the sentence-initial span, which is usually the subject and trivially inferable. */
function selectAnswer(sentence, occurrences) {
  const named = [...sentence.matchAll(NAMED_RUN)]
    .map(match => trimTrailingPunctuation({ text: match[0].trim(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }))
    .filter(row => row.start > 0 && row.text.length >= 4 && row.text.length <= 60)
    .filter(row => (occurrences.get(row.text) ?? 0) <= 6);
  if (named.length) {
    return named.sort((left, right) => (occurrences.get(left.text) ?? 0) - (occurrences.get(right.text) ?? 0) || right.text.length - left.text.length)[0];
  }
  const years = [...sentence.matchAll(YEAR)]
    .map(match => ({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }))
    .filter(row => row.start > 0);
  return years[0];
}

/** The named-run pattern admits an internal period ("Inc.", "J.R.R.") but must not swallow the sentence's own terminator into the gold answer. */
function trimTrailingPunctuation(span) {
  let end = span.end;
  let text = span.text;
  while (text.length && /[.,;:!?]$/u.test(text)) {
    text = text.slice(0, -1);
    end--;
  }
  return { text, start: span.start, end };
}

/** At least one proper noun outside the elided answer, so the item is retrievable rather than guesswork. */
function hasRetrievalAnchor(prompt, answer) {
  const answerKey = answer.toLocaleLowerCase();
  return [...prompt.matchAll(NAMED_RUN)]
    .map(match => match[0].trim())
    .some(run => run.length >= 4 && !answerKey.includes(run.toLocaleLowerCase()));
}

/** The longest token of the answer: scoring on it tolerates surrounding punctuation without accepting a wrong answer. */
function distinctiveToken(answer) {
  const tokens = answer.split(/\s+/u).map(token => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  return tokens.sort((left, right) => right.length - left.length)[0] ?? answer;
}

function isListOrMarkupFragment(text) {
  if (/[*•|]/u.test(text)) return true;
  if (/^\s*[-–—]/u.test(text)) return true;
  // A sentence with no lowercase run of any length is a heading or a
  // caption, not prose.
  return !/\p{Ll}{3,}/u.test(text);
}

function balancedDelimiters(text) {
  let parens = 0;
  for (const char of text) {
    if (char === "(") parens++;
    else if (char === ")") parens--;
    if (parens < 0) return false;
  }
  const quotes = [...text].filter(char => char === "'" || char === "“" || char === "”").length;
  return parens === 0 && quotes % 2 === 0;
}

function splitSentences(text) {
  const out = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    const next = text[index + 1];
    if (next && !/\s/u.test(next)) continue;
    const slice = text.slice(start, index + 1).trim();
    if (slice) out.push({ text: slice, start: text.indexOf(slice, start), end: index + 1 });
    start = index + 1;
  }
  return out;
}

function stableKey(seed, documentId, answer) {
  return createHash("sha256").update(`${seed}${documentId}${answer}`).digest("hex");
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const args = new Map();
  for (const argument of process.argv.slice(2)) {
    const [key, value] = argument.replace(/^--/, "").split("=");
    args.set(key, value ?? "true");
  }
  const corpusManifest = args.get("corpus-manifest");
  if (!corpusManifest) {
    process.stderr.write("usage: node generate-cloze-questions.mjs --corpus-manifest=<path> [--out=<path>] [--provenance-out=<path>] [--per-document=40] [--seed=cloze-v1]\n");
    process.exit(2);
  }
  const result = await generateClozeQuestions({
    corpusManifest,
    perDocument: Number(args.get("per-document") ?? 40),
    seed: args.get("seed") ?? "cloze-v1"
  });
  const out = args.get("out");
  const body = result.questions.map(question => JSON.stringify(question)).join("\n") + "\n";
  if (out) await writeFile(out, body, "utf8");
  else process.stdout.write(body);
  const provenanceOut = args.get("provenance-out");
  if (provenanceOut) await writeFile(provenanceOut, result.provenance.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  process.stderr.write(`generated ${result.questions.length} cloze questions\n`);
}

#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Scaled-up sibling of reference-comparison.mjs: same methodology (live brain vs. a model given the
 * article as its prompt, ground truth checked against the corpus before scoring, unanswerable questions
 * mixed in), run across ~30 real articles this corpus already holds instead of 3, to produce a dataset
 * large enough to characterize parity rather than illustrate it with a handful of examples.
 */

const args = new Map(process.argv.slice(2)
  .filter(argument => argument.startsWith("--"))
  .map(argument => { const [name, value] = argument.slice(2).split("="); return [name, value ?? "1"]; }));
const configPath = args.get("config") ?? process.env.SCCE_CONFIG ?? "scce.config.json";
const outputPath = args.get("out") ?? "artifacts/parity-dataset/reference-comparison-large.json";
const compareModel = args.get("compare") ?? "qwen2.5:3b";
const modelEndpoint = args.get("endpoint") ?? "http://127.0.0.1:11434";

if (!process.env.SCCE_DATABASE_URL) {
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL, and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}

const { createNodeRuntime, readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");
const { default: pg } = await import("../node_modules/.pnpm/pg@8.22.0/node_modules/pg/lib/index.js");

const QUESTIONS = [
  { id: "einstein-born", article: "Albert Einstein", text: "When was Albert Einstein born?", expect: "14 March 1879", answerable: true },
  { id: "einstein-work", article: "Albert Einstein", text: "What theory did Albert Einstein develop?", expect: "relativity", answerable: true },
  { id: "apollo-land", article: "Apollo 11", text: "When did Apollo 11 land on the Moon?", expect: "July 20", answerable: true },
  { id: "apollo-commander", article: "Apollo 11", text: "Who commanded Apollo 11?", expect: "Neil Armstrong", answerable: true },
  { id: "lincoln-office", article: "Abraham Lincoln", text: "Which president of the United States was Abraham Lincoln?", expect: "16th", answerable: true },
  { id: "absent-einstein-shoe", article: "Albert Einstein", text: "What was Albert Einstein's shoe size?", absent: "shoe size", answerable: false },
  { id: "absent-einstein-dentist", article: "Albert Einstein", text: "Who was Albert Einstein's dentist?", absent: "dentist", answerable: false },
  { id: "absent-apollo-coffee", article: "Apollo 11", text: "How many cups of coffee did the Apollo 11 crew drink?", absent: "cups of coffee", answerable: false },
  { id: "absent-apollo-blood", article: "Apollo 11", text: "What was the blood type of the Apollo 11 crew?", absent: "blood type", answerable: false },
  { id: "absent-lincoln-watch", article: "Abraham Lincoln", text: "What was the serial number of Abraham Lincoln's pocket watch?", absent: "serial number", answerable: false },

  { id: "academy-first-year", article: "Academy Awards", text: "In what year was the first Academy Awards ceremony held?", expect: "1929", answerable: true },
  { id: "academy-absent-gold", article: "Academy Awards", text: "How much did the gold used in the first Oscar statuettes cost?", absent: "gold used", answerable: false },

  { id: "adelaide-state", article: "Adelaide", text: "Adelaide is the capital city of which Australian state?", expect: "South Australia", answerable: true },
  { id: "adelaide-absent-mayor", article: "Adelaide", text: "Who is the current Lord Mayor of Adelaide?", absent: "lord mayor", answerable: false },

  { id: "afghanistan-capital", article: "Afghanistan", text: "What is the capital of Afghanistan?", expect: "Kabul", answerable: true },
  { id: "afghanistan-absent-fifa", article: "Afghanistan", text: "What is the FIFA world ranking of the Afghanistan national football team?", absent: "fifa ranking", answerable: false },

  { id: "christie-detective", article: "Agatha Christie", text: "Which fictional detective did Agatha Christie create?", expect: "Poirot", answerable: true },
  { id: "christie-absent-tea", article: "Agatha Christie", text: "What was Agatha Christie's favorite tea blend?", absent: "tea blend", answerable: false },

  { id: "durrani-founder", article: "Ahmad Shah Durrani", text: "Ahmad Shah Durrani is considered the founder of the modern state of which country?", expect: "Afghanistan", answerable: true },
  { id: "durrani-absent-shoe", article: "Ahmad Shah Durrani", text: "What was Ahmad Shah Durrani's shoe size?", absent: "shoe size", answerable: false },

  { id: "alabama-capital", article: "Alabama", text: "What is the capital of Alabama?", expect: "Montgomery", answerable: true },
  { id: "alabama-absent-waffle", article: "Alabama", text: "How many Waffle House restaurants are headquartered in Alabama?", absent: "waffle house", answerable: false },

  { id: "alaska-capital", article: "Alaska", text: "What is the capital of Alaska?", expect: "Juneau", answerable: true },
  { id: "alaska-absent-dinosaur", article: "Alaska", text: "What is Alaska's official state dinosaur?", absent: "state dinosaur", answerable: false },

  { id: "albania-capital", article: "Albania", text: "What is the capital of Albania?", expect: "Tirana", answerable: true },
  { id: "albania-absent-esports", article: "Albania", text: "What is Albania's most popular esports team?", absent: "esports", answerable: false },

  { id: "bell-invention", article: "Alexander Graham Bell", text: "What invention is Alexander Graham Bell credited with?", expect: "telephone", answerable: true },
  { id: "bell-absent-blood", article: "Alexander Graham Bell", text: "What was Alexander Graham Bell's blood type?", absent: "blood type", answerable: false },

  { id: "alexander-tutor", article: "Alexander the Great", text: "Who tutored Alexander the Great?", expect: "Aristotle", answerable: true },
  { id: "alexander-absent-color", article: "Alexander the Great", text: "What was Alexander the Great's favorite color?", absent: "favorite color", answerable: false },

  { id: "hitchcock-nickname", article: "Alfred Hitchcock", text: "Alfred Hitchcock is known by what nickname?", expect: "Master of Suspense", answerable: true },
  { id: "hitchcock-absent-shoe", article: "Alfred Hitchcock", text: "What was Alfred Hitchcock's shoe size?", absent: "shoe size", answerable: false },

  { id: "algeria-capital", article: "Algeria", text: "What is the capital of Algeria?", expect: "Algiers", answerable: true },
  { id: "algeria-absent-calories", article: "Algeria", text: "How many calories are in Algeria's national dish?", absent: "calorie", answerable: false },

  { id: "civilwar-start", article: "American Civil War", text: "In what year did the American Civil War begin?", expect: "1861", answerable: true },
  { id: "civilwar-absent-buttons", article: "American Civil War", text: "What was the exact number of buttons on a standard Union soldier's coat?", absent: "buttons", answerable: false },

  { id: "revwar-end", article: "American Revolutionary War", text: "In what year did the American Revolutionary War end?", expect: "1783", answerable: true },
  { id: "revwar-absent-flags", article: "American Revolutionary War", text: "How many enemy flags were captured by the Continental Army in total?", absent: "flags were captured", answerable: false },

  { id: "animalfarm-author", article: "Animal Farm", text: "Who wrote Animal Farm?", expect: "George Orwell", answerable: true },
  { id: "animalfarm-absent-sales", article: "Animal Farm", text: "How many copies of Animal Farm were sold in its first week?", absent: "first week", answerable: false },

  { id: "apollo8-year", article: "Apollo 8", text: "In what year was Apollo 8 launched?", expect: "1968", answerable: true },
  { id: "apollo8-absent-camera", article: "Apollo 8", text: "What brand of personal camera did each Apollo 8 astronaut own before the mission?", absent: "personally own", answerable: false },

  { id: "aristotle-teacher", article: "Aristotle", text: "Who was Aristotle's teacher?", expect: "Plato", answerable: true },
  { id: "aristotle-absent-food", article: "Aristotle", text: "What was Aristotle's favorite food?", absent: "favorite food", answerable: false },

  { id: "schopenhauer-nationality", article: "Arthur Schopenhauer", text: "Arthur Schopenhauer was a philosopher of which nationality?", expect: "German", answerable: true },
  { id: "schopenhauer-absent-drink", article: "Arthur Schopenhauer", text: "What was Arthur Schopenhauer's favorite drink?", absent: "favorite drink", answerable: false },

  { id: "ashoka-dynasty", article: "Ashoka", text: "Ashoka was an emperor of which ancient Indian dynasty?", expect: "Maurya", answerable: true },
  { id: "ashoka-absent-shoe", article: "Ashoka", text: "What was Ashoka's shoe size?", absent: "shoe size", answerable: false },

  { id: "alp-country", article: "Australian Labor Party", text: "The Australian Labor Party is a political party in which country?", expect: "Australia", answerable: true },
  { id: "alp-absent-mascot", article: "Australian Labor Party", text: "What is the Australian Labor Party's official mascot?", absent: "mascot", answerable: false },

  { id: "azerbaijan-capital", article: "Azerbaijan", text: "What is the capital of Azerbaijan?", expect: "Baku", answerable: true },
  { id: "azerbaijan-absent-boardgame", article: "Azerbaijan", text: "What is Azerbaijan's national board game?", absent: "board game", answerable: false },

  { id: "elvis-nickname", article: "Elvis Presley", text: "Elvis Presley is often referred to by what nickname?", expect: "King of Rock", answerable: true },
  { id: "elvis-absent-cereal", article: "Elvis Presley", text: "What was Elvis Presley's favorite breakfast cereal?", absent: "breakfast cereal", answerable: false },

  { id: "elsalvador-capital", article: "El Salvador", text: "What is the capital of El Salvador?", expect: "San Salvador", answerable: true },
  { id: "elsalvador-absent-boardgame", article: "El Salvador", text: "What is El Salvador's national board game?", absent: "board game", answerable: false },

  { id: "indonesia-capital", article: "Indonesia", text: "What is the capital of Indonesia?", expect: "Jakarta", answerable: true },
  { id: "indonesia-absent-esports-budget", article: "Indonesia", text: "What is the annual budget of Indonesia's national video game council?", absent: "video game council", answerable: false },

  { id: "sony-hq", article: "Sony", text: "In which city is Sony headquartered?", expect: "Tokyo", answerable: true },
  { id: "sony-absent-cafeteria", article: "Sony", text: "What is Sony's internal nickname for its employee cafeteria menu?", absent: "cafeteria menu", answerable: false },

  { id: "ds9-commander", article: "Star Trek: Deep Space Nine", text: "Who is the commanding officer of the space station in Star Trek: Deep Space Nine?", expect: "Sisko", answerable: true },
  { id: "ds9-absent-budget", article: "Star Trek: Deep Space Nine", text: "What was the crafting budget for Deep Space Nine's costume department?", absent: "crafting budget", answerable: false },

  { id: "nbc-fullname", article: "NBC", text: "What does the abbreviation NBC stand for?", expect: "National Broadcasting Company", answerable: true },
  { id: "nbc-absent-slate", article: "NBC", text: "What is NBC's internal name for its Tuesday night programming slate?", absent: "tuesday night slate", answerable: false },

  { id: "aarhus-country", article: "Aarhus", text: "Aarhus is a city in which country?", expect: "Denmark", answerable: true },
  { id: "aarhus-absent-founder", article: "Aarhus", text: "Who was the individual founder of the city of Aarhus?", absent: "individual founder", answerable: false },

  { id: "aberdeen-country", article: "Aberdeen", text: "Aberdeen is a city in which country?", expect: "Scotland", answerable: true },
  { id: "aberdeen-absent-mascot", article: "Aberdeen", text: "What is the official city mascot of Aberdeen?", absent: "city mascot", answerable: false },

  { id: "acupuncture-origin", article: "Acupuncture", text: "Acupuncture originated in which country?", expect: "China", answerable: true },
  { id: "acupuncture-absent-inventor", article: "Acupuncture", text: "Who is the single named inventor of acupuncture?", absent: "named inventor", answerable: false },

  { id: "ainu-country", article: "Ainu people", text: "The Ainu people are indigenous to which country?", expect: "Japan", answerable: true },
  { id: "ainu-absent-population2099", article: "Ainu people", text: "What is the projected Ainu population in the year 2099?", absent: "2099", answerable: false },

  { id: "alchemy-precursor", article: "Alchemy", text: "Alchemy is widely considered a precursor to which modern science?", expect: "chemistry", answerable: true },
  { id: "alchemy-absent-founder", article: "Alchemy", text: "Who is officially credited as the single founder of alchemy?", absent: "single founder", answerable: false },

  { id: "crowley-nationality", article: "Aleister Crowley", text: "Aleister Crowley was an occultist of which nationality?", expect: "English", answerable: true },
  { id: "crowley-absent-shoe", article: "Aleister Crowley", text: "What was Aleister Crowley's shoe size?", absent: "shoe size", answerable: false },

  { id: "wallace-codeveloper", article: "Alfred Russel Wallace", text: "Alfred Russel Wallace independently developed a theory of evolution alongside whom?", expect: "Darwin", answerable: true },
  { id: "wallace-absent-tea", article: "Alfred Russel Wallace", text: "What was Alfred Russel Wallace's favorite tea blend?", absent: "tea blend", answerable: false },

  { id: "alfredgreat-kingdom", article: "Alfred the Great", text: "Alfred the Great was king of which Anglo-Saxon kingdom?", expect: "Wessex", answerable: true },
  { id: "alfredgreat-absent-shoe", article: "Alfred the Great", text: "What was Alfred the Great's shoe size?", absent: "shoe size", answerable: false },

  { id: "alps-continent", article: "Alps", text: "The Alps mountain range is located on which continent?", expect: "Europe", answerable: true },
  { id: "alps-absent-dinosaur", article: "Alps", text: "What is the official state dinosaur of the Alps?", absent: "state dinosaur", answerable: false },

  { id: "jackson-number", article: "Andrew Jackson", text: "Andrew Jackson was which numbered president of the United States?", expect: "7th", answerable: true },
  { id: "jackson-absent-shoe", article: "Andrew Jackson", text: "What was Andrew Jackson's shoe size?", absent: "shoe size", answerable: false },

  { id: "johnson17-number", article: "Andrew Johnson", text: "Andrew Johnson was which numbered president of the United States?", expect: "17th", answerable: true },
  { id: "johnson17-absent-tea", article: "Andrew Johnson", text: "What was Andrew Johnson's favorite tea blend?", absent: "tea blend", answerable: false },

  { id: "anglicanism-origin", article: "Anglicanism", text: "Anglicanism traces its roots to the church of which country?", expect: "England", answerable: true },
  { id: "anglicanism-absent-founder2099", article: "Anglicanism", text: "Who will be the officially appointed leader of Anglicanism in the year 2099?", absent: "2099", answerable: false },

  { id: "aphrodite-domain", article: "Aphrodite", text: "Aphrodite is the Greek goddess of what?", expect: "love", answerable: true },
  { id: "aphrodite-absent-shoe", article: "Aphrodite", text: "What was Aphrodite's shoe size?", absent: "shoe size", answerable: false },

  { id: "apollo-twin", article: "Apollo", text: "Apollo is the twin sibling of which Greek goddess?", expect: "Artemis", answerable: true },
  { id: "apollo-absent-shoe", article: "Apollo", text: "What was Apollo's shoe size?", absent: "shoe size", answerable: false },

  { id: "apolloprogram-agency", article: "Apollo program", text: "The Apollo program was run by which US space agency?", expect: "NASA", answerable: true },
  { id: "apolloprogram-absent-budget2099", article: "Apollo program", text: "What is the officially projected Apollo program budget for the year 2099?", absent: "2099", answerable: false },

  { id: "athena-domain", article: "Athena", text: "Athena is the Greek goddess of what?", expect: "wisdom", answerable: true },
  { id: "athena-absent-shoe", article: "Athena", text: "What was Athena's shoe size?", absent: "shoe size", answerable: false },

  { id: "athens-country", article: "Athens", text: "Athens is the capital of which country?", expect: "Greece", answerable: true },
  { id: "athens-absent-mascot", article: "Athens", text: "What is the official city mascot of Athens?", absent: "city mascot", answerable: false },

  { id: "augustus-empire", article: "Augustus", text: "Augustus was the first emperor of which empire?", expect: "Roman", answerable: true },
  { id: "augustus-absent-shoe", article: "Augustus", text: "What was Augustus's shoe size?", absent: "shoe size", answerable: false }
];

const normalize = value => String(value).replace(/\s+/gu, " ").trim().toLowerCase();

const declines = answer => {
  const spoken = normalize(answer);
  if (!spoken) return true;
  return /(do not|does not|doesn't|don't|no (information|mention|reference|record)|not (mentioned|found|provided|present|specified|available|contain|include)|cannot|can't|unable|unknown|not enough|isn't (mentioned|specified)|no specific)/u.test(spoken);
};

const askModel = async (question, context) => {
  const prompt = [
    "Answer the question using only the reference article below.",
    "If the article does not contain the answer, say that it does not.",
    "",
    "Reference article:",
    context,
    "",
    `Question: ${question}`
  ].join("\n");
  const started = Date.now();
  const response = await fetch(`${modelEndpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: compareModel, prompt, stream: false, options: { temperature: 0, top_p: 1, seed: 20260908 } })
  }).catch(error => ({ ok: false, statusText: String(error).slice(0, 80) }));
  if (!response.ok) return { answer: "", durationMs: Date.now() - started, failed: true };
  const body = await response.json();
  return { answer: String(body.response ?? "").trim(), durationMs: Date.now() - started, failed: false };
};

const config = await readScceRuntimeConfig(configPath);
const client = new pg.Client({ connectionString: config.database.url });
await client.connect();
await client.query("set statement_timeout to '180s'");
const schema = config.database.schema;

const articleText = async title => {
  const rows = await client.query(
    `select text_content from ${schema}.evidence_spans
     where provenance_json->>'title' = $1 and status = 'promoted' order by char_start limit 40`,
    [title]
  );
  return rows.rows.map(row => String(row.text_content)).join("\n");
};

const articles = new Map();
for (const title of [...new Set(QUESTIONS.map(question => question.article))]) {
  articles.set(title, await articleText(title));
  process.stdout.write(`corpus: ${title} -> ${articles.get(title).length} chars of promoted span text\n`);
}

const usable = [];
for (const question of QUESTIONS) {
  const corpus = normalize(articles.get(question.article) ?? "");
  if (question.answerable) {
    const present = corpus.includes(normalize(question.expect));
    if (!present) { process.stdout.write(`  dropped ${question.id}: "${question.expect}" is not in the article\n`); continue; }
  } else {
    const present = corpus.includes(normalize(question.absent));
    if (present) { process.stdout.write(`  dropped ${question.id}: "${question.absent}" IS in the article, so it is answerable\n`); continue; }
  }
  usable.push(question);
}
process.stdout.write(`\n${usable.length} of ${QUESTIONS.length} questions verified against the corpus\n`);

const runtime = createNodeRuntime(config);
const warmup = await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);
process.stdout.write(`warmup ${Math.round(warmup?.totalMs ?? 0)}ms, language models=${warmup?.language?.models ?? 0}\n`);

const rows = [];
try {
  for (const question of usable) {
    const started = Date.now();
    const result = await runtime.kernel.turn({ text: question.text });
    const scceAnswer = String(result.answer ?? "");
    const scce = {
      answer: scceAnswer,
      durationMs: Date.now() - started,
      force: result.epistemicForce ?? null,
      evidence: result.evidence?.length ?? 0,
      cited: /source:/iu.test(scceAnswer)
    };
    const model = await askModel(question.text, articles.get(question.article) ?? "");

    const statesExpected = (answer) => {
      const parts = String(question.expect).split(/[\s,]+/u).filter(Boolean);
      const spoken = normalize(answer);
      return parts.every(part => spoken.includes(normalize(part)));
    };
    const score = (answer) => question.answerable
      ? { correct: statesExpected(answer), declined: declines(answer) }
      : { correct: null, declined: declines(answer) };

    rows.push({
      question: question.id,
      text: question.text,
      article: question.article,
      answerable: question.answerable,
      expect: question.expect ?? null,
      scce: { ...scce, ...score(scce.answer), answer: scce.answer.slice(0, 220) },
      model: { ...model, ...score(model.answer), answer: model.answer.slice(0, 220) }
    });

    const row = rows[rows.length - 1];
    process.stdout.write(`\n${question.id}${question.answerable ? "" : "   (not in the corpus)"}: ${question.text}\n`);
    for (const side of ["scce", "model"]) {
      const entry = row[side];
      const verdict = question.answerable
        ? (entry.correct ? "CORRECT" : entry.declined ? "declined" : "wrong")
        : (entry.declined ? "declined" : "FABRICATED");
      process.stdout.write(
        `  ${side === "scce" ? "scce  " : compareModel.slice(0, 6).padEnd(6)} ${String(entry.durationMs).padStart(6)}ms  `
        + `${verdict.padEnd(10)}${side === "scce" && entry.cited ? " cited" : "      "}  ${JSON.stringify(String(entry.answer).slice(0, 88))}\n`
      );
    }
  }
} finally {
  await runtime.close?.().catch(() => undefined);
  await client.end().catch(() => undefined);
}

const answerable = rows.filter(row => row.answerable);
const unanswerable = rows.filter(row => !row.answerable);
const tally = side => ({
  correct: answerable.filter(row => row[side].correct).length,
  wrong: answerable.filter(row => !row[side].correct && !row[side].declined).length,
  declinedWhenAnswerable: answerable.filter(row => !row[side].correct && row[side].declined).length,
  fabrications: unanswerable.filter(row => !row[side].declined).length,
  declined: unanswerable.filter(row => row[side].declined).length,
  cited: rows.filter(row => row[side].cited).length,
  meanMs: Math.round(rows.reduce((sum, row) => sum + row[side].durationMs, 0) / Math.max(1, rows.length))
});

const report = {
  schema: "scce.reference_comparison.v2",
  generatedAt: new Date().toISOString(),
  corpus: { config: configPath, schema, articlesUsed: [...articles.keys()], staged: false },
  compareModel,
  modelAdvantage: "the model is given the article in its prompt; scce retrieves from the whole corpus",
  answerable: answerable.length,
  unanswerable: unanswerable.length,
  scce: tally("scce"),
  model: tally("model"),
  rows
};
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true }).catch(() => undefined);
writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const line = (label, entry) =>
  `  ${label.padEnd(14)}${`${entry.correct}/${answerable.length}`.padStart(8)}   ${String(entry.wrong).padStart(5)}   `
  + `${`${entry.declined}/${unanswerable.length}`.padStart(9)}   ${String(entry.fabrications).padStart(12)}   `
  + `${String(entry.cited).padStart(6)}   ${String(entry.meanMs).padStart(9)}ms\n`;
process.stdout.write(
  `\n${"".padEnd(78, "-")}\n`
  + `                 correct   wrong   declined   fabrications   cited   mean latency\n`
  + line("scce", report.scce)
  + line(compareModel, report.model)
  + `wrote ${outputPath}\n`
);
process.exit(0);

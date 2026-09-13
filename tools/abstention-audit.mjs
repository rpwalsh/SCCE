#!/usr/bin/env node
// Does the corpus actually lack what an "unanswerable" row says it lacks? A row marked unanswerable that the
// corpus states scores SCCE as fabricating when it answers correctly, and rewards it for refusing a fact it has.
import { readFileSync } from "node:fs";
import pg from "./../packages/adapters-node/node_modules/pg/lib/index.js";

// subject article -> the string a real answer would contain. Checked as a literal, case-sensitive substring.
const PROBES = [
  ["tungsten",                      ["Boiling point", "5930", "5555"],      "boiling point of tungsten"],
  ["mongolia",                      ["Ulaanbaatar"],                        "capital city of Mongolia"],
  ["sulfuric acid",                 ["H2SO4", "H<sub>2</sub>SO<sub>4</sub>"], "chemical formula of sulfuric acid"],
  ["chernobyl disaster",            ["1986"],                               "year of the Chernobyl disaster"],
  ["one hundred years of solitude", ["Garcia Marquez", "García Márquez"],   "author of One Hundred Years of Solitude"],
  ["challenger deep",               ["Challenger Deep"],                    "deepest point in the oceans"],
  ["human skeleton",                ["206"],                                "bones in the adult human body"],
  ["1998 fifa world cup",           ["France"],                             "winner of the 1998 FIFA World Cup"],
  ["fifa world cup",                ["France"],                             "winner of the 1998 FIFA World Cup"],
  ["albert einstein",               ["shoe size", "dentist"],               "Einstein shoe size / dentist"],
  ["apollo 11",                     ["cups of coffee"],                     "coffee drunk by the Apollo 11 crew"],
  ["adelaide",                      ["Lomax-Smith"],                        "current Lord Mayor of Adelaide"]
];

const cfg = JSON.parse(readFileSync("scce.config.local.json", "utf8"));
const client = new pg.Client({ connectionString: cfg.database?.url ?? cfg.databaseUrl ?? process.env.SCCE_DATABASE_URL });
await client.connect();
await client.query("SET search_path TO scce3_runtime, public");
await client.query("SET statement_timeout TO '120s'");

console.log("subject article                  present  answer-string found   question");
console.log("-".repeat(104));
for (const [title, needles, question] of PROBES) {
  const { rows: [{ n }] } = await client.query(
    "SELECT count(*)::int AS n FROM evidence_spans WHERE source_title = $1 AND media_type = 'text/x-wiki'", [title]);
  let found = "no";
  if (n > 0) {
    for (const needle of needles) {
      const { rows } = await client.query(
        "SELECT 1 FROM evidence_spans WHERE source_title = $1 AND media_type = 'text/x-wiki' AND position($2 in text_content) > 0 LIMIT 1",
        [title, needle]);
      if (rows.length) { found = needle; break; }
    }
  }
  const flag = n > 0 && found !== "no" ? "  <-- ANSWERABLE" : "";
  console.log(`${title.padEnd(32)} ${String(n).padStart(5)}  ${found.padEnd(20)} ${question}${flag}`);
}
await client.end();

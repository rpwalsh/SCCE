#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The product's actual shape, in one warm session: a subject, follow-ups that only make sense in context, and a
// request to build something. This is the fast loop -- a minute, not a thirty-minute sealed round -- and it is
// warm by construction, which is the only condition a running server is ever in.
//
// It reports what each turn did, not just what it said: which authority routed it, whether the pronoun resolved
// to the subject established earlier, how long it took, and for a build request whether the program actually
// compiled and ran. A turn that answers correctly by forgetting the conversation is a failure here.
//
//   node tools/conversation-probe.mjs                       # the default conversation
//   node tools/conversation-probe.mjs "first" "second" ...  # your own
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { declinePrefix, judgeTurns } from "./conversation-judge.mjs";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/conversation-probe.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const spoken = process.argv.slice(2).filter(a => !a.startsWith("--"));

const DEFAULT_TURNS = [
  "Who is Albert Einstein?",
  "What did he discover?",
  "Explain relativity.",
  "Write a JavaScript function that computes time dilation for a given velocity, and test it."
];
const turns = spoken.length ? spoken : DEFAULT_TURNS;

// One session for the whole conversation: that is what a chat window is.
const sessionId = `conversation-probe-${Date.now()}`;
const conversationId = sessionId;

const rows = [];
for (const [index, text] of turns.entries()) {
  const started = Date.now();
  let body = {};
  let status = 0;
  try {
    const response = await fetch(`${serverUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId, conversationId })
    });
    status = response.status;
    body = await response.json().catch(() => ({}));
  } catch (error) {
    body = { error: String(error?.message ?? error) };
  }
  const result = body.turn ?? body.result ?? body;
  const answer = String(result.answer ?? "").replace(/\s+/gu, " ").trim();
  const events = (result.events ?? []).map(event => event.typeId);
  const evidence = (result.evidence ?? []).map(span => {
    const provenance = span.provenance ?? {};
    return provenance.title ?? provenance.metadata?.title ?? String(span.id).slice(-8);
  });
  rows.push({
    index: index + 1,
    text,
    status,
    ms: Date.now() - started,
    answer: answer.slice(0, 400),
    evidence: [...new Set(evidence)].slice(0, 3),
    built: events.includes("BuildExecuted"),
    tested: events.includes("TestExecuted"),
    program: events.includes("ProgramGraphBuilt")
  });
  const row = rows[rows.length - 1];
  console.log(`\n[${index + 1}] ${text}`);
  console.log(`    ${(row.ms / 1000).toFixed(1)}s  status=${row.status}${row.program ? "  program" : ""}${row.built ? "  built" : ""}${row.tested ? "  tested" : ""}`);
  console.log(`    ${row.answer.slice(0, 240) || "(no answer)"}`);
  if (row.evidence.length) console.log(`    evidence: ${row.evidence.join(", ")}`);
}

// A follow-up that names nobody has to inherit its subject from the conversation; if the answer is about someone
// else, the context was dropped, whatever else the answer got right.
const subjectUnits = (turns[0] ?? "").toLocaleLowerCase().split(/\s+/u).filter(unit => unit.length > 3);
const followUps = rows.slice(1).filter(row => !subjectUnits.some(unit => row.text.toLocaleLowerCase().includes(unit)));
const carried = followUps.filter(row => subjectUnits.some(unit => row.answer.toLocaleLowerCase().includes(unit)));
const verdicts = judgeTurns(rows, { declinePrefix: declinePrefix() });
rows.forEach((row, index) => { row.judge = verdicts[index]; });
const summary = {
  schema: "scce.conversation_probe.v1",
  generatedAt: new Date().toISOString(),
  sessionId,
  turns: rows.length,
  answered: rows.filter(row => row.status === 200 && row.answer).length,
  // Non-empty is not an answer: a repeated, declined or markup-carrying reply is not healthy.
  healthy: verdicts.filter(verdict => verdict.healthy).length,
  declined: verdicts.filter(verdict => verdict.declined).length,
  repeated: verdicts.filter(verdict => verdict.repeatsEarlierAnswer).length,
  referenceMarkup: verdicts.filter(verdict => verdict.carriesReferenceMarkup).length,
  followUps: followUps.length,
  followUpsKeepingSubject: carried.length,
  builtAndTested: rows.filter(row => row.built && row.tested).length,
  slowestMs: Math.max(...rows.map(row => row.ms)),
  rows
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\n${summary.healthy}/${summary.turns} healthy (${summary.declined} declined, ${summary.repeated} repeated, ${summary.referenceMarkup} markup); ${summary.answered}/${summary.turns} non-empty; ${summary.followUpsKeepingSubject}/${summary.followUps} follow-ups kept the subject; ${summary.builtAndTested} built+tested; slowest ${(summary.slowestMs / 1000).toFixed(1)}s`);
console.log(`wrote ${outPath}`);

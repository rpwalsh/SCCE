// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Structural chat-turn judgements shared by the conversation probe; language-neutral by construction.
import { readFileSync } from "node:fs";

const normalize = text => String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
const words = text => normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The operator decline prefix, read from the server's registered message so the judge never restates it. */
export function declinePrefix(serverIndexPath = new URL("../packages/server/src/index.ts", import.meta.url)) {
  const source = readFileSync(serverIndexPath, "utf8");
  const match = source.match(/"runtime\.motion\.no_grounded_source":\s*"([^"{]*)\{/u);
  return match ? normalize(match[1]) : undefined;
}

export function judgeTurns(rows, options = {}) {
  const prefix = options.declinePrefix;
  return rows.map((row, index) => {
    const answer = normalize(row.answer);
    const repeatsEarlierAnswer = Boolean(answer) && rows.slice(0, index).some(prior => normalize(prior.answer) === answer && normalize(prior.text) !== normalize(row.text));
    const carriesReferenceMarkup = /https?:\/\//u.test(answer) || /\[\[|\]\]|\{\{|\}\}|==/u.test(answer);
    const declined = Boolean(prefix) && answer.startsWith(prefix);
    const answerWords = words(row.answer);
    const requestWords = new Set(words(row.text));
    const echoShare = answerWords.length ? answerWords.filter(word => requestWords.has(word)).length / answerWords.length : 0;
    const empty = !answer;
    return {
      index: row.index ?? index + 1,
      empty,
      declined,
      repeatsEarlierAnswer,
      carriesReferenceMarkup,
      echoShare: Number(echoShare.toFixed(3)),
      healthy: row.status === 200 && !empty && !declined && !repeatsEarlierAnswer && !carriesReferenceMarkup
    };
  });
}

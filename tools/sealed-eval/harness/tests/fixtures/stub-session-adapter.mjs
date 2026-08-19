// Test-only jsonl-stdio adapter. Answers STUB_ANSWER_COUNT questions, one every
// STUB_PER_QUESTION_MS, then stays silent forever so the runner's idle watchdog
// has a real hang to catch.
import { createInterface } from "node:readline";

const perQuestionMs = Number(process.env.STUB_PER_QUESTION_MS ?? 50);
const answerCount = Number(process.env.STUB_ANSWER_COUNT ?? Infinity);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const queue = [];
for await (const line of rl) if (line.trim()) queue.push(JSON.parse(line));

let answered = 0;
for (const question of queue) {
  if (answered >= answerCount) break;
  await new Promise(resolve => setTimeout(resolve, perQuestionMs));
  process.stdout.write(JSON.stringify({ status: "ok", answer: `answer-for-${question.questionId}` }) + "\n");
  answered++;
}
if (answered < queue.length) await new Promise(resolve => setTimeout(resolve, 600000));

#!/usr/bin/env node
// Ask the live SCCE API real open questions and print what actually comes back.
const server = process.env.SCCE_LIVE_SERVER_URL ?? "http://127.0.0.1:3873";
const questions = process.argv.slice(2);
for (const text of questions) {
  const started = Date.now();
  let out;
  try {
    const res = await fetch(`${server}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId: "acceptance-probe" })
    });
    out = await res.json();
    out.httpStatus = res.status;
  } catch (error) {
    out = { httpStatus: 0, error: String(error?.message ?? error) };
  }
  const ms = Date.now() - started;
  const answer = out.answer ?? out.text ?? out.response ?? null;
  console.log("=".repeat(100));
  console.log(`Q (${ms}ms, http ${out.httpStatus}): ${text}`);
  console.log(`A: ${typeof answer === "string" ? answer : JSON.stringify(answer)}`);
  const meta = {
    assistantForce: out.assistantForce ?? out.metadata?.assistantForce,
    citations: Array.isArray(out.citations) ? out.citations.length : undefined,
    support: out.support?.status ?? out.support,
    reason: out.reason ?? out.metadata?.reason,
    error: out.error
  };
  console.log(`   ${JSON.stringify(meta)}`);
}

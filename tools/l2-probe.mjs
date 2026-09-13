#!/usr/bin/env node
// L2: ask the live server a few questions so their traces can be read. Run under the server lock.
const questions = process.argv.slice(2);
for (const text of questions) {
  const started = Date.now();
  const response = await fetch("http://127.0.0.1:3873/api/turn", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text })
  });
  if (response.status === 422) { process.stdout.write(`${Date.now() - started}ms 422 REFUSED  ${text}\n`); continue; }
  const payload = await response.json();
  process.stdout.write(`${Date.now() - started}ms ev=${Array.isArray(payload.evidence) ? payload.evidence.length : 0}  ${text}\n  ${String(payload.answer ?? "").replace(/\s+/g, " ").slice(0, 200)}\n`);
}

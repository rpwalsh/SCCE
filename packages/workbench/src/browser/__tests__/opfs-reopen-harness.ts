// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

const output = document.querySelector<HTMLPreElement>("#result");
if (!output) throw new Error("OPFS test output element is missing");

const worker = new Worker(new URL("./opfs-reopen.worker.ts", import.meta.url), { type: "module", name: "scce-opfs-reopen-test" });
const timeout = setTimeout(() => {
  output.dataset.status = "failed";
  output.textContent = JSON.stringify({ ok: false, error: "OPFS reopen test timed out" }, null, 2);
  worker.terminate();
}, 30_000);
worker.addEventListener("message", event => {
  clearTimeout(timeout);
  const result = event.data as { ok?: boolean };
  output.dataset.status = result.ok ? "passed" : "failed";
  output.textContent = JSON.stringify(result, null, 2);
  worker.terminate();
});
worker.addEventListener("error", event => {
  clearTimeout(timeout);
  output.dataset.status = "failed";
  output.textContent = JSON.stringify({ ok: false, error: event.message }, null, 2);
  worker.terminate();
});

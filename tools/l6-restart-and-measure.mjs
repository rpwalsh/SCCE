#!/usr/bin/env node
// L6: restart the one server on the committed dist, then run the workloads named in L6_RUNS. Run under with-server-lock.
import { execFileSync, spawn } from "node:child_process";

const READY = "http://127.0.0.1:3873/api/ready";

const ps = script => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const serverPid = () => {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | Select-Object -First 1; if ($p) { $p.ProcessId } else { '' }`);
  return out ? Number(out) : undefined;
};

if (!process.argv.includes("--no-restart")) {
  const before = serverPid();
  if (before) {
    process.stdout.write(`stopping server pid ${before}\n`);
    ps(`Stop-Process -Id ${before} -Force -ErrorAction SilentlyContinue`);
    for (let i = 0; i < 60 && serverPid() === before; i++) sleep(1000);
  }
  process.stdout.write("starting server\n");
  const child = spawn(process.execPath, ["--max-old-space-size=7168", "packages/server/dist/index.js"], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.unref();
}

let ready = false;
for (let i = 0; i < 300; i++) {
  sleep(2000);
  try {
    const response = await fetch(READY, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (body?.ok && body?.warmup?.complete) { ready = true; process.stdout.write(`ready after ${(i + 1) * 2}s\n`); break; }
  } catch { /* still starting */ }
}
if (!ready) { process.stdout.write("server did not report ready\n"); process.exit(1); }

for (const argv of JSON.parse(process.env.L6_RUNS ?? "[]")) {
  process.stdout.write(`\n=== ${argv.join(" ")}\n`);
  execFileSync(process.execPath, argv, { stdio: "inherit" });
}

#!/usr/bin/env node
// L2: ship the HEAD-only dist built in .l2build, restart the one server, then measure. Run under with-server-lock.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";

const PACKAGES = ["kernel", "adapters-node", "ui", "server", "cli"];
const READY = "http://127.0.0.1:3873/api/ready";

const ps = script => execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (process.argv.includes("--ship")) {
  for (const name of PACKAGES) {
    const from = `.l2build/packages/${name}/dist`;
    if (!existsSync(from)) throw new Error(`missing build output: ${from}`);
    cpSync(from, `packages/${name}/dist`, { recursive: true, force: true });
    process.stdout.write(`shipped ${name}\n`);
  }
}

const serverPid = () => {
  const out = ps(`$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server/dist/index.js*' } | Select-Object -First 1; if ($p) { $p.ProcessId } else { '' }`);
  return out ? Number(out) : undefined;
};

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

for (const argv of JSON.parse(process.env.L2_RUNS ?? "[]")) {
  process.stdout.write(`\n=== ${argv.join(" ")}\n`);
  execFileSync(process.execPath, argv, { stdio: "inherit" });
}

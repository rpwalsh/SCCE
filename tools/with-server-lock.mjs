#!/usr/bin/env node
// One SCCE server, several lanes. Live measurement must not interleave or every latency and CPU number is
// another lane's work. Waits for the lock, runs the command, always releases.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const LOCK = ".agent/locks/server.lock";
const holder = process.env.LANE ?? `pid-${process.pid}`;
const staleMs = Number(process.env.LOCK_STALE_MS ?? 1800000);
mkdirSync(".agent/locks", { recursive: true });

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let waited = 0;
for (;;) {
  try {
    writeFileSync(LOCK, JSON.stringify({ holder, at: Date.now() }), { flag: "wx" });
    break;
  } catch {
    let age = Infinity;
    try { age = Date.now() - JSON.parse(readFileSync(LOCK, "utf8")).at; } catch {}
    if (age > staleMs) { rmSync(LOCK, { force: true }); continue; }
    if (waited % 60000 === 0) {
      let who = "?"; try { who = JSON.parse(readFileSync(LOCK, "utf8")).holder; } catch {}
      process.stderr.write(`[lock] waiting on ${who} (${Math.round(waited / 1000)}s)\n`);
    }
    sleep(5000); waited += 5000;
  }
}

try {
  const r = spawnSync(process.argv[2], process.argv.slice(3), { stdio: "inherit", shell: false });
  process.exitCode = r.status ?? 1;
} finally {
  if (existsSync(LOCK)) { try { if (JSON.parse(readFileSync(LOCK, "utf8")).holder === holder) rmSync(LOCK, { force: true }); } catch { rmSync(LOCK, { force: true }); } }
}

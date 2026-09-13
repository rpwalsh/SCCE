#!/usr/bin/env node
// One SCCE server, several lanes. Live measurement must not interleave or every latency and CPU number is
// another lane's work.
//
// Two rules learned the hard way. The holder HEARTBEATS: a first version aged the lock from the moment it was
// taken, so a waiter declared a live 94-minute cloze run stale at 30 minutes, broke its lock and restarted the
// server underneath it. And a waiter never breaks a lock whose holder PROCESS IS STILL ALIVE, whatever its
// timestamp says -- that covers a holder started by an older copy of this file, which does not heartbeat at all.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const LOCK = ".agent/locks/server.lock";
const HEARTBEAT_MS = 20000;
const STALE_MS = Number(process.env.LOCK_STALE_MS ?? 180000);
const LEGACY_STALE_MS = 2 * 60 * 60 * 1000;
const holder = process.env.LANE ?? `pid-${process.pid}`;
mkdirSync(".agent/locks", { recursive: true });

const readLock = () => { try { return JSON.parse(readFileSync(LOCK, "utf8")); } catch { return undefined; } };
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Is that process still running? A holder that is alive keeps its lock however long it has been working. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

let waited = 0;
for (;;) {
  try {
    writeFileSync(LOCK, JSON.stringify({ holder, at: Date.now(), pid: process.pid }), { flag: "wx" });
    break;
  } catch {
    const current = readLock();
    if (!current) { rmSync(LOCK, { force: true }); continue; }
    const alive = processAlive(current.pid);
    const quiet = Date.now() - current.at;
    // A lock from an older copy of this file carries no pid, so liveness is unknowable and only elapsed time
    // decides -- generously, because such a holder never heartbeats and a long run must not be cut short.
    const breakable = current.pid === undefined ? quiet > LEGACY_STALE_MS : !alive;
    if (breakable) {
      console.error(`[lock] ${current.holder} is gone; breaking a lock idle ${Math.round(quiet / 1000)}s`);
      rmSync(LOCK, { force: true });
      continue;
    }
    if (waited % 60000 === 0) {
      const note = alive && quiet > STALE_MS ? " (alive but not heartbeating -- older lock format)" : "";
      console.error(`[lock] waiting on ${current.holder} (${Math.round(waited / 1000)}s)${note}`);
    }
    sleep(5000); waited += 5000;
  }
}

const beat = setInterval(() => {
  const current = readLock();
  if (!current || current.holder !== holder) return;         // someone else owns it now; stop claiming it
  try { writeFileSync(LOCK, JSON.stringify({ ...current, at: Date.now() })); } catch {}
}, HEARTBEAT_MS);
beat.unref();

const release = () => {
  clearInterval(beat);
  if (!existsSync(LOCK)) return;
  const current = readLock();
  if (!current || current.holder === holder) rmSync(LOCK, { force: true });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => { release(); process.exit(130); });
}
process.on("exit", release);

const child = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit", shell: false });
child.on("exit", (code, signal) => { release(); process.exit(signal ? 128 : (code ?? 1)); });
child.on("error", error => { console.error(`[lock] ${error.message}`); release(); process.exit(1); });

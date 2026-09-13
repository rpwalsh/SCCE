#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Six lanes want one server lock and the lock helper is first-come, not a queue. This waits for an agreed order:
// it does not try to acquire until every lane named ahead of it has been seen to take the lock and let it go.
//
//   node tools/l3-wait-for-turn.mjs final L2      # wait out the authoritative run, then L2, then exit 0
//
// Exits 0 when it is this lane's turn. It acquires nothing; run the real work under with-server-lock afterwards.
import { readFileSync, existsSync } from "node:fs";

const LOCK = ".agent/locks/server.lock";
const ahead = process.argv.slice(2);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Cost bound: how long a named lane may fail to appear before its turn is treated as taken.
const APPEAR_TIMEOUT_MS = Number(process.env.L3_APPEAR_TIMEOUT_MS ?? 1800000);

const holder = () => {
  if (!existsSync(LOCK)) return undefined;
  try { return String(JSON.parse(readFileSync(LOCK, "utf8")).holder); } catch { return undefined; }
};

for (const lane of ahead) {
  const waitingSince = Date.now();
  let seen = false;
  for (;;) {
    const current = holder();
    if (current === lane) {
      if (!seen) process.stdout.write(`[turn] ${lane} holds the lock\n`);
      seen = true;
    } else if (seen) {
      process.stdout.write(`[turn] ${lane} released after ${Math.round((Date.now() - waitingSince) / 1000)}s\n`);
      break;
    } else if (Date.now() - waitingSince > APPEAR_TIMEOUT_MS) {
      process.stdout.write(`[turn] ${lane} never appeared in ${Math.round(APPEAR_TIMEOUT_MS / 1000)}s; treating its turn as taken\n`);
      break;
    }
    sleep(10000);
  }
}
process.stdout.write("[turn] L3's turn\n");

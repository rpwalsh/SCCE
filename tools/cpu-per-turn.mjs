#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Per-turn CPU probe: --config=LOCAL --pids=SERVER,POSTGRES [--packet=PUBLIC_JSON] [questions...] [--warm=2] [--repeat=1].
import {cpuProbeMain} from "./lib/cpu-probe.mjs";
await cpuProbeMain(process.argv.slice(2),"per-turn");

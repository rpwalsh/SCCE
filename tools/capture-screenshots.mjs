#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Captures the workbench against the running server with a headless Chromium (Edge or Chrome, whichever is installed).
// Each shot opens the workbench with a `?q=` deep link, which asks the question on load, and waits for the answer.
//   node tools/capture-screenshots.mjs                       -> docs/screenshots/workbench-*.png
//   SCCE_SERVER_URL=http://127.0.0.1:3873 node tools/capture-screenshots.mjs --wait=25000
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? "1"]; }));
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const waitMs = Number(args.get("wait") ?? 30000);
const outDir = args.get("out") ?? "docs/screenshots";

const browsers = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "/usr/bin/chromium", "/usr/bin/google-chrome"
];
const browser = browsers.find(candidate => candidate && existsSync(candidate));
if (!browser) {
  console.error("no headless Chromium found (Edge or Chrome)");
  process.exit(2);
}

const shots = [
  { file: "workbench-chat.png", question: "Who is Albert Einstein?" },
  { file: "workbench-false-premise.png", question: "Did Apollo 11 land on Mars?" },
  { file: "workbench-decline.png", question: "What was Albert Einstein's shoe size?" }
];

for (const shot of shots) {
  const url = `${serverUrl}/?q=${encodeURIComponent(shot.question)}`;
  const target = path.resolve(outDir, shot.file);
  const result = spawnSync(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--window-size=1280,820", `--virtual-time-budget=${waitMs}`, `--screenshot=${target}`, url
  ], { stdio: "pipe", timeout: waitMs + 60000 });
  const ok = result.status === 0 && existsSync(target);
  console.log(`${ok ? "captured" : "FAILED"} ${shot.file} <- "${shot.question}"${ok ? "" : ` (${String(result.stderr).slice(0, 200)})`}`);
}

#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Captures the workbench against the running server with a headless Chromium (Edge or Chrome) driven over the
// DevTools protocol: each shot opens the workbench with a `?q=` deep link, waits until the answer bubble is rendered
// and the typing indicator is gone, then screenshots. No extra dependencies; Node's own WebSocket is used.
//   node tools/capture-screenshots.mjs                       -> docs/screenshots/workbench-*.png
//   SCCE_SERVER_URL=http://127.0.0.1:3873 node tools/capture-screenshots.mjs --wait=90000
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, v] = a.slice(2).split("="); return [k, v ?? "1"]; }));
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";
const waitMs = Number(args.get("wait") ?? 90000);
const outDir = args.get("out") ?? "docs/screenshots";
const port = Number(args.get("port") ?? 9333);

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

// A throwaway profile in the OS temp directory, removed on exit: never inside the repository.
const profileDir = mkdtempSync(path.join(os.tmpdir(), "scce-capture-"));
const child = spawn(browser, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, "--window-size=1280,820", `--user-data-dir=${profileDir}`, "about:blank"
], { stdio: "ignore" });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Recent Chromium requires PUT for /json/new; GET is refused.
async function devtools(pathname, method = "GET") {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
      if (response.ok) return response.json();
      if (response.status === 405 && method === "GET") return devtools(pathname, "PUT");
    } catch { /* browser still starting */ }
    await sleep(200);
  }
  throw new Error("DevTools endpoint did not come up");
}

class Session {
  constructor(socket) {
    this.socket = socket; this.id = 0; this.pending = new Map();
    socket.addEventListener("message", event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === undefined) return;
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result ?? {});
      } catch { /* an event we do not consume */ }
    });
    socket.addEventListener("close", () => { for (const waiter of this.pending.values()) waiter.reject(new Error("devtools socket closed")); this.pending.clear(); });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
}

async function open(url) {
  const target = await devtools(`/json/new?${encodeURIComponent(url)}`, "PUT");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const session = new Session(socket);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await session.send("Page.navigate", { url });
  return { session, socket, targetId: target.id };
}

async function answered(session) {
  const { result } = await session.send("Runtime.evaluate", {
    // The topbar's runtime status can read "request in flight" after the answer has rendered, so the page's
    // text is not the signal; the typing row disappearing and an answer/notice/error row existing are.
    expression: "(() => { const typing = document.querySelector('.typing'); const rows = document.querySelectorAll('.row.scce, .row.notice, .row.error'); return JSON.stringify({ typing: Boolean(typing), rows: rows.length, inFlight: false }); })()",
    returnByValue: true
  });
  const state = JSON.parse(result.value);
  return state.rows > 0 && !state.typing && !state.inFlight;
}

try {
  mkdirSync(outDir, { recursive: true });
  for (const shot of shots) {
    const url = `${serverUrl}/?q=${encodeURIComponent(shot.question)}`;
    const { session, socket, targetId } = await open(url);
    const started = Date.now();
    let done = false;
    while (Date.now() - started < waitMs) {
      await sleep(500);
      if (await answered(session).catch(() => false)) { done = true; break; }
    }
    await sleep(600);
    const { data } = await session.send("Page.captureScreenshot", { format: "png" });
    const target = path.resolve(outDir, shot.file);
    writeFileSync(target, Buffer.from(data, "base64"));
    console.log(`${done ? "captured" : "captured (timed out waiting for the answer)"} ${shot.file} <- "${shot.question}" after ${Math.round((Date.now() - started) / 1000)}s`);
    socket.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => undefined);
  }
} finally {
  child.kill();
  await sleep(500);
  rmSync(profileDir, { recursive: true, force: true });
}

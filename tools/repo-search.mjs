import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const max = Math.max(1, Number(process.env.REPO_SEARCH_MAX ?? process.argv.find(arg => arg.startsWith("--max="))?.slice("--max=".length) ?? 300));
const root = process.cwd();
const excludedDirs = new Set(["node_modules", "dist", "coverage", ".git", ".scce", ".tmp"]);
const excludedSuffixes = [".zip"];

const rgOk = await listWithRg().catch(() => false);
if (!rgOk) listWithFs();

function listWithRg() {
  return new Promise((resolve) => {
    const child = spawn(
      "rg",
      [
        "--files",
        "-g", "!node_modules",
        "-g", "!dist",
        "-g", "!coverage",
        "-g", "!.git",
        "-g", "!.scce",
        "-g", "!.tmp",
        "-g", "!*.zip",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"], shell: false },
    );
    let count = 0;
    let carry = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      const lines = `${carry}${chunk}`.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(`${line}\n`);
        count++;
        if (count >= max) {
          child.kill();
          break;
        }
      }
    });
    child.on("close", code => {
      if (carry.trim() && count < max) {
        process.stdout.write(`${carry}\n`);
        count++;
      }
      if (count >= max) process.stderr.write(`repo:search truncated at ${max} files\n`);
      resolve(code === 0 || count > 0);
    });
    child.on("error", () => resolve(false));
  });
}

function listWithFs() {
  const stack = [root];
  let count = 0;
  while (stack.length && count < max) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink() || excludedSuffixes.some(suffix => entry.name.toLowerCase().endsWith(suffix))) continue;
      if (!existsSync(full)) continue;
      process.stdout.write(`${path.relative(root, full)}\n`);
      count++;
      if (count >= max) break;
    }
  }
  if (count >= max) process.stderr.write(`repo:search truncated at ${max} files\n`);
}

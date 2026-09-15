import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sha256Text } from "./util.mjs";

const execute = promisify(execFile);
async function command(command, args, options = {}) {
  try {
    const { stdout } = await execute(command, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, ...options });
    return { value: stdout.trim(), error: null };
  } catch (error) { return { value: null, error: error.code ?? "command-failed" }; }
}

export async function captureHostConfiguration(systems) {
  const [revision, dirty] = await Promise.all([
    command("git", ["rev-parse", "HEAD"]),
    command("git", ["status", "--porcelain", "--untracked-files=normal"])
  ]);
  let windows = null;
  if (process.platform === "win32") {
    const probe = await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../power/windows-host-configuration.ps1", import.meta.url))]);
    try { windows = probe.value ? JSON.parse(probe.value.replace(/^\uFEFF/u, "")) : { error: probe.error }; }
    catch { windows = { error: "invalid-inventory-json" }; }
  }
  let ollama;
  try {
    const request = async route => {
      const response = await fetch(`http://127.0.0.1:11434${route}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP-${response.status}`);
      return response.json();
    };
    const [version, tags, running] = await Promise.all([request("/api/version"), request("/api/tags"), request("/api/ps")]);
    ollama = {
      endpoint: "http://127.0.0.1:11434", version: version.version,
      installedModels: (tags.models ?? []).map(row => ({ name: row.name, digest: row.digest, size: row.size, details: row.details })),
      runningModelsBeforeConditions: (running.models ?? []).map(row => ({ name: row.name, digest: row.digest, size: row.size, size_vram: row.size_vram, context_length: row.context_length }))
    };
  } catch (error) { ollama = { status: "unavailable", reason: String(error.message) }; }
  return {
    schemaVersion: "1.0", capturedAt: new Date().toISOString(),
    node: { version: process.version, versions: process.versions, executable: process.execPath },
    os: { platform: process.platform, architecture: process.arch, release: os.release(), version: os.version(), totalMemoryBytes: os.totalmem(), availableParallelism: os.availableParallelism(), cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))] },
    windows,
    source: { commit: revision.value, commitError: revision.error, dirty: dirty.value === null ? null : dirty.value.length > 0, dirtyStatus: dirty.value?.split(/\r?\n/u).filter(Boolean) ?? null, dirtyStatusSha256: dirty.value === null ? null : sha256Text(dirty.value), statusError: dirty.error },
    ollama,
    // Settings are already in the system manifest; copy only the public
    // command line, never the inherited environment or connection strings.
    conditions: systems.map(system => ({ systemId: system.systemId, conditionId: system.conditionId, mode: system.mode, command: system.command, timeoutMs: system.timeoutMs })),
    captureBoundary: "Before all timed conditions. Ollama options and observed residency are additionally recorded per answer."
  };
}

export function assertHostPreconditions(requirements, snapshot) {
  if (requirements?.ollamaModelsUnloaded !== true) return;
  const running = snapshot?.ollama?.runningModelsBeforeConditions;
  if (!Array.isArray(running)) {
    throw new Error("Cold-run preflight could not verify Ollama residency");
  }
  if (running.length > 0) {
    throw new Error(`Cold-run preflight found ${running.length} preloaded Ollama model(s)`);
  }
}

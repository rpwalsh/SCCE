// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Per-item cost for a head-to-head run: the CPU seconds each system's own process accumulated while it answered,
// read from the operating system before and after the item. The meter runs in its own short-lived process and is
// never inside a timed window, so its cost is not charged to either system. Energy is CPU seconds times one stated
// wattage; the ratio between the two systems does not depend on that constant.
import { spawnSync } from "node:child_process";

/** Accumulated CPU seconds for processes matching a name pattern or a command-line fragment. */
export function processCpuSeconds({ names = [], commandLineIncludes = [], commandLineProcessName = "node.exe" } = {}) {
  // A command-line match is restricted to the named executable: the meter's own shell carries the fragment in its script.
  const filters = [
    ...names.map(name => `$_.Name -like '${name}'`),
    ...commandLineIncludes.map(fragment => `($_.Name -eq '${commandLineProcessName}' -and $_.CommandLine -like '*${fragment}*')`)
  ];
  if (!filters.length) return { seconds: 0, processes: 0 };
  const script = [
    `$rows = Get-CimInstance Win32_Process | Where-Object { ${filters.join(" -or ")} }`,
    "$total = 0; $count = 0",
    "foreach ($row in $rows) { $p = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue; if ($p) { $total += $p.TotalProcessorTime.TotalSeconds; $count++ } }",
    "Write-Output \"$total $count\""
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const [seconds, processes] = String(result.stdout ?? "").trim().split(/\s+/u).map(Number);
  return { seconds: Number.isFinite(seconds) ? seconds : 0, processes: Number.isFinite(processes) ? processes : 0 };
}

/** Thermal-zone temperature in Celsius where Windows exposes it; null (with the reason) when it does not. */
export function thermalReading() {
  const script = "try { $z = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop; ($z | ForEach-Object { ($_.CurrentTemperature / 10) - 273.15 }) -join ',' } catch { 'unavailable: ' + $_.Exception.Message }";
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const text = String(result.stdout ?? "").trim();
  if (!text || text.startsWith("unavailable")) return { celsius: null, reason: text || "no output" };
  const zones = text.split(",").map(Number).filter(Number.isFinite);
  return zones.length ? { celsius: Math.max(...zones), zones } : { celsius: null, reason: text };
}

/** Runs `work` between two process-CPU samples. The samples are outside the timed window. */
export async function metered(target, work) {
  const before = processCpuSeconds(target);
  const started = performance.now();
  const value = await work();
  const wallMs = performance.now() - started;
  const after = processCpuSeconds(target);
  return { value, wallMs, cpuSeconds: Math.max(0, after.seconds - before.seconds), processes: after.processes };
}

/** Ollama's own accounting from a non-streaming /api/generate response. */
export function ollamaTokenCost(body) {
  const ns = value => (Number.isFinite(value) ? value / 1e6 : null);
  return {
    promptTokens: body?.prompt_eval_count ?? null,
    outputTokens: body?.eval_count ?? null,
    totalMs: ns(body?.total_duration),
    loadMs: ns(body?.load_duration),
    promptEvalMs: ns(body?.prompt_eval_duration),
    evalMs: ns(body?.eval_duration)
  };
}

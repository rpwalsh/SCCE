import http from "node:http";
import { createNodeRuntime, readScceRuntimeConfig } from "@scce/adapters-node";
import { handleRequest, serverPatchValidationRuntime } from "./routes.js";
import { createTrace, traceEvent } from "@scce/kernel";
import { createRuntimeStartupReadiness, startRuntimeSurface } from "./startup.js";

async function main(): Promise<void> {
  const trace = createTrace('server.start');
  const configPath = parseConfigPath(process.argv.slice(2)) ?? "scce.config.json";
  const config = await readScceRuntimeConfig(configPath);
  const runtime = createNodeRuntime(config);
  const startupReadiness = createRuntimeStartupReadiness();
  const patchValidation = serverPatchValidationRuntime(config);
  const serverUrl = new URL(config.server.url);
  if (trace) {
    (globalThis as any).__sccTrace = trace;
    traceEvent(trace, { stage: 'server.start', label: `server.configure ${config.server.url}` });
  }
  const host = config.server.host ?? serverUrl.hostname;
  const port = Number(config.server.port ?? serverUrl.port ?? 3873);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { runtime, config, maxBodyBytes: config.runtime.maxFileBytes, patchValidation, startupReadiness }).catch(error => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    });
  });
  const strictWarmup = process.env.SCCE_STARTUP_WARMUP_STRICT === "1";
  const performWarmup = async () => {
    const warmup = await runtime.kernel.warmup({ languageLimit: startupWarmupLanguageLimit() });
    const warmupLine = [
      `SCCE runtime warmup ${warmup.failures.length ? "completed with warnings" : "complete"}`,
      `${Math.round(warmup.totalMs)}ms`,
      `graph=${warmup.graph?.nodes ?? 0}/${warmup.graph?.edges ?? 0}`,
      `language=${warmup.language?.models ?? 0}/${warmup.language?.units ?? 0}`,
      `failures=${warmup.failures.length}`
    ].join(" ");
    process.stdout.write(`${warmupLine}\n`);
    if (trace) traceEvent(trace, { stage: "runtime.start", label: "server.warmup", durationMs: warmup.totalMs, support: { warmup: warmup as unknown as Record<string, unknown> } });
    if (warmup.failures.length) {
      for (const failure of warmup.failures) process.stderr.write(`${failure}\n`);
      throw new Error(`SCCE startup warmup failed: ${warmup.failures.join("; ")}`);
    }
  };
  await startRuntimeSurface({
    warmupEnabled: process.env.SCCE_STARTUP_WARMUP !== "0",
    strictWarmup,
    listen: () => listen(server, port, host, config.server.url),
    warmup: performWarmup,
    onBackgroundWarmupError: error => process.stderr.write(`SCCE runtime warmup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`),
    readiness: startupReadiness
  });

  const shutdown = async () => {
    server.close();
    await runtime.close();
  };
  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

function listen(server: http.Server, port: number, host: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      process.stdout.write(`SCCE v3 server listening on ${url}\n`);
      resolve();
    });
  });
}

function startupWarmupLanguageLimit(): number {
  const parsed = Number(process.env.SCCE_STARTUP_LANGUAGE_LIMIT ?? 12);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(64, Math.floor(parsed)));
}

function parseConfigPath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--config") return argv[i + 1];
  return undefined;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

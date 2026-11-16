// Explicit retained-event metadata maintenance. Default invocation is read-only.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--config", "--proof", "--proof-sha256", "--report", "--execute"].includes(argv[i]) || !argv[i + 1] || args.has(argv[i])) throw Error("Use --config PATH --proof FILE --report FRESH_FILE [--execute true --proof-sha256 SHA256]");
    args.set(argv[i], argv[i + 1]);
  }
  if (!["--config", "--proof", "--report"].every(key => args.has(key)) || args.has("--execute") && args.get("--execute") !== "true") throw Error("Explicit configuration, proof and fresh report are required");
  if (process.env.SCCE_DATABASE_URL?.trim()) throw Error("Unset SCCE_DATABASE_URL before explicitly pinned maintenance");
  const execute = args.get("--execute") === "true", bytes = await fs.readFile(args.get("--proof")), proofSha256 = createHash("sha256").update(bytes).digest("hex"), proof = JSON.parse(bytes);
  if (execute && args.get("--proof-sha256") !== proofSha256) throw Error("Explicit maintenance requires the exact reviewed proof SHA-256");
  const report = path.resolve(args.get("--report"));
  if ([args.get("--config"), args.get("--proof")].some(file => path.resolve(file) === report)) throw Error("Report must not replace an input");
  try { await fs.access(report); throw Error("Report already exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const { readScceRuntimeConfig, createPostgresStorageAdapter } = await import("../packages/adapters-node/dist/index.js");
  const { planRetainedEventLedgerPositions, applyRetainedEventLedgerPositions } = await import("../packages/adapters-node/dist/event-ledger-position-maintenance.js");
  const configPath = path.resolve(args.get("--config")), configBytes = await fs.readFile(configPath);
  const input = { configPath, configSha256: createHash("sha256").update(configBytes).digest("hex"), proofPath: path.resolve(args.get("--proof")), proofSha256 };
  const config = await readScceRuntimeConfig(configPath), url = new URL(config.database.url);
  if (!execute) url.searchParams.set("options", [url.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  const storage = createPostgresStorageAdapter({ ...config.database, url: url.href, informationAccess: config.security?.informationAccess });
  let result;
  try {
    const [session] = await storage.query("SELECT current_database() AS database,current_schema() AS session_default_schema");
    const target = { database: session.database, schema: storage.schema, sessionDefaultSchema: session.session_default_schema };
    result = { status: "complete", input, target, result: await (execute ? applyRetainedEventLedgerPositions(storage, proof) : planRetainedEventLedgerPositions(storage, proof)) };
  } catch (error) {
    result = { status: "failed", input, failure: error instanceof Error ? error.message : String(error), failureStack: error instanceof Error ? error.stack : undefined };
  } finally { await storage.close(); }
  await fs.writeFile(report, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  if (result.status !== "complete") throw Error(result.failure);
  console.log(JSON.stringify({ status: result.status, report, mode: execute ? "explicit_maintenance" : "read_only" }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();

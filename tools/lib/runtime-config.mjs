// The database URL is configuration, not environment: tools read it from scce.config.json like every other runtime setting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readRuntimeConfig(configPath = process.env.SCCE_CONFIG ?? path.join(repoRoot, "scce.config.json")) {
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8"));
  const override = process.env.SCCE_DATABASE_URL?.trim();
  return override ? { ...config, database: { ...config.database, url: override } } : config;
}

export function databaseUrl(configPath) {
  const url = readRuntimeConfig(configPath).database?.url?.trim();
  if (!url) throw new Error("database.url is missing from the runtime config");
  return url;
}

export function databaseSchema(configPath) {
  return readRuntimeConfig(configPath).database?.schema ?? "scce3_runtime";
}

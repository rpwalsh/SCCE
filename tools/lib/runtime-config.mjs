// The database URL is configuration, not environment: tools read it from scce.config.json like every other runtime setting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function merge(base, overlay) {
  if (overlay === null || typeof overlay !== "object" || Array.isArray(overlay)) return overlay ?? base;
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(overlay)) out[key] = merge(out[key], value);
  return out;
}

export function readRuntimeConfig(configPath = process.env.SCCE_CONFIG ?? path.join(repoRoot, "scce.config.json")) {
  const absolute = path.resolve(configPath);
  let config = JSON.parse(fs.readFileSync(absolute, "utf8"));
  // Credentials live in the untracked overlay beside the config, never in the tracked file or the environment.
  const overlay = absolute.replace(/(\.json)?$/i, "") + ".local.json";
  if (fs.existsSync(overlay)) config = merge(config, JSON.parse(fs.readFileSync(overlay, "utf8")));
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

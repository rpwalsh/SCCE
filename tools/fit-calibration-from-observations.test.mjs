import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const toolPath = fileURLToPath(new URL("./fit-calibration-from-observations.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "scce-calibration-config-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("scce-calibration-config-"));
    rmSync(root, { recursive: true, force: true });
  });
  const write = (name, data) => {
    const target = path.join(root, name);
    writeFileSync(target, JSON.stringify(data));
    return target;
  };
  // An unrelated default overlay must never redirect an explicitly selected brain.
  write("scce.config.local.json", { database: { schema: "scce5_runtime", url: "postgres://wrong-default" } });
  const run = (args, environment = {}) => {
    const env = { ...process.env };
    delete env.SCCE_CONFIG;
    delete env.SCCE_DATABASE_URL;
    delete env.SCCE_REPO_ROOT;
    return spawnSync(process.execPath, [toolPath, "--check-config", ...args], {
      cwd: root,
      env: { ...env, ...environment },
      encoding: "utf8",
      timeout: 10000
    });
  };
  return { root, write, run };
}

test("calibration preflight uses the explicit config and only its matching overlay", t => {
  const f = fixture(t);
  const configPath = f.write("scce.config.scce6.json", { database: { schema: "base_runtime" } });
  f.write("scce.config.scce6.local.json", {
    database: { schema: "scce6_runtime", url: "postgres://test:private-password@invalid.example/database" }
  });
  const result = f.run([`--config=${configPath}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configPath, schema: "scce6_runtime", databaseUrlConfigured: true });
  assert.ok(!result.stdout.includes("private-password"));
  assert.ok(!result.stdout.includes("postgres://"));
});

test("SCCE_CONFIG selects the brain and an explicit --config takes precedence", t => {
  const f = fixture(t);
  const envConfig = f.write("environment.json", { database: { schema: "environment_runtime", url: "postgres://invalid" } });
  const cliConfig = f.write("explicit.json", { database: { schema: "scce6_runtime", url: "postgres://invalid" } });
  const fromEnv = f.run([], { SCCE_CONFIG: envConfig });
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(JSON.parse(fromEnv.stdout).schema, "environment_runtime");
  const explicit = f.run(["--config", cliConfig], { SCCE_CONFIG: envConfig });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).schema, "scce6_runtime");
});

test("an explicit schema override is validated and does not modify the selected config", t => {
  const f = fixture(t);
  const configPath = f.write("brain.json", { database: { schema: "scce5_runtime", url: "postgres://invalid" } });
  const before = readFileSync(configPath, "utf8");
  const selected = f.run([`--config=${configPath}`, "--schema=scce6_runtime"]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(JSON.parse(selected.stdout).schema, "scce6_runtime");
  assert.equal(readFileSync(configPath, "utf8"), before);
  const invalid = f.run([`--config=${configPath}`, "--schema=public,scce5_runtime"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /schema must be a plain identifier/u);
});

test("a config without a schema fails rather than falling back to another brain", t => {
  const f = fixture(t);
  const configPath = f.write("incomplete.json", { database: {} });
  const result = f.run([`--config=${configPath}`], { SCCE_DATABASE_URL: "postgres://invalid" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /schema must be a plain identifier/u);
});

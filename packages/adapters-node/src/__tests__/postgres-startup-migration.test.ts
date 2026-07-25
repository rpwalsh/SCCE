import { afterEach, describe, expect, it, vi } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const originalEnv = process.env.SCCE_STARTUP_MIGRATE;

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.SCCE_STARTUP_MIGRATE;
  else process.env.SCCE_STARTUP_MIGRATE = originalEnv;
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

function fixture(): PostgresStorageAdapter {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  return adapter;
}

describe("PostgresStorageAdapter.init startup contract", () => {
  it("verifies the schema and does not mutate it when the checkout is already compatible", async () => {
    const adapter = fixture();
    delete process.env.SCCE_STARTUP_MIGRATE;
    const migrate = vi.fn(async () => {});
    const verify = vi.fn(async () => ({ ok: true, tables: [], errors: [] }));
    adapter.migrate = migrate;
    adapter.verify = verify;

    await expect(adapter.init()).resolves.toBeUndefined();

    expect(verify).toHaveBeenCalledTimes(1);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("throws an actionable error instead of silently migrating when the schema is missing or incompatible", async () => {
    const adapter = fixture();
    delete process.env.SCCE_STARTUP_MIGRATE;
    const migrate = vi.fn(async () => {});
    adapter.migrate = migrate;
    adapter.verify = vi.fn(async () => ({
      ok: false,
      tables: [],
      errors: ["missing table: events", "missing extension: vector"]
    }));

    await expect(adapter.init()).rejects.toThrow(/missing table: events/);
    await expect(adapter.init()).rejects.toThrow(/pnpm scce db migrate/);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("migrates automatically only under the explicit local-development opt-in", async () => {
    const adapter = fixture();
    process.env.SCCE_STARTUP_MIGRATE = "1";
    const migrate = vi.fn(async () => {});
    const verify = vi.fn(async () => ({ ok: false, tables: [], errors: [] }));
    adapter.migrate = migrate;
    adapter.verify = verify;

    await expect(adapter.init()).resolves.toBeUndefined();

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not opt in to startup migration for any value other than the literal \"1\"", async () => {
    const adapter = fixture();
    process.env.SCCE_STARTUP_MIGRATE = "true";
    const migrate = vi.fn(async () => {});
    adapter.migrate = migrate;
    adapter.verify = vi.fn(async () => ({ ok: true, tables: [], errors: [] }));

    await expect(adapter.init()).resolves.toBeUndefined();

    expect(migrate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { createPostgresContract, verifyPostgresContract } from "../postgres-contract.js";

describe("postgres contract", () => {
  it("matches the adapter event ledger shape and extension set", () => {
    const contract = createPostgresContract({ schema: "scce_test" });
    const checks = verifyPostgresContract(contract);
    const events = contract.tables.find(table => table.name === "events");
    const graphNodes = contract.tables.find(table => table.name === "graph_nodes");

    expect(checks.every(check => check.passed)).toBe(true);
    expect(contract.extensions).toEqual(["vector"]);
    expect(events?.columns.map(column => [column.name, column.scalar])).toEqual(expect.arrayContaining([
      ["payload_json", "JSONB"],
      ["parents", "TEXT[]"],
      ["ledger_hash", "TEXT"]
    ]));
    expect(events?.columns.some(column => column.name === "payload")).toBe(false);
    expect(graphNodes?.columns.some(column => column.name === "embedding")).toBe(false);
  });
});

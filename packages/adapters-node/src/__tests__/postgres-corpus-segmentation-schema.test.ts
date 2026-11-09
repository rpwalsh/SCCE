// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it } from "vitest";
import { POSTGRES_REQUIRED_TABLES,POSTGRES_SCHEMA_VERSION } from "@scce/kernel";
import { schemaStatements,requiredHydrationColumns } from "../postgres-schema.js";
it("adds run-owned canonical segmentation spill and exact-scope activation in schema32",()=>{
  expect(POSTGRES_SCHEMA_VERSION).toBe(32);
  const names=["segmentation_consolidation_runs","segmentation_consolidation_rows","segmentation_consolidation_active"];
  const statements=schemaStatements('"fixture"').filter(sql=>names.some(name=>sql.includes(`.${name} `)));
  expect(statements).toHaveLength(3);
  expect(statements.every(sql=>sql.startsWith("CREATE TABLE IF NOT EXISTS"))).toBe(true);
  expect(statements.find(sql=>sql.includes(".segmentation_consolidation_rows "))).toContain("PRIMARY KEY(run_id,collection,order_key)");
  expect(statements.find(sql=>sql.includes(".segmentation_consolidation_rows "))).toContain('COLLATE "C"');
  expect(statements.find(sql=>sql.includes(".segmentation_consolidation_runs "))).toContain("information_label JSONB NOT NULL");
  expect(statements.find(sql=>sql.includes(".segmentation_consolidation_active "))).toContain("scope_id TEXT PRIMARY KEY");
  for(const name of names){expect(POSTGRES_REQUIRED_TABLES).toContain(name);expect(requiredHydrationColumns()[name]?.length).toBeGreaterThan(0);}
  expect(statements.join("\n")).not.toMatch(/TRUNCATE|DROP TABLE/iu);
});

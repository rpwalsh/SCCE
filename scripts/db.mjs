import { createRequire } from "node:module";
const require_ = createRequire("file:///C:/Users/react/fuggit/packages/adapters-node/package.json");
const pg = require_("pg");
import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync("scce.config.json","utf8"));
let local = {}; try { local = JSON.parse(fs.readFileSync("scce.config.local.json","utf8")); } catch {}
const url = local?.database?.url ?? cfg.database.url;
const schema = local?.database?.schema ?? cfg.database.schema;
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`SET search_path TO "${schema}"`);
const sql = process.argv[2];
const res = await client.query(sql);
console.log(JSON.stringify(res.rows, null, 1).slice(0, 6000));
await client.end();

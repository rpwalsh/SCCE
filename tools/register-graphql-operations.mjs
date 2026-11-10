#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const directory = new URL("../packages/workbench/src/__generated__/", import.meta.url);
const output = new URL("../packages/server/operations.json", import.meta.url);
const documents = {};
for (const file of (await readdir(directory)).filter(name => name.endsWith(".graphql.ts")).sort()) {
  const source = ts.createSourceFile(file, await readFile(new URL(file, directory), "utf8"), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const props = new Map(node.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(source).replaceAll('"', ''), property.initializer]));
      const name = props.get("name"), text = props.get("text"), kind = props.get("operationKind");
      if (name && text && kind && ts.isStringLiteral(name) && ts.isStringLiteral(text) && ts.isStringLiteral(kind)) {
        if (documents[name.text] && documents[name.text] !== text.text) throw new Error(`conflicting operation ${name.text}`);
        documents[name.text] = text.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (!Object.keys(documents).length) throw new Error("Relay generated no operation documents");
const text = `${JSON.stringify(documents, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== text) throw new Error("GraphQL operation registry differs from compiled Relay artifacts; run pnpm build");
} else {
  let previous;
  try { previous = await readFile(output, "utf8"); } catch { /* first build */ }
  if (previous !== text) await writeFile(output, text);
}
console.log(`Registered ${Object.keys(documents).length} compiled local GraphQL operations.`);

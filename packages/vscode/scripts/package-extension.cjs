// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
const fs = require("node:fs");
const path = require("node:path");
const { createVSIX } = require("@vscode/vsce");

async function main() {
  const extensionPath = path.resolve(__dirname, "..");
  const outputDirectory = path.resolve(extensionPath, "..", "..", "artifacts");
  const packagePath = path.join(outputDirectory, "scce-vscode.vsix");

  fs.mkdirSync(outputDirectory, { recursive: true });
  await createVSIX({ cwd: extensionPath, packagePath });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

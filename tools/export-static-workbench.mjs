// SCCE proprietary source. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Inspection only; no license is granted except by separate written agreement. See LICENSE.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.resolve(process.argv[2] ?? path.join(repositoryRoot, "dist-pages"));
const outputRelative = path.relative(repositoryRoot, outputDirectory);
if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) {
  throw new Error("Choose a Pages output subdirectory inside the repository, such as dist-pages.");
}
const uiModulePath = path.join(repositoryRoot, "packages", "ui", "dist", "index.js");
const modelModulePath = path.join(repositoryRoot, "packages", "ui", "dist", "workbench-model.js");

const { renderWorkbench } = await import(pathToFileURL(uiModulePath).href);
const html = renderWorkbench("", { staticConnector: true });
const modelModule = await readFile(modelModulePath, "utf8");
try {
  await access(path.join(outputDirectory, "functions"));
  throw new Error("Static export refused: the output directory contains Pages Functions.");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Static export refused:")) throw error;
}
await mkdir(path.join(outputDirectory, "ui"), { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, "index.html"), html),
  writeFile(path.join(outputDirectory, "ui", "workbench-model.js"), modelModule)
]);
process.stdout.write(`Static Pages workbench written to ${outputDirectory}\n`);

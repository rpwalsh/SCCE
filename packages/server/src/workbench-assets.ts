// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../workbench/dist/", import.meta.url));
const mediaTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
export async function readWorkbenchAsset(pathname: string) {
  let relative: string;
  try { relative = decodeURIComponent(pathname.replace(/^\/(?:scce\/)?workbench\//u, "")) || "index.html"; }
  catch { return missing(); }
  if (relative.includes("\\") || relative.split("/").some(part => part === ".." || part.startsWith(".")) || relative.includes("\0")) return missing();
  const contentType = mediaTypes[path.extname(relative)];
  if (!contentType) return missing();
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(path.join(root, relative))]);
    const local = path.relative(resolvedRoot, resolvedFile);
    if (local.startsWith("..") || path.isAbsolute(local)) return missing();
    return { status: 200, contentType, body: await readFile(resolvedFile) };
  } catch { return missing(); }
}
function missing() { return { status: 404, contentType: "text/plain; charset=utf-8", body: Buffer.from("Workbench asset not found. Run pnpm build.") }; }

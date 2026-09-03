import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatBytes, listLocalModels, removeLocalModel } from "../model-management.js";

let dir = "";
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe("local model management", () => {
  it("lists models in the transformers.js <org>/<name> layout with sizes, and removes only inside modelDir", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "scce-models-"));
    await mkdir(path.join(dir, "Xenova", "clip-vit-base-patch32", "onnx"), { recursive: true });
    await writeFile(path.join(dir, "Xenova", "clip-vit-base-patch32", "config.json"), "{}");
    await writeFile(path.join(dir, "Xenova", "clip-vit-base-patch32", "onnx", "model.onnx"), Buffer.alloc(2048));
    const models = await listLocalModels(dir);
    expect(models.map(model => model.id)).toEqual(["Xenova/clip-vit-base-patch32"]);
    expect(models[0]?.files).toBe(2);
    expect(models[0]?.bytes).toBe(2050);
    await expect(removeLocalModel(dir, "../../etc")).rejects.toThrow(/outside modelDir/u);
    expect(await removeLocalModel(dir, "Xenova/clip-vit-base-patch32")).toBe(true);
    expect(await listLocalModels(dir)).toEqual([]);
    expect(await removeLocalModel(dir, "Xenova/clip-vit-base-patch32")).toBe(false);
  });

  it("formats sizes for humans", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3.5 * 1024 * 1024 * 1024)).toBe("3.5 GB");
  });
});

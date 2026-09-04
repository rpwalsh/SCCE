// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "./document.js";

/**
 * Visual evidence (Phase 3): CLIP image/text embeddings computed locally with
 * @huggingface/transformers (declared in models.declared.json, gated by
 * ingestion.visual.embeddings.enabled, weights local-only). Produces a whole-image
 * vector plus per-region vectors; the kernel stores them as attributes on the
 * evidence span, so provenance is never duplicated per region.
 */

export interface VisualAttributes {
  embedding: number[];
  regions: number[][];
  model: string;
  width: number;
  height: number;
  pages?: number;
}

export interface VisualEmbedder {
  modelId: string;
  embedImageFile(filePath: string): Promise<VisualAttributes | undefined>;
  embedText(text: string): Promise<number[] | undefined>;
}

export interface VisualEmbedderOptions {
  modelId: string;
  modelDir: string;
  grid?: number;
  log?: (message: string) => void;
}

/** Region boxes for an n×n grid plus the whole image, as [x1, y1, x2, y2]. Pure. */
export function tileRegions(width: number, height: number, grid = 2): Array<[number, number, number, number]> {
  const boxes: Array<[number, number, number, number]> = [[0, 0, width, height]];
  const n = Math.max(1, Math.floor(grid));
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      const x1 = Math.floor((column * width) / n), y1 = Math.floor((row * height) / n);
      const x2 = Math.floor(((column + 1) * width) / n), y2 = Math.floor(((row + 1) * height) / n);
      if (x2 > x1 && y2 > y1 && n > 1) boxes.push([x1, y1, x2, y2]);
    }
  }
  return boxes;
}

/** L2-normalize so cosine == dot. Pure. */
export function normalizeVector(values: ArrayLike<number>): number[] {
  const out = Array.from(values, Number);
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0));
  return norm ? out.map(value => value / norm) : out;
}

/** Mean of page vectors, renormalized: a document-level vector for PDFs whose pages become regions. Pure. */
export function meanVector(vectors: readonly (readonly number[])[]): number[] {
  if (!vectors.length) return [];
  const length = vectors[0]!.length;
  const sum = new Array<number>(length).fill(0);
  for (const vector of vectors) for (let index = 0; index < length; index++) sum[index]! += vector[index] ?? 0;
  return normalizeVector(sum.map(value => value / vectors.length));
}

let registeredEmbedder: VisualEmbedder | undefined;
export function registerVisualEmbedder(embedder: VisualEmbedder | undefined): void { registeredEmbedder = embedder; }
export function activeVisualEmbedder(): VisualEmbedder | undefined { return registeredEmbedder; }

export function createClipVisualEmbedder(options: VisualEmbedderOptions): VisualEmbedder {
  const log = options.log ?? (() => undefined);
  const grid = options.grid ?? 2;
  let runtime: Promise<ClipRuntime | undefined> | undefined;
  const load = () => {
    if (!runtime) {
      runtime = loadClipRuntime(options).catch(error => {
        log(`visual embedder unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
    }
    return runtime;
  };
  return {
    modelId: options.modelId,
    async embedImageFile(filePath) {
      const clip = await load();
      if (!clip) return undefined;
      const image = await clip.readImage(filePath);
      const boxes = tileRegions(image.width, image.height, grid);
      const vectors: number[][] = [];
      for (const box of boxes) vectors.push(normalizeVector(await clip.embedImage(image, box)));
      return { embedding: vectors[0]!, regions: vectors.slice(1), model: options.modelId, width: image.width, height: image.height };
    },
    async embedText(text) {
      const clip = await load();
      if (!clip) return undefined;
      return normalizeVector(await clip.embedText(text));
    }
  };
}

/** Render PDF pages with pdftoppm (optional tool) and embed each page; pages become regions, their mean the document vector. */
export async function embedPdfPages(filePath: string, embedder: VisualEmbedder, options: { pdftoppm?: string; maxPages?: number } = {}): Promise<VisualAttributes | undefined> {
  const tool = options.pdftoppm ?? "pdftoppm";
  const maxPages = Math.max(1, Math.min(64, options.maxPages ?? 8));
  const directory = await mkdtemp(path.join(tmpdir(), "scce-pdf-pages-"));
  try {
    const rendered = await runProcess(tool, ["-r", "72", "-png", "-l", String(maxPages), filePath, path.join(directory, "page")], { timeoutMs: 120_000 });
    if (rendered.code !== 0) return undefined;
    const files = (await readdir(directory)).filter(name => name.endsWith(".png")).sort().map(name => path.join(directory, name));
    const pages: number[][] = [];
    let width = 0, height = 0;
    for (const page of files) {
      const attributes = await embedder.embedImageFile(page);
      if (!attributes) continue;
      pages.push(attributes.embedding);
      width = attributes.width; height = attributes.height;
    }
    if (!pages.length) return undefined;
    return { embedding: meanVector(pages), regions: pages, model: embedder.modelId, width, height, pages: pages.length };
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ClipRuntime {
  readImage(filePath: string): Promise<{ width: number; height: number; raw: unknown }>;
  embedImage(image: { raw: unknown }, box: [number, number, number, number]): Promise<ArrayLike<number>>;
  embedText(text: string): Promise<ArrayLike<number>>;
}

async function loadClipRuntime(options: VisualEmbedderOptions): Promise<ClipRuntime> {
  const specifier = "@huggingface/transformers";
  const transformers = await import(specifier) as typeof import("@huggingface/transformers");
  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.localModelPath = options.modelDir;
  const local = { local_files_only: true } as const;
  const [processor, tokenizer, vision, textModel] = await Promise.all([
    transformers.AutoProcessor.from_pretrained(options.modelId, local),
    transformers.AutoTokenizer.from_pretrained(options.modelId, local),
    transformers.CLIPVisionModelWithProjection.from_pretrained(options.modelId, { ...local, device: "cpu" }),
    transformers.CLIPTextModelWithProjection.from_pretrained(options.modelId, { ...local, device: "cpu" })
  ]);
  return {
    async readImage(filePath) {
      const raw = await transformers.RawImage.read(filePath);
      return { width: raw.width, height: raw.height, raw };
    },
    async embedImage(image, box) {
      const raw = image.raw as InstanceType<typeof transformers.RawImage>;
      const [x1, y1, x2, y2] = box;
      const cropped = x1 === 0 && y1 === 0 && x2 === raw.width && y2 === raw.height ? raw : await raw.crop([x1, y1, x2 - 1, y2 - 1]);
      const inputs = await processor(cropped);
      const output = await vision(inputs) as { image_embeds: { data: ArrayLike<number> } };
      return output.image_embeds.data;
    },
    async embedText(text) {
      const inputs = tokenizer([text], { padding: true, truncation: true });
      const output = await textModel(inputs) as { text_embeds: { data: ArrayLike<number> } };
      return output.text_embeds.data;
    }
  };
}

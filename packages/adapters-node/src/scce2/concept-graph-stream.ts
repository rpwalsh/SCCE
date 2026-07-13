import { TextDecoder } from "node:util";
import { withBrainBundleEntryStream } from "./brain-bundle.js";
import { readScce2ConceptSnapshot, type Scce2Concept, type Scce2Relation } from "./brain-shard-reader.js";

export interface Scce2ConceptGraphStreamSummary {
  concepts: number;
  relations: number;
  warnings: string[];
}

export interface Scce2ConceptGraphStreamOptions {
  maxBytes?: number;
}

export async function streamScce2ConceptGraph(
  filePath: string,
  onConcept: (id: string, concept: Scce2Concept) => Promise<void>,
  onRelation: (relation: Scce2Relation) => Promise<void>,
  options: Scce2ConceptGraphStreamOptions = {}
): Promise<Scce2ConceptGraphStreamSummary> {
  if (filePath.toLocaleLowerCase().endsWith(".v8")) {
    const decoded = await readScce2ConceptSnapshot(filePath, { maxBytes: options.maxBytes });
    if (!decoded.ok || !decoded.value) return { concepts: 0, relations: 0, warnings: [decoded.warning ?? "SCCE2 V8 concept graph snapshot not decoded"] };
    let concepts = 0;
    let relations = 0;
    for (const [id, concept] of conceptEntries(decoded.value.concepts)) {
      await onConcept(id, concept);
      concepts++;
    }
    for (const relation of decoded.value.relations) {
      await onRelation(relation);
      relations++;
    }
    return { concepts, relations, warnings: [] };
  }
  let concepts = 0;
  let relations = 0;
  await streamJsonArrayProperty(filePath, "concepts", async objectText => {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const id = typeof parsed.id === "string" && parsed.id ? parsed.id : `concept:${concepts}`;
    await onConcept(id, {
      id,
      names: Array.isArray(parsed.names) ? parsed.names.map(String) : undefined,
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      domain: typeof parsed.domain === "string" ? parsed.domain : undefined,
      properties: parsed.properties && typeof parsed.properties === "object" && !Array.isArray(parsed.properties) ? parsed.properties as Record<string, string[]> : undefined
    });
    concepts++;
  });
  await streamJsonArrayProperty(filePath, "relations", async objectText => {
    const parsed = JSON.parse(objectText) as Record<string, unknown>;
    const subject = firstString(parsed, ["subject", "source", "from"]);
    const predicate = firstString(parsed, ["predicate", "relation", "type"]);
    const object = firstString(parsed, ["object", "target", "to"]);
    if (subject && predicate && object) {
      await onRelation({
        subject,
        predicate,
        object,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
        source: typeof parsed.source === "string" ? parsed.source : undefined,
        bidirectional: parsed.bidirectional === true,
        bundlePriority: typeof parsed.bundlePriority === "number" ? parsed.bundlePriority : undefined,
        bundleId: typeof parsed.bundleId === "string" ? parsed.bundleId : undefined
      });
      relations++;
    }
  });
  return { concepts, relations, warnings: [] };
}

function conceptEntries(value: Map<string, Scce2Concept> | Record<string, Scce2Concept>): Array<[string, Scce2Concept]> {
  if (value instanceof Map) return [...value.entries()];
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value);
  return [];
}

async function streamJsonArrayProperty(filePath: string, propertyName: string, onObject: (objectText: string) => Promise<void>): Promise<void> {
  const needle = `"${propertyName}"`;
  await withBrainBundleEntryStream(filePath, async input => {
    const decoder = new TextDecoder();
    let tail = "";
    let foundProperty = false;
    let inArray = false;
    let inString = false;
    let escaped = false;
    let depth = 0;
    let objectText = "";
    const consumeChar = async (ch: string) => {
      if (!foundProperty) {
        tail = (tail + ch).slice(-needle.length - 8);
        if (tail.includes(needle)) foundProperty = true;
        return;
      }
      if (!inArray) {
        if (ch === "[") inArray = true;
        return;
      }
      if (depth === 0) {
        if (ch === "]") {
          inArray = false;
          foundProperty = false;
          tail = "";
          return;
        }
        if (ch === "{") {
          depth = 1;
          objectText = "{";
          inString = false;
          escaped = false;
        }
        return;
      }
      objectText += ch;
      if (escaped) {
        escaped = false;
        return;
      }
      if (ch === "\\") {
        escaped = true;
        return;
      }
      if (ch === "\"") {
        inString = !inString;
        return;
      }
      if (inString) return;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          await onObject(objectText);
          objectText = "";
        }
      }
    };
    for await (const raw of input.stream as AsyncIterable<Buffer | Uint8Array>) {
      const text = decoder.decode(raw, { stream: true });
      for (const ch of text) await consumeChar(ch);
    }
    const rest = decoder.decode();
    for (const ch of rest) await consumeChar(ch);
  });
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

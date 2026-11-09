// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export const DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA = "scce.creative_event_page.storage.v1";

type StoredValue = null | boolean | number | StoredValue[];
interface StoredEvents {
  schema: typeof DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA;
  strings: string[];
  shapes: string[][];
  values: StoredValue[];
}

class UnsupportedJson extends Error {}

/** Dictionaries change only the wire representation, never the event compiler's public fields. */
export function encodeDurableCreativeEvents(events: readonly unknown[]): StoredEvents | undefined {
  const strings: string[] = [], stringIds = new Map<string, number>();
  const shapes: string[][] = [], shapeIds = new Map<string, number>();
  const active = new WeakSet<object>();
  const visit = (value: unknown): StoredValue => {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      let id = stringIds.get(value);
      if (id === undefined) { id = strings.length; strings.push(value); stringIds.set(value, id); }
      return id;
    }
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return [0, value];
    if (!value || typeof value !== "object" || active.has(value)) throw new UnsupportedJson();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) throw new UnsupportedJson();
        return [1, ...value.map(visit)];
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new UnsupportedJson();
      const entries = Object.entries(value), keys = entries.map(([key]) => key), key = JSON.stringify(keys);
      let id = shapeIds.get(key);
      if (id === undefined) { id = shapes.length; shapes.push(keys); shapeIds.set(key, id); }
      return [2, id, ...entries.map(([, child]) => visit(child))];
    } finally { active.delete(value); }
  };
  try {
    const values = events.map(visit);
    const stored: StoredEvents = { schema: DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA, strings, shapes, values };
    return Buffer.byteLength(JSON.stringify(stored)) < Buffer.byteLength(JSON.stringify(events)) ? stored : undefined;
  } catch (error) {
    if (error instanceof UnsupportedJson) return undefined;
    throw error;
  }
}

export function decodeDurableCreativeEvents(value: Record<string, unknown>): unknown[] {
  const invalid = (): never => { throw new Error("invalid durable creative-event storage marker"); };
  if (value.schema !== DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA || Object.keys(value).length !== 4
    || !Array.isArray(value.strings) || !value.strings.every((item): item is string => typeof item === "string")
    || new Set(value.strings).size !== value.strings.length || !Array.isArray(value.shapes) || !Array.isArray(value.values)) return invalid();
  const strings = value.strings, shapes = value.shapes;
  for (const keys of shapes) if (!Array.isArray(keys) || !keys.every(key => typeof key === "string")
    || new Set(keys).size !== keys.length) return invalid();
  const index = (input: unknown, length: number): input is number => Number.isSafeInteger(input) && Number(input) >= 0 && Number(input) < length;
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return index(input, strings.length) ? strings[input]! : invalid();
    if (!Array.isArray(input)) return invalid();
    if (input[0] === 0 && input.length === 2 && typeof input[1] === "number" && Number.isFinite(input[1]) && !Object.is(input[1], -0)) return input[1];
    if (input[0] === 1) return input.slice(1).map(visit);
    if (input[0] === 2 && index(input[1], shapes.length)) {
      const keys = shapes[input[1]] as string[];
      if (input.length === keys.length + 2) return Object.fromEntries(keys.map((key, position) => [key, visit(input[position + 2])]));
    }
    return invalid();
  };
  return value.values.map(visit);
}

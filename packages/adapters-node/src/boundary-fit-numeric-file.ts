// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BoundaryFitNumericBinding, BoundaryFitNumericReplay, BoundaryFitNumericSection, SegmentationPageBounds } from "@scce/kernel";

const FRAME_BYTES = 40;
interface Section {
  binding: BoundaryFitNumericBinding; start: number; end: number; rows: number; frames: number;
  hash: ReturnType<typeof createHash>; digest?: string;
}
function validBinding(binding: BoundaryFitNumericBinding): void {
  if (!binding || typeof binding.statisticsId !== "string" || !binding.statisticsId || !/^[a-f0-9]{64}$/u.test(binding.headerDigest)
    || !Number.isSafeInteger(binding.rowWidth) || binding.rowWidth < 1 || !Number.isSafeInteger(binding.rowCount) || binding.rowCount < 0) throw Error("Invalid numeric boundary replay binding");
}
function same(a: BoundaryFitNumericBinding, b: BoundaryFitNumericBinding): boolean {
  return a.statisticsId === b.statisticsId && a.headerDigest === b.headerDigest && a.rowWidth === b.rowWidth && a.rowCount === b.rowCount;
}

/** One private ephemeral file; canonical statistics and learned artifacts remain PostgreSQL-owned. */
export async function createBoundaryFitNumericFile(bounds: SegmentationPageBounds,
  options: { directory?: string; onFile?: (file: string) => void } = {}): Promise<BoundaryFitNumericReplay> {
  if (!Number.isSafeInteger(bounds.pageRows) || bounds.pageRows < 1 || !Number.isSafeInteger(bounds.maxPageBytes)
    || bounds.maxPageBytes <= FRAME_BYTES + 8 || bounds.maxPageBytes > 0xffffffff) throw Error("Invalid numeric boundary replay page bounds");
  bounds = Object.freeze({ pageRows: bounds.pageRows, maxPageBytes: bounds.maxPageBytes });
  const file = path.join(options.directory ?? tmpdir(), `scce-boundary-fit-${randomUUID()}.bin`);
  const handle = await open(file, "wx+", 0o600);
  let identity: Stats;
  try { identity = await handle.stat(); }
  catch (error) {
    const errors: unknown[] = [error];
    try { await handle.close(); } catch (cleanup) { errors.push(cleanup); }
    try { await unlink(file); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw new AggregateError(errors, "Numeric boundary replay creation and cleanup failed");
    throw error;
  }
  let disposed = false, disposal: Promise<void> | undefined, offset = 0, busy = false, writing: BoundaryFitNumericSection | undefined;
  const sections: { training?: Section; calibration?: Section } = {};
  const active = () => { if (disposed) throw Error("Numeric boundary replay is disposed"); };
  const sectionForWrite = (name: BoundaryFitNumericSection, binding: BoundaryFitNumericBinding): Section => {
    active(); validBinding(binding);
    if (name !== "training" && name !== "calibration") throw Error("Unknown numeric boundary replay section");
    const previous = sections[name];
    if (previous) {
      if (!same(previous.binding, binding) || previous.digest !== undefined || writing !== name) throw Error("Numeric boundary replay binding or write phase changed");
      return previous;
    }
    if (name === "training" ? sections.calibration !== undefined : sections.training?.digest === undefined) throw Error("Numeric boundary replay sections are out of order");
    const result: Section = { binding: { ...binding }, start: offset, end: offset, rows: 0, frames: 0, hash: createHash("sha256") };
    sections[name] = result; writing = name;
    return result;
  };
  const writeExact = async (bytes: Buffer) => {
    let position = 0;
    while (position < bytes.length) {
      const result = await handle.write(bytes, position, bytes.length - position, offset);
      if (result.bytesWritten < 1) throw Error("Numeric boundary replay write made no progress");
      position += result.bytesWritten; offset += result.bytesWritten;
      if (!Number.isSafeInteger(offset)) throw Error("Numeric boundary replay file exceeds exact offset range");
    }
  };
  const readExact = async (size: number, position: number): Promise<Buffer> => {
    const bytes = Buffer.allocUnsafe(size); let read = 0;
    while (read < size) {
      const result = await handle.read(bytes, read, size - read, position + read);
      if (result.bytesRead < 1) throw Error("Numeric boundary replay is truncated");
      read += result.bytesRead;
    }
    return bytes;
  };
  const replay: BoundaryFitNumericReplay = {
    pageRows: bounds.pageRows, maxPageBytes: bounds.maxPageBytes - FRAME_BYTES,
    async append(name, binding, values) {
      if (busy) throw Error("Concurrent numeric boundary replay mutation");
      busy = true;
      try {
        const section = sectionForWrite(name, binding), rows = values.length / binding.rowWidth;
        if (!(values instanceof Float64Array) || !Number.isSafeInteger(rows) || rows < 1 || rows > bounds.pageRows
          || values.byteLength > replay.maxPageBytes || section.rows + rows > binding.rowCount) throw Error("Numeric boundary replay page exceeds its binding or bounds");
        const payload = Buffer.allocUnsafe(values.byteLength);
        for (let index = 0; index < values.length; index++) {
          if (!Number.isFinite(values[index])) throw Error("Numeric boundary replay value is not finite");
          payload.writeDoubleLE(values[index]!, index * 8);
        }
        const frame = Buffer.alloc(FRAME_BYTES); frame.writeUInt32LE(payload.length, 0); frame.writeUInt32LE(rows, 4);
        createHash("sha256").update(payload).digest().copy(frame, 8);
        await writeExact(frame); await writeExact(payload);
        section.hash.update(frame); section.hash.update(payload); section.rows += rows; section.frames++; section.end = offset;
      } finally { busy = false; }
    },
    async seal(name, binding) {
      if (busy) throw Error("Concurrent numeric boundary replay mutation");
      const section = sectionForWrite(name, binding);
      if (section.rows !== binding.rowCount) throw Error("Numeric boundary replay row inventory changed");
      section.digest = section.hash.digest("hex"); writing = undefined;
    },
    async *pages(name, binding) {
      active(); validBinding(binding);
      const section = sections[name];
      if (!section || !section.digest || !same(section.binding, binding) || busy || writing !== undefined) throw Error("Numeric boundary replay is unavailable or has a changed binding");
      if ((await handle.stat()).size !== offset) throw Error("Numeric boundary replay file length changed");
      const hash = createHash("sha256"); let position = section.start, rows = 0, frames = 0;
      while (position < section.end) {
        active();
        const frame = await readExact(FRAME_BYTES, position), length = frame.readUInt32LE(0), frameRows = frame.readUInt32LE(4);
        if (!frameRows || frameRows > bounds.pageRows || length !== frameRows * binding.rowWidth * 8 || length > replay.maxPageBytes
          || position + FRAME_BYTES + length > section.end) throw Error("Numeric boundary replay frame bounds changed");
        const payload = await readExact(length, position + FRAME_BYTES);
        if (!createHash("sha256").update(payload).digest().equals(frame.subarray(8))) throw Error("Numeric boundary replay page checksum changed");
        const values = new Float64Array(length / 8);
        for (let index = 0; index < values.length; index++) {
          values[index] = payload.readDoubleLE(index * 8);
          if (!Number.isFinite(values[index])) throw Error("Numeric boundary replay value is not finite");
        }
        hash.update(frame); hash.update(payload); position += FRAME_BYTES + length; rows += frameRows; frames++;
        yield values;
      }
      if (position !== section.end || rows !== section.rows || frames !== section.frames || hash.digest("hex") !== section.digest) throw Error("Numeric boundary replay section checksum or inventory changed");
    },
    dispose() {
      return disposal ??= (async () => {
        disposed = true;
        const errors: unknown[] = [];
        try { await handle.close(); } catch (error) { errors.push(error); }
        try {
          const current = await lstat(file);
          if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) throw Error("Numeric boundary replay cleanup path no longer identifies its leased file");
          await unlink(file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, "Numeric boundary replay cleanup failed");
      })();
    }
  };
  try { options.onFile?.(file); }
  catch (error) { try { await replay.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Numeric boundary replay preparation and cleanup failed"); } throw error; }
  return replay;
}

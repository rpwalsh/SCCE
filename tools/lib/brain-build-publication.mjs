// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const PUBLICATION_SCHEMA = "scce.brain_build_publication.v1";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(target) {
  try { await readFile(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export function brainBuildPublicationJournalPath(statePath) {
  return `${path.resolve(statePath)}.publication.json`;
}

/** Restore the last complete file if Windows replacement was interrupted after moving the old target aside. */
export async function recoverAtomicReplacement(targetPath) {
  const target = path.resolve(targetPath);
  const backup = `${target}.previous`;
  const [targetExists, backupExists] = await Promise.all([exists(target), exists(backup)]);
  if (!backupExists) return false;
  if (!targetExists) await rename(backup, target);
  else await rm(backup, { force: true });
  return true;
}

async function replaceFile(tempPath, targetPath) {
  try {
    await rename(tempPath, targetPath);
    return;
  } catch (error) {
    // POSIX rename replaces an existing file. Windows can reject that replacement while the
    // destination exists, so retain the old target until the new one has landed.
    if (!["EACCES", "EEXIST", "EPERM"].includes(error?.code)) throw error;
  }
  const backup = `${targetPath}.previous`;
  await rm(backup, { force: true });
  let movedExisting = false;
  try {
    await rename(targetPath, backup);
    movedExisting = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (movedExisting) {
      try { await rename(backup, targetPath); } catch { /* the publication journal repairs this on restart */ }
    }
    throw error;
  }
  if (movedExisting) await rm(backup, { force: true });
}

/** Same-directory durable temp write followed by atomic rename (or recoverable Windows replacement). */
export async function atomicWriteText(targetPath, text) {
  const target = path.resolve(targetPath);
  await mkdir(path.dirname(target), { recursive: true });
  await recoverAtomicReplacement(target);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceFile(temp, target);
  } finally {
    try { await handle?.close(); } catch { /* best effort after a failed write */ }
    await rm(temp, { force: true });
  }
}

export async function atomicWriteJson(targetPath, value, spacing = 0) {
  await atomicWriteText(targetPath, `${JSON.stringify(value, null, spacing)}\n`);
}

function verifiedJournal(value, statePath, receiptPath) {
  const state = path.resolve(statePath), receipt = path.resolve(receiptPath);
  if (value?.schema !== PUBLICATION_SCHEMA || value.statePath !== state || value.receiptPath !== receipt
    || typeof value.stateText !== "string" || typeof value.receiptText !== "string"
    || value.stateSha256 !== sha256(value.stateText) || value.receiptSha256 !== sha256(value.receiptText)) {
    throw new Error("Brain build publication journal is invalid or belongs to different targets");
  }
  return value;
}

async function fileHash(targetPath) {
  try { return sha256(await readFile(targetPath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/**
 * Complete an interrupted two-file publication. The journal owns exact payloads, so recovery
 * never invokes ingestion or reconstructs a receipt from mutable database state.
 */
export async function recoverBrainBuildPublication({ statePath, receiptPath }) {
  const stateTarget = path.resolve(statePath), receiptTarget = path.resolve(receiptPath);
  const journalPath = brainBuildPublicationJournalPath(stateTarget);
  await recoverAtomicReplacement(journalPath);
  await Promise.all([recoverAtomicReplacement(stateTarget), recoverAtomicReplacement(receiptTarget)]);
  let raw;
  try { raw = await readFile(journalPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { recovered: false };
    throw error;
  }
  let journal;
  try { journal = verifiedJournal(JSON.parse(raw), stateTarget, receiptTarget); }
  catch (error) { throw new Error(`Cannot recover brain build publication: ${error instanceof Error ? error.message : String(error)}`); }
  if (await fileHash(receiptTarget) !== journal.receiptSha256) await atomicWriteText(receiptTarget, journal.receiptText);
  if (await fileHash(stateTarget) !== journal.stateSha256) await atomicWriteText(stateTarget, journal.stateText);
  if (await fileHash(receiptTarget) !== journal.receiptSha256 || await fileHash(stateTarget) !== journal.stateSha256) {
    throw new Error("Recovered brain build publication failed hash verification");
  }
  await rm(journalPath, { force: true });
  return { recovered: true, state: JSON.parse(journal.stateText), receipt: JSON.parse(journal.receiptText) };
}

/** Receipt first, state last: state is the publication commit marker. */
export async function publishBrainBuildCheckpoint({ statePath, receiptPath, state, receipt, hooks = {} }) {
  await recoverBrainBuildPublication({ statePath, receiptPath });
  const stateTarget = path.resolve(statePath), receiptTarget = path.resolve(receiptPath);
  const stateText = `${JSON.stringify(state)}\n`;
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  const journal = {
    schema: PUBLICATION_SCHEMA,
    statePath: stateTarget,
    receiptPath: receiptTarget,
    stateSha256: sha256(stateText),
    receiptSha256: sha256(receiptText),
    stateText,
    receiptText
  };
  const journalPath = brainBuildPublicationJournalPath(stateTarget);
  await atomicWriteJson(journalPath, journal);
  await hooks.afterJournal?.();
  await atomicWriteText(receiptTarget, receiptText);
  await hooks.afterReceipt?.();
  await atomicWriteText(stateTarget, stateText);
  await hooks.afterState?.();
  if (await fileHash(receiptTarget) !== journal.receiptSha256 || await fileHash(stateTarget) !== journal.stateSha256) {
    throw new Error("Brain build checkpoint failed post-publication hash verification");
  }
  await rm(journalPath, { force: true });
  return receipt;
}

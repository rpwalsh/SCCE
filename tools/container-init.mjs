#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Only creates absent local files. Never rotates credentials or moves existing corpora.
const root = path.resolve(import.meta.dirname, '..');
for (const directory of ['.scce/docker', 'data/corpora', 'models', 'artifacts/container']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
for (const name of ['postgres-password', 'api-token']) {
  const file = path.join(root, '.scce/docker', name);
  try {
    await writeFile(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`Created .scce/docker/${name}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Kept existing .scce/docker/${name}`);
  }
}
console.log('Local deployment inputs ready. No database or ingestion was started.');

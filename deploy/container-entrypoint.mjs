// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Deployment-only secret injection; the application retains its existing config contract.
const env = { ...process.env };
if (env.SCCE_DATABASE_PASSWORD_FILE) {
  const url = new URL(`postgresql://${env.SCCE_DATABASE_HOST ?? 'postgres'}:5432/${env.SCCE_DATABASE_NAME ?? 'scce_container'}`);
  url.username = env.SCCE_DATABASE_USER ?? 'scce';
  url.password = (await readFile(env.SCCE_DATABASE_PASSWORD_FILE, 'utf8')).trim();
  if (!url.password) throw new Error('Database password file is empty');
  env.SCCE_DATABASE_URL = url.href;
}
if (env.SCCE_API_BEARER_TOKEN_FILE) {
  env.SCCE_API_BEARER_TOKEN = (await readFile(env.SCCE_API_BEARER_TOKEN_FILE, 'utf8')).trim();
  if (!env.SCCE_API_BEARER_TOKEN) throw new Error('API token file is empty');
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A container command is required');
const child = spawn(command, args, { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1);
});

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, readConfig, validateBinding } from './notifications.mjs';

export function bindNotification({ configFile, binding }) {
  if (!configFile || !path.isAbsolute(configFile)) throw new Error('--config must be an absolute path');
  const valid = validateBinding(binding);
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const lock = `${configFile}.lock`;
  if (!acquireLock(lock)) throw new Error('Notification configuration is busy; retry shortly');
  try {
    let config = { version: 1, bindings: [] };
    try { config = readConfig(configFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    config.bindings = config.bindings.filter(item => !(item.client === valid.client
      && item.hostSessionId === valid.hostSessionId && item.cwd === valid.cwd));
    config.bindings.push(valid);
    if (config.bindings.length > 100) throw new Error('notification config allows at most 100 bindings');
    const serialized = JSON.stringify(config, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('notification config exceeds the 64 KiB size limit');
    const temporary = `${configFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, configFile);
    } finally { fs.rmSync(temporary, { force: true }); }
    return valid;
  } finally { fs.rmSync(lock, { force: true }); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index];
      if (!['--config', '--client', '--host-session', '--cwd', '--room', '--session', '--broker-url'].includes(key)
        || !process.argv[index + 1]) throw new Error('invalid or missing bind option');
      flags[key] = process.argv[index + 1];
    }
    const binding = bindNotification({ configFile: flags['--config'], binding: { client: flags['--client'],
      hostSessionId: flags['--host-session'], cwd: flags['--cwd'], room: flags['--room'], mailboxSessionId: flags['--session'],
      ...(flags['--broker-url'] === undefined ? {} : { brokerUrl: flags['--broker-url'] }) } });
    console.log(`Bound ${binding.client} host session to mailbox session ${binding.mailboxSessionId}.`);
  } catch (error) {
    console.error(`${error.message}\nUsage: node hooks/bind.mjs --config /absolute/notifications.json --client codex|claude-code|opencode --host-session HOST_ID --cwd /absolute/worktree --room ROOM --session MAILBOX_SESSION [--broker-url URL]`);
    process.exitCode = 1;
  }
}

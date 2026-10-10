import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CODEX_WAKE_PREFIX = 'This message was queued automatically by the agent-chat hook, not typed by the user. ';

export function codexControlSocket(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}

function frame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
    : payload.length < 65536 ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]) : null;
  if (!header) throw new Error('Codex control request is too large');
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index++) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Thread ids loaded in the shared Codex app-server daemon, or null when it cannot be asked. */
export function codexLoadedThreads({ socket = codexControlSocket(), timeoutMs = 3000 } = {}) {
  return new Promise(resolve => {
    if (process.platform === 'win32' || !fs.existsSync(socket)) return resolve(null);
    const connection = net.connect(socket);
    let upgraded = false; let buffer = Buffer.alloc(0); let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); connection.destroy(); resolve(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = message => connection.write(frame(JSON.stringify({ jsonrpc: '2.0', ...message })));
    const parse = () => {
      while (buffer.length >= 2) {
        let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (length > 1024 * 1024) return finish(null);
        if (buffer.length < offset + length) return;
        const opcode = buffer[0] & 15; const body = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) return finish(null);
        if (opcode !== 1) continue;
        let message; try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/loaded/list', params: {} });
        } else if (message.id === 2) {
          const ids = message.result?.data;
          finish(Array.isArray(ids) ? new Set(ids.filter(id => typeof id === 'string')) : null);
        }
      }
    };
    connection.on('error', () => finish(null));
    connection.on('close', () => finish(null));
    connection.on('connect', () => connection.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    connection.on('data', data => {
      if (!upgraded) {
        buffer = Buffer.concat([buffer, data]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101 /.test(buffer.subarray(0, end).toString('latin1'))) return finish(null);
        upgraded = true; buffer = buffer.subarray(end + 4);
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-chat', title: 'Agent Chat', version: '1' },
          capabilities: { experimentalApi: true } } });
      } else buffer = Buffer.concat([buffer, data]);
      parse();
    });
  });
}

/** Queues fixed wake text for a daemon-hosted thread; rejects so an undelivered notice is retried. */
export async function queueCodexWake({ threadId, text, env = process.env, loadedThreads = codexLoadedThreads,
  run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { env, timeout: 30000 },
    error => error ? reject(error) : resolve())) }) {
  // A thread outside the shared daemon may belong to another host process; queueing could start a second writer.
  if (!(await loadedThreads({ socket: codexControlSocket(env) }))?.has(threadId)) throw new Error('Codex thread is not hosted by the shared app-server');
  await run(env.AGENT_CHAT_CODEX_BIN || 'codex', ['queue', '--thread', threadId, '--message', CODEX_WAKE_PREFIX + text.trim()]);
}

/** Starts the idle watcher outside the Stop hook so the Codex turn can finish immediately. */
export function startCodexIdleWatch({ identity, env = process.env, spawnChild = spawn }) {
  if (process.platform === 'win32' || !fs.existsSync(codexControlSocket(env))) return false;
  const notify = fileURLToPath(new URL('./notify.mjs', import.meta.url));
  const child = spawnChild(process.execPath, [notify, 'codex', 'codex-idle-watch'], { detached: true, stdio: 'ignore',
    env: { ...env, AGENT_CHAT_IDLE_WATCH_PAYLOAD: JSON.stringify({ session_id: identity.hostSessionId, cwd: identity.cwd, hook_event_name: 'Stop' }) } });
  child.on?.('error', () => {});
  child.unref?.();
  return true;
}

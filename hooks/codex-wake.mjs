import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CODEX_WAKE_PREFIX = 'This message was queued automatically by the agent-chat hook, not typed by the user. ';
const LOADED_PAGES = 20;
const WATCHER_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'CODEX_HOME', 'AGENT_CHAT_HOME', 'AGENT_CHAT_NOTIFY_CONFIG',
  'AGENT_CHAT_NOTIFY_AUTO_BIND', 'AGENT_CHAT_NOTIFY_IDENTITY_TOOLS', 'AGENT_CHAT_CODEX_BIN', 'AGENT_CHAT_BROKER_URL',
  'AGENT_CHAT_BROKER_TOKEN_FILE', 'AGENT_CHAT_BROKER_SESSION_DIR', 'AGENT_CHAT_ROOM'];

export function codexControlSocket(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}

export function codexWakeSupported(env = process.env) {
  return process.platform !== 'win32' && fs.existsSync(codexControlSocket(env));
}

function frame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : payload.length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 255]) : null;
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
    const threads = new Set();
    let upgraded = false; let buffer = Buffer.alloc(0); let fragments = []; let settled = false; let pages = 0;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); connection.destroy(); resolve(value); } };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = message => connection.write(frame(1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))));
    const list = cursor => send({ id: 2, method: 'thread/loaded/list', params: cursor ? { cursor } : {} });
    const handle = text => {
      let message; try { message = JSON.parse(text); } catch { return; }
      if (message.id === 1) { send({ method: 'initialized' }); list(); return; }
      if (message.id !== 2) return;
      const ids = message.result?.data;
      if (!Array.isArray(ids)) return finish(null);
      for (const id of ids) if (typeof id === 'string') threads.add(id);
      const cursor = message.result.nextCursor;
      if (typeof cursor === 'string' && cursor && ++pages < LOADED_PAGES) list(cursor); else finish(threads);
    };
    const parse = () => {
      while (buffer.length >= 2) {
        let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (length > 1024 * 1024) return finish(null);
        if (buffer.length < offset + length) return;
        const fin = (buffer[0] & 0x80) !== 0; const opcode = buffer[0] & 15;
        const body = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) return finish(null);
        if (opcode === 9) { connection.write(frame(10, body)); continue; }
        if (opcode === 1) fragments = [body];
        else if (opcode === 0 && fragments.length) fragments.push(body);
        else continue;
        if (fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; handle(text); }
      }
    };
    connection.on('error', () => finish(null));
    connection.on('close', () => finish(null));
    connection.on('connect', () => connection.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    connection.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101 /.test(buffer.subarray(0, end).toString('latin1'))) return finish(null);
        upgraded = true; buffer = buffer.subarray(end + 4);
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-chat', title: 'Agent Chat', version: '1' },
          capabilities: { experimentalApi: true } } });
      }
      parse();
    });
  });
}

function unreachable(message) {
  return Object.assign(new Error(message), { code: 'IDLE_WAKE_UNREACHABLE' });
}

/** Queues fixed wake text for a daemon-hosted thread; rejects so an undelivered notice is retried. */
export async function queueCodexWake({ threadId, text, env = process.env, loadedThreads = codexLoadedThreads,
  run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { env, timeout: 10000 },
    error => error ? reject(error) : resolve())) }) {
  // A thread outside the shared daemon may belong to another host process; queueing could start a second writer.
  const hosted = await loadedThreads({ socket: codexControlSocket(env) });
  if (!hosted?.has(threadId)) throw unreachable('Codex thread is not hosted by the shared app-server');
  try { await run(env.AGENT_CHAT_CODEX_BIN || 'codex', ['queue', '--thread', threadId, '--message', CODEX_WAKE_PREFIX + text.trim()]); }
  catch (error) { throw error.code === 'ENOENT' ? unreachable('codex executable not found') : error; }
}

/** Starts the idle watcher outside the Stop hook so the Codex turn can finish immediately. */
export function startCodexIdleWatch({ identity, generation, env = process.env, spawnChild = spawn }) {
  const notify = fileURLToPath(new URL('./notify.mjs', import.meta.url));
  const childEnv = Object.fromEntries(WATCHER_ENV.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const child = spawnChild(process.execPath, [notify, 'codex', 'codex-idle-watch'], { detached: true, stdio: 'ignore', cwd: os.homedir(),
    env: { ...childEnv, AGENT_CHAT_IDLE_WATCH_GENERATION: generation,
      AGENT_CHAT_IDLE_WATCH_PAYLOAD: JSON.stringify({ session_id: identity.hostSessionId, cwd: identity.cwd, hook_event_name: 'Stop' }) } });
  child.on?.('error', () => {});
  child.unref?.();
  return true;
}

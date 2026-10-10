import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailbox } from '../lib/mailbox.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { runCommandHook, notifySession } from '../hooks/notifications.mjs';
import { codexLoadedThreads, queueCodexWake, startCodexIdleWatch, codexWakeSupported, CODEX_WAKE_PREFIX } from '../hooks/codex-wake.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-codex-wake-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'worktree'); fs.mkdirSync(cwd);
  const home = path.join(root, 'mailbox');
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('codex-wake');
  const peer = mailbox.claimIdentity(room, 'codex-peer', 'codex-mcp-client', crypto.randomUUID());
  const configFile = path.join(root, 'notifications.json');
  const hostSessionId = '01a12495-4b5d-7c10-bfcb-b927fe0c3f5d';
  bindNotification({ configFile, binding: { client: 'codex', hostSessionId, cwd, room: room.id, mailboxSessionId: peer.sessionId } });
  const codexHome = path.join(root, 'codex');
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: configFile, CODEX_HOME: codexHome };
  const send = (text = 'private request', to = peer.name) => mailbox.appendMessage(room, 'sender', to, text);
  return { root, cwd, home, mailbox, room, peer, configFile, hostSessionId, codexHome, env, send,
    payload: { session_id: hostSessionId, cwd, hook_event_name: 'Stop' } };
}

// A minimal app-server control socket: answers the WebSocket upgrade, initialize, and thread/loaded/list.
async function fakeDaemon(t, codexHome, threads, pages = [threads]) {
  const dir = path.join(codexHome, 'app-server-control'); fs.mkdirSync(dir, { recursive: true });
  const socket = path.join(dir, 'app-server-control.sock');
  const methods = [];
  const server = net.createServer(connection => {
    let upgraded = false; let buffer = Buffer.alloc(0);
    const reply = value => { const body = Buffer.from(JSON.stringify(value)); connection.write(Buffer.concat([Buffer.from([0x81, body.length]), body])); };
    connection.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
        buffer = buffer.subarray(end + 4); upgraded = true;
        connection.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      }
      while (buffer.length >= 6) {
        let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
        buffer = buffer.subarray(offset + 4 + length);
        const message = JSON.parse(body.toString('utf8'));
        methods.push(message.method);
        if (message.method === 'initialize') reply({ id: message.id, result: { userAgent: 'fake' } });
        if (message.method === 'thread/loaded/list') {
          const index = message.params?.cursor ? Number(message.params.cursor) : 0;
          reply({ id: message.id, result: { data: pages[index], nextCursor: index + 1 < pages.length ? String(index + 1) : null } });
        }
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => server.close());
  return { socket, methods };
}

test('loaded-thread query speaks the app-server control protocol and fails closed', async t => {
  const f = fixture(t);
  const daemon = await fakeDaemon(t, f.codexHome, [f.hostSessionId, 'other']);
  assert.deepEqual([...await codexLoadedThreads({ socket: daemon.socket })], [f.hostSessionId, 'other']);
  assert.deepEqual(daemon.methods, ['initialize', 'initialized', 'thread/loaded/list']);
  assert.equal(await codexLoadedThreads({ socket: path.join(f.root, 'missing.sock') }), null);
});

test('loaded-thread query follows page cursors', async t => {
  const f = fixture(t);
  const daemon = await fakeDaemon(t, f.codexHome, null, [['a'], ['b'], [f.hostSessionId]]);
  assert.deepEqual([...await codexLoadedThreads({ socket: daemon.socket })], ['a', 'b', f.hostSessionId]);
});

test('Codex wake queues fixed text only for a daemon-hosted thread', async t => {
  const f = fixture(t);
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); };
  await assert.rejects(queueCodexWake({ threadId: f.hostSessionId, text: 'notice', env: f.env, run,
    loadedThreads: async () => new Set(['other']) }), error => error.code === 'IDLE_WAKE_UNREACHABLE');
  await assert.rejects(queueCodexWake({ threadId: f.hostSessionId, text: 'notice', env: f.env, loadedThreads: async () => new Set([f.hostSessionId]),
    run: async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); } }), error => error.code === 'IDLE_WAKE_UNREACHABLE');
  await assert.rejects(queueCodexWake({ threadId: f.hostSessionId, text: 'notice', env: f.env, run, loadedThreads: async () => null }), /not hosted/);
  assert.equal(calls.length, 0);
  await queueCodexWake({ threadId: f.hostSessionId, text: 'notice\n', env: { ...f.env, AGENT_CHAT_CODEX_BIN: '/bin/codex' }, run,
    loadedThreads: async () => new Set([f.hostSessionId]) });
  assert.deepEqual(calls, [['/bin/codex', 'queue', '--thread', f.hostSessionId, '--message', `${CODEX_WAKE_PREFIX}notice`]]);
});

test('Codex Stop starts a detached watcher only for a bound session with a control socket', async t => {
  const f = fixture(t);
  const spawned = [];
  const codexWake = { codexWakeSupported, startCodexIdleWatch: options => startCodexIdleWatch({ ...options, spawnChild: (file, args, options) => {
    spawned.push({ file, args, options }); return { unref() {}, on() {} };
  } }) };
  const stop = async payload => { const output = []; await runCommandHook({ client: 'codex', payload, env: f.env, mailbox: f.mailbox,
    codexWake, write: value => output.push(value) }); return output.join(''); };
  assert.equal(await stop(f.payload), '{}\n');
  assert.equal(spawned.length, 0);
  await fakeDaemon(t, f.codexHome, []);
  assert.equal(await stop({ ...f.payload, session_id: 'unbound-host' }), '{}\n');
  assert.equal(spawned.length, 0);
  assert.equal(await stop(f.payload), '{}\n');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(1), ['codex', 'codex-idle-watch']);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.stdio, 'ignore');
  assert.deepEqual(JSON.parse(spawned[0].options.env.AGENT_CHAT_IDLE_WATCH_PAYLOAD), f.payload);
  assert.equal(spawned[0].options.cwd, os.homedir());
  assert.equal(spawned[0].options.env.AGENT_CHAT_NOTIFY_CONFIG, f.configFile);
  const generation = spawned[0].options.env.AGENT_CHAT_IDLE_WATCH_GENERATION;
  assert.match(generation, /^[0-9a-f-]{36}$/);
  const stateDir = path.join(path.dirname(f.configFile), 'notification-state');
  const watchFile = fs.readdirSync(stateDir).find(name => name.startsWith('idle-watch-'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, watchFile), 'utf8')).generation, generation);
  await runCommandHook({ client: 'codex', payload: { ...f.payload, hook_event_name: 'UserPromptSubmit' }, env: f.env, mailbox: f.mailbox, write: () => {} });
  assert.equal(fs.existsSync(path.join(stateDir, watchFile)), false);
});

test('Codex idle watcher exits for an unhosted thread and wakes a hosted one once per directed message', async t => {
  const f = fixture(t);
  let clock = Date.now();
  const queued = [];
  let hosted = new Set();
  let failNext = false;
  const codexWake = {
    codexControlSocket: () => 'socket',
    codexLoadedThreads: async () => hosted,
    queueCodexWake: async ({ threadId, text }) => { if (failNext) { failNext = false; throw new Error('codex queue failed'); } queued.push([threadId, text]); },
  };
  const watch = () => runCommandHook({ client: 'codex', payload: f.payload, env: f.env, mailbox: f.mailbox, mode: 'codex-idle-watch', codexWake,
    write: () => assert.fail('the detached watcher writes nothing'),
    idleWatchOptions: { maxMs: 60000, now: () => clock, sleep: async ms => { clock += ms; } } });
  f.send();
  assert.equal((await watch()).reason, 'idle-not-hosted');
  hosted = new Set([f.hostSessionId]);
  failNext = true;
  assert.equal((await watch()).reason, 'idle-woke');
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], f.hostSessionId);
  assert.match(queued[0][1], /1 new message/);
  assert.doesNotMatch(queued[0][1], /private request/);
  assert.equal((await watch()).reason, 'idle-timeout');
  f.send('second request');
  codexWake.queueCodexWake = async () => { throw Object.assign(new Error('gone'), { code: 'IDLE_WAKE_UNREACHABLE' }); };
  assert.equal((await watch()).reason, 'idle-unreachable');
  const notices = [];
  await notifySession({ client: 'codex', hostSessionId: f.hostSessionId, cwd: f.cwd, env: f.env, mailbox: f.mailbox, deliver: text => notices.push(text) });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /1 new message/);
});

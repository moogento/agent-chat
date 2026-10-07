import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createMailbox, LIMITS } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-core-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mailbox = createMailbox({ home });
  return { home, mailbox, room: mailbox.resolveRoom('test-room') };
}
function serverFor(t, mailbox, options = {}) {
  const responses = [];
  const server = createServer({ mailbox, output: (result) => responses.push(result), sessionId: `test-${Math.random().toString(16).slice(2)}`, ...options });
  t.after(() => server.stop());
  return { server, responses };
}

test('rejects traversal and mailbox symlink escapes', (t) => {
  const { home, mailbox } = fixture(t);
  assert.throws(() => mailbox.resolveRoom('.'), /cannot be/);
  assert.throws(() => mailbox.resolveRoom('..'), /cannot be/);
  for (const id of ['../escape', '..', '.', '/tmp', 'a/b', 'a\\b']) assert.throws(() => mailbox.roomDir({ id }), /Invalid room/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(home, 'rooms', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => mailbox.roomDir({ id: 'escape' }), /Unsafe/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('new identities use fresh cursors; long handles preserve suffix ownership', (t) => {
  const { mailbox, room } = fixture(t);
  const base = 'x'.repeat(40);
  const first = mailbox.claimIdentity(room, base);
  const second = mailbox.claimIdentity(room, base);
  assert.equal(second.name.length, 40);
  assert.notEqual(first.name, second.name);
  mailbox.touchPeer(second, 'second');
  assert.equal(mailbox.listPeers(room).find((p) => p.name === first.name).status, '');
  mailbox.releaseIdentity(second);
  assert.equal(mailbox.listPeers(room).length, 1);
  mailbox.appendMessage(room, 'sender', first.name, 'hello');
  assert.equal(mailbox.takeUnread(first).messages.length, 1);
  mailbox.releaseIdentity(first);
  const restart = mailbox.claimIdentity(room, base);
  assert.notEqual(first.sessionId, restart.sessionId);
  assert.equal(mailbox.takeUnread(restart).messages.length, 1);
  assert.throws(() => mailbox.claimIdentity(room, 'all'), /reserved/);
});

test('bounded Unicode pages retain every undelivered message', (t) => {
  const { mailbox, room } = fixture(t);
  const reader = mailbox.claimIdentity(room, 'reader');
  mailbox.takeUnread(reader);
  const expected = [];
  for (let i = 0; i < 60; i++) expected.push(mailbox.appendMessage(room, 'sender', 'reader', `${i}: ${'🦉'.repeat(90)}`).id);
  const received = [];
  let result;
  do {
    result = mailbox.takeUnread(reader, { limit: 7, maxBytes: 2048 });
    assert.ok(result.messages.length <= 7);
    assert.ok(Buffer.byteLength(JSON.stringify(result.messages)) < 2048);
    received.push(...result.messages.map((msg) => msg.id));
  } while (result.hasMore);
  assert.deepEqual(received, expected);
  assert.equal(mailbox.takeUnread(reader).messages.length, 0);
});

test('first read scans a bounded tail and returns latest eligible messages', (t) => {
  const { mailbox, room } = fixture(t);
  mailbox.roomDir(room);
  const file = path.join(mailbox.roomPath(room), 'messages.jsonl');
  const lines = Array.from({ length: 2000 }, (_, index) => JSON.stringify({ id: String(index), ts: 'now', from: 'other', to: 'all', text: `${index} ${'z'.repeat(200)}` }) + '\n');
  fs.writeFileSync(file, lines.join(''));
  const result = mailbox.takeUnread(mailbox.claimIdentity(room, 'reader'));
  assert.equal(result.messages.length, 20);
  assert.equal(result.messages[0].id, '1980');
  assert.equal(result.messages.at(-1).id, '1999');
  assert.ok(result.earliestOffset > 0);
});

test('partial trailing Unicode append is not consumed until newline', (t) => {
  const { mailbox, room } = fixture(t);
  const reader = mailbox.claimIdentity(room, 'reader');
  mailbox.takeUnread(reader);
  const file = path.join(mailbox.roomPath(room), 'messages.jsonl');
  const encoded = Buffer.from(JSON.stringify({ id: 'partial', ts: 'now', from: 'other', to: 'reader', text: '🦉' }) + '\n');
  const split = encoded.indexOf(Buffer.from('🦉')) + 2;
  fs.appendFileSync(file, encoded.subarray(0, split));
  assert.equal(mailbox.takeUnread(reader).nextOffset, 0);
  fs.appendFileSync(file, encoded.subarray(split));
  assert.equal(mailbox.takeUnread(reader).messages[0].text, '🦉');
});

test('oversized new and legacy messages have explicit policy without cursor loss', (t) => {
  const { mailbox, room } = fixture(t);
  assert.throws(() => mailbox.appendMessage(room, 'sender', 'all', 'x'.repeat(LIMITS.textBytes + 1)), /exceeds/);
  assert.throws(() => mailbox.appendMessage(room, 'sender', 'all', '\u0000'.repeat(LIMITS.textBytes)), /Encoded message/);
  const reader = mailbox.claimIdentity(room, 'reader'); mailbox.takeUnread(reader);
  const file = path.join(mailbox.roomPath(room), 'messages.jsonl');
  fs.appendFileSync(file, JSON.stringify({ id: 'old', ts: 'now', from: 'other', to: 'reader', text: 'x'.repeat(40000) }) + '\n');
  const blocked = mailbox.takeUnread(reader);
  assert.ok(blocked.blocked); assert.equal(blocked.nextOffset, 0);
  assert.equal(mailbox.takeUnread(reader, { maxBytes: LIMITS.scanBytes }).messages[0].id, 'old');
});

test('notification inspection is read only and suppresses messages already consumed', (t) => {
  const { mailbox, room } = fixture(t);
  const reader = mailbox.claimIdentity(room, 'reader'); mailbox.takeUnread(reader);
  mailbox.appendMessage(room, 'other', 'reader', 'direct');
  mailbox.appendMessage(room, 'other', 'elsewhere', 'hidden');
  mailbox.appendMessage(room, 'other', 'all', 'broadcast');
  const inspected = mailbox.inspectNotifications({ room, name: reader.name, sessionId: reader.sessionId, afterOffset: 0, unreadOnly: true });
  assert.deepEqual(inspected.messages.map((msg) => msg.text), ['direct', 'broadcast']);
  assert.equal(mailbox.takeUnread(reader).messages.length, 2);
  assert.equal(mailbox.inspectNotifications({ room, name: reader.name, sessionId: reader.sessionId, afterOffset: 0, unreadOnly: true }).messages.length, 0);
});

test('cleanup never removes an active room and expires inactive rooms', (t) => {
  const { mailbox, room } = fixture(t);
  const live = mailbox.claimIdentity(room, 'reader');
  const old = mailbox.resolveRoom('old'); mailbox.roomDir(old);
  const ancient = new Date(Date.now() - 10 * 86400000);
  for (const target of [room, old]) fs.utimesSync(path.join(mailbox.roomPath(target), 'room.json'), ancient, ancient);
  assert.deepEqual(mailbox.tidyRooms({ force: true, ttlDays: 7 }), ['old']);
  assert.ok(fs.existsSync(mailbox.roomPath(room)));
  mailbox.releaseIdentity(live);
  assert.deepEqual(mailbox.tidyRooms({ force: true, ttlDays: 7 }), ['test-room']);
});

test('MCP validates malformed requests and arguments and remains usable', async (t) => {
  const { mailbox } = fixture(t); const { server, responses } = serverFor(t, mailbox);
  for (const req of [null, [], 'hi', {}, { jsonrpc: '2.0', id: [], method: 'ping' }]) { await server.handle(req); assert.equal(responses.at(-1).error.code, -32600); }
  for (const args of [null, [], { text: 12 }, { text: 'hi', to: null }, { text: 'hi', extra: true }]) {
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_send', arguments: args } }); assert.equal(responses.at(-1).error.code, -32602);
  }
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'unsupported', clientInfo: { name: 'test' } } });
  assert.equal(responses.at(-1).result.protocolVersion, '2025-06-18');
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat_who' } });
  assert.equal(responses.at(-1).result.structuredContent.agentChatIdentity.sessionId, server.state.identity.sessionId);
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'ping' }); assert.deepEqual(responses.at(-1).result, {});
});

test('unchanged status is quiet and response is concise', async (t) => {
  const { mailbox } = fixture(t); const { server } = serverFor(t, mailbox);
  await server.callTool('chat_status', { mine: 'testing', room_summary: 'task' });
  const { room } = server.state.identity;
  const before = fs.statSync(path.join(mailbox.roomPath(room), 'messages.jsonl')).size;
  assert.equal(await server.callTool('chat_status', { mine: 'testing', room_summary: 'task' }), 'No status changes.');
  assert.equal(fs.statSync(path.join(mailbox.roomPath(room), 'messages.jsonl')).size, before);
});

test('pending reads retain old identity and stop safely on rename and join', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox);
  await server.callTool('chat_join', { name: 'reader', room: room.id });
  const old = server.state.identity;
  mailbox.claimIdentity(room, 'peer');
  const pending = server.callTool('chat_read', { wait_seconds: 2 });
  await server.callTool('chat_join', { name: 'renamed', room: 'new-room' });
  const result = await pending;
  assert.match(result, /identity changed/);
  assert.ok(!mailbox.listPeers(room).some((peer) => peer.name === old.name));
  mailbox.appendMessage(room, 'peer', 'reader', 'old room only');
  assert.equal((await server.callTool('chat_read')).includes('old room only'), false);
});

test('repeated joins preserve a suffixed identity, status and pending read', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox);
  const builder = mailbox.claimIdentity(room, 'builder');
  await server.callTool('chat_join', { name: 'builder', room: room.id });
  const identity = server.state.identity; assert.equal(identity.name, 'builder-2');
  await server.callTool('chat_status', { mine: 'working' });
  const pending = server.callTool('chat_read', { wait_seconds: 2 });
  await server.callTool('chat_join', { name: 'builder', room: room.id });
  assert.equal(server.state.identity, identity);
  const ownPeers = mailbox.listPeers(room).filter(peer => peer.sessionId === identity.sessionId);
  assert.equal(ownPeers.length, 1); assert.equal(ownPeers[0].status, 'working');
  mailbox.appendMessage(room, builder.name, identity.name, 'continue pending read', builder.sessionId);
  assert.match(await pending, /continue pending read/);
  assert.equal(await server.callTool('chat_read'), 'No new messages.');
  server.stop();
  assert.deepEqual(mailbox.listPeers(room).map(peer => peer.sessionId), [builder.sessionId]);
});

test('cancelled pending read does not consume messages', async (t) => {
  const { mailbox, room } = fixture(t); const { server, responses } = serverFor(t, mailbox);
  await server.callTool('chat_join', { name: 'reader', room: room.id }); mailbox.claimIdentity(room, 'peer');
  const pending = server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'chat_read', arguments: { wait_seconds: 1 } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } });
  mailbox.appendMessage(room, 'peer', 'reader', 'after cancellation');
  await pending;
  assert.match(responses.at(-1).result.content[0].text, /cancelled/);
  assert.match(await server.callTool('chat_read'), /after cancellation/);
});

test('zero waiting budget stops immediately without consuming messages', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox, { waitBudget: 0 });
  await server.callTool('chat_join', { name: 'reader', room: room.id }); mailbox.claimIdentity(room, 'peer');
  assert.match(await server.callTool('chat_read', { wait_seconds: 1 }), /budget exhausted/);
  mailbox.appendMessage(room, 'peer', 'reader', 'still readable');
  assert.match(await server.callTool('chat_read', { wait_seconds: 1 }), /still readable/);
});

test('a completed wait exhausts its cumulative session budget', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox, { waitBudget: 0.25 });
  await server.callTool('chat_join', { name: 'reader', room: room.id }); mailbox.claimIdentity(room, 'peer');
  assert.match(await server.callTool('chat_read', { wait_seconds: 1 }), /Wait ended/);
  assert.match(await server.callTool('chat_read', { wait_seconds: 1 }), /budget exhausted/);
});

test('simultaneous processes claim unique handles atomically', async (t) => {
  const { home, mailbox, room } = fixture(t);
  const script = `import {createMailbox} from ${JSON.stringify(new URL('../lib/mailbox.mjs', import.meta.url).href)};const m=createMailbox({home:process.argv[2]}); const me=m.claimIdentity(m.resolveRoom('test-room'),'same'); for(let i=0;i<20;i++) m.appendMessage(me.room,me.name,'all',String(i)+' 🦉',me.sessionId); console.log(JSON.stringify(me));setInterval(()=>{},1000);`;
  const worker = path.join(home, 'claim-worker.mjs'); fs.writeFileSync(worker, script);
  const children = Array.from({ length: 8 }, () => spawn(process.execPath, [worker, home], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const workerErrors = new Map();
  for (const child of children) {
    workerErrors.set(child, ''); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => workerErrors.set(child, workerErrors.get(child) + chunk));
  }
  t.after(async () => { await Promise.all(children.map(async (child) => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } })); });
  const identities = await Promise.all(children.map(async (child) => { let data = ''; for await (const chunk of child.stdout) { data += chunk; if (data.includes('\n')) return JSON.parse(data.split('\n')[0]); } throw new Error(`Worker exited without identity (exit ${child.exitCode}, signal ${child.signalCode}): ${workerErrors.get(child)}`); }));
  assert.equal(new Set(identities.map((item) => item.name)).size, children.length);
  assert.equal(new Set(identities.map((item) => item.sessionId)).size, children.length);
  assert.equal(mailbox.listPeers(room).length, children.length);
  const all = []; let offset = 0; let page;
  do { page = mailbox.inspectNotifications({ room, afterOffset: offset, limit: 100, maxBytes: LIMITS.scanBytes }); all.push(...page.messages); offset = page.nextOffset; } while (page.hasMore);
  assert.equal(all.length, children.length * 20);
  assert.equal(new Set(all.map((msg) => msg.id)).size, all.length);
  for (const msg of all) assert.match(msg.text, /🦉$/);
});

test('Windows exclusive lock opens retry transient deletion errors without stealing ownership', (t) => {
  const { home } = fixture(t); const mailbox = createMailbox({ home, lockTimeoutMs: 100 });
  const room = mailbox.resolveRoom('windows-open'); const file = path.join(home, 'locks', 'windows-open.lock');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'); const open = fs.openSync;
  let attempts = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.openSync = function(target, flags, ...args) {
    if (target === file && flags === 'wx' && ++attempts <= 2) throw Object.assign(new Error('pending deletion'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    return open.call(this, target, flags, ...args);
  };
  try {
    const identity = mailbox.claimIdentity(room, 'reader');
    assert.equal(identity.name, 'reader'); assert.equal(attempts, 3);
    assert.ok(!fs.existsSync(file));
  } finally { fs.openSync = open; Object.defineProperty(process, 'platform', platform); }
});

test('Windows persistent lock permission failures stop at the configured deadline', (t) => {
  const { home } = fixture(t); const mailbox = createMailbox({ home, lockTimeoutMs: 30 });
  const room = mailbox.resolveRoom('windows-denied'); const file = path.join(home, 'locks', 'windows-denied.lock');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'); const open = fs.openSync;
  let attempts = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.openSync = function(target, flags, ...args) {
    if (target === file && flags === 'wx') { attempts++; throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }
    return open.call(this, target, flags, ...args);
  };
  const started = Date.now();
  try {
    assert.throws(() => mailbox.claimIdentity(room, 'reader'), error => error.code === 'EACCES');
    assert.ok(attempts > 1); assert.ok(Date.now() - started < 500);
    assert.ok(!fs.existsSync(file));
  } finally { fs.openSync = open; Object.defineProperty(process, 'platform', platform); }
});

test('abandoned reclaim lock fails within a bounded timeout', (t) => {
  const { home } = fixture(t);
  const mailbox = createMailbox({ home, lockTimeoutMs: 30 });
  const room = mailbox.resolveRoom('stale');
  fs.writeFileSync(path.join(home, 'locks', 'stale.lock'), JSON.stringify({ pid: 999999999 }));
  fs.writeFileSync(path.join(home, 'locks', 'stale.lock.reclaim'), '');
  const started = Date.now();
  assert.throws(() => mailbox.claimIdentity(room, 'reader'), /Mailbox busy/);
  assert.ok(Date.now() - started < 500);
});

test('stable explicit session resumes its own cursor and same-room rename cancels pending reads', async (t) => {
  const { mailbox, room } = fixture(t);
  const { server } = serverFor(t, mailbox, { sessionId: 'stable-explicit-session' });
  await server.callTool('chat_join', { room: room.id, name: 'reader' });
  mailbox.claimIdentity(room, 'peer');
  await server.callTool('chat_read');
  mailbox.appendMessage(room, 'peer', 'reader', 'consumed');
  assert.match(await server.callTool('chat_read'), /consumed/);
  const pending = server.callTool('chat_read', { wait_seconds: 1 });
  await server.callTool('chat_join', { name: 'renamed' });
  assert.match(await pending, /identity changed/);
  assert.equal(server.state.identity.sessionId, 'stable-explicit-session');
  assert.equal(mailbox.listPeers(room).filter((p) => p.sessionId === 'stable-explicit-session').length, 1);
  server.stop();
  const { server: restart } = serverFor(t, mailbox, { sessionId: 'stable-explicit-session' });
  await restart.callTool('chat_join', { room: room.id, name: 'reader' });
  assert.equal(await restart.callTool('chat_read'), 'No new messages.');
});

test('stdio framing rejects oversized and malformed lines then handles ping', async (t) => {
  const { home } = fixture(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agent-chat.mjs', import.meta.url))], { env: { ...process.env, AGENT_CHAT_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let text = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { text += chunk; });
  child.stdin.write('x'.repeat(300 * 1024) + '\nnull\n{not-json}\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n');
  const deadline = Date.now() + 3000;
  while (!text.includes('"id":99') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const results = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(results.map((result) => result.error?.code || result.id), [-32600, -32600, -32700, 99]);
  child.kill(); await once(child, 'exit');
});

test('CLI works through an installed symlink', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows bin wrappers do not use file symlinks');
  const { home } = fixture(t);
  const link = path.join(home, 'agent-chat.mjs');
  fs.symlinkSync(fileURLToPath(new URL('../agent-chat.mjs', import.meta.url)), link);
  const child = spawn(process.execPath, [link, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0); assert.equal(output.trim(), '0.3.0');
});

test('waiting stops immediately when only a crashed peer remains', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox);
  await server.callTool('chat_join', { room: room.id, name: 'reader' });
  fs.writeFileSync(path.join(mailbox.roomPath(room), 'peers', 'crashed.json'), JSON.stringify({ name: 'crashed', pid: 999999999, sessionId: 'crashed', lastSeen: new Date().toISOString() }));
  const started = Date.now();
  assert.match(await server.callTool('chat_read', { wait_seconds: 2 }), /No active peers/);
  assert.ok(Date.now() - started < 500);
});

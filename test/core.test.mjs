import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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

test('default Git worktree rooms preserve the version 0.2 native-path hash and existing history', (t) => {
  const { mailbox } = fixture(t);
  let gitTop;
  try { gitTop = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return t.skip('Requires a Git worktree'); }
  const nativeTop = path.resolve(gitTop);
  const legacyId = `${path.basename(nativeTop).replace(/[^A-Za-z0-9._-]/g, '_') || 'root'}-${crypto.createHash('sha1').update(nativeTop).digest('hex').slice(0, 6)}`;
  const room = mailbox.resolveRoom(); assert.equal(room.id, legacyId); assert.equal(room.label, nativeTop);
  assert.deepEqual(mailbox.resolveRoom(gitTop), room);
  const legacyRoom = { id: legacyId, label: gitTop };
  const message = mailbox.appendMessage(legacyRoom, 'sender', 'reader', 'history from version 0.2');
  const reader = mailbox.claimIdentity(room, 'reader');
  assert.deepEqual(mailbox.takeUnread(reader).messages.map(item => item.id), [message.id]);
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
  assert.equal(mailbox.takeUnread(restart).messages.length, 0);
  assert.throws(() => mailbox.claimIdentity(room, 'all'), /reserved/);
});

test('reconnecting a stable session removes its stale handles while preserving other sessions', (t) => {
  const { mailbox, room } = fixture(t); const sessionId = 'stable-reconnect';
  const stale = mailbox.claimIdentity(room, 'old', 'test', sessionId);
  const oldFile = path.join(mailbox.roomPath(room), 'peers', stale.name + '.json');
  const oldPeer = JSON.parse(fs.readFileSync(oldFile, 'utf8')); oldPeer.pid = process.ppid;
  fs.writeFileSync(oldFile, JSON.stringify(oldPeer));
  assert.throws(() => mailbox.claimIdentity(room, 'new', 'test', sessionId), /already active in another process/);
  assert.equal(JSON.parse(fs.readFileSync(oldFile, 'utf8')).pid, process.ppid);
  oldPeer.pid = 999999999; fs.writeFileSync(oldFile, JSON.stringify(oldPeer));
  const other = mailbox.claimIdentity(room, 'new');
  const otherFile = path.join(mailbox.roomPath(room), 'peers', other.name + '.json');
  const otherBytes = fs.readFileSync(otherFile, 'utf8');
  const resumed = mailbox.claimIdentity(room, 'new', 'test', sessionId);
  assert.equal(resumed.name, 'new-2'); assert.ok(!fs.existsSync(oldFile));
  assert.deepEqual(mailbox.listPeers(room).filter(peer => peer.sessionId === sessionId).map(peer => peer.name), ['new-2']);
  assert.equal(fs.readFileSync(otherFile, 'utf8'), otherBytes);
  mailbox.claimIdentity(room, 'renamed', 'test', sessionId);
  assert.deepEqual(mailbox.listPeers(room).filter(peer => peer.sessionId === sessionId).map(peer => peer.name), ['renamed']);
  assert.equal(fs.readFileSync(otherFile, 'utf8'), otherBytes);
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

test('an oversized incomplete first-read tail never replays older history', (t) => {
  const { mailbox, room } = fixture(t);
  for (let i = 0; i < 5; i++) mailbox.appendMessage(room, 'sender', 'reader', `old history ${i}`);
  const file = path.join(mailbox.roomPath(room), 'messages.jsonl');
  fs.appendFileSync(file, JSON.stringify({ id: 'legacy', ts: 'now', from: 'sender', to: 'reader', text: 'x'.repeat(LIMITS.scanBytes + 100) }));
  const reader = mailbox.claimIdentity(room, 'reader');
  const first = mailbox.takeUnread(reader);
  assert.equal(first.nextOffset, fs.statSync(file).size); assert.equal(first.hasMore, false);
  assert.match(first.blocked, /initial cursor starts at transcript end/);
  assert.deepEqual(mailbox.takeUnread(reader).messages, []);
  fs.appendFileSync(file, '\n');
  const fresh = mailbox.appendMessage(room, 'sender', 'reader', 'new message after legacy tail');
  assert.deepEqual(mailbox.takeUnread(reader).messages.map(message => message.id), [fresh.id]);
  assert.deepEqual(mailbox.takeUnread(reader).messages, []);
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

test('explicit server wait limits are capped and warn once without extending broker waits', (t) => {
  const { mailbox } = fixture(t); const write = process.stderr.write; const notices = [];
  process.stderr.write = chunk => { notices.push(String(chunk)); return true; };
  try {
    const first = serverFor(t, mailbox, { maxWait: 90 }).server;
    const second = serverFor(t, mailbox, { maxWait: 90 }).server;
    for (const server of [first, second]) assert.equal(server.tools.find(tool => tool.name === 'chat_read').inputSchema.properties.wait_seconds.maximum, 50);
    assert.equal(notices.length, 1); assert.match(notices[0], /maxWait=90.*using 50 seconds/);
    for (const maxWait of [-1, NaN, Infinity, '90']) assert.throws(() => createServer({ mailbox, maxWait }), /finite nonnegative number/);
  } finally { process.stderr.write = write; }
});

async function mcpWaitSetting(t, value, { home = fixture(t).home, env: overrides = {} } = {}) {
  const env = { ...process.env, AGENT_CHAT_HOME: home, AGENT_CHAT_MAX_WAIT: value, ...overrides };
  for (const key of ['AGENT_CHAT_BROKER_URL', 'AGENT_CHAT_BROKER_TOKEN_FILE', 'AGENT_CHAT_BROKER_SESSION_FILE', 'AGENT_CHAT_SESSION', 'AGENT_CHAT_SESSION_ID']) delete env[key];
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agent-chat.mjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = ''; const responses = [];
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; let newline; while ((newline = stdout.indexOf('\n')) >= 0) { responses.push(JSON.parse(stdout.slice(0, newline))); stdout = stdout.slice(newline + 1); } });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, env, responses, stderr: () => stderr, remainder: () => stdout };
}

test('legacy AGENT_CHAT_MAX_WAIT initializes MCP with a capped schema and stderr-only notice', async (t) => {
  const client = await mcpWaitSetting(t, '90');
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } } }) + '\n');
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat_read', arguments: { wait_seconds: 90 } } }) + '\n');
  const deadline = Date.now() + 10000;
  while (client.responses.length < 3 && client.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.responses.length, 3, client.stderr());
  assert.equal(client.responses.find(response => response.id === 1).result.serverInfo.version, '0.4.0');
  const read = client.responses.find(response => response.id === 2).result.tools.find(tool => tool.name === 'chat_read');
  assert.equal(read.inputSchema.properties.wait_seconds.maximum, 50); assert.match(read.description, /up to 50s/);
  assert.equal(client.responses.find(response => response.id === 3).error.code, -32602);
  assert.match(client.stderr(), /AGENT_CHAT_MAX_WAIT=90.*using 50 seconds/);
  assert.equal(client.stderr().match(/AGENT_CHAT_MAX_WAIT=90/g)?.length, 1); assert.equal(client.remainder(), '');
  client.child.stdin.end(); const [code] = await once(client.child, 'close'); assert.equal(code, 0);
});

test('negative and nonnumeric AGENT_CHAT_MAX_WAIT still reject MCP startup clearly', async (t) => {
  for (const value of ['-1', 'NaN']) {
    const client = await mcpWaitSetting(t, value);
    const [code] = await once(client.child, 'close');
    assert.equal(code, 1); assert.match(client.stderr(), /AGENT_CHAT_MAX_WAIT must be a finite nonnegative number/);
    assert.deepEqual(client.responses, []); assert.equal(client.remainder(), '');
  }
});

async function mcpResponses(client, requests) {
  for (const request of requests) client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
  const deadline = Date.now() + 10000;
  while (client.responses.length < requests.length && client.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(client.responses.length, requests.length, client.stderr());
  return client.responses;
}
function agedTranscript(mailbox) {
  const room = mailbox.resolveRoom('aged-history'); mailbox.appendMessage(room, 'sender', 'all', 'keep recent inactive history');
  const transcript = path.join(mailbox.roomPath(room), 'messages.jsonl');
  const yesterday = new Date(Date.now() - 86400000);
  for (const file of [transcript, path.join(mailbox.roomPath(room), 'room.json')]) fs.utimesSync(file, yesterday, yesterday);
  return transcript;
}

test('empty and whitespace local environment settings retain default startup history, waits and worktree room', async (t) => {
  for (const blank of ['', ' \t ']) {
    const { home, mailbox } = fixture(t); const transcript = agedTranscript(mailbox); const history = fs.readFileSync(transcript, 'utf8');
    const room = mailbox.resolveRoom();
    const client = await mcpWaitSetting(t, blank, { home, env: { AGENT_CHAT_WAIT_BUDGET: blank, AGENT_CHAT_TTL_DAYS: blank, AGENT_CHAT_ROOM: blank, AGENT_CHAT_NAME: blank } });
    const responses = await mcpResponses(client, [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'test' } } },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'chat_who' } },
      { id: 4, method: 'tools/call', params: { name: 'chat_join', arguments: { room: '' } } },
      { id: 5, method: 'tools/call', params: { name: 'chat_join', arguments: { room: ' \t ' } } },
      { id: 6, method: 'tools/call', params: { name: 'chat_join', arguments: { name: '' } } },
      { id: 7, method: 'tools/call', params: { name: 'chat_join', arguments: { name: ' \t ' } } },
    ]);
    const read = responses.find(response => response.id === 2).result.tools.find(tool => tool.name === 'chat_read');
    assert.equal(read.inputSchema.properties.wait_seconds.maximum, 50); assert.match(read.description, /within 300s session budget/);
    assert.equal(responses.find(response => response.id === 3).result.structuredContent.agentChatIdentity.room, room.id);
    assert.equal(responses.find(response => response.id === 3).result.structuredContent.agentChatIdentity.name, 'test');
    for (const id of [4, 5]) { const rejected = responses.find(response => response.id === id).result; assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Room must be a nonempty string/); }
    for (const id of [6, 7]) { const rejected = responses.find(response => response.id === id).result; assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Name must be a nonempty string/); }
    assert.equal(fs.readFileSync(transcript, 'utf8'), history); assert.equal(client.stderr(), '');
    const cli = fileURLToPath(new URL('../agent-chat.mjs', import.meta.url));
    for (const args of [['who'], ['tidy']]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env: client.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message); assert.equal(result.stderr, '');
      if (args[0] === 'who') assert.ok(result.stdout.includes(`Room: ${room.label}`));
      assert.equal(fs.readFileSync(transcript, 'utf8'), history);
    }
    const invalidRoom = spawnSync(process.execPath, [cli, 'who', '--room', ''], { env: client.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(invalidRoom.status, 1); assert.match(invalidRoom.stderr, /Room must be a nonempty string/);
    client.child.stdin.end(); const [code] = await once(client.child, 'close'); assert.equal(code, 0);
  }
});

test('explicit zero numeric environment values keep zero waits, budget and intentional retention', async (t) => {
  const { home, mailbox } = fixture(t); const transcript = agedTranscript(mailbox);
  const client = await mcpWaitSetting(t, '0', { home, env: { AGENT_CHAT_WAIT_BUDGET: '0', AGENT_CHAT_TTL_DAYS: '0' } });
  const responses = await mcpResponses(client, [{ id: 1, method: 'tools/list' }]);
  const read = responses[0].result.tools.find(tool => tool.name === 'chat_read');
  assert.equal(read.inputSchema.properties.wait_seconds.maximum, 0); assert.match(read.description, /within 0s session budget/);
  assert.ok(!fs.existsSync(transcript)); assert.equal(client.stderr(), '');
  client.child.stdin.end(); const [code] = await once(client.child, 'close'); assert.equal(code, 0);
});

test('invalid nonblank budget and retention environment settings still reject startup', async (t) => {
  for (const name of ['AGENT_CHAT_WAIT_BUDGET', 'AGENT_CHAT_TTL_DAYS']) for (const value of ['-1', 'NaN']) {
    const client = await mcpWaitSetting(t, '50', { env: { [name]: value } });
    const [code] = await once(client.child, 'close'); assert.equal(code, 1);
    assert.ok(client.stderr().includes(`${name} must be between 0 and`)); assert.deepEqual(client.responses, []); assert.equal(client.remainder(), '');
  }
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
  const realNow = Date.now; const wait = Atomics.wait;
  let now = 0; let attempts = 0; const delays = [];
  Date.now = () => now;
  Atomics.wait = (array, index, value, timeout) => { delays.push(timeout); now += timeout; return 'timed-out'; };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.openSync = function(target, flags, ...args) {
    if (target === file && flags === 'wx' && ++attempts <= 2) throw Object.assign(new Error('pending deletion'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    return open.call(this, target, flags, ...args);
  };
  try {
    const identity = mailbox.claimIdentity(room, 'reader');
    assert.equal(identity.name, 'reader'); assert.equal(attempts, 3);
    assert.deepEqual(delays, [10, 10]); assert.equal(now, 20);
    assert.ok(!fs.existsSync(file));
  } finally { fs.openSync = open; Date.now = realNow; Atomics.wait = wait; Object.defineProperty(process, 'platform', platform); }
});

test('Windows persistent lock permission failures stop at the configured deadline', (t) => {
  const { home } = fixture(t); const mailbox = createMailbox({ home, lockTimeoutMs: 30 });
  const room = mailbox.resolveRoom('windows-denied'); const file = path.join(home, 'locks', 'windows-denied.lock');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'); const open = fs.openSync;
  const realNow = Date.now; const wait = Atomics.wait;
  let now = 0; let attempts = 0; const delays = [];
  Date.now = () => now;
  Atomics.wait = (array, index, value, timeout) => { delays.push(timeout); now += timeout; return 'timed-out'; };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fs.openSync = function(target, flags, ...args) {
    if (target === file && flags === 'wx') { attempts++; throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); }
    return open.call(this, target, flags, ...args);
  };
  try {
    assert.throws(() => mailbox.claimIdentity(room, 'reader'), error => error.code === 'EACCES');
    assert.equal(attempts, 3); assert.deepEqual(delays, [10, 10, 10]); assert.equal(now, 30);
    assert.ok(!fs.existsSync(file));
  } finally { fs.openSync = open; Date.now = realNow; Atomics.wait = wait; Object.defineProperty(process, 'platform', platform); }
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
  assert.equal(code, 0); assert.equal(output.trim(), '0.4.0');
});

test('waiting stops immediately when only a crashed peer remains', async (t) => {
  const { mailbox, room } = fixture(t); const { server } = serverFor(t, mailbox);
  await server.callTool('chat_join', { room: room.id, name: 'reader' });
  fs.writeFileSync(path.join(mailbox.roomPath(room), 'peers', 'crashed.json'), JSON.stringify({ name: 'crashed', pid: 999999999, sessionId: 'crashed', lastSeen: new Date().toISOString() }));
  const started = Date.now();
  assert.match(await server.callTool('chat_read', { wait_seconds: 2 }), /No active peers/);
  assert.ok(Date.now() - started < 500);
});

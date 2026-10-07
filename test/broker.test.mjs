import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createBroker } from '../lib/broker.mjs';
import { createMailbox } from '../lib/mailbox.mjs';
import { createRemoteSession, remoteRpc, acknowledgeRemoteResponse, heartbeatRemoteSession, closeRemoteSession, resumeRemoteSession, inspectRemoteNotifications, canonicalBrokerUrl, validateRemoteRoom } from '../lib/broker-client.mjs';

async function fixture(t, options = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-broker-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const tokenFile = path.join(base, 'token'); fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const home = path.join(base, 'mailbox');
  const broker = await createBroker({ home, tokenFile, ...options }); t.after(() => broker.close());
  const creds = path.join(base, 'credentials');
  const make = async (name, room = 'shared', extra = {}) => createRemoteSession({ url: broker.url, tokenFile, room, name, client: name, clientCwd: base, sessionDir: creds, ...extra });
  return { base, home, tokenFile, broker, creds, make };
}
let rpcId = 1;
async function call(session, name, args = {}, { ack = true } = {}) {
  const result = await remoteRpc(session, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  if (ack) await acknowledgeRemoteResponse(session, result.receipt);
  return { ...result, response: result.responses[0], text: result.responses[0]?.result?.content?.[0]?.text };
}
async function raw(url, endpoint, token, body, method = 'POST') {
  return fetch(url + endpoint, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('authentication gates all sessions and requires explicit safe rooms', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.broker.url + '/health')).status, 200);
  assert.equal((await raw(f.broker.url, '/v1/sessions', 'wrong', {})).status, 401);
  const master = fs.readFileSync(f.tokenFile, 'utf8');
  for (const room of [undefined, '..', '.', '/tmp/repo', 'bad room']) assert.equal((await raw(f.broker.url, '/v1/sessions', master, { room, client: 'test', clientCwd: f.base })).status, 400);
  assert.equal((await raw(f.broker.url, '/v1/sessions', master, { room: 'shared', client: 'test', clientCwd: f.base, sessionId: crypto.randomUUID() })).status, 400);
  assert.throws(() => canonicalBrokerUrl('http://example.com/path'), /origin/);
  assert.throws(() => canonicalBrokerUrl('http://user:secret@example.com'), /origin/);
  assert.throws(() => validateRemoteRoom('-bad'), /explicit/);
});

test('unique session credentials isolate directed messages and notification inspection', async t => {
  const f = await fixture(t);
  const alice = await f.make('alice'); const bob = await f.make('bob'); const bob2 = await f.make('bob');
  assert.notEqual(alice.sessionId, bob.sessionId); assert.notEqual(alice.sessionToken, bob.sessionToken);
  assert.match((await call(bob2, 'chat_who')).text, /bob-2/);
  await call(alice, 'chat_send', { to: 'bob', text: 'PRIVATE PAYLOAD' });
  const info = await inspectRemoteNotifications({ url: f.broker.url, tokenFile: f.tokenFile, room: 'shared', sessionId: bob.sessionId, sessionDir: f.creds });
  assert.equal(info.messages.length, 1); assert.deepEqual(Object.keys(info.messages[0]), ['id']); assert.equal(info.peer.clientCwd, f.base);
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE PAYLOAD/);
  const unauthorized = await raw(f.broker.url, `/v1/sessions/${bob.sessionId}/notifications`, alice.sessionToken, { room: 'shared' }); assert.equal(unauthorized.status, 401);
  assert.equal((await raw(f.broker.url, `/v1/sessions/${bob.sessionId}/notifications`, fs.readFileSync(f.tokenFile, 'utf8'), { room: 'shared' })).status, 401);
  assert.equal((await raw(f.broker.url, `/v1/sessions/${bob.sessionId}/notifications`, bob.sessionToken, { room: 'other' })).status, 403);
  assert.match((await call(bob, 'chat_read')).text, /PRIVATE PAYLOAD/);
  assert.doesNotMatch((await call(bob2, 'chat_read')).text, /PRIVATE PAYLOAD/);
  assert.equal((await inspectRemoteNotifications({ url: f.broker.url, tokenFile: f.tokenFile, room: 'shared', sessionId: bob.sessionId, sessionDir: f.creds })).messages.length, 0);
  assert.throws(() => createMailbox({ home: f.home }), /belongs to a broker/);
});

test('read cursor commits only after response acknowledgement', async t => {
  const f = await fixture(t); const alice = await f.make('alice'); const bob = await f.make('bob');
  await call(alice, 'chat_send', { to: 'bob', text: 'retain until accepted' });
  const read = await call(bob, 'chat_read', {}, { ack: false }); assert.match(read.text, /retain until accepted/);
  const cursor = path.join(f.home, 'rooms/shared/cursors', `${bob.sessionId}.json`); assert.ok(!fs.existsSync(cursor));
  await assert.rejects(call(bob, 'chat_read'), error => error.status === 409);
  await acknowledgeRemoteResponse(bob, read.receipt);
  assert.ok(fs.existsSync(cursor)); assert.match((await call(bob, 'chat_read')).text, /No new messages/);
});

test('leases expire independently despite a shared live broker PID', async t => {
  const realNow = Date.now;
  let now = realNow();
  // Freeze only the lease clock. HTTP scheduling and request timeouts remain real.
  Date.now = () => now;
  try {
    const f = await fixture(t, { leaseMs: 1000 }); const alice = await f.make('same', 'shared', { resumable: true }); const bob = await f.make('same');
    now += 750; await heartbeatRemoteSession(bob);
    now += 500;
    await assert.rejects(call(alice, 'chat_who'), error => error.status === 410);
    const next = await f.make('same'); assert.match((await call(next, 'chat_who')).text, /"same"/);
    assert.match((await call(bob, 'chat_who')).text, /same-2/);
    assert.equal(f.broker.stats().activeSessions, 2);
    const inspect = { url: f.broker.url, tokenFile: f.tokenFile, room: 'shared', sessionId: alice.sessionId, sessionDir: f.creds };
    await assert.rejects(inspectRemoteNotifications(inspect), error => error.status === 410);
  } finally { Date.now = realNow; }
});

test('broker restart resumes only a proven session and preserves unread cursor', async t => {
  const f = await fixture(t); const alice = await f.make('alice'); const bob = await f.make('bob', 'shared', { resumable: true });
  await call(alice, 'chat_send', { to: 'bob', text: 'already read' }); assert.match((await call(bob, 'chat_read')).text, /already read/);
  await call(alice, 'chat_send', { to: 'bob', text: 'still unread' });
  const port = f.broker.server.address().port; await f.broker.close();
  const broker = await createBroker({ home: f.home, tokenFile: f.tokenFile, port }); t.after(() => broker.close());
  await assert.rejects(resumeRemoteSession({ ...bob, sessionToken: alice.sessionToken }), error => error.status === 401);
  await resumeRemoteSession(bob);
  const result = await call(bob, 'chat_read'); assert.match(result.text, /still unread/); assert.doesNotMatch(result.text, /already read/);
  await assert.rejects(resumeRemoteSession(bob), error => error.status === 409);
});

test('exclusive leadership clears previous same-PID room locks without stealing active leadership', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-broker-lock-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'locks')); fs.writeFileSync(path.join(base, 'locks/shared.lock'), JSON.stringify({ pid: process.pid }));
  const token = 'a'.repeat(64); const broker = await createBroker({ home: base, token }); t.after(() => broker.close());
  assert.ok(!fs.existsSync(path.join(base, 'locks/shared.lock')));
  await assert.rejects(createBroker({ home: base, token }), error => error.status === 409);
});

test('session/body/request bounds and malformed MCP requests remain contained', async t => {
  const f = await fixture(t, { maxSessions: 1 }); const alice = await f.make('alice');
  await assert.rejects(f.make('other'), error => error.status === 429);
  const tooLarge = await raw(f.broker.url, `/v1/sessions/${alice.sessionId}/rpc`, alice.sessionToken, { requestId: crypto.randomUUID(), rpc: 'x'.repeat(300 * 1024) }); assert.equal(tooLarge.status, 413);
  const invalid = await remoteRpc(alice, null); assert.equal(invalid.responses[0].error.code, -32600); await acknowledgeRemoteResponse(alice, invalid.receipt);
  const wrongRoom = await raw(f.broker.url, `/v1/sessions/${alice.sessionId}/rpc`, alice.sessionToken, { requestId: crypto.randomUUID(), rpc: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'chat_join', arguments: { room: 'elsewhere' } } } }); assert.equal(wrongRoom.status, 403);
  assert.match((await call(alice, 'chat_who')).text, /alice/);
});

test('concurrent reads are rejected without corrupting the first read cursor context', async t => {
  const f = await fixture(t); const alice = await f.make('alice'); const bob = await f.make('bob');
  const pending = call(bob, 'chat_read', { wait_seconds: 2 });
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(call(bob, 'chat_read', { wait_seconds: 1 }), error => error.status === 409);
  await call(alice, 'chat_send', { to: 'bob', text: 'wake first read' });
  assert.match((await pending).text, /wake first read/);
  assert.doesNotMatch((await call(bob, 'chat_read')).text, /wake first read/);
});

test('forty waiting sessions leave bounded capacity for another client to send and inspect identity', async t => {
  const f = await fixture(t);
  const sender = await f.make('sender');
  const readers = await Promise.all(Array.from({ length: 40 }, (_, index) => f.make(`reader-${index}`)));
  const waiting = readers.map(session => call(session, 'chat_read', { wait_seconds: 20 }).catch(error => ({ error })));
  const deadline = Date.now() + 10000;
  while (f.broker.stats().pendingRequests < readers.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.broker.stats().pendingRequests, readers.length);
  const stats = f.broker.stats();
  assert.equal(stats.cacheBudget, 128 * 256 * 1024 * 2);
  assert.ok(stats.pendingBytes + stats.pendingRequests * 256 * 1024 <= stats.cacheBudget);
  assert.match((await call(sender, 'chat_who')).text, /sender/);
  await call(sender, 'chat_send', { to: 'all', text: 'concurrent wait capacity' });
  const results = await Promise.all(waiting);
  for (const result of results) { assert.equal(result.error, undefined); assert.match(result.text, /concurrent wait capacity/); }
  assert.equal(f.broker.stats().pendingBytes, 0);
});

test('capacity rejection is definite only for a fresh transport ID, not a potentially completed retry', async t => {
  const f = await fixture(t); const sender = await f.make('sender'); const recipient = await f.make('recipient');
  const requestId = crypto.randomUUID();
  const rpc = { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'chat_send', arguments: { to: 'recipient', text: 'completed before retry' } } };
  const completed = await remoteRpc(sender, rpc, { requestId }); await acknowledgeRemoteResponse(sender, completed.receipt);
  const pending = [];
  for (let index = 0; index < 8; index++) pending.push(await call(sender, 'chat_who', {}, { ack: false }));
  await assert.rejects(remoteRpc(sender, { ...rpc, id: rpcId++, params: { ...rpc.params, arguments: { to: 'recipient', text: 'rejected before send' } } }),
    error => error.status === 429 && error.definitelyNotExecuted === true);
  await assert.rejects(remoteRpc(sender, rpc, { requestId }), error => error.status === 429
    && error.rejectedBeforeExecution === true && error.definitelyNotExecuted === false);
  const unread = (await call(recipient, 'chat_read')).text;
  assert.match(unread, /completed before retry/); assert.doesNotMatch(unread, /rejected before send/);
  for (const result of pending) await acknowledgeRemoteResponse(sender, result.receipt);
});

async function proxy(t, f, extra = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../agent-chat.mjs', import.meta.url))], { env: { ...process.env, AGENT_CHAT_BROKER_URL: f.broker.url, AGENT_CHAT_BROKER_TOKEN_FILE: f.tokenFile, AGENT_CHAT_ROOM: 'shared', AGENT_CHAT_BROKER_SESSION_DIR: f.creds, ...extra }, cwd: f.base, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let buffer = ''; const waiting = new Map(); const responses = []; let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk); child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, end)); responses.push(response); buffer = buffer.slice(end + 1); waiting.get(response.id)?.(response); waiting.delete(response.id); } });
  const send = rpc => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Proxy timed out: ${stderr}`)), 5000); waiting.set(rpc.id, value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify(rpc) + '\n'); });
  return { child, send, responses, stderr: () => stderr };
}

test('stdio adapter forwards independent MCP sessions and never prints credentials', async t => {
  const f = await fixture(t); const p = await proxy(t, f, { AGENT_CHAT_NAME: 'proxy' });
  const who = await p.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_who' } });
  const identity = who.result.structuredContent.agentChatIdentity;
  assert.equal(identity.transport, 'broker'); assert.equal(identity.brokerUrl, f.broker.url); assert.equal(identity.clientCwd, f.base);
  assert.doesNotMatch(JSON.stringify(who), /sessionToken|bootstrapHash/);
  p.child.stdin.end(); await once(p.child, 'exit'); assert.equal(f.broker.stats().activeSessions, 0);
});

test('stdio adapter distinguishes definite capacity refusal from uncertain connection failures', async t => {
  const f = await fixture(t); const p = await proxy(t, f, { AGENT_CHAT_NAME: 'proxy' });
  const who = await p.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_who' } });
  const id = who.result.structuredContent.agentChatIdentity.sessionId;
  const session = JSON.parse(fs.readFileSync(path.join(f.creds, `${id}.json`), 'utf8'));
  const deadline = Date.now() + 10000;
  while ((f.broker.stats().pendingBytes || f.broker.stats().pendingRequests) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.broker.stats().pendingBytes, 0); assert.equal(f.broker.stats().pendingRequests, 0);
  const pending = [];
  for (let index = 0; index < 8; index++) pending.push(await call(session, 'chat_who', {}, { ack: false }));
  const rejected = await p.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_send', arguments: { text: 'must not execute' } } });
  assert.equal(rejected.error.code, -32001);
  assert.deepEqual(rejected.error.data, { retryable: true, execution: 'not-started' });
  assert.match(rejected.error.message, /rejected before execution/); assert.doesNotMatch(rejected.error.message, /may have completed/);
  for (const result of pending) await acknowledgeRemoteResponse(session, result.receipt);
  await f.broker.close();
  const uncertain = await p.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'chat_who' } });
  assert.equal(uncertain.error.code, -32000); assert.match(uncertain.error.message, /may have completed/);
  p.child.stdin.end(); await once(p.child, 'exit');
});

function loseRpcResponses(t, broker, shouldDrop) {
  const requests = [];
  const intercept = (req, res) => {
    if (!req.url.endsWith('/rpc')) return;
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { requests.push(JSON.parse(body)); });
    const end = res.end;
    res.end = function(data, ...args) {
      const result = JSON.parse(String(data));
      if (shouldDrop(result)) { res.socket.destroy(); return res; }
      return end.call(this, data, ...args);
    };
  };
  broker.server.prependListener('request', intercept);
  t.after(() => broker.server.removeListener('request', intercept));
  return requests;
}

test('stdio proxy recovers lost cached reads and sends with the same transport ID', async t => {
  const f = await fixture(t); const sender = await f.make('sender');
  const p = await proxy(t, f, { AGENT_CHAT_NAME: 'proxy' });
  const who = await p.send({ jsonrpc: '2.0', id: 100001, method: 'tools/call', params: { name: 'chat_who' } });
  await call(sender, 'chat_send', { to: 'proxy', text: 'recover cached read' });
  const dropOnce = new Set([100002, 100004]);
  const requests = loseRpcResponses(t, f.broker, result => dropOnce.delete(result.responses?.[0]?.id));
  const read = await p.send({ jsonrpc: '2.0', id: 100002, method: 'tools/call', params: { name: 'chat_read' } });
  assert.match(read.result.content[0].text, /recover cached read/);
  const next = await p.send({ jsonrpc: '2.0', id: 100003, method: 'tools/call', params: { name: 'chat_read' } });
  assert.match(next.result.content[0].text, /No new messages/);
  const sent = await p.send({ jsonrpc: '2.0', id: 100004, method: 'tools/call', params: { name: 'chat_send', arguments: { to: 'sender', text: 'send exactly once' } } });
  assert.match(sent.result.content[0].text, /Sent/);
  const received = await call(sender, 'chat_read'); assert.equal(received.text.match(/send exactly once/g)?.length, 1);
  for (const id of [100002, 100004]) {
    const attempts = requests.filter(request => request.rpc.id === id);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(p.responses.filter(response => response.id === id).length, 1);
  }
  assert.equal(dropOnce.size, 0);
  const sessionId = who.result.structuredContent.agentChatIdentity.sessionId;
  const cursor = JSON.parse(fs.readFileSync(path.join(f.home, 'rooms/shared/cursors', `${sessionId}.json`), 'utf8'));
  assert.ok(cursor.offset > 0);
  p.child.stdin.end(); await once(p.child, 'exit'); assert.equal(f.broker.stats().pendingBytes, 0);
});

test('stdio proxy preserves uncertainty after both cached response deliveries are lost', async t => {
  const f = await fixture(t); const recipient = await f.make('recipient'); const p = await proxy(t, f, { AGENT_CHAT_NAME: 'proxy' });
  await p.send({ jsonrpc: '2.0', id: 200001, method: 'tools/call', params: { name: 'chat_who' } });
  const requests = loseRpcResponses(t, f.broker, result => result.responses?.[0]?.id === 200002);
  const response = await p.send({ jsonrpc: '2.0', id: 200002, method: 'tools/call', params: { name: 'chat_send', arguments: { to: 'recipient', text: 'uncertain but only once' } } });
  assert.equal(response.error.code, -32000); assert.match(response.error.message, /may have completed/);
  assert.equal(p.responses.filter(value => value.id === 200002).length, 1);
  const attempts = requests.filter(request => request.rpc.id === 200002);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal((await call(recipient, 'chat_read')).text.match(/uncertain but only once/g)?.length, 1);
  p.child.stdin.end(); await once(p.child, 'exit'); assert.equal(f.broker.stats().pendingBytes, 0);
});

test('RPC retry keeps an ambiguous earlier execution uncertain when recovery is refused', async t => {
  const f = await fixture(t); const sender = await f.make('sender');
  const fetch = globalThis.fetch; const attempts = [];
  globalThis.fetch = async (url, options) => {
    const value = JSON.parse(options.body); attempts.push(value);
    if (attempts.length === 1) {
      const completed = await fetch(url, options); await completed.text();
      throw new TypeError('lost first response after execution');
    }
    return new Response(JSON.stringify({ execution: 'not-started', requestId: value.requestId }), { status: 429 });
  };
  try {
    await assert.rejects(remoteRpc(sender, { jsonrpc: '2.0', id: 300001, method: 'tools/call', params: { name: 'chat_send', arguments: { text: 'completed before refused recovery' } } }),
      error => error.status === 429 && error.rejectedBeforeExecution === true && error.definitelyNotExecuted === false);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  } finally { globalThis.fetch = fetch; }
  const messages = fs.readFileSync(path.join(f.home, 'rooms/shared/messages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.filter(message => message.text === 'completed before refused recovery').length, 1);
});

test('RPC transport retries stop on cancellation and never retry an HTTP rejection', async t => {
  const f = await fixture(t); const sender = await f.make('sender');
  const fetch = globalThis.fetch; const controller = new AbortController(); let attempts = 0;
  globalThis.fetch = async () => { attempts++; controller.abort(); throw new TypeError('cancelled transport'); };
  try {
    await assert.rejects(remoteRpc(sender, { jsonrpc: '2.0', id: 400001, method: 'ping' }, { signal: controller.signal }), /cancelled transport/);
    assert.equal(attempts, 1);
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response('{}', { status: 403 }); };
    await assert.rejects(remoteRpc(sender, { jsonrpc: '2.0', id: 400002, method: 'ping' }), error => error.status === 403);
    assert.equal(attempts, 1);
    attempts = 0;
    globalThis.fetch = async () => { attempts++; return new Response(new ReadableStream({ start(stream) { stream.error(new TypeError('refusal body disconnected')); } }), { status: 403 }); };
    await assert.rejects(remoteRpc(sender, { jsonrpc: '2.0', id: 400003, method: 'ping' }), error => error.status === 403);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = fetch; }
});

test('a timed-out response can recover the same cached result without changing RPC payload or reused-ID rules', async t => {
  const f = await fixture(t); const sender = await f.make('sender');
  const fetch = globalThis.fetch; const attempts = []; const requestId = crypto.randomUUID();
  const rpc = { jsonrpc: '2.0', id: 500001, method: 'tools/call', params: { name: 'chat_send', arguments: { text: 'original payload' } } };
  globalThis.fetch = async (url, options) => {
    attempts.push(JSON.parse(options.body));
    const response = await fetch(url, options);
    if (attempts.length === 1) { await response.text(); rpc.params.arguments.text = 'mutated payload'; throw new DOMException('response timed out', 'TimeoutError'); }
    return response;
  };
  let recovered;
  try {
    recovered = await remoteRpc(sender, rpc, { requestId });
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  } finally { globalThis.fetch = fetch; }
  assert.match(recovered.responses[0].result.content[0].text, /Sent/);
  await assert.rejects(remoteRpc(sender, rpc, { requestId }), error => error.status === 409 && error.definitelyNotExecuted === false);
  await acknowledgeRemoteResponse(sender, recovered.receipt);
  const messages = fs.readFileSync(path.join(f.home, 'rooms/shared/messages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(messages.map(message => message.text), ['original payload']);
});

test('explicit private session file resumes across adapter restart and rejects sharing', async t => {
  const f = await fixture(t); const sessionFile = path.join(f.base, 'adapter-session.json');
  const p = await proxy(t, f, { AGENT_CHAT_BROKER_SESSION_FILE: sessionFile, AGENT_CHAT_NAME: 'persistent' });
  const who = await p.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chat_who' } }); const id = who.result.structuredContent.agentChatIdentity.sessionId;
  await assert.rejects(createRemoteSession({ url: f.broker.url, tokenFile: f.tokenFile, room: 'shared', clientCwd: f.base, sessionFile, sessionDir: f.creds }), error => error.status === 409);
  p.child.stdin.end(); await once(p.child, 'exit');
  const resumed = await proxy(t, f, { AGENT_CHAT_BROKER_SESSION_FILE: sessionFile, AGENT_CHAT_NAME: 'persistent' });
  const next = await resumed.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_who' } }); assert.equal(next.result.structuredContent.agentChatIdentity.sessionId, id);
  resumed.child.stdin.end(); await once(resumed.child, 'exit');
});


test('invalid credential targets allocate no session and ephemeral sessions do not exhaust retained storage', async t => {
  const f = await fixture(t, { maxSessions: 1, maxStoredSessions: 1 });
  await assert.rejects(f.make('bad', 'shared', { sessionFile: 'relative.json' }), /absolute/);
  await assert.rejects(f.make('bad', 'shared', { sessionDir: 'relative' }), /absolute/);
  assert.equal(f.broker.stats().activeSessions, 0);
  await assert.rejects(f.make('all', 'shared', { resumable: true }), error => error.status === 400);
  assert.equal(fs.readdirSync(path.join(f.home, '.broker-sessions')).length, 0);
  for (let i = 0; i < 3; i++) {
    const session = await f.make('ephemeral');
    await closeRemoteSession(session);
    assert.equal(fs.readdirSync(path.join(f.home, '.broker-sessions')).length, 0);
    assert.equal(fs.readdirSync(f.creds).length, 0);
  }
});

test('simultaneous first creation of a private session file admits only one adapter', async t => {
  const f = await fixture(t); const sessionFile = path.join(f.base, 'one-session.json');
  const results = await Promise.allSettled([f.make('one', 'shared', { sessionFile }), f.make('two', 'shared', { sessionFile })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected'); assert.equal(rejected.reason.status, 409);
  const session = results.find(result => result.status === 'fulfilled').value;
  assert.equal(f.broker.stats().activeSessions, 1); await closeRemoteSession(session);
  assert.ok(!fs.existsSync(sessionFile + '.lock'));
});

test('failed local credential persistence closes the newly allocated session', async t => {
  const f = await fixture(t); const sessionFile = path.join(f.base, 'unwritable.json');
  const original = fs.renameSync;
  fs.renameSync = function(source, target) { if (target === sessionFile) throw new Error('injected save failure'); return original.call(this, source, target); };
  try { await assert.rejects(f.make('fails', 'shared', { sessionFile }), /injected save failure/); }
  finally { fs.renameSync = original; }
  assert.equal(f.broker.stats().activeSessions, 0);
  assert.ok(!fs.existsSync(sessionFile + '.lock'));
});

test('inactive retained credentials expire after seven days and free bounded descriptor storage', async t => {
  const f = await fixture(t, { maxSessions: 1, maxStoredSessions: 1 });
  const retained = await f.make('retained', 'shared', { resumable: true }); await closeRemoteSession(retained);
  const file = path.join(f.home, '.broker-sessions', retained.sessionId + '.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8')); record.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; fs.writeFileSync(file, JSON.stringify(record));
  const fresh = await f.make('fresh'); assert.notEqual(fresh.sessionId, retained.sessionId);
  await assert.rejects(resumeRemoteSession(retained), error => error.status === 404);
});

test('a broker that loses storage ownership cannot consume a resumed session read or release its peer', async t => {
  const f = await fixture(t); const bob = await f.make('bob', 'shared', { resumable: true }); const alice = await f.make('alice');
  const pending = call(bob, 'chat_read', { wait_seconds: 2 });
  await new Promise(resolve => setTimeout(resolve, 50));
  fs.writeFileSync(path.join(f.home, '.broker-owner.lock'), JSON.stringify({ epoch: 'expired-other-owner', expiresAt: 0 }));
  const successor = await createBroker({ home: f.home, tokenFile: f.tokenFile }); t.after(() => successor.close());
  const resumed = { ...bob, url: successor.url }; await resumeRemoteSession(resumed);
  const sender = await createRemoteSession({ url: successor.url, tokenFile: f.tokenFile, room: 'shared', name: 'new-sender', clientCwd: f.base, sessionDir: f.creds });
  await call(sender, 'chat_send', { to: 'bob', text: 'new owner message' });
  await f.broker.close();
  await pending.catch(() => {});
  assert.match((await call(resumed, 'chat_who')).text, /bob/);
  assert.match((await call(resumed, 'chat_read')).text, /new owner message/);
  assert.equal(successor.stats().activeSessions, 2);
});


test('Linux private launch locks distinguish replacement containers reusing a live PID', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); const sessionFile = path.join(f.base, 'container-session.json');
  fs.writeFileSync(sessionFile + '.lock', JSON.stringify({ pid: process.pid, nonce: 'old', instance: 'pid:[previous-namespace]:0' }));
  const session = await f.make('replacement', 'shared', { sessionFile });
  await closeRemoteSession(session); assert.ok(!fs.existsSync(sessionFile + '.lock'));
});

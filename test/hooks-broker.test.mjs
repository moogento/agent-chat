import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindNotification } from '../hooks/bind.mjs';
import { notifySession, readConfig, runCommandHook } from '../hooks/notifications.mjs';
import { AgentChatPlugin } from '../integrations/opencode/agent-chat.mjs';

function fixture(t, client = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-remote-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = fs.realpathSync(root);
  const configFile = path.join(root, 'notifications.json');
  const binding = { client, hostSessionId: 'host-conversation', cwd, room: 'explicit-team-room',
    mailboxSessionId: 'remote-session', brokerUrl: 'https://broker.example.test' };
  bindNotification({ configFile, binding });
  const env = { AGENT_CHAT_NOTIFY_CONFIG: configFile, AGENT_CHAT_BROKER_URL: binding.brokerUrl,
    AGENT_CHAT_BROKER_TOKEN_FILE: path.join(root, 'bootstrap-token'), AGENT_CHAT_BROKER_SESSION_DIR: path.join(root, 'credentials'),
    AGENT_CHAT_HOME: path.join(root, 'unused-mailbox'), AGENT_CHAT_ROOM: binding.room };
  const calls = [];
  const peer = { sessionId: binding.mailboxSessionId, room: binding.room, name: 'remote-recipient',
    cwd: '/broker-only/worktree', clientCwd: cwd };
  const remoteInspector = async input => {
    calls.push(input);
    return { peer, messages: input.afterOffset === 25 ? [] : [{ id: 'message-one' }], nextOffset: 25, hasMore: false, size: 25 };
  };
  // An accidental local path in remote mode must fail this test.
  const mailbox = new Proxy({}, { get() { assert.fail('broker hook accessed local mailbox'); } });
  const input = { client, hostSessionId: binding.hostSessionId, cwd, env, mailbox, remoteInspector };
  return { root, cwd, configFile, binding, env, calls, peer, remoteInspector, input };
}

test('broker hooks inspect exact session credentials and deduplicate without local mailbox access', async t => {
  const f = fixture(t);
  const notices = [];
  for (let index = 0; index < 3; index++) await notifySession({ ...f.input, deliver: notice => notices.push(notice) });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /1 new message/);
  assert.deepEqual(f.calls[0], { url: f.binding.brokerUrl, tokenFile: f.env.AGENT_CHAT_BROKER_TOKEN_FILE,
    sessionDir: f.env.AGENT_CHAT_BROKER_SESSION_DIR, home: f.env.AGENT_CHAT_HOME, room: f.binding.room,
    sessionId: f.binding.mailboxSessionId, afterOffset: undefined, limit: 10, maxBytes: 64 * 1024 });
  assert.equal(f.calls[1].afterOffset, 25);
  assert.equal(fs.existsSync(f.env.AGENT_CHAT_HOME), false);
  const stateFiles = fs.readdirSync(path.join(f.root, 'notification-state'));
  assert.equal(stateFiles.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, 'notification-state', stateFiles[0]), 'utf8'), /bootstrap-token|remote-recipient/);
});

test('broker configuration requires pinned endpoint, explicit room and token file, with no local fallback', async t => {
  const f = fixture(t);
  const invalid = [
    { ...f.env, AGENT_CHAT_BROKER_URL: 'https://other-broker.example.test' },
    { ...f.env, AGENT_CHAT_BROKER_URL: undefined },
    { ...f.env, AGENT_CHAT_BROKER_TOKEN_FILE: undefined },
    { ...f.env, AGENT_CHAT_ROOM: undefined },
    { ...f.env, AGENT_CHAT_ROOM: 'other-room' },
  ];
  for (const env of invalid) {
    const result = await notifySession({ ...f.input, env, deliver: () => assert.fail('mismatched broker notice') });
    assert.equal(result.delivered, false);
    assert.ok(['unbound', 'broker-mismatch'].includes(result.reason));
  }
  fs.rmSync(f.configFile);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, brokerUrl: undefined } });
  assert.equal((await notifySession({ ...f.input, deliver: () => assert.fail('local binding in broker mode') })).delivered, false);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'notification-state')), false);
});

test('broker responses must match the exact mailbox session, room, and originating client cwd', async t => {
  const f = fixture(t);
  for (const peer of [{ ...f.peer, sessionId: 'another-session' }, { ...f.peer, room: 'another-room' },
    { ...f.peer, clientCwd: undefined }, { ...f.peer, clientCwd: path.dirname(f.cwd) }]) {
    const result = await notifySession({ ...f.input, remoteInspector: async () => ({ peer, messages: [{ id: 'one' }],
      nextOffset: 12, hasMore: false }), deliver: () => assert.fail('wrong remote identity') });
    assert.equal(result.reason, 'wrong-remote-identity');
  }
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'notification-state')), []);
  const result = await notifySession({ ...f.input, deliver: () => {} });
  assert.equal(result.delivered, true);
});

test('failed remote delivery or inspection is retryable and does not expose remote error contents', async t => {
  const f = fixture(t);
  await assert.rejects(notifySession({ ...f.input, deliver: () => { throw new Error('host failure'); } }), /host failure/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'notification-state')), []);
  await assert.rejects(notifySession({ ...f.input, remoteInspector: () => { throw new Error('secret-session-token'); },
    deliver: () => assert.fail('failed remote request') }), error => /Broker notification inspection failed/.test(error.message)
      && !error.message.includes('secret-session-token'));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'notification-state')), []);
  assert.equal((await notifySession({ ...f.input, deliver: () => {} })).delivered, true);
});

test('broker notification response and dedupe storage remain bounded', async t => {
  const f = fixture(t);
  const base = { peer: f.peer, messages: [{ id: 'valid' }], nextOffset: 12, hasMore: false };
  for (const response of [{ ...base, messages: Array.from({ length: 11 }, (_, index) => ({ id: String(index) })) },
    { ...base, messages: [{ id: 'x'.repeat(129) }] }, { ...base, messages: [{ id: '\n'.repeat(128) }] },
    { ...base, nextOffset: -1 }, { ...base, hasMore: 'true' }]) {
    await assert.rejects(notifySession({ ...f.input, remoteInspector: async () => response,
      deliver: () => assert.fail('invalid remote response') }), /invalid bounded notification response/);
  }
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'notification-state')), []);
});

for (const client of ['codex', 'claude-code']) {
  test(`${client} auto-binding verifies broker metadata using the local session credential`, async t => {
    const f = fixture(t, client);
    fs.rmSync(f.configFile);
    const tool = 'mcp__agent_chat__chat_who';
    const env = { ...f.env, AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: tool };
    const metadata = { version: 1, sessionId: f.binding.mailboxSessionId, transport: 'broker',
      brokerUrl: f.binding.brokerUrl, cwd: '/broker-only/worktree', clientCwd: f.cwd, room: f.binding.room, name: f.peer.name };
    const payload = { session_id: f.binding.hostSessionId, cwd: f.cwd, hook_event_name: 'PostToolUse',
      tool_name: tool, tool_response: { structuredContent: { agentChatIdentity: metadata } } };
    const notices = [];
    await runCommandHook({ ...f.input, payload, env, write: value => notices.push(value) });
    assert.equal(readConfig(f.configFile).bindings[0].brokerUrl, f.binding.brokerUrl);
    assert.equal(notices.length, 1);
    assert.match(JSON.parse(notices[0]).hookSpecificOutput.additionalContext, /1 new message/);
    assert.equal(fs.existsSync(f.env.AGENT_CHAT_HOME), false);
  });
}

test('remote auto-binding rejects local metadata, forged worktree, room, endpoint and missing session credential', async t => {
  const f = fixture(t);
  fs.rmSync(f.configFile);
  const tool = 'mcp__agent_chat__chat_join';
  const env = { ...f.env, AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: tool };
  const base = { version: 1, sessionId: f.binding.mailboxSessionId, transport: 'broker', brokerUrl: f.binding.brokerUrl,
    clientCwd: f.cwd, cwd: f.cwd, room: f.binding.room, name: f.peer.name };
  for (const metadata of [{ ...base, transport: undefined }, { ...base, clientCwd: undefined },
    { ...base, clientCwd: path.dirname(f.cwd) }, { ...base, room: 'other-room' }, { ...base, brokerUrl: 'https://other.test' }]) {
    const payload = { session_id: f.binding.hostSessionId, cwd: f.cwd, hook_event_name: 'PostToolUse', tool_name: tool,
      tool_response: { structuredContent: { agentChatIdentity: metadata } } };
    assert.equal((await runCommandHook({ ...f.input, env, payload, write: () => assert.fail('invalid auto-bind') })).reason, 'unbound');
    assert.equal(fs.existsSync(f.configFile), false);
  }
  const payload = { session_id: f.binding.hostSessionId, cwd: f.cwd, hook_event_name: 'PostToolUse', tool_name: tool,
    tool_response: { structuredContent: { agentChatIdentity: base } } };
  await assert.rejects(runCommandHook({ ...f.input, env, payload, remoteInspector: () => { throw new Error('no credential'); } }), /Broker notification inspection failed/);
  assert.equal(fs.existsSync(f.configFile), false);
});

test('OpenCode broker context and idle toast retain separate dedupe without starting turns', async t => {
  const f = fixture(t, 'opencode');
  const calls = [];
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: { tui: { showToast: async value => { calls.push(value); return { data: true }; } },
    session: { prompt() { assert.fail('must not start a turn'); } } } }, { env: f.env, remoteInspector: f.remoteInspector, mailbox: f.input.mailbox });
  const output = { output: 'original output', metadata: { retained: true } };
  await plugin['tool.execute.after']({ sessionID: f.binding.hostSessionId }, output);
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: f.binding.hostSessionId } } });
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: f.binding.hostSessionId } } });
  assert.match(output.output, /^original output\n\n\[💬 Agent Chat: 1 new message/);
  assert.deepEqual(output.metadata, { retained: true });
  assert.equal(calls.length, 1);
  assert.equal(fs.readdirSync(path.join(f.root, 'notification-state')).length, 2);
});

test('manual bind helper pins normalized broker endpoint without credentials', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.resolve('hooks/bind.mjs'), '--config', f.configFile, '--client', 'codex',
    '--host-session', f.binding.hostSessionId, '--cwd', f.cwd, '--room', f.binding.room, '--session', f.binding.mailboxSessionId,
    '--broker-url', `${f.binding.brokerUrl}/`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readConfig(f.configFile).bindings[0].brokerUrl, f.binding.brokerUrl);
  for (const brokerUrl of ['https://token@broker.test', 'https://broker.test?token=secret', 'https://broker.test/path', 'file:///tmp/broker']) {
    assert.throws(() => bindNotification({ configFile: f.configFile, binding: { ...f.binding, brokerUrl } }), /brokerUrl/);
  }
});

test('additional broker bindings trim oldest history to keep the notification configuration readable', t => {
  const f = fixture(t);
  const bindings = [];
  const added = { ...f.binding, hostSessionId: 'new-host' };
  const serializedAfter = () => JSON.stringify({ version: 1, bindings: [...bindings, added] }, null, 2) + '\n';
  // Derive the boundary from actual bytes, including platform-specific cwd length.
  while (Buffer.byteLength(serializedAfter()) <= 64 * 1024 && bindings.length < 99) {
    bindings.push({ ...f.binding, hostSessionId: `${bindings.length}-${'h'.repeat(250)}`,
      room: 'r'.repeat(128), mailboxSessionId: 's'.repeat(128) });
  }
  const before = JSON.stringify({ version: 1, bindings });
  assert.ok(Buffer.byteLength(before) <= 64 * 1024);
  assert.ok(Buffer.byteLength(serializedAfter()) > 64 * 1024);
  fs.writeFileSync(f.configFile, before);
  bindNotification({ configFile: f.configFile, binding: added });
  assert.ok(fs.statSync(f.configFile).size <= 64 * 1024);
  const retained = readConfig(f.configFile).bindings;
  assert.equal(retained.at(-1).hostSessionId, added.hostSessionId);
  assert.ok(retained.length < bindings.length + 1);
  assert.equal(retained.some(binding => binding.hostSessionId === bindings[0].hostSessionId), false);
  assert.equal(fs.existsSync(`${f.configFile}.lock`), false);
});

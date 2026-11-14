import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailbox } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';
import { autoBindCommand, findConversationBinding } from '../hooks/notifications.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { guardDecision } from '../lib/guards.mjs';

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

async function fixture(t, { bind = true } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-guard-conversation-')));
  const cwd = path.join(base, 'project');
  const commandCwd = path.join(base, 'executor');
  const home = path.join(base, 'mailbox');
  fs.mkdirSync(cwd);
  fs.mkdirSync(commandCwd);
  const guard = (dir, lock = 'publish') => writeJson(path.join(dir, '.agent-chat-guards.json'), {
    version: 1, guards: [{ lock, pattern: '^publish$' }],
  });
  guard(cwd);
  guard(commandCwd);
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('guard-conversation');
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: path.join(home, 'notifications.json'),
    AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: 'mcp__agent_chat__chat_who' };
  const responses = [];
  const server = createServer({ mailbox, sessionId: 'original', roomSpec: room.id,
    output: value => responses.push(value) });
  t.after(() => { server.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { clientInfo: { name: 'codex-desktop' } } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_who', arguments: {} } });
  if (bind) {
    assert.equal(await autoBindCommand({ client: 'codex', env, mailbox, payload: {
      hook_event_name: 'PostToolUse', session_id: 'host-root', cwd,
      tool_name: 'mcp__agent_chat__chat_who', tool_response: responses.at(-1).result,
    } }), true);
  }
  const identity = server.state.identity;
  const context = { client: 'codex', hostSessionId: 'host-root', cwd, room, sessionId: identity.sessionId };
  const hold = (owner = identity, lock = 'publish') => mailbox.acquireResource(owner, lock, 'private test');
  const decide = (extra = {}, extraEnv = {}) => guardDecision({ client: 'codex', env: { ...env, ...extraEnv }, mailbox,
    payload: { hook_event_name: 'PreToolUse', session_id: 'host-root', cwd: commandCwd,
      tool_name: 'Bash', tool_input: { command: 'publish' }, ...extra } });
  const binding = () => readJson(env.AGENT_CHAT_NOTIFY_CONFIG).bindings[0];
  const changeBinding = update => {
    const config = readJson(env.AGENT_CHAT_NOTIFY_CONFIG);
    config.bindings[0] = { ...config.bindings[0], ...update };
    writeJson(env.AGENT_CHAT_NOTIFY_CONFIG, config);
  };
  const peerFile = path.join(mailbox.roomPath(room), 'peers', `${identity.name}.json`);
  const changePeer = update => writeJson(peerFile, { ...readJson(peerFile), ...update });
  return { base, cwd, commandCwd, home, env, mailbox, room, identity, context, server,
    guard, hold, decide, binding, changeBinding, changePeer };
}

test('a verified Codex conversation keeps its own lock across native shell working directories', async t => {
  const f = await fixture(t);
  f.hold();
  assert.equal(f.mailbox.matchesConversation(f.context), true);
  assert.equal(findConversationBinding({ client: 'codex', hostSessionId: 'host-root', env: f.env })
    .mailboxSessionId, f.identity.sessionId);
  assert.deepEqual(await f.decide(), { allow: true, locks: ['publish'] });
  assert.deepEqual(await f.decide({ tool_name: 'exec_command', tool_input: { cmd: 'publish' } }),
    { allow: true, locks: ['publish'] });
});

test('a changed shell project still supplies its own guard requirements', async t => {
  const f = await fixture(t);
  f.guard(f.commandCwd, 'executor-publish');
  f.hold();
  assert.equal((await f.decide()).allow, false);
  f.hold(f.identity, 'executor-publish');
  assert.deepEqual(await f.decide(), { allow: true, locks: ['executor-publish'] });
});

test('a different host or missing notification binding cannot borrow the held lock', async t => {
  const f = await fixture(t);
  f.hold();
  assert.equal((await f.decide({ session_id: 'different-host' })).allow, false);
  writeJson(f.env.AGENT_CHAT_NOTIFY_CONFIG, { version: 1, bindings: [] });
  assert.equal((await f.decide()).allow, false);
});

test('an unbound MCP peer with a manually written notification binding cannot cross directories', async t => {
  const f = await fixture(t, { bind: false });
  bindNotification({ configFile: f.env.AGENT_CHAT_NOTIFY_CONFIG, binding: {
    client: 'codex', hostSessionId: 'host-root', cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.identity.sessionId,
  } });
  f.hold();
  assert.equal(f.mailbox.matchesConversation(f.context), false);
  assert.equal((await f.decide()).allow, false);
});

test('ambiguous bindings for one host are not resolved by choosing the lock holder', async t => {
  const f = await fixture(t);
  f.hold();
  const third = path.join(f.base, 'third');
  fs.mkdirSync(third);
  const config = readJson(f.env.AGENT_CHAT_NOTIFY_CONFIG);
  config.bindings.push({ ...config.bindings[0], cwd: third });
  writeJson(f.env.AGENT_CHAT_NOTIFY_CONFIG, config);
  assert.equal(findConversationBinding({ client: 'codex', hostSessionId: 'host-root', env: f.env }), null);
  assert.equal((await f.decide()).allow, false);
});

test('a binding cannot point to another room that happens to reuse the session identifier', async t => {
  const f = await fixture(t);
  f.hold();
  const otherRoom = f.mailbox.resolveRoom('other-room');
  f.mailbox.claimIdentity(otherRoom, 'other-peer', 'codex-desktop', f.identity.sessionId);
  f.changeBinding({ room: otherRoom.id });
  assert.equal(f.mailbox.matchesConversation({ ...f.context, room: otherRoom }), false);
  assert.equal((await f.decide()).allow, false);
});

test('a changed durable route cannot authorize the former session', async t => {
  const f = await fixture(t);
  f.hold();
  const dir = path.join(f.mailbox.roomPath(f.room), 'conversations');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  writeJson(path.join(dir, files[0]), { version: 1, sessionId: 'replacement-owner' });
  assert.equal(f.mailbox.matchesConversation(f.context), false);
  assert.equal((await f.decide()).allow, false);
});

for (const [label, update] of [['client', { client: 'claude-code' }], ['directory', null], ['liveness', { pid: null }]]) {
  test(`a peer with mismatched ${label} cannot authorize the fallback`, async t => {
    const f = await fixture(t);
    f.hold();
    f.changePeer(update ?? { cwd: f.commandCwd });
    assert.equal(f.mailbox.matchesConversation(f.context), false);
    assert.equal((await f.decide()).allow, false);
  });
}

test('a stale provisional redirect is not accepted as the durable owner', async t => {
  const f = await fixture(t);
  f.hold();
  const identityDir = path.join(f.mailbox.roomPath(f.room), 'identities');
  const record = readJson(path.join(identityDir, `${f.identity.sessionId}.json`));
  writeJson(path.join(identityDir, 'provisional.json'), { ...record, sessionId: 'provisional',
    redirectTo: f.identity.sessionId });
  f.changeBinding({ mailboxSessionId: 'provisional' });
  assert.equal(f.mailbox.matchesConversation({ ...f.context, sessionId: 'provisional' }), false);
  assert.equal((await f.decide()).allow, false);
});

test('replacement symlinks cannot redirect the verified conversation directory', async t => {
  const f = await fixture(t);
  f.hold();
  const old = path.join(f.base, 'original-project');
  const replacement = path.join(f.base, 'replacement-project');
  fs.renameSync(f.cwd, old);
  fs.mkdirSync(replacement);
  fs.symlinkSync(replacement, f.cwd, 'dir');
  assert.equal(f.mailbox.matchesConversation(f.context), false);
  assert.equal((await f.decide()).allow, false);
});

test('subagents cannot inherit the parent lock or use their own lock through the parent binding', async t => {
  const f = await fixture(t);
  f.hold();
  for (const cwd of [f.cwd, f.commandCwd]) {
    const decision = await f.decide({ agent_id: 'child', cwd });
    assert.equal(decision.allow, false);
    assert.match(decision.reason, /subagent|child/i);
  }
  const broker = await f.decide({ agent_id: 'child' }, { AGENT_CHAT_BROKER_URL: 'http://127.0.0.1:1' });
  assert.equal(broker.allow, false);
  assert.match(broker.reason, /subagent|child/i);
  f.mailbox.releaseResource(f.identity, 'publish');
  const child = f.mailbox.claimIdentity(f.room, 'child-peer', 'codex-desktop', 'child-mailbox');
  f.hold(child);
  const decision = await f.decide({ agent_id: 'child' });
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /subagent|child/i);
});

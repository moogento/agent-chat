import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailbox } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';
import { autoBindCommand, findBinding, notifySession, runCommandHook, waitForReplyAtStop } from '../hooks/notifications.mjs';

function fixture(t) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-conversation-')));
  const home = path.join(cwd, 'mailbox');
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('conversation');
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: path.join(cwd, 'notifications.json'),
    AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: 'mcp__agent-chat__chat_who' };
  const servers = [];
  t.after(() => { for (const server of servers) server.stop(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const connect = async (id, client = 'codex-cli') => {
    const responses = [];
    const server = createServer({ mailbox, sessionId: id, roomSpec: room.id, nameSpec: 'Review code and plugin options',
      output: value => responses.push(value) });
    servers.push(server);
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: client } } });
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat_who', arguments: {} } });
    return { server, response: responses.at(-1).result };
  };
  const bind = (connection, hostSessionId = 'same-host-conversation') => autoBindCommand({ client: 'codex',
    payload: { hook_event_name: 'PostToolUse', session_id: hostSessionId, cwd,
      tool_name: 'mcp__agent-chat__chat_who', tool_response: connection.response }, env, mailbox });
  return { cwd, home, mailbox, room, env, connect, bind };
}

test('verified terminal to desktop reconnect preserves inbox, cursor, watch, profile and lock expiry', async t => {
  const f = fixture(t);
  const first = await f.connect('original');
  assert.equal(await f.bind(first), true);
  const original = first.server.state.identity;
  const peer = f.mailbox.claimIdentity(f.room, 'claude-project-peer', 'claude-code', 'peer');
  f.mailbox.appendMessage(f.room, peer.name, original.name, 'already read', peer.sessionId);
  await first.server.callTool('chat_read');
  await first.server.callTool('chat_status', { task: 'Reviewing code', availability: 'busy' });
  await first.server.callTool('chat_send', { to: peer.name, text: 'Please review', await_reply_minutes: 10 });
  const watchId = f.mailbox.replyWaitStatus(original).watchId;
  const { record: lock } = f.mailbox.acquireResource(original, 'runtime-install', 'installing', 2);
  first.server.stop();
  assert.equal(f.mailbox.isPeerAlive(f.mailbox.getIdentity(original)), false);
  await runCommandHook({ client: 'codex', payload: { session_id: 'same-host-conversation', cwd: f.cwd,
    hook_event_name: 'SessionEnd' }, env: f.env, mailbox: f.mailbox, write: () => {} });
  assert.equal(f.mailbox.replyWaitStatus(original).watchId, watchId);
  f.mailbox.appendMessage(f.room, peer.name, original.name, 'offline reply', peer.sessionId);
  const replacement = await f.connect('temporary', 'codex-desktop');
  const temporary = replacement.server.state.identity;
  f.mailbox.appendMessage(f.room, peer.name, temporary.name, 'during handshake', peer.sessionId);
  assert.equal(await f.bind(replacement), true);
  assert.match(await replacement.server.callTool('chat_who'), /Session: original/);
  const resumed = replacement.server.state.identity;
  assert.equal(resumed.name, original.name);
  assert.equal(resumed.task, 'Reviewing code');
  assert.equal(resumed.availability, 'busy');
  assert.equal(f.mailbox.replyWaitStatus(resumed).watchId, watchId);
  assert.equal(f.mailbox.replyWaitStatus(resumed).state, 'replied');
  assert.equal(f.mailbox.heldLock('runtime-install').expiresAt, lock.expiresAt);
  assert.throws(() => f.mailbox.acquireResource(peer, 'runtime-install', 'competing'), /Not locked/);
  const unread = f.mailbox.takeUnread(resumed).messages.map(message => message.text);
  assert.ok(unread.includes('offline reply'));
  assert.ok(unread.includes('during handshake'));
  assert.ok(!unread.includes('already read'));
  assert.equal(f.mailbox.replyWaitStatus(resumed).state, 'none');
  assert.equal(f.mailbox.resolveRecipient(f.room, 'temporary').sessionId, original.sessionId);
  assert.equal(f.mailbox.resolveRecipient(f.room, temporary.name).sessionId, original.sessionId);
  assert.equal(findBinding({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd, env: f.env }).mailboxSessionId, original.sessionId);
  f.mailbox.releaseResource(resumed, 'runtime-install');
});

test('a live owner refuses competing reconnects without changing either inbox', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const duplicate = await f.connect('duplicate', 'codex-desktop');
  await assert.rejects(f.bind(duplicate), /already connected/);
  assert.equal(first.server.state.identity.sessionId, 'first');
  assert.equal(duplicate.server.state.identity.sessionId, 'duplicate');
  assert.match(await first.server.callTool('chat_who'), /Session: first/);
});

test('titles and folders never combine distinct conversations, clients or rooms', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const second = await f.connect('second');
  await f.bind(second, 'different-host-conversation');
  assert.equal(second.server.state.identity.sessionId, 'second');
  const claude = f.mailbox.claimIdentity(f.room, 'claude-project-title', 'claude-code', 'claude');
  assert.equal(f.mailbox.bindConversation({ client: 'claude-code', hostSessionId: 'same-host-conversation', cwd: f.cwd,
    room: f.room, sessionId: claude.sessionId }).sessionId, 'claude');
  assert.throws(() => f.mailbox.bindConversation({ client: 'codex', hostSessionId: 'other', cwd: f.cwd,
    room: f.room, sessionId: claude.sessionId }), /verified connection/);
  const otherRoom = f.mailbox.resolveRoom('another-room');
  const other = f.mailbox.claimIdentity(otherRoom, 'codex-project-title', 'codex', 'other-room');
  assert.equal(f.mailbox.bindConversation({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd,
    room: otherRoom, sessionId: other.sessionId }).sessionId, 'other-room');
});

test('crash recovery fences late cleanup and retains durable state through idle pruning', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const old = first.server.state.identity;
  const peerFile = path.join(f.mailbox.roomDir(f.room), 'peers', `${old.name}.json`);
  const stored = JSON.parse(fs.readFileSync(peerFile));
  fs.writeFileSync(peerFile, JSON.stringify({ ...stored, pid: null, lastSeen: '2000-01-01T00:00:00Z' }));
  f.mailbox.tidyRooms({ force: true, ttlDays: 0 });
  assert.ok(fs.existsSync(peerFile));
  const second = await f.connect('second');
  await f.bind(second);
  await second.server.callTool('chat_who');
  const resumed = second.server.state.identity;
  assert.notEqual(resumed.ownerId, old.ownerId);
  assert.equal(f.mailbox.touchPeer(old), false);
  assert.equal(f.mailbox.updatePeer(old, { task: 'stale update' }), false);
  first.server.stop();
  assert.equal(f.mailbox.getIdentity(resumed).ownerId, resumed.ownerId);
  const { record } = f.mailbox.acquireResource(resumed, 'expires', 'bounded', 1);
  const lockFile = path.join(f.home, 'resource-locks', 'expires.json');
  fs.writeFileSync(lockFile, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
  second.server.stop();
  assert.equal(f.mailbox.heldLock('expires'), null);
});

test('reconnect refuses to merge a provisional connection that already consumed mail or sent work', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  first.server.stop();
  const second = await f.connect('second');
  await second.server.callTool('chat_read');
  await assert.rejects(f.bind(second), /before starting new mailbox work/);
  const third = await f.connect('third');
  await third.server.callTool('chat_send', { text: 'already working' });
  await assert.rejects(f.bind(third), /before starting new mailbox work/);
});

test('an existing exact host binding seeds durable identity during an upgrade', async t => {
  const f = fixture(t);
  const first = await f.connect('legacy-original');
  const old = first.server.state.identity;
  const { bindNotification } = await import('../hooks/bind.mjs');
  bindNotification({ configFile: f.env.AGENT_CHAT_NOTIFY_CONFIG, binding: { client: 'codex',
    hostSessionId: 'same-host-conversation', cwd: f.cwd, room: f.room.id, mailboxSessionId: old.sessionId } });
  f.mailbox.appendMessage(f.room, 'sender', old.name, 'retained upgrade inbox', 'sender');
  first.server.stop();
  const next = await f.connect('upgrade-provisional');
  await f.bind(next);
  assert.match(await next.server.callTool('chat_who'), /Session: legacy-original/);
  assert.equal(next.server.state.identity.name, old.name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.mailbox.roomDir(f.room), 'identities', 'legacy-original.json'))).untilAt, undefined);
  assert.ok(f.mailbox.takeUnread(next.server.state.identity).messages.some(message => message.text === 'retained upgrade inbox'));
});

test('a terminated adapter process recovers its original mailbox and lock in a new process owner', async t => {
  const f = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../lib/mailbox.mjs', import.meta.url).href;
  const script = `import { createMailbox } from ${JSON.stringify(moduleUrl)};
    const mailbox = createMailbox(JSON.parse(process.argv[1]));
    const room = mailbox.resolveRoom('conversation');
    const peer = mailbox.claimIdentity(room, 'codex-project-original', 'codex-cli', 'terminated-process');
    mailbox.bindConversation({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: mailbox.cwd, room, sessionId: peer.sessionId });
    mailbox.acquireResource(peer, 'crash-lock', 'work in progress', 2);
    mailbox.appendMessage(room, 'sender', peer.name, 'survives process exit', 'sender');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ home: f.home, cwd: f.cwd })], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const before = f.mailbox.heldLock('crash-lock');
  assert.ok(before);
  const next = await f.connect('new-process-owner', 'codex-desktop');
  await f.bind(next);
  assert.match(await next.server.callTool('chat_who'), /Session: terminated-process/);
  assert.equal(f.mailbox.heldLock('crash-lock').expiresAt, before.expiresAt);
  assert.ok(f.mailbox.takeUnread(next.server.state.identity).messages.some(message => message.text === 'survives process exit'));
});

test('offline title sync preserves detached ownership and allows Claude reattachment', t => {
  const f = fixture(t);
  const old = f.mailbox.claimIdentity(f.room, 'claude-project-original', 'claude-code', 'claude-original');
  f.mailbox.bindConversation({ client: 'claude-code', hostSessionId: 'claude-host', cwd: f.cwd, room: f.room, sessionId: old.sessionId });
  f.mailbox.releaseIdentity(f.mailbox.getIdentity(old));
  const renamed = f.mailbox.syncSessionTitle({ room: f.room, sessionId: old.sessionId, title: 'Updated offline title',
    client: 'claude-code', cwd: f.cwd, titleSource: 'claude-code:session_title' });
  assert.equal(renamed.pid, null);
  assert.equal(f.mailbox.isPeerAlive(renamed), false);
  const replacement = f.mailbox.claimIdentity(f.room, 'claude-project-temporary', 'claude-code', 'claude-temporary');
  const attached = f.mailbox.bindConversation({ client: 'claude-code', hostSessionId: 'claude-host', cwd: f.cwd,
    room: f.room, sessionId: replacement.sessionId });
  assert.equal(attached.sessionId, old.sessionId);
  assert.equal(attached.name, renamed.name);
});

test('redirected connections respect alias expiry and do not duplicate offline title candidates', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  first.server.stop();
  const next = await f.connect('temporary');
  await next.server.callTool('chat_rename', { name: 'Another provisional name' });
  const source = next.server.state.identity;
  const file = path.join(f.mailbox.roomDir(f.room), 'identities', 'temporary.json');
  const record = JSON.parse(fs.readFileSync(file));
  const expired = record.aliases[0].name;
  record.aliases.forEach(alias => { alias.expiresAt = 1; });
  fs.writeFileSync(file, JSON.stringify(record));
  const attached = f.mailbox.bindConversation({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd,
    room: f.room, sessionId: source.sessionId });
  assert.equal(f.mailbox.resolveRecipient(f.room, expired), null);
  assert.equal(f.mailbox.resolveRecipient(f.room, source.name).sessionId, 'first');
  f.mailbox.releaseIdentity(attached);
  assert.equal(f.mailbox.resolveRecipient(f.room, 'Review code and plugin options').sessionId, 'first');
});

test('a verified legacy peer without routing records can enroll durably', t => {
  const f = fixture(t);
  const legacy = f.mailbox.claimIdentity(f.room, 'legacy', 'codex', 'legacy');
  fs.rmSync(path.join(f.mailbox.roomDir(f.room), 'identities', 'legacy.json'));
  const bound = f.mailbox.bindConversation({ client: 'codex', hostSessionId: 'host', cwd: f.cwd,
    room: f.room, sessionId: legacy.sessionId });
  assert.equal(bound.sessionId, legacy.sessionId);
  assert.equal(bound.persistent, true);
});

test('harmless lookups before identity verification do not prevent reconnect', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  first.server.stop();
  const next = await f.connect('next');
  for (const name of ['chat_presence', 'chat_rooms', 'chat_invitations', 'chat_wait_status']) await next.server.callTool(name);
  await f.bind(next);
  assert.match(await next.server.callTool('chat_who'), /Session: first/);
});

test('offline notices restore identity first without deduplicating unread mail', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const old = first.server.state.identity;
  f.mailbox.appendMessage(f.room, 'sender', old.name, 'offline message', 'sender');
  first.server.stop();
  const peerFile = path.join(f.mailbox.roomDir(f.room), 'peers', `${old.name}.json`);
  const detached = JSON.parse(fs.readFileSync(peerFile));
  fs.writeFileSync(peerFile, JSON.stringify({ ...detached, lastSeen: '2000-01-01T00:00:00Z' }));
  const next = await f.connect('next');
  const notices = [];
  const notify = () => notifySession({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd,
    env: f.env, mailbox: f.mailbox, deliver: text => notices.push(text) });
  assert.equal((await notify()).reason, 'reconnect-required');
  assert.match(notices.at(-1), /Call chat_who first/);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'notifications')), []);
  assert.equal((await notify()).reason, 'reconnect-required');
  await f.bind(next);
  assert.equal((await notify()).delivered, true);
  assert.match(notices.at(-1), /Call chat_read now/);
  assert.match(await next.server.callTool('chat_read'), /offline message/);
});

test('offline reply-watch continuations restore identity before reading the watch', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const peer = f.mailbox.claimIdentity(f.room, 'peer', 'claude-code', 'peer');
  await first.server.callTool('chat_send', { to: peer.name, text: 'reply please', await_reply_minutes: 1 });
  const watchId = f.mailbox.replyWaitStatus(first.server.state.identity).watchId;
  first.server.stop();
  const notices = [];
  const result = await waitForReplyAtStop({ identity: { client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd },
    env: f.env, mailbox: f.mailbox, write: text => notices.push(JSON.parse(text)) });
  assert.equal(result.state, 'reconnect-required');
  assert.match(notices[0].reason, /Call chat_who first/);
  assert.equal(f.mailbox.replyWaitStatus({ room: f.room, sessionId: 'first' }).watchId, watchId);
});

test('a different host receives a recovery notice without inheriting the original conversation', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  const notices = [];
  const result = await runCommandHook({ client: 'codex', payload: { hook_event_name: 'PostToolUse',
    session_id: 'another-host', cwd: f.cwd, model: 'gpt-6.1-sol', tool_name: 'mcp__agent-chat__chat_who',
    tool_response: first.response }, env: f.env, mailbox: f.mailbox, write: text => notices.push(JSON.parse(text)) });
  assert.equal(result.reason, 'binding-refused');
  assert.match(notices[0].hookSpecificOutput.additionalContext, /Reconnect a separate MCP connection/);
  assert.equal(findBinding({ client: 'codex', hostSessionId: 'another-host', cwd: f.cwd, env: f.env }), null);
  assert.equal(findBinding({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd, env: f.env }).mailboxSessionId, 'first');
  assert.match(await first.server.callTool('chat_who'), /Session: first/);
});

test('mail notified before disconnection still requests identity restoration until read', async t => {
  const f = fixture(t);
  const first = await f.connect('first');
  await f.bind(first);
  f.mailbox.appendMessage(f.room, 'sender', first.server.state.identity.name, 'notified but unread', 'sender');
  const notices = [];
  const notify = () => notifySession({ client: 'codex', hostSessionId: 'same-host-conversation', cwd: f.cwd,
    env: f.env, mailbox: f.mailbox, deliver: text => notices.push(text) });
  assert.equal((await notify()).delivered, true);
  const files = fs.readdirSync(path.join(f.home, 'notifications'));
  const before = files.map(file => fs.readFileSync(path.join(f.home, 'notifications', file), 'utf8'));
  first.server.stop();
  assert.equal((await notify()).reason, 'reconnect-required');
  assert.match(notices.at(-1), /Call chat_who first/);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(f.home, 'notifications', file), 'utf8')), before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailbox } from '../lib/mailbox.mjs';
import { createPresence } from '../lib/presence.mjs';
import { createServer } from '../agent-chat.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-presence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mailbox = createMailbox({ home });
  return { home, mailbox, presence: createPresence({ home }) };
}

test('host sessions appear before joining and receive scoped invitations without joining automatically', t => {
  const { mailbox, presence } = fixture(t);
  const host = presence.registerHost({ client: 'claude', hostSessionId: 'host-123', cwd: '/tmp/work', title: 'planning' });
  assert.equal(presence.list(mailbox).find(x => x.id === host.id)?.room, null);
  const room = mailbox.resolveRoom('team');
  const from = mailbox.claimIdentity(room, 'leader', 'codex', 'leader-session');
  const invite = presence.invite({ from, toId: host.id, room, note: 'Review the API', mailbox });
  assert.equal(presence.pendingForHost({ client: 'claude', hostSessionId: 'host-123' })[0].id, invite.id);
  assert.equal(presence.list(mailbox).find(x => x.id === host.id)?.room, null);
  assert.equal(presence.pendingForHost({ client: 'claude', hostSessionId: 'other' }).length, 0);
  assert.equal(presence.consume(invite.id, ['host-wrong']), null);
  assert.equal(presence.consume(invite.id, [host.id])?.id, invite.id);
  assert.equal(presence.pendingForHost({ client: 'claude', hostSessionId: 'host-123' }).length, 0);
});

test('a filesystem-root working directory still gets a usable provisional handle', async t => {
  const { home, presence } = fixture(t);
  const root = path.parse(process.cwd()).root;
  const mailbox = createMailbox({ home, cwd: root });
  const host = presence.registerHost({ client: 'codex', hostSessionId: 'root-host', cwd: root });
  assert.match(host.name, /^codex-root-[a-f0-9]{6}$/);
  const server = createServer({ mailbox, sessionId: 'root-mcp' });
  t.after(() => server.stop());
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } });
  assert.match(server.state.identity.name, /^codex-root-[a-f0-9]{6}$/);
});

test('a failed eager claim does not break MCP initialization', async t => {
  const { mailbox } = fixture(t);
  const failing = { ...mailbox, claimIdentity: () => { throw new Error('identity busy'); } };
  const responses = [];
  const server = createServer({ mailbox: failing, output: item => responses.push(item) });
  t.after(() => server.stop());
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try { await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex' } } }); }
  finally { process.stderr.write = stderr; }
  assert.equal(responses[0].result.serverInfo.name, 'agent-chat');
  await assert.rejects(server.callTool('chat_who'), /identity busy/);
});

test('same-repo unlinked MCP peers are grouped without guessing host identity', async t => {
  const { mailbox, presence } = fixture(t);
  presence.registerHost({ client: 'codex', hostSessionId: 'first', cwd: process.cwd(), title: 'first task' });
  presence.registerHost({ client: 'codex', hostSessionId: 'second', cwd: process.cwd(), title: 'second task' });
  const first = createServer({ mailbox, sessionId: 'peer-first', roomSpec: 'room-a' });
  const second = createServer({ mailbox, sessionId: 'peer-second', roomSpec: 'room-b' });
  t.after(() => { first.stop(); second.stop(); });
  first.state.client = 'codex-mcp-client'; second.state.client = 'codex-mcp-client';
  await first.callTool('chat_who'); await second.callTool('chat_who');
  const output = await first.callTool('chat_presence');
  assert.match(output, /first-task.*host not linked/);
  assert.match(output, /second-task.*host not linked/);
  assert.equal((output.match(/Unlinked MCP connections/g) || []).length, 1);
  assert.match(output, /peer-first|peer-second|codex-agent-chat/);
  assert.equal(presence.linkedHostIds(first.state.identity.room, first.state.identity.sessionId).length, 0);
});

test('roster groups a host launched through a symlink with its canonical peer directory', async t => {
  const { home, mailbox, presence } = fixture(t);
  const alias = path.join(home, 'cwd-alias');
  try { fs.symlinkSync(process.cwd(), alias, 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  presence.registerHost({ client: 'codex', hostSessionId: 'alias-host', cwd: alias });
  const server = createServer({ mailbox, sessionId: 'alias-peer' });
  t.after(() => server.stop());
  server.state.client = 'codex';
  await server.callTool('chat_who');
  assert.match(await server.callTool('chat_presence'), /Unlinked MCP connections/);
});

test('joined sessions can invite across rooms and accept explicitly', async t => {
  const { mailbox } = fixture(t);
  const alice = createServer({ mailbox, sessionId: 'alice-session', roomSpec: 'alpha' });
  const bob = createServer({ mailbox, sessionId: 'bob-session', roomSpec: 'beta' });
  t.after(() => { alice.stop(); bob.stop(); });
  await alice.callTool('chat_join', { name: 'alice' });
  await bob.callTool('chat_join', { name: 'bob' });
  const visible = await alice.callTool('chat_presence');
  const id = visible.match(/bob \(unknown\) \[(peer-[a-f0-9]{24})\]/)?.[1];
  assert.ok(id, visible);
  const sent = await alice.callTool('chat_invite', { to_id: id, note: 'Please help' });
  const invitationId = sent.match(/Invitation ([a-f0-9-]{36})/)?.[1];
  assert.ok(invitationId, sent);
  assert.equal(bob.state.identity.room.id, 'beta');
  assert.match(await bob.callTool('chat_invitations'), /Please help/);
  assert.match(await bob.callTool('chat_accept_invite', { id: invitationId }), /room alpha/);
  assert.equal(bob.state.identity.room.id, 'alpha');
  assert.equal(await bob.callTool('chat_invitations'), 'No pending invitations.');
});

test('expired host presence and invitations are omitted', t => {
  const { home, mailbox, presence } = fixture(t);
  const host = presence.registerHost({ client: 'codex', hostSessionId: 'old', cwd: '/tmp' });
  const room = mailbox.resolveRoom('work');
  const from = mailbox.claimIdentity(room, 'lead', 'codex', 'lead-session');
  presence.invite({ from, toId: host.id, room, mailbox });
  const file = path.join(home, 'presence', 'registry.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  registry.hosts[0].seenAt = 0;
  registry.invites[0].expiresAt = 0;
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.equal(presence.list(mailbox).some(x => x.id === host.id), false);
  assert.equal(presence.pendingForHost({ client: 'codex', hostSessionId: 'old' }).length, 0);
});

test('broker invitations instruct reconnection without changing a pinned room', async t => {
  const { mailbox } = fixture(t);
  const sender = createServer({ mailbox, sessionId: 'sender-session', roomSpec: 'target' });
  const broker = createServer({ mailbox, sessionId: 'broker-session', roomSpec: 'current', identityExtras: () => ({ transport: 'broker' }) });
  t.after(() => { sender.stop(); broker.stop(); });
  await sender.callTool('chat_join', { name: 'sender' });
  await broker.callTool('chat_join', { name: 'broker' });
  const id = (await sender.callTool('chat_presence')).match(/broker \(unknown\) \[(peer-[a-f0-9]{24})\]/)?.[1];
  assert.ok(id);
  const invitationId = (await sender.callTool('chat_invite', { to_id: id })).match(/Invitation ([a-f0-9-]{36})/)?.[1];
  assert.ok(invitationId);
  assert.match(await broker.callTool('chat_accept_invite', { id: invitationId }), /Reconnect the adapter/);
  assert.equal(broker.state.identity.room.id, 'current');
  assert.match(await broker.callTool('chat_invitations'), new RegExp(invitationId));
});

test('an unlinked host invitation waits for an exact host-to-peer binding', async t => {
  const { mailbox, presence } = fixture(t);
  const host = presence.registerHost({ client: 'claude-code', hostSessionId: 'host-first', cwd: process.cwd(), title: 'reviewer' });
  const sender = createServer({ mailbox, sessionId: 'sender-first', roomSpec: 'review-room' });
  const receiver = createServer({ mailbox, sessionId: 'receiver-first', roomSpec: 'other-room' });
  receiver.state.client = 'claude-mcp-client';
  t.after(() => { sender.stop(); receiver.stop(); });
  await sender.callTool('chat_join', { name: 'sender' });
  const invitationId = (await sender.callTool('chat_invite', { to_id: host.id })).match(/Invitation ([a-f0-9-]{36})/)?.[1];
  assert.ok(invitationId);
  assert.equal(await receiver.callTool('chat_invitations'), 'No pending invitations.');
  presence.linkHost({ client: 'claude-code', hostSessionId: 'host-first', sessionId: receiver.state.identity.sessionId,
    room: receiver.state.identity.room, name: receiver.state.identity.name });
  assert.match(await receiver.callTool('chat_invitations'), new RegExp(invitationId));
  assert.match(await receiver.callTool('chat_accept_invite', { id: invitationId }), /room review-room/);
});

test('ambiguous host sessions are not linked to the wrong MCP identity', async t => {
  const { mailbox, presence } = fixture(t);
  const first = presence.registerHost({ client: 'codex', hostSessionId: 'one', cwd: process.cwd() });
  presence.registerHost({ client: 'codex', hostSessionId: 'two', cwd: process.cwd() });
  const sender = createServer({ mailbox, sessionId: 'sender-ambiguous', roomSpec: 'room' });
  const receiver = createServer({ mailbox, sessionId: 'receiver-ambiguous', roomSpec: 'other' });
  receiver.state.client = 'codex-mcp-client';
  t.after(() => { sender.stop(); receiver.stop(); });
  await sender.callTool('chat_join', { name: 'sender' });
  await sender.callTool('chat_invite', { to_id: first.id });
  assert.equal(await receiver.callTool('chat_invitations'), 'No pending invitations.');
  assert.equal(presence.linkedHostIds(receiver.state.identity.room, receiver.state.identity.sessionId).length, 0);
});

test('a stale linked host prevents a newer host invitation being claimed by another session', async t => {
  const { mailbox, presence } = fixture(t);
  presence.registerHost({ client: 'codex', hostSessionId: 'older', cwd: process.cwd() });
  presence.linkHost({ client: 'codex', hostSessionId: 'older', sessionId: 'former-session', room: mailbox.resolveRoom('old'), name: 'former' });
  const newer = presence.registerHost({ client: 'codex', hostSessionId: 'newer', cwd: process.cwd() });
  const sender = createServer({ mailbox, sessionId: 'sender-stale', roomSpec: 'review' });
  const receiver = createServer({ mailbox, sessionId: 'receiver-stale', roomSpec: 'other' });
  receiver.state.client = 'codex-mcp-client';
  t.after(() => { sender.stop(); receiver.stop(); });
  await sender.callTool('chat_join', { name: 'sender' });
  await sender.callTool('chat_invite', { to_id: newer.id });
  assert.equal(await receiver.callTool('chat_invitations'), 'No pending invitations.');
  assert.equal(presence.linkedHostIds(receiver.state.identity.room, receiver.state.identity.sessionId).length, 0);
});

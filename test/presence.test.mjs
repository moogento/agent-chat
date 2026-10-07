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

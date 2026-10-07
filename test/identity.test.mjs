import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailbox, IDENTITY_LIMITS } from '../lib/mailbox.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mailbox = createMailbox({ home });
  return { mailbox, room: mailbox.resolveRoom('identity-room') };
}
function legacy(mailbox, room, to, text, ts = '2020-01-01T00:00:00.000Z') {
  fs.appendFileSync(path.join(mailbox.roomDir(room), 'messages.jsonl'), JSON.stringify({ id: text, ts, from: 'sender', to, text }) + '\n');
}

test('rename preserves unread directed messages and pins sends through remembered aliases', t => {
  const { mailbox, room } = fixture(t);
  const original = mailbox.claimIdentity(room, 'original', 'codex', 'session-original');
  const sent = mailbox.appendMessage(room, 'sender', original.name, 'before rename', 'session-sender');
  const renamed = mailbox.claimIdentity(room, 'renamed', 'codex', original.sessionId);
  const aliasSend = mailbox.appendMessage(room, 'sender', original.name, 'using old name', 'session-sender');
  assert.equal(sent.toSessionId, original.sessionId);
  assert.equal(aliasSend.toSessionId, original.sessionId);
  assert.deepEqual(mailbox.resolveRecipient(room, 'original'), { name: 'renamed', sessionId: original.sessionId, alias: true });
  assert.deepEqual(mailbox.takeUnread(renamed).messages.map(message => message.text), ['before rename', 'using old name']);
  assert.equal(mailbox.getIdentity(original).name, 'renamed');
  assert.equal(mailbox.claimIdentity(room, 'original', 'claude', 'other').name, 'original-2');
});

test('new holder of a released handle cannot read earlier directed or legacy messages', t => {
  const { mailbox, room } = fixture(t);
  const original = mailbox.claimIdentity(room, 'reader', 'codex', 'first-reader');
  legacy(mailbox, room, 'reader', 'legacy before rename');
  mailbox.appendMessage(room, 'sender', 'reader', 'pinned before release');
  mailbox.releaseIdentity(original);
  const newcomer = mailbox.claimIdentity(room, 'reader', 'claude', 'second-reader');
  assert.equal(newcomer.name, original.name);
  assert.deepEqual(mailbox.takeUnread(newcomer).messages, []);
  const fresh = mailbox.appendMessage(room, 'sender', 'reader', 'for new holder');
  assert.equal(fresh.toSessionId, newcomer.sessionId);
  assert.deepEqual(mailbox.takeUnread(newcomer).messages.map(message => message.id), [fresh.id]);
  assert.deepEqual(mailbox.takeUnread(original).messages.map(message => message.text), ['legacy before rename', 'pinned before release']);
});

test('first claim retains pre-install name-only history after a rename', t => {
  const { mailbox, room } = fixture(t);
  legacy(mailbox, room, 'reader', 'pre-install history');
  const original = mailbox.claimIdentity(room, 'reader', 'codex', 'reader-session');
  const renamed = mailbox.claimIdentity(room, 'renamed', 'codex', original.sessionId);
  assert.deepEqual(mailbox.takeUnread(renamed).messages.map(message => message.text), ['pre-install history']);
});

test('a former owner reconnecting under a suffix does not reserve a transferred handle', t => {
  const { mailbox, room } = fixture(t);
  const first = mailbox.claimIdentity(room, 'shared', 'codex', 'first-session');
  mailbox.releaseIdentity(first);
  const second = mailbox.claimIdentity(room, 'shared', 'claude', 'second-session');
  const resumed = mailbox.claimIdentity(room, 'shared', 'codex', first.sessionId);
  assert.equal(resumed.name, 'shared-2');
  assert.equal(mailbox.resolveRecipient(room, 'shared').sessionId, second.sessionId);
  mailbox.releaseIdentity(second);
  const third = mailbox.claimIdentity(room, 'shared', 'opencode', 'third-session');
  assert.equal(third.name, 'shared');
  assert.equal(mailbox.resolveRecipient(room, 'shared').sessionId, third.sessionId);
});

test('legacy ownership windows prevent previous holders reading later holders messages', t => {
  const { mailbox, room } = fixture(t);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const first = mailbox.claimIdentity(room, 'shared', 'codex', 'first-session');
  legacy(mailbox, room, 'shared', 'first holder', new Date(++now).toISOString());
  mailbox.releaseIdentity(first);
  now++;
  const second = mailbox.claimIdentity(room, 'shared', 'claude', 'second-session');
  legacy(mailbox, room, 'shared', 'second holder', new Date(++now).toISOString());
  mailbox.releaseIdentity(second);
  now++;
  const third = mailbox.claimIdentity(room, 'shared', 'opencode', 'third-session');
  legacy(mailbox, room, 'shared', 'third holder', new Date(++now).toISOString());
  assert.deepEqual(mailbox.takeUnread(first).messages.map(message => message.text), ['first holder']);
  assert.deepEqual(mailbox.takeUnread(second).messages.map(message => message.text), ['second holder']);
  assert.deepEqual(mailbox.takeUnread(third).messages.map(message => message.text), ['third holder']);
});

test('alias memory is bounded, expires, and never permits old pinned delivery to a new holder', t => {
  const { mailbox, room } = fixture(t);
  let peer = mailbox.claimIdentity(room, 'name-0', 'codex', 'renaming-session');
  const message = mailbox.appendMessage(room, 'sender', peer.name, 'survives alias eviction');
  for (let i = 1; i <= IDENTITY_LIMITS.aliases + 2; i++) peer = mailbox.claimIdentity(room, `name-${i}`, 'codex', peer.sessionId);
  const file = path.join(mailbox.roomPath(room), 'identities', `${peer.sessionId}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.aliases.length, IDENTITY_LIMITS.aliases);
  assert.equal(mailbox.resolveRecipient(room, 'name-0'), null);
  const reused = mailbox.claimIdentity(room, 'name-0', 'claude', 'new-holder');
  assert.deepEqual(mailbox.takeUnread(reused).messages, []);
  assert.deepEqual(mailbox.takeUnread(peer).messages.map(item => item.id), [message.id]);
  const lastAlias = stored.aliases.at(-1).name;
  stored.aliases = stored.aliases.map(alias => ({ ...alias, expiresAt: Date.now() - 1 }));
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(mailbox.resolveRecipient(room, lastAlias), null);
  assert.equal(mailbox.claimIdentity(room, lastAlias, 'claude', 'expired-alias-holder').name, lastAlias);
});

test('stable session lookup supports full-length opaque recipient IDs', t => {
  const { mailbox, room } = fixture(t);
  const sessionId = 's'.repeat(128);
  const reader = mailbox.claimIdentity(room, 'reader', 'codex', sessionId);
  assert.equal(mailbox.resolveRecipient(room, sessionId).sessionId, sessionId);
  mailbox.appendMessage(room, 'sender', reader.name, 'explicit session recipient', 'sender', sessionId);
  assert.equal(mailbox.takeUnread(reader).messages[0].toSessionId, sessionId);
});

test('bound title sync validates room, session, client and cwd while preserving the owner', t => {
  const { mailbox, room } = fixture(t);
  const peer = mailbox.claimIdentity(room, 'old', 'opencode', 'title-session');
  assert.equal(mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, title: 'new', client: 'claude', cwd: peer.cwd }), null);
  assert.equal(mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, title: 'new', client: peer.client, cwd: path.join(peer.cwd, 'other') }), null);
  assert.equal(mailbox.syncSessionTitle({ room, sessionId: 'other-session', title: 'new', client: peer.client, cwd: peer.cwd }), null);
  const renamed = mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, title: 'New title', client: peer.client, cwd: peer.cwd, titleSource: 'opencode:session.updated' });
  assert.equal(renamed.name, 'New-title');
  assert.equal(renamed.pid, peer.pid);
  assert.equal(renamed.titleSource, 'opencode:session.updated');
  assert.equal(mailbox.resolveRecipient(room, 'old').sessionId, peer.sessionId);
  assert.throws(() => mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, title: 'unsafe\nname', client: peer.client, cwd: peer.cwd }), /without controls/);
});

test('an explicit handle survives title updates and recorded title metadata stays current', t => {
  const { mailbox, room } = fixture(t);
  const peer = mailbox.claimIdentity(room, 'chosen', 'opencode', 'explicit-session', { nameSource: 'explicit' });
  const updated = mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, title: 'Different title', client: peer.client, cwd: peer.cwd });
  assert.equal(updated.name, 'chosen');
  assert.equal(updated.sessionTitle, 'Different title');
  assert.equal(updated.nameSource, 'explicit');
});

test('failed identity writes roll back the peer, durable alias record and target handle claim', t => {
  const { mailbox, room } = fixture(t);
  const peer = mailbox.claimIdentity(room, 'old', 'codex', 'rollback-session');
  const identityFile = path.join(mailbox.roomPath(room), 'identities', `${peer.sessionId}.json`);
  const before = fs.readFileSync(identityFile, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = function(source, target) { if (target === path.join(mailbox.roomPath(room), 'peers', 'new.json')) throw new Error('injected rename failure'); return rename.call(this, source, target); };
  try { assert.throws(() => mailbox.claimIdentity(room, 'new', 'codex', peer.sessionId), /injected rename failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(identityFile, 'utf8'), before);
  assert.equal(mailbox.getIdentity(peer).name, 'old');
  assert.equal(mailbox.resolveRecipient(room, 'new'), null);
  assert.equal(mailbox.resolveRecipient(room, 'old').sessionId, peer.sessionId);
  assert.equal(mailbox.claimIdentity(room, 'new', 'claude', 'new-session').name, 'new');
});

test('identity and handle storage reject directory symlinks', t => {
  const { mailbox, room } = fixture(t);
  const peer = mailbox.claimIdentity(room, 'reader', 'codex', 'safe-session');
  for (const directory of ['identities', 'handles']) {
    const original = path.join(mailbox.roomPath(room), directory);
    const moved = `${original}-moved`;
    fs.renameSync(original, moved);
    fs.symlinkSync(moved, original, 'dir');
    assert.throws(() => directory === 'identities' ? mailbox.takeUnread(peer) : mailbox.resolveRecipient(room, 'unknown'), /Unsafe mailbox directory/);
    fs.rmSync(original);
    fs.renameSync(moved, original);
  }
});

test('tidy prunes released identity scans but retains handle tombstones and active aliases', t => {
  const { mailbox, room } = fixture(t);
  const active = mailbox.claimIdentity(room, 'active', 'codex', 'active-session');
  const released = mailbox.claimIdentity(room, 'reused', 'codex', 'released-session');
  const alias = mailbox.claimIdentity(room, 'old-name', 'codex', 'alias-session');
  const renamed = mailbox.claimIdentity(room, 'new-name', 'codex', alias.sessionId);
  mailbox.releaseIdentity(released);
  mailbox.releaseIdentity(renamed);
  const directory = mailbox.roomPath(room);
  const old = new Date(Date.now() - IDENTITY_LIMITS.aliasTtlMs - 1000);
  for (const session of [active.sessionId, released.sessionId, renamed.sessionId]) {
    const file = path.join(directory, 'identities', `${session}.json`);
    if (session !== active.sessionId) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...record, releasedAt: old.getTime() }));
    }
    fs.utimesSync(file, old, old);
  }
  mailbox.tidyRooms({ force: true });
  assert.equal(fs.existsSync(path.join(directory, 'identities', `${released.sessionId}.json`)), false);
  assert.equal(fs.existsSync(path.join(directory, 'identities', `${active.sessionId}.json`)), true);
  assert.equal(fs.existsSync(path.join(directory, 'identities', `${renamed.sessionId}.json`)), true);
  assert.equal(fs.existsSync(path.join(directory, 'handles', 'reused.json')), true);
  assert.equal(mailbox.resolveRecipient(room, 'reused'), null);
  const newcomer = mailbox.claimIdentity(room, 'reused', 'claude', 'new-session');
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'identities', `${newcomer.sessionId}.json`), 'utf8'));
  assert.equal(record.firstClaim, false);
});

test('a long-lived session retains its routing record for a full day after release', t => {
  const { mailbox, room } = fixture(t);
  const peer = mailbox.claimIdentity(room, 'long-running', 'codex', 'long-session');
  const file = path.join(mailbox.roomPath(room), 'identities', `${peer.sessionId}.json`);
  const old = new Date(Date.now() - IDENTITY_LIMITS.aliasTtlMs - 1000);
  fs.utimesSync(file, old, old);
  mailbox.releaseIdentity(peer);
  mailbox.tidyRooms({ force: true });
  assert.equal(fs.existsSync(file), true);
  assert.equal(mailbox.resolveRecipient(room, 'long-running')?.sessionId, peer.sessionId);
});

test('broker-style identity pruning retains idle room history', t => {
  const { mailbox } = fixture(t);
  const room = mailbox.resolveRoom('resumable-history');
  const directory = mailbox.roomDir(room);
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(path.join(directory, 'room.json'), old, old);
  assert.deepEqual(mailbox.tidyRooms({ force: true, ttlDays: 0, pruneOnly: true }), []);
  assert.equal(fs.existsSync(directory), true);
});

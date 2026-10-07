import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailbox } from '../lib/mailbox.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { findBinding, readConfig, runCommandHook, notifySession, sameBindingCwd, NOTIFICATION_LIMITS } from '../hooks/notifications.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-binding-lifecycle-'));
  const cwd = ['win32', 'darwin'].includes(process.platform) ? fs.realpathSync.native(temporary) : fs.realpathSync(temporary);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configFile = path.join(cwd, 'notifications.json');
  const binding = { client: 'codex', hostSessionId: 'host', cwd, room: 'room', mailboxSessionId: 'session' };
  const lookup = (env = {}, extra = {}) => findBinding({ client: binding.client, hostSessionId: binding.hostSessionId, cwd,
    env: { AGENT_CHAT_NOTIFY_CONFIG: configFile, ...env }, ...extra });
  return { temporary, cwd, configFile, binding, lookup };
}

test('deleted stored worktrees are inert and do not block healthy lookups or new bindings', t => {
  const f = fixture(t);
  const stale = path.join(f.cwd, 'deleted-worktree'); fs.mkdirSync(stale);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: stale, hostSessionId: 'stale', mailboxSessionId: 'stale-session' } });
  bindNotification({ configFile: f.configFile, binding: f.binding });
  fs.rmSync(stale, { recursive: true });
  assert.equal(readConfig(f.configFile).bindings.length, 2);
  assert.equal(f.lookup().mailboxSessionId, f.binding.mailboxSessionId);
  bindNotification({ configFile: f.configFile, binding: f.binding });
  assert.equal(readConfig(f.configFile).bindings.length, 2);
  assert.throws(() => bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: stale } }), /existing absolute directory/);
  for (const invalid of [{ ...f.binding, cwd: 'relative' }, { ...f.binding, boundAt: -1 }, { ...f.binding, boundAt: 'yesterday' }]) {
    fs.writeFileSync(f.configFile, JSON.stringify({ version: 1, bindings: [invalid] }));
    assert.throws(() => readConfig(f.configFile));
  }
});

test('stored worktree paths never follow a replacement symlink into another worktree', t => {
  const f = fixture(t);
  const original = path.join(f.cwd, 'original'); const other = path.join(f.cwd, 'other');
  fs.mkdirSync(original); fs.mkdirSync(other);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: original } });
  fs.rmSync(original, { recursive: true });
  try { fs.symlinkSync(other, original, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  assert.equal(f.lookup({}, { cwd: original }), null);
  assert.equal(f.lookup({}, { cwd: other }), null);
  assert.equal(sameBindingCwd(original, other), false);
  assert.equal(sameBindingCwd(other, original), false);
  assert.equal(readConfig(f.configFile).bindings[0].cwd, original);
});

test('bounded history evicts legacy records then oldest timestamps while retaining incoming bindings', t => {
  const f = fixture(t);
  const bindings = Array.from({ length: NOTIFICATION_LIMITS.bindings }, (_, index) => ({ ...f.binding,
    hostSessionId: `host-${index}`, mailboxSessionId: `session-${index}`,
    ...(index === 99 ? {} : { boundAt: 1000 + index }) })).reverse();
  fs.writeFileSync(f.configFile, JSON.stringify({ version: 1, bindings }));
  bindNotification({ configFile: f.configFile, binding: f.binding });
  let retained = readConfig(f.configFile).bindings;
  assert.equal(retained.length, NOTIFICATION_LIMITS.bindings);
  assert.equal(retained.some(binding => binding.hostSessionId === 'host-99'), false);
  assert.equal(retained.at(-1).hostSessionId, f.binding.hostSessionId);
  assert.ok(Number.isSafeInteger(retained.at(-1).boundAt));
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, hostSessionId: 'next', mailboxSessionId: 'next-session' } });
  retained = readConfig(f.configFile).bindings;
  assert.equal(retained.length, NOTIFICATION_LIMITS.bindings);
  assert.equal(retained.some(binding => binding.hostSessionId === 'host-0'), false);
  assert.equal(retained.at(-1).hostSessionId, 'next');
  assert.ok(fs.statSync(f.configFile).size <= NOTIFICATION_LIMITS.configBytes);
});

test('mailbox deduplication and host lookup preserve client, worktree and broker endpoint isolation', t => {
  const f = fixture(t);
  const one = { ...f.binding, brokerUrl: 'https://one.example.test' };
  const two = { ...f.binding, brokerUrl: 'https://two.example.test' };
  const otherClient = { ...one, client: 'claude-code' };
  const otherCwd = path.join(f.cwd, 'other'); fs.mkdirSync(otherCwd);
  for (const binding of [f.binding, one, two, otherClient, { ...one, cwd: otherCwd }]) bindNotification({ configFile: f.configFile, binding });
  assert.equal(f.lookup().brokerUrl, undefined);
  assert.equal(f.lookup({ AGENT_CHAT_BROKER_URL: one.brokerUrl }).brokerUrl, one.brokerUrl);
  assert.equal(f.lookup({ AGENT_CHAT_BROKER_URL: two.brokerUrl }).brokerUrl, two.brokerUrl);
  bindNotification({ configFile: f.configFile, binding: { ...one, hostSessionId: 'replacement-host' } });
  const retained = readConfig(f.configFile).bindings;
  assert.equal(retained.length, 5);
  assert.equal(f.lookup({ AGENT_CHAT_BROKER_URL: one.brokerUrl }), null);
  assert.equal(f.lookup({ AGENT_CHAT_BROKER_URL: two.brokerUrl }).hostSessionId, 'host');
  assert.equal(f.lookup({ AGENT_CHAT_BROKER_URL: one.brokerUrl }, { hostSessionId: 'replacement-host' }).mailboxSessionId, 'session');
  assert.ok(retained.some(binding => binding.client === 'claude-code'));
  assert.ok(retained.some(binding => binding.cwd === otherCwd));
});

test('successful identity auto-binding refreshes retention at most once per hour', async t => {
  const f = fixture(t);
  const mailbox = createMailbox({ home: path.join(f.cwd, 'mailbox'), cwd: f.cwd });
  const room = mailbox.resolveRoom('room'); const peer = mailbox.claimIdentity(room, 'recipient', 'codex', crypto.randomUUID());
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, mailboxSessionId: peer.sessionId } });
  const config = readConfig(f.configFile);
  const old = Date.now() - NOTIFICATION_LIMITS.refreshMs - 1000;
  config.bindings[0].boundAt = old; fs.writeFileSync(f.configFile, JSON.stringify(config));
  const tool = 'mcp__agent_chat__chat_who';
  const input = { client: 'codex', mailbox, env: { AGENT_CHAT_NOTIFY_CONFIG: f.configFile, AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: tool },
    payload: { session_id: 'host', cwd: f.cwd, hook_event_name: 'PostToolUse', tool_name: tool,
      tool_response: { structuredContent: { agentChatIdentity: { version: 1, sessionId: peer.sessionId, cwd: f.cwd, room: room.id, name: peer.name } } } }, write: () => assert.fail('no unread messages') };
  await runCommandHook(input);
  const refreshed = readConfig(f.configFile).bindings[0].boundAt;
  assert.ok(refreshed > old);
  const past = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(f.configFile, past, past);
  await runCommandHook(input);
  assert.equal(readConfig(f.configFile).bindings[0].boundAt, refreshed);
  assert.equal(fs.statSync(f.configFile).mtimeMs, past.getTime());
});

test('macOS legacy case bindings resolve and deduplicate without combining distinct directories', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t);
  const actual = path.join(f.cwd, 'MixedCaseWorktree'); const variant = path.join(f.cwd, 'mixedcaseworktree');
  fs.mkdirSync(actual);
  if (!fs.existsSync(variant)) {
    fs.mkdirSync(variant);
    assert.equal(sameBindingCwd(actual, variant), false);
    bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: actual } });
    bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: variant } });
    assert.equal(readConfig(f.configFile).bindings.length, 2);
    return;
  }
  assert.equal(fs.statSync(actual).ino, fs.statSync(variant).ino);
  const native = fs.realpathSync.native(actual);
  fs.writeFileSync(f.configFile, JSON.stringify({ version: 1, bindings: [{ ...f.binding, cwd: fs.realpathSync(variant) }] }));
  assert.equal(sameBindingCwd(variant, native), true);
  assert.equal(sameBindingCwd(native, variant), true);
  assert.equal(f.lookup({}, { cwd: actual }).mailboxSessionId, f.binding.mailboxSessionId);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: variant } });
  assert.equal(readConfig(f.configFile).bindings.length, 1);
  assert.equal(readConfig(f.configFile).bindings[0].cwd, native);
  const other = path.join(f.cwd, 'OtherWorktree'); fs.mkdirSync(other);
  assert.equal(f.lookup({}, { cwd: other }), null);
  assert.equal(sameBindingCwd(actual, other), false);
});

test('Windows path case variants share one native canonical binding', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: f.cwd.toUpperCase() } });
  assert.equal(readConfig(f.configFile).bindings[0].cwd, fs.realpathSync.native(f.cwd));
  assert.equal(f.lookup({}, { cwd: f.cwd.toLowerCase() }).mailboxSessionId, f.binding.mailboxSessionId);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: f.cwd.toLowerCase() } });
  assert.equal(readConfig(f.configFile).bindings.length, 1);
  const legacy = readConfig(f.configFile);
  legacy.bindings[0].cwd = f.cwd.toLowerCase();
  fs.writeFileSync(f.configFile, JSON.stringify(legacy));
  assert.equal(f.lookup().mailboxSessionId, f.binding.mailboxSessionId);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: f.cwd.toUpperCase() } });
  assert.equal(readConfig(f.configFile).bindings.length, 1);
  assert.equal(readConfig(f.configFile).bindings[0].cwd, fs.realpathSync.native(f.cwd));
});

test('Windows legacy temporary short-name aliases support lookup, peer matching and rebind deduplication', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  // CI TEMP commonly includes RUNNER~1; the old resolver retains that alias.
  const legacy = fs.realpathSync(f.temporary); const native = fs.realpathSync.native(f.temporary);
  assert.equal(sameBindingCwd(legacy, native), true);
  assert.equal(sameBindingCwd(native, legacy), true);
  const mailbox = createMailbox({ home: path.join(native, 'mailbox'), cwd: native });
  const room = mailbox.resolveRoom('room'); const peer = mailbox.claimIdentity(room, 'recipient', 'codex', crypto.randomUUID());
  fs.writeFileSync(f.configFile, JSON.stringify({ version: 1, bindings: [{ ...f.binding, cwd: legacy, mailboxSessionId: peer.sessionId }] }));
  assert.equal(f.lookup({}, { cwd: native }).mailboxSessionId, peer.sessionId);
  mailbox.appendMessage(room, 'sender', peer.name, 'legacy path message', crypto.randomUUID());
  let notices = 0;
  await notifySession({ client: 'codex', hostSessionId: 'host', cwd: native, env: { AGENT_CHAT_NOTIFY_CONFIG: f.configFile },
    mailbox, deliver: () => notices++ });
  assert.equal(notices, 1);
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: legacy.toLowerCase(), mailboxSessionId: peer.sessionId } });
  const retained = readConfig(f.configFile).bindings;
  assert.equal(retained.length, 1);
  assert.equal(retained[0].cwd, native);
});

test('Windows ancestor junction replacement cannot remap a stored child worktree', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const original = path.join(f.cwd, 'original'); const other = path.join(f.cwd, 'other');
  fs.mkdirSync(path.join(original, 'child'), { recursive: true }); fs.mkdirSync(path.join(other, 'child'), { recursive: true });
  bindNotification({ configFile: f.configFile, binding: { ...f.binding, cwd: path.join(original, 'child') } });
  fs.rmSync(original, { recursive: true }); fs.symlinkSync(other, original, 'junction');
  assert.equal(sameBindingCwd(path.join(original, 'child'), path.join(other, 'child')), false);
  assert.equal(sameBindingCwd(path.join(other, 'child'), path.join(original, 'child')), false);
  assert.equal(f.lookup({}, { cwd: path.join(other, 'child') }), null);
});

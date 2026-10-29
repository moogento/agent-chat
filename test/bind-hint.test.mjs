import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailbox } from '../lib/mailbox.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { readConfig } from '../hooks/notifications.mjs';
import { writeBindHint, scanBindHints, claimBindHint, BIND_HINT_MAX_AGE_MS } from '../lib/bind-hint.mjs';
import { AgentChatPlugin } from '../integrations/opencode/agent-chat.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-bind-hint-'));
  const root = process.platform === 'win32' ? fs.realpathSync.native(temporary) : fs.realpathSync(temporary);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'worktree');
  fs.mkdirSync(cwd);
  const home = path.join(root, 'mailbox');
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('bind-hint');
  const peer = mailbox.claimIdentity(room, 'recipient', 'opencode', crypto.randomUUID());
  const configFile = path.join(root, 'notifications.json');
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: configFile };
  const hint = (overrides = {}) => writeBindHint({ home, hostPid: process.pid, mcpPid: 4343, cwd,
    room: room.id, mailboxSessionId: peer.sessionId, name: peer.name, ...overrides });
  return { root, cwd, home, room, mailbox, peer, configFile, env, hint };
}

test('bind hints round-trip for the host process and directory only', t => {
  const f = fixture(t);
  f.hint({ hostPid: 4242 });
  const hints = scanBindHints({ home: f.home, hostPid: 4242, cwd: f.cwd });
  assert.equal(hints.length, 1);
  assert.equal(hints[0].mailboxSessionId, f.peer.sessionId);
  assert.equal(hints[0].mcpPid, 4343);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 9999, cwd: f.cwd }), []);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 4242, cwd: f.root }), []);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 4242, cwd: f.cwd, now: Date.now() + BIND_HINT_MAX_AGE_MS + 60000 }), []);
});

test('an aliased or symlinked directory still matches its hint', t => {
  const f = fixture(t);
  f.hint();
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.cwd, alias);
  assert.equal(scanBindHints({ home: f.home, hostPid: process.pid, cwd: alias }).length, 1);
});

test('bind hints reject malformed, oversized and symlinked files', t => {
  const f = fixture(t);
  const dir = path.join(f.home, 'bind-hints');
  fs.mkdirSync(dir, { recursive: true });
  const fresh = () => ({ version: 1, hostPid: process.pid, mcpPid: 12, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId, name: f.peer.name, at: Date.now() });
  fs.writeFileSync(path.join(dir, 'mcp-not-a-pid.json'), '{}');
  fs.writeFileSync(path.join(dir, 'mcp-11.json'), JSON.stringify({ ...fresh(), mcpPid: 12 }));
  fs.writeFileSync(path.join(dir, 'mcp-12.json'), JSON.stringify(fresh()));
  fs.writeFileSync(path.join(dir, 'mcp-13.json'), 'x'.repeat(5000));
  const target = path.join(f.root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify({ ...fresh(), mcpPid: 14 }));
  fs.symlinkSync(target, path.join(dir, 'mcp-14.json'));
  const hints = scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd });
  assert.deepEqual(hints.map(hint => hint.mcpPid), [12]);
});

test('scanning prunes stale hints and keeps a capped directory from hiding a live one', t => {
  const f = fixture(t);
  f.hint({ mcpPid: 9191 });
  const stale = Date.now() - BIND_HINT_MAX_AGE_MS - 60000;
  for (let index = 0; index < 3; index += 1) {
    const file = path.join(f.home, 'bind-hints', `mcp-${9200 + index}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, hostPid: process.pid, mcpPid: 9200 + index, cwd: f.cwd,
      room: f.room.id, mailboxSessionId: f.peer.sessionId, name: f.peer.name, at: stale }));
  }
  const hints = scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd, maxAgeMs: BIND_HINT_MAX_AGE_MS });
  assert.deepEqual(hints.map(hint => hint.mcpPid), [9191]);
  const remaining = fs.readdirSync(path.join(f.home, 'bind-hints')).filter(name => name.startsWith('mcp-920'));
  assert.deepEqual(remaining, []);
});

test('writeBindHint rejects unusable input', t => {
  const f = fixture(t);
  const base = { home: f.home, hostPid: 1, mcpPid: 2, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId, name: f.peer.name };
  assert.throws(() => writeBindHint({ ...base, home: 'relative' }), /absolute path/);
  assert.throws(() => writeBindHint({ ...base, cwd: 'relative' }), /absolute path/);
  assert.throws(() => writeBindHint({ ...base, hostPid: 0 }), /positive integer/);
  assert.throws(() => writeBindHint({ ...base, room: '' }), /room must be/);
  assert.throws(() => writeBindHint({ ...base, mailboxSessionId: '' }), /mailboxSessionId must be/);
});

test('claiming a hint removes it so a later session cannot bind from it', t => {
  const f = fixture(t);
  f.hint({ mcpPid: 5151 });
  assert.equal(claimBindHint({ home: f.home, mcpPid: 5151 }), true);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd }), []);
});

test('OpenCode binds notifications from its own MCP hint without an identity tool call', async t => {
  const f = fixture(t);
  f.hint({ mcpPid: 6161 });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'hint-host', title: 'Reporting work' } } } });
  const bindings = readConfig(f.configFile).bindings;
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].hostSessionId, 'hint-host');
  assert.equal(bindings[0].mailboxSessionId, f.peer.sessionId);
  assert.equal(bindings[0].room, f.room.id);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd }), []);
});

test('OpenCode leaves concurrent or unowned hints unbound instead of guessing', async t => {
  const f = fixture(t);
  f.hint({ mcpPid: 7171 });
  f.hint({ mcpPid: 7172 });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ambiguous-host', title: 'One of two' } } } });
  assert.equal(fs.existsSync(f.configFile), false);
  assert.equal(scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd }).length, 2);
});

test('OpenCode ignores a hint whose mailbox peer is no longer live', async t => {
  const f = fixture(t);
  f.hint({ mcpPid: 8181, mailboxSessionId: crypto.randomUUID() });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'stale-host', title: 'Unknown peer' } } } });
  assert.equal(fs.existsSync(f.configFile), false);
});

test('OpenCode ignores a hint whose recorded name no longer matches the peer', async t => {
  const f = fixture(t);
  f.hint({ mcpPid: 8282, name: 'someone-else' });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'renamed-host', title: 'Renamed peer' } } } });
  assert.equal(fs.existsSync(f.configFile), false);
});

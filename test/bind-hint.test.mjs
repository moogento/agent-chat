import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailbox } from '../lib/mailbox.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { readConfig } from '../hooks/notifications.mjs';
import { writeBindHint, scanBindHints, claimBindHint } from '../lib/bind-hint.mjs';
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
  return { root, cwd, home, room, mailbox, peer, configFile, env };
}

test('bind hints round-trip for the host process and directory only', t => {
  const f = fixture(t);
  writeBindHint({ home: f.home, hostPid: 4242, mcpPid: 4343, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId, name: f.peer.name });
  const hints = scanBindHints({ home: f.home, hostPid: 4242, cwd: f.cwd });
  assert.equal(hints.length, 1);
  assert.equal(hints[0].mailboxSessionId, f.peer.sessionId);
  assert.equal(hints[0].mcpPid, 4343);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 9999, cwd: f.cwd }), []);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 4242, cwd: f.root }), []);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: 4242, cwd: f.cwd, now: Date.now() + 25 * 60 * 60 * 1000 }), []);
});

test('bind hints reject malformed, oversized and symlinked files', t => {
  const f = fixture(t);
  const dir = path.join(f.home, 'bind-hints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mcp-not-a-pid.json'), '{}');
  fs.writeFileSync(path.join(dir, 'mcp-11.json'), JSON.stringify({ version: 1, hostPid: process.pid, mcpPid: 12,
    cwd: f.cwd, room: f.room.id, mailboxSessionId: f.peer.sessionId, at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'mcp-12.json'), JSON.stringify({ version: 1, hostPid: process.pid, mcpPid: 12,
    cwd: f.cwd, room: f.room.id, mailboxSessionId: f.peer.sessionId, at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'mcp-13.json'), 'x'.repeat(5000));
  const target = path.join(f.root, 'outside.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, hostPid: process.pid, mcpPid: 14, cwd: f.cwd,
    room: f.room.id, mailboxSessionId: f.peer.sessionId, at: Date.now() }));
  fs.symlinkSync(target, path.join(dir, 'mcp-14.json'));
  const hints = scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd });
  assert.deepEqual(hints.map(hint => hint.mcpPid), [12]);
});

test('claiming a hint removes it so a later session cannot bind from it', t => {
  const f = fixture(t);
  writeBindHint({ home: f.home, hostPid: process.pid, mcpPid: 5151, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId, name: f.peer.name });
  assert.equal(claimBindHint({ home: f.home, mcpPid: 5151 }), true);
  assert.deepEqual(scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd }), []);
});

test('OpenCode binds notifications from its own MCP hint without an identity tool call', async t => {
  const f = fixture(t);
  writeBindHint({ home: f.home, hostPid: process.pid, mcpPid: 6161, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId, name: f.peer.name });
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
  writeBindHint({ home: f.home, hostPid: process.pid, mcpPid: 7171, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId });
  writeBindHint({ home: f.home, hostPid: process.pid, mcpPid: 7172, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: f.peer.sessionId });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'ambiguous-host', title: 'One of two' } } } });
  assert.equal(fs.existsSync(f.configFile), false);
  assert.equal(scanBindHints({ home: f.home, hostPid: process.pid, cwd: f.cwd }).length, 2);
});

test('OpenCode ignores a hint whose mailbox peer is no longer live', async t => {
  const f = fixture(t);
  writeBindHint({ home: f.home, hostPid: process.pid, mcpPid: 8181, cwd: f.cwd, room: f.room.id,
    mailboxSessionId: crypto.randomUUID() });
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {} }, { env: f.env, mailbox: f.mailbox });
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: 'stale-host', title: 'Unknown peer' } } } });
  assert.equal(fs.existsSync(f.configFile), false);
});

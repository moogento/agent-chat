import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailbox } from '../lib/mailbox.mjs';
import { createPresence } from '../lib/presence.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { createV2Plugin, createV2Client } from '../integrations/opencode/v2.mjs';

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-v2-'));
  const root = process.platform === 'win32' ? fs.realpathSync.native(temporary) : fs.realpathSync(temporary);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'worktree');
  fs.mkdirSync(cwd);
  const home = path.join(root, 'mailbox');
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('v2-test');
  const peer = mailbox.claimIdentity(room, 'recipient', 'opencode', crypto.randomUUID());
  const configFile = path.join(root, 'notification config.json');
  const binding = { client: 'opencode', hostSessionId: 'host-session-v2', cwd, room: room.id, mailboxSessionId: peer.sessionId };
  bindNotification({ configFile, binding });
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: configFile };
  const send = (text = 'private peer contents') => mailbox.appendMessage(room, 'sender', peer.name, text, crypto.randomUUID());
  return { root, cwd, home, room, mailbox, peer, configFile, binding, env, send };
}

function fakeContext(t, f) {
  const registered = { events: null, tool: null, prompts: [], disposals: 0 };
  const ctx = {
    location: { directory: f.cwd },
    event: {
      subscribe: async (options, handler) => {
        registered.events = { options, handler };
        return () => { registered.disposals++; };
      },
    },
    tool: {
      hook: async (name, handler) => {
        registered.tool = { name, handler };
        return { dispose: () => { registered.disposals++; } };
      },
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, agent: 'build', model: { providerID: 'provider', id: 'model' } }),
      prompt: async request => { registered.prompts.push(request); },
    },
  };
  return { ctx, registered };
}

test('setup registers the event stream and the tool-after hook, and returns a working cleanup', async t => {
  const f = fixture(t);
  const { ctx, registered } = fakeContext(t, f);
  const dispose = await createV2Plugin(ctx, { env: f.env, mailbox: f.mailbox });
  assert.deepEqual(registered.events.options.types, ['session.created', 'session.updated', 'session.deleted',
    'session.status', 'session.idle', 'message.updated']);
  assert.equal(registered.tool.name, 'execute.after');
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(registered.disposals, 2);
});

test('a session.idle event reaches the adapter and records host presence', async t => {
  const f = fixture(t);
  const { ctx, registered } = fakeContext(t, f);
  await createV2Plugin(ctx, { env: f.env, mailbox: f.mailbox });
  await registered.events.handler({ type: 'session.idle', properties: { sessionID: f.binding.hostSessionId } });
  const host = createPresence({ home: f.home }).getHost({ client: 'opencode', hostSessionId: f.binding.hostSessionId });
  assert.equal(host.activity, 'idle');
});

test('execute.after carries the notice in result.output and preserves the rest of the payload', async t => {
  const f = fixture(t);
  const { ctx, registered } = fakeContext(t, f);
  f.send();
  await createV2Plugin(ctx, { env: f.env, mailbox: f.mailbox });
  const payload = { tool: 'bash', sessionID: f.binding.hostSessionId, agent: 'build', messageID: 'm1', id: 't1',
    status: 'completed', input: {}, result: { output: 'original\noutput', metadata: { key: 'retained' } } };
  await registered.tool.handler(payload);
  assert.match(payload.result.output, /^original\noutput\n\n\[💬 Agent Chat: 1 new message/);
  assert.deepEqual(payload.result.metadata, { key: 'retained' });
  assert.equal(payload.status, 'completed');
  const previous = payload.result.output;
  await registered.tool.handler(payload);
  assert.equal(payload.result.output, previous);
});

test('execute.after appends to an MCP content result and ignores failed tools', async t => {
  const f = fixture(t);
  const { ctx, registered } = fakeContext(t, f);
  f.send();
  await createV2Plugin(ctx, { env: f.env, mailbox: f.mailbox });
  const content = [{ type: 'text', text: 'tool output' }];
  const payload = { tool: 'agent-chat_chat_read', sessionID: f.binding.hostSessionId, status: 'completed', result: { content } };
  await registered.tool.handler(payload);
  assert.equal(payload.result.content.length, 2);
  assert.match(payload.result.content[1].text, /Agent Chat/);

  const failed = { tool: 'bash', sessionID: f.binding.hostSessionId, status: 'error', error: { message: 'boom' } };
  await registered.tool.handler(failed);
  assert.deepEqual(failed.error, { message: 'boom' });
});

test('a wake starts the prompt without awaiting the turn it begins', async t => {
  const f = fixture(t);
  const requested = [];
  const client = createV2Client({
    session: {
      get: async () => ({}),
      prompt: request => { requested.push(request); return new Promise(() => {}); },
    },
  });
  const result = await client.session.promptAsync({ path: { id: 'session-1' },
    body: { parts: [{ type: 'text', text: 'wake' }], agent: 'build', model: { providerID: 'p', modelID: 'm' } } });
  assert.deepEqual(result, { data: true });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].sessionID, 'session-1');
  assert.equal(requested[0].agent, 'build');
  assert.deepEqual(requested[0].parts, [{ type: 'text', text: 'wake' }]);
  const shim = await createV2Plugin(fakeContext(t, f).ctx, { env: f.env, mailbox: f.mailbox });
  assert.equal(typeof shim, 'function');
});

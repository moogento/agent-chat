import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailbox } from '../lib/mailbox.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { AgentChatPlugin } from '../integrations/opencode/agent-chat.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-opencode-wait-'));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const home = path.join(root, 'mailbox');
  const mailbox = createMailbox({ home, cwd });
  const room = mailbox.resolveRoom('await-room');
  const receiver = mailbox.claimIdentity(room, 'receiver', 'opencode', 'opencode-peer');
  const sender = mailbox.claimIdentity(room, 'sender', 'claude-code', 'claude-peer');
  const configFile = path.join(root, 'notifications.json');
  bindNotification({ configFile, binding: { client: 'opencode', hostSessionId: 'host-opencode', cwd,
    room: room.id, mailboxSessionId: receiver.sessionId } });
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: configFile };
  const prompts = [];
  const toasts = [];
  const sessionInfo = { id: 'host-opencode', agent: 'plan', model: { providerID: 'provider', id: 'model', variant: 'high' } };
  const client = { session: { get: async () => ({ data: sessionInfo }),
    promptAsync: async args => { prompts.push(args); return { data: true }; } },
    tui: { showToast: async args => { toasts.push(args); return { data: true }; } } };
  const cleanup = async adapter => {
    await adapter?.event({ event: { type: 'session.deleted', properties: { info: { id: 'host-opencode' } } } });
    fs.rmSync(root, { recursive: true, force: true });
  };
  t.after(async () => cleanup(t.adapter));
  return { mailbox, room, receiver, sender, cwd, env, client, sessionInfo, prompts, toasts };
}

async function until(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), 'Expected asynchronous OpenCode wake');
}

test('OpenCode resumes only the exact idle session for an explicitly awaited peer reply', async t => {
  const f = fixture(t);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 500 });
  t.adapter = adapter;
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  assert.equal(f.prompts.length, 0);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name,
    'private peer reply, do not put this into a wake prompt', f.sender.sessionId, f.receiver.sessionId);
  await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts[0].path, { id: 'host-opencode' });
  assert.equal(f.prompts[0].body.agent, 'plan');
  assert.equal(f.prompts[0].body.variant, 'high');
  assert.match(f.prompts[0].body.parts[0].text, /Call chat_read/);
  assert.doesNotMatch(JSON.stringify(f.prompts), /private peer reply/);
  assert.equal(f.mailbox.replyWaitStatus(f.receiver).state, 'replied', 'wake does not acknowledge the inbox');
  await adapter.event({ event: { type: 'message.updated', properties: { info: { sessionID: 'host-opencode', role: 'assistant' } } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.prompts.length, 1, 'one reply watch sends one wake prompt');
  assert.equal(f.toasts.length, 0, 'confirmed activity suppresses the fallback toast');
});

test('OpenCode ordinary messages do not create a wake or a polling timer', async t => {
  const f = fixture(t);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 50 });
  t.adapter = adapter;
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name,
    'ordinary unawaited message', f.sender.sessionId, f.receiver.sessionId);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(f.prompts.length, 0);
});

test('OpenCode ignores other senders and falls back to a toast if async wake is unconfirmed', async t => {
  const f = fixture(t);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 25 });
  t.adapter = adapter;
  const other = f.mailbox.claimIdentity(f.room, 'other', 'codex', 'other-peer');
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  await adapter.event({ event: { type: 'message.updated', properties: { info: {
    sessionID: 'host-opencode', role: 'assistant', providerID: 'provider', modelID: 'model',
  } } } });
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  f.mailbox.appendMessage(f.room, other.name, f.receiver.name, 'unrelated private message',
    other.sessionId, f.receiver.sessionId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.prompts.length, 0);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name, 'awaited private message',
    f.sender.sessionId, f.receiver.sessionId);
  await until(() => f.prompts.length === 1);
  assert.deepEqual(f.prompts[0].body.model, { providerID: 'provider', modelID: 'model' });
  await until(() => f.toasts.length === 1);
  assert.doesNotMatch(JSON.stringify(f.toasts), /awaited private message/);
  assert.equal(f.prompts.length, 1, 'an unconfirmed 204 does not create repeated prompts');
});

test('OpenCode shows a toast instead of changing agent when the current agent is unknown', async t => {
  const f = fixture(t);
  delete f.sessionInfo.agent;
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 25 });
  t.adapter = adapter;
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name, 'awaited reply',
    f.sender.sessionId, f.receiver.sessionId);
  assert.equal(f.mailbox.replyWaitStatus(f.receiver).state, 'replied');
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  await until(() => f.toasts.some(toast => /reply is ready/.test(toast.body.message)));
  assert.equal(f.prompts.length, 0);
});

test('OpenCode expiry fallback reports no reply instead of prompting chat_read', async t => {
  const f = fixture(t);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 25 });
  t.adapter = adapter;
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  const waitFile = path.join(f.mailbox.roomDir(f.room), 'reply-waits', `${f.receiver.sessionId}.json`);
  const wait = JSON.parse(fs.readFileSync(waitFile, 'utf8'));
  fs.writeFileSync(waitFile, JSON.stringify({ ...wait, deadlineAt: Date.now() - 1 }));
  delete f.client.session.promptAsync;
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  await until(() => f.toasts.length === 1);
  assert.equal(f.prompts.length, 0);
  assert.match(f.toasts[0].body.message, /expired without a reply/);
  assert.doesNotMatch(f.toasts[0].body.message, /reply is ready/);
});

test('OpenCode retries a transient watch inspection failure without waking the wrong session', async t => {
  const f = fixture(t);
  let inspections = 0;
  const flakyMailbox = { ...f.mailbox, replyWaitStatus: identity => {
    inspections++;
    if (inspections === 1) throw new Error('temporary mailbox failure');
    return f.mailbox.replyWaitStatus(identity);
  } };
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: flakyMailbox, watchPollMs: 10, wakeConfirmMs: 500 });
  t.adapter = adapter;
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name,
    'reply after transient failure', f.sender.sessionId, f.receiver.sessionId);
  await until(() => f.prompts.length === 1);
  assert.ok(inspections >= 2);
  assert.equal(f.prompts[0].path.id, 'host-opencode');
  assert.doesNotMatch(JSON.stringify(f.prompts), /reply after transient failure/);
});

test('OpenCode does not wake from a stale reply result after the watch was cancelled', async t => {
  const f = fixture(t);
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name,
    'reply being cancelled', f.sender.sessionId, f.receiver.sessionId);
  let inspections = 0;
  const mailbox = { ...f.mailbox, replyWaitStatus: identity => {
    inspections++;
    const status = f.mailbox.replyWaitStatus(identity);
    if (inspections === 1) f.mailbox.cancelReplyWait(identity);
    return status;
  } };
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox, watchPollMs: 10, wakeConfirmMs: 50 });
  t.adapter = adapter;
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(inspections, 2);
  assert.equal(f.prompts.length, 0);
});

test('OpenCode rechecks the watch after fetching the session profile', async t => {
  const f = fixture(t);
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name, 'reply being cancelled',
    f.sender.sessionId, f.receiver.sessionId);
  f.client.session.get = async () => {
    f.mailbox.cancelReplyWait(f.receiver);
    return { data: f.sessionInfo };
  };
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 25 });
  t.adapter = adapter;
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  assert.equal(f.prompts.length, 0);
});

test('OpenCode can wake on a later idle event after becoming busy during profile lookup', async t => {
  const f = fixture(t);
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name, 'awaited reply',
    f.sender.sessionId, f.receiver.sessionId);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 25 });
  t.adapter = adapter;
  let first = true;
  f.client.session.get = async () => {
    if (first) {
      first = false;
      await adapter.event({ event: { type: 'session.status', properties: {
        sessionID: 'host-opencode', status: { type: 'busy' },
      } } });
    }
    return { data: f.sessionInfo };
  };
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  assert.equal(f.prompts.length, 0);
  await adapter.event({ event: { type: 'session.status', properties: {
    sessionID: 'host-opencode', status: { type: 'idle' },
  } } });
  assert.equal(f.prompts.length, 1);
});

test('OpenCode waits for a confirmed idle status before prompting the session', async t => {
  const f = fixture(t);
  const adapter = await AgentChatPlugin({ client: f.client, directory: f.cwd },
    { env: f.env, mailbox: f.mailbox, watchPollMs: 10, wakeConfirmMs: 500 });
  t.adapter = adapter;
  f.mailbox.beginReplyWait(f.receiver, f.sender.sessionId, 1);
  await adapter.event({ event: { type: 'session.idle', properties: { sessionID: 'host-opencode' } } });
  await adapter.event({ event: { type: 'session.status', properties: {
    sessionID: 'host-opencode', status: { type: 'busy' },
  } } });
  f.mailbox.appendMessage(f.room, f.sender.name, f.receiver.name, 'reply while busy',
    f.sender.sessionId, f.receiver.sessionId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.prompts.length, 0);
  await adapter.event({ event: { type: 'session.status', properties: {
    sessionID: 'host-opencode', status: { type: 'idle' },
  } } });
  await until(() => f.prompts.length === 1);
});

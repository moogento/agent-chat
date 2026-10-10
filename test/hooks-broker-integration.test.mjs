import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createBroker } from '../lib/broker.mjs';
import { createRemoteSession, remoteRpc, acknowledgeRemoteResponse, inspectRemoteNotifications } from '../lib/broker-client.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { runCommandHook } from '../hooks/notifications.mjs';
import { AgentChatPlugin } from '../integrations/opencode/agent-chat.mjs';

async function fixture(t, client = 'codex') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-live-hooks-')));
  const cwd = path.join(root, 'client-worktree'); fs.mkdirSync(cwd);
  const tokenFile = path.join(root, 'broker-token'); fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const brokerHome = path.join(root, 'broker-storage');
  let broker;
  t.after(async () => { try { await broker?.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  broker = await createBroker({ home: brokerHome, tokenFile });
  const room = 'hook-integration';
  const sessionDir = path.join(root, 'recipient-credentials');
  const recipient = await createRemoteSession({ url: broker.url, tokenFile, room, name: 'recipient', client, clientCwd: cwd, sessionDir });
  const sender = await createRemoteSession({ url: broker.url, tokenFile, room, name: 'sender', client: 'sender', clientCwd: cwd,
    sessionDir: path.join(root, 'sender-credentials') });
  let id = 0;
  const tool = async (session, name, args = {}) => {
    const result = await remoteRpc(session, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    const response = result.responses.find(response => response.id === id);
    assert.ok(response && !response.error && !response.result?.isError, JSON.stringify(response));
    await acknowledgeRemoteResponse(session, result.receipt);
    return response.result;
  };
  const identity = await tool(recipient, 'chat_who');
  const configFile = path.join(root, 'notifications.json');
  const env = { ...process.env, AGENT_CHAT_BROKER_URL: broker.url, AGENT_CHAT_BROKER_TOKEN_FILE: tokenFile,
    AGENT_CHAT_BROKER_SESSION_DIR: sessionDir, AGENT_CHAT_ROOM: room, AGENT_CHAT_HOME: path.join(root, 'unused-local-mailbox'),
    AGENT_CHAT_NOTIFY_CONFIG: configFile, AGENT_CHAT_NOTIFY_AUTO_BIND: '1',
    AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: client === 'claude-code' ? 'mcp__agent-chat__chat_who' : 'mcp__agent_chat__chat_who' };
  delete env.AGENT_CHAT_NOTIFY_DEBUG;
  delete env.CLAUDE_PROJECT_DIR;
  env.CODEX_HOME = path.join(root, 'codex-home');
  const payload = { session_id: 'live-host', cwd, hook_event_name: 'PostToolUse', tool_name: env.AGENT_CHAT_NOTIFY_IDENTITY_TOOLS,
    tool_response: identity };
  const send = text => tool(sender, 'chat_send', { to: identity.structuredContent.agentChatIdentity.name, text });
  return { root, cwd, tokenFile, broker, brokerHome, room, sessionDir, recipient, sender, tool, identity, configFile, env, payload, send };
}

function executeHook(payload, env, client = 'codex') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('hooks/notify.mjs'), client], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Broker hook executable timed out')); }, 5000);
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

for (const client of ['codex', 'claude-code']) {
test(`real broker ${client} executable auto-binds and reports counts without consuming chat_read`, async t => {
  const f = await fixture(t, client);
  const other = await createRemoteSession({ url: f.broker.url, tokenFile: f.tokenFile, room: 'another-room', name: 'other-sender',
    clientCwd: f.cwd, sessionDir: path.join(f.root, 'other-credentials') });
  await f.tool(other, 'chat_send', { to: 'all', text: 'different room private text' });
  await f.send('private broker message');
  const first = await executeHook(f.payload, f.env, client);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /1 new message/);
  assert.doesNotMatch(first.stdout, /private broker message|different room private text/);
  assert.equal((await executeHook(f.payload, f.env, client)).stdout, '');
  assert.equal(fs.existsSync(f.env.AGENT_CHAT_HOME), false);
  const unread = await f.tool(f.recipient, 'chat_read', { wait_seconds: 0 });
  assert.match(JSON.stringify(unread), /private broker message/);
  assert.doesNotMatch(JSON.stringify(unread), /different room private text/);
  await f.send('already consumed message');
  await f.tool(f.recipient, 'chat_read', { wait_seconds: 0 });
  assert.equal((await executeHook(f.payload, f.env, client)).stdout, '');
});
}

test('broker Stop wakes the exact bound session for its watched reply and SessionEnd cancels another watch', async t => {
  const f = await fixture(t, 'claude-code');
  assert.equal((await executeHook(f.payload, f.env, 'claude-code')).status, 0);
  const request = await f.tool(f.recipient, 'chat_send', { to: 'sender', text: 'Please send a result', await_reply_minutes: 1 });
  assert.match(JSON.stringify(request), /Watching for a reply/);
  const stop = { session_id: f.payload.session_id, cwd: f.cwd, hook_event_name: 'Stop' };
  const other = await createRemoteSession({ url: f.broker.url, tokenFile: f.tokenFile, room: f.room, name: 'unrelated',
    clientCwd: f.cwd, sessionDir: path.join(f.root, 'unrelated-credentials') });
  await f.tool(other, 'chat_send', { to: 'recipient', text: 'wrong sender private text' });
  await f.send('watched private reply');
  const wake = await executeHook(stop, f.env, 'claude-code');
  assert.equal(wake.status, 0, wake.stderr);
  assert.equal(JSON.parse(wake.stdout).decision, 'block');
  assert.match(wake.stdout, /chat_read/);
  assert.doesNotMatch(wake.stdout, /private text|private reply/);
  assert.equal((await executeHook(stop, f.env, 'claude-code')).stdout, '{}\n');
  const unread = await f.tool(f.recipient, 'chat_read', { wait_seconds: 0 });
  assert.match(JSON.stringify(unread), /watched private reply/);
  const second = await f.tool(f.recipient, 'chat_send', { to: 'sender', text: 'Please send another result', await_reply_minutes: 2 });
  assert.match(JSON.stringify(second), /Watching for a reply/);
  const ended = await executeHook({ ...stop, hook_event_name: 'SessionEnd' }, f.env, 'claude-code');
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(ended.stdout, '');
  const status = await f.tool(f.recipient, 'chat_wait_status');
  assert.match(JSON.stringify(status), /No active reply watch/);
});

test('real broker hooks cannot bind a session whose private credential belongs to another client', async t => {
  const f = await fixture(t);
  await f.send('unread private data');
  const env = { ...f.env, AGENT_CHAT_BROKER_SESSION_DIR: path.join(f.root, 'sender-credentials') };
  await assert.rejects(runCommandHook({ client: 'codex', payload: f.payload, env, write: () => assert.fail('another session credential') }), /Broker notification inspection failed/);
  assert.equal(fs.existsSync(f.configFile), false);
  const output = await executeHook(f.payload, env);
  assert.deepEqual(output, { status: 0, stdout: '', stderr: '' });
  await assert.rejects(inspectRemoteNotifications({ url: f.broker.url, tokenFile: f.tokenFile, room: f.room,
    sessionId: f.recipient.sessionId, sessionDir: path.join(f.root, 'sender-credentials') }));
  assert.match(JSON.stringify(await f.tool(f.recipient, 'chat_read', { wait_seconds: 0 })), /unread private data/);
});

test('real broker OpenCode notices preserve tool output, use idle toasts and leave unread data intact', async t => {
  const f = await fixture(t, 'opencode');
  const metadata = f.identity.structuredContent.agentChatIdentity;
  bindNotification({ configFile: f.configFile, binding: { client: 'opencode', hostSessionId: 'live-host', cwd: f.cwd,
    room: f.room, mailboxSessionId: metadata.sessionId, brokerUrl: f.broker.url } });
  await f.send('private opencode broker message');
  const toasts = [];
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: { tui: { showToast: async value => { toasts.push(value); return { data: true }; } },
    session: { prompt() { assert.fail('notification must not start a turn'); } } } }, { env: f.env });
  const output = { output: 'normal tool result', metadata: { retained: true } };
  await plugin['tool.execute.after']({ sessionID: 'live-host' }, output);
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'live-host' } } });
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'live-host' } } });
  assert.match(output.output, /^normal tool result\n\n\[💬 Agent Chat: 1 new message/);
  assert.deepEqual(output.metadata, { retained: true });
  assert.equal(toasts.length, 1);
  assert.doesNotMatch(output.output + toasts[0].body.message, /private opencode broker message/);
  assert.match(JSON.stringify(await f.tool(f.recipient, 'chat_read', { wait_seconds: 0 })), /private opencode broker message/);
});

test('real broker OpenCode resumes only its bound idle session for an awaited reply', async t => {
  const f = await fixture(t, 'opencode');
  const metadata = f.identity.structuredContent.agentChatIdentity;
  bindNotification({ configFile: f.configFile, binding: { client: 'opencode', hostSessionId: 'live-host', cwd: f.cwd,
    room: f.room, mailboxSessionId: metadata.sessionId, brokerUrl: f.broker.url } });
  const sender = (await f.tool(f.sender, 'chat_who')).structuredContent.agentChatIdentity;
  await f.tool(f.recipient, 'chat_send', { to: sender.name, text: 'Please review this change', await_reply_minutes: 1 });
  await f.tool(f.sender, 'chat_send', { to: metadata.name, text: 'Private review reply' });
  const prompts = [];
  const plugin = await AgentChatPlugin({ directory: f.cwd, client: {
    session: { get: async () => ({ data: { id: 'live-host', agent: 'plan',
      model: { providerID: 'provider', id: 'model', variant: 'high' } } }),
    promptAsync: async value => { prompts.push(value); return { data: true }; } },
    tui: { showToast: async () => ({ data: true }) },
  } }, { env: f.env });
  await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'live-host' } } });
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].path, { id: 'live-host' });
  assert.equal(prompts[0].body.agent, 'plan');
  assert.equal(prompts[0].body.variant, 'high');
  assert.match(prompts[0].body.parts[0].text, /Call chat_read/);
  assert.doesNotMatch(JSON.stringify(prompts), /Private review reply/);
  assert.match(JSON.stringify(await f.tool(f.recipient, 'chat_wait_status')), /Reply received/);
  await plugin.event({ event: { type: 'session.deleted', properties: { info: { id: 'live-host' } } } });
});

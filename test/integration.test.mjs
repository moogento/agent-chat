import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMailbox } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { AgentChatPlugin } from '../integrations/opencode/agent-chat.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-integration-')));
  const cwd = path.join(temp, 'project');
  fs.mkdirSync(cwd);
  const home = path.join(temp, 'mailbox');
  const configFile = path.join(temp, 'notifications.json');
  const mailbox = createMailbox({ home, cwd });
  const responses = [];
  const server = createServer({ mailbox, output: value => responses.push(value) });
  t.after(() => { server.stop(); fs.rmSync(temp, { recursive: true, force: true }); });
  const env = { ...process.env, AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: configFile,
    AGENT_CHAT_NOTIFY_AUTO_BIND: '1', AGENT_CHAT_NOTIFY_DEBUG: '0',
    AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: 'mcp__agent-chat__chat_join' };
  return { cwd, home, configFile, mailbox, responses, server, env };
}
function run(file, args, env, input) {
  const child = spawnSync(process.execPath, [path.join(root, file), ...args], {
    env, input, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout;
}
async function join(fixture) {
  await fixture.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'chat_join', arguments: { name: 'reviewer', room: 'integration' } } });
  const response = fixture.responses.at(-1).result;
  assert.equal(response.isError, undefined);
  return response;
}
for (const client of ['codex', 'claude-code']) {
  test(`${client} executable hook binds real MCP metadata and preserves the real inbox`, async t => {
    const f = fixture(t);
    const response = await join(f);
    const payload = { session_id: 'host-integration', cwd: f.cwd, hook_event_name: 'PostToolUse',
      tool_name: 'mcp__agent-chat__chat_join', tool_response: response };
    const hook = value => run('hooks/notify.mjs', [client], f.env, JSON.stringify(value));
    assert.equal(hook(payload), '');
    assert.ok(fs.existsSync(f.configFile), 'Successful identity result establishes the binding.');
    run('agent-chat.mjs', ['send', '--room', 'integration', '--to', 'reviewer', 'integration message'], f.env);
    const prompt = { session_id: payload.session_id, cwd: f.cwd, hook_event_name: 'UserPromptSubmit' };
    const notice = JSON.parse(hook(prompt));
    assert.match(notice.hookSpecificOutput.additionalContext, /^💬 Agent Chat: 1 new message/);
    assert.doesNotMatch(JSON.stringify(notice), /integration message/);
    assert.equal(hook(prompt), '', 'Repeated lifecycle events do not repeat the hint.');
    assert.match(await f.server.callTool('chat_read'), /^💬 Agent Chat \| .*integration message/);
    assert.equal(hook(prompt), '', 'Reading the message remains silent afterwards.');
  });
}
test('OpenCode adapter reads the shared core mailbox without acknowledging messages', async t => {
  const f = fixture(t);
  const response = await join(f);
  bindNotification({ configFile: f.configFile, binding: { client: 'opencode', hostSessionId: 'host-opencode',
    cwd: f.cwd, room: response.structuredContent.agentChatIdentity.room,
    mailboxSessionId: response.structuredContent.agentChatIdentity.sessionId } });
  const adapter = await AgentChatPlugin({ client: {}, directory: f.cwd }, { env: f.env });
  run('agent-chat.mjs', ['send', '--room', 'integration', '--to', 'reviewer', 'OpenCode integration message'], f.env);
  const output = { output: 'original tool output' };
  await adapter['tool.execute.after']({ sessionID: 'host-opencode' }, output);
  assert.match(output.output, /^original tool output/);
  assert.match(output.output, /1 new message/);
  assert.doesNotMatch(output.output, /OpenCode integration message/);
  assert.match(await f.server.callTool('chat_read'), /OpenCode integration message/);
});

// Optional real-container integration checks. Never run by the default test suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-docker-'));
const project = `agent-chat-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const tokenFile = path.join(temp, 'broker-token');
fs.writeFileSync(tokenFile, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o444 });
if (process.platform !== 'win32') fs.chmodSync(tokenFile, 0o444);
const env = { ...process.env, AGENT_CHAT_TOKEN_FILE: tokenFile, AGENT_CHAT_ROOM: 'docker-integration', AGENT_CHAT_IMAGE: `${project}:local` };
const composeArgs = ['compose', '--project-name', project, '--file', path.join(root, 'examples/docker/compose.yaml')];
const children = new Set();
let created = false;
let cleanupFailed = false;
const log = message => process.stdout.write(`${message}\n`);
async function docker(args, timeout = 120000) {
  const result = await exec('docker', args, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}
const compose = (args, timeout) => docker([...composeArgs, ...args], timeout);
async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
async function waitForHealth(url) {
  const deadline = Date.now() + 20000;
  do {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).ok) return;
    } catch { /* Container and host port forwarding can become ready at different times. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('Broker did not become reachable after restart.');
}
class Mcp {
  constructor(command, args, childEnv = env) {
    this.child = spawn(command, args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(this.child); this.pending = new Map(); this.next = 0; this.stderr = ''; this.buffer = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-8192); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('data', data => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); } catch { this.fail(new Error('Non-JSON data on MCP stdout')); continue; }
        const waiter = this.pending.get(response.id);
        if (waiter) { clearTimeout(waiter.timer); this.pending.delete(response.id); response.error ? waiter.reject(new Error(response.error.message)) : waiter.resolve(response.result); }
      }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => { children.delete(this.child); this.fail(new Error(`MCP exited ${code}: ${this.stderr}`)); });
  }
  fail(error) { for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.pending.clear(); }
  request(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out: ${this.stderr}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async start(name) {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name, version: 'test' } });
    return this.call('chat_join', { name, room: env.AGENT_CHAT_ROOM });
  }
  async call(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  }
  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
  }
}
const text = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';

try {
  await docker(['version', '--format', '{{.Server.Version}}'], 15000);
  await docker(['compose', 'version'], 15000);
  // A port published as 0 can change on a container restart. Pick an available
  // port first, then publish that exact value for a stable authenticated endpoint.
  env.AGENT_CHAT_PORT = String(await availablePort());
  log('Building an isolated broker image and starting its private mailbox volume.');
  created = true;
  await compose(['up', '--build', '--detach', '--wait', '--wait-timeout', '60', 'broker'], 240000);
  const address = await compose(['port', 'broker', '47321']);
  const url = `http://${address}`;
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  await waitForHealth(url);
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  assert.equal(health.ok, true);
  const unauthorized = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  const ownership = JSON.parse(await compose(['exec', '-T', 'broker', 'node', '-e', "const fs=require('fs'); const s=fs.statSync('/data'); console.log(JSON.stringify({uid:process.getuid(),owner:s.uid,mode:s.mode&511}))"]));
  assert.equal(ownership.uid, 1000); assert.equal(ownership.owner, 1000); assert.equal(ownership.mode, 0o700);
  const hostEnv = { ...env, AGENT_CHAT_BROKER_URL: url, AGENT_CHAT_BROKER_TOKEN_FILE: tokenFile,
    AGENT_CHAT_BROKER_SESSION_DIR: path.join(temp, 'sessions'), AGENT_CHAT_BROKER_SESSION_FILE: path.join(temp, 'reviewer-session.json'),
    AGENT_CHAT_HOME: path.join(temp, 'unused-local-mailbox') };
  let reviewer = new Mcp(process.execPath, [path.join(root, 'agent-chat.mjs'), 'proxy'], hostEnv);
  const identity = await reviewer.start('reviewer');
  const agents = ['builder', 'tester'].map(name => new Mcp('docker', [...composeArgs, 'run', '--rm', '--no-deps', '-T', '--name', `${project}-${name}`, 'agent']));
  await Promise.all(agents.map((agent, index) => agent.start(index ? 'tester' : 'builder')));
  log('Exchanging concurrent messages from two separate agent containers to a host agent.');
  for (const name of ['builder', 'tester']) {
    const mounts = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', `${project}-${name}`]));
    assert.ok(!mounts.some(mount => mount.Destination === '/data'), 'Agent containers must not mount the mailbox.');
  }
  await Promise.all(Array.from({ length: 12 }, (_, index) => agents[index % 2].call('chat_send', { to: 'reviewer', text: `container-message-${index}` })));
  const received = text(await reviewer.call('chat_read', { limit: 100 }));
  for (let index = 0; index < 12; index++) assert.match(received, new RegExp(`container-message-${index}(?!\\d)`));
  assert.doesNotMatch(text(await reviewer.call('chat_read')), /container-message/);
  assert.equal(fs.existsSync(path.join(temp, 'unused-local-mailbox')), false, 'Host proxy must not create a local mailbox.');

  log('Checking a real notification adapter against the broker without consuming the inbox.');
  const hookEnv = { ...hostEnv, AGENT_CHAT_NOTIFY_CONFIG: path.join(temp, 'notifications.json'), AGENT_CHAT_NOTIFY_AUTO_BIND: '1',
    AGENT_CHAT_NOTIFY_IDENTITY_TOOLS: 'mcp__agent-chat__chat_join' };
  async function hook(payload) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'hooks/notify.mjs'), 'claude-code'], { cwd: root, env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
      child.on('error', reject); child.on('exit', code => code ? reject(new Error(stderr)) : resolve(stdout));
      child.stdin.end(JSON.stringify(payload));
    });
  }
  const host = { session_id: 'docker-host-session', cwd: root };
  await hook({ ...host, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-chat__chat_join', tool_response: identity });
  await agents[0].call('chat_send', { to: 'reviewer', text: 'broker-notification-private-text' });
  const notice = await hook({ ...host, hook_event_name: 'UserPromptSubmit' });
  assert.match(notice, /1 new message/); assert.doesNotMatch(notice, /broker-notification-private-text/);
  assert.match(text(await reviewer.call('chat_read')), /broker-notification-private-text/);

  log('Restarting the broker and host adapter, preserving the authenticated session and cursor.');
  const before = identity.structuredContent.agentChatIdentity.sessionId;
  await agents[0].call('chat_send', { to: 'reviewer', text: 'persisted-across-restart' });
  await reviewer.stop();
  await compose(['restart', '--no-deps', 'broker']);
  await waitForHealth(url);
  reviewer = new Mcp(process.execPath, [path.join(root, 'agent-chat.mjs'), 'proxy'], hostEnv);
  const resumed = await reviewer.start('reviewer');
  assert.equal(resumed.structuredContent.agentChatIdentity.sessionId, before);
  assert.doesNotMatch(text(await reviewer.call('chat_who')), /"builder"|"tester"/, 'Previous broker leases must not appear active after a restart.');
  assert.match(text(await reviewer.call('chat_read')), /persisted-across-restart/);
  assert.doesNotMatch(text(await reviewer.call('chat_read')), /container-message|persisted-across-restart/);
  const reconnected = new Mcp('docker', [...composeArgs, 'run', '--rm', '--no-deps', '-T', '--name', `${project}-reconnected`, 'agent']);
  await reconnected.start('reconnected');
  await reconnected.call('chat_send', { to: 'reviewer', text: 'fresh-container-after-restart' });
  assert.match(text(await reviewer.call('chat_read')), /fresh-container-after-restart/);
  const credentials = fs.statSync(hostEnv.AGENT_CHAT_BROKER_SESSION_FILE);
  if (process.platform !== 'win32') assert.equal(credentials.mode & 0o077, 0);
  await Promise.all([reviewer.stop(), reconnected.stop(), ...agents.map(agent => agent.stop())]);
  log('Docker broker integration checks passed.');
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (created) {
    try { await compose(['down', '--volumes', '--remove-orphans'], 60000); }
    catch {
      cleanupFailed = true; process.exitCode = 1;
      process.stderr.write(`Cleanup failed. Temporary credentials retained at ${temp}. Set AGENT_CHAT_TOKEN_FILE to ${tokenFile}, then run docker compose --project-name ${project} --file examples/docker/compose.yaml down --volumes after restoring Docker access.\n`);
    }
    try { await docker(['image', 'rm', `${project}:local`], 30000); } catch { /* No image was built, or Docker is unavailable. */ }
  }
  if (!cleanupFailed) fs.rmSync(temp, { recursive: true, force: true });
}

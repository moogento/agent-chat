import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entry = fileURLToPath(new URL('../agent-chat.mjs', import.meta.url));
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-cli-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}
function run(args, cwd) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  return result;
}
test('install with no explicit clients only detects and never writes client settings', t => {
  const project = fixture(t);
  fs.mkdirSync(path.join(project, '.claude'));
  const result = run(['install', '--project', project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.action, 'detect');
  assert.ok(response.detected.includes('claude'));
  assert.deepEqual(fs.readdirSync(project), ['.claude']);
});
test('invalid or contradictory management options cannot change the project', t => {
  const project = fixture(t);
  for (const args of [
    ['install', '--clients', 'claude', '--hooks', '--no-hooks'],
    ['install', '--clients', 'claude', '--hooks', '--wake-permission', '--no-wake-permission'],
    ['uninstall', '--no-wake-permission'],
    ['install', '--clients', ''],
    ['install', '--clients', 'claude,'],
    ['install', '--clients', 'unknown'],
    ['uninstall', '--hooks'],
    ['doctor', '--unexpected'],
  ]) {
    const result = run([...args, '--project', project]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(project), []);
  }
});
test('doctor emits valid JSON and a failing status for an uninstalled project without writes', t => {
  const project = fixture(t);
  const result = run(['doctor', '--project', project, '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'not-installed');
  assert.equal(report.ok, false);
  assert.deepEqual(fs.readdirSync(project), []);
});
test('blank explicit project paths never fall back to the current directory', t => {
  const project = fixture(t);
  for (const command of ['install', 'update', 'uninstall', 'doctor']) {
    for (const blank of ['', '   ']) {
      const result = run([command, '--project', blank, ...(command === 'install' ? ['--clients', 'claude'] : [])], project);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--project must be a nonempty path/);
      assert.deepEqual(fs.readdirSync(project), []);
    }
  }
});
test('management CLI forwards broker settings and can explicitly restore local transport', t => {
  const project = fixture(t);
  const tokenFile = path.join(project, 'broker-token');
  let result = run(['install', '--project', project, '--clients', 'claude', '--broker-url', 'http://broker:47321', '--broker-token-file', tokenFile, '--room', 'portable-task', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const config = () => JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['agent-chat'].env;
  assert.equal(config().AGENT_CHAT_BROKER_URL, 'http://broker:47321');
  assert.equal(config().AGENT_CHAT_ROOM, 'portable-task');
  result = run(['update', '--project', project, '--local', '--broker-url', 'http://broker:47321']);
  assert.notEqual(result.status, 0);
  assert.equal(config().AGENT_CHAT_BROKER_URL, 'http://broker:47321');
  result = run(['update', '--project', project, '--local', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(config().AGENT_CHAT_BROKER_URL, '');
});
test('management CLI accepts a named local default and preserves it on update', t => {
  const project = fixture(t);
  let result = run(['install', '--project', project, '--clients', 'claude', '--room', 'm2-moo', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const config = () => JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['agent-chat'].env;
  assert.equal(config().AGENT_CHAT_ROOM, 'm2-moo');
  result = run(['update', '--project', project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(config().AGENT_CHAT_ROOM, 'm2-moo');
  result = run(['update', '--project', project, '--local', '--room', 'other-room', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(config().AGENT_CHAT_ROOM, 'other-room');
});
test('management CLI persists --no-wake-permission until --wake-permission re-enables it', t => {
  const project = fixture(t);
  const instructions = () => fs.existsSync(path.join(project, 'CLAUDE.md')) ? fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8') : null;
  let result = run(['install', '--project', project, '--clients', 'claude', '--hooks', '--no-wake-permission', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).wakePermission.claude, false);
  assert.equal(instructions(), null);
  result = run(['update', '--project', project, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(instructions(), null);
  result = run(['update', '--project', project, '--wake-permission', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /create: CLAUDE\.md/);
  assert.equal(instructions(), null);
  result = run(['update', '--project', project, '--wake-permission']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(instructions(), /^<!-- >>> agent-chat managed instructions >>> -->\n\n## Agent Chat\n\n/);
});

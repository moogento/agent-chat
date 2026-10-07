import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { doctorProject } from '../lib/doctor.mjs';
import { installProject, inspectInstallation, installationPaths } from '../lib/install.mjs';
import { bindNotification } from '../hooks/bind.mjs';

function fixture(t, options = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-doctor-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  if (options.install !== false) installProject({ project, clients: options.clients || ['codex', 'claude', 'opencode'], hooks: Boolean(options.hooks) });
  return { project, paths: installationPaths(project) };
}

function snapshot(directory) {
  const output = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const relative = path.relative(directory, file);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) output[relative] = { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtime: fs.statSync(file).mtimeMs };
      else output[relative] = 'non-file';
    }
  }
  visit(directory);
  return output;
}

const check = (report, id) => report.checks.filter(value => value.id === id);

test('doctor checks broker credential availability without exposing credentials or connecting', async t => {
  const { project } = fixture(t, { install: false });
  const tokenFile = path.join(project, 'broker-token');
  installProject({ project, clients: 'claude', brokerUrl: 'http://127.0.0.1:1', brokerTokenFile: tokenFile, room: 'test-task' });
  const missing = await doctorProject({ project });
  assert.equal(check(missing, 'claude.broker-token')[0].status, 'error');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.ok, true);
  assert.equal(check(result, 'claude.broker-token')[0].status, 'ok');
  assert.equal(check(result, 'claude.transport')[0].status, 'warning');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.deepEqual(snapshot(project), before);
});

test('doctor is read-only and verifies actual project installation for all clients', async t => {
  const { project } = fixture(t);
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.clients, ['codex', 'claude', 'opencode']);
  assert.equal(check(result, 'runtime.files')[0].status, 'ok');
  for (const client of result.clients) {
    assert.equal(check(result, `${client}.mcp`)[0].status, 'ok');
    assert.equal(check(result, `${client}.skill`)[0].status, 'ok');
    assert.equal(check(result, `${client}.hooks`)[0].status, 'ok');
  }
  assert.ok(result.hints.some(value => /Restart or reload/.test(value)));
  assert.deepEqual(snapshot(project), before);
});

test('doctor reports missing installation without creating project or mailbox files', async t => {
  const { project } = fixture(t, { install: false });
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.status, 'not-installed');
  assert.equal(result.ok, false);
  assert.match(check(result, 'installation')[0].message, /Run agent-chat install/);
  assert.deepEqual(snapshot(project), before);
  const missing = path.join(project, 'missing');
  assert.equal((await doctorProject({ project: missing })).ok, false);
  assert.equal(fs.existsSync(missing), false);
});

test('doctor reads actual native client config instead of trusting a receipt', async t => {
  const { project } = fixture(t);
  const file = path.join(project, '.mcp.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.mcpServers['agent-chat'].args = ['/wrong/runtime/agent-chat.mjs'];
  config.mcpServers['agent-chat'].env.API_KEY = 'do-not-print-this-secret';
  fs.writeFileSync(file, JSON.stringify(config));
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.ok, false);
  assert.equal(check(result, 'claude.mcp')[0].status, 'error');
  assert.equal(check(result, 'codex.mcp')[0].status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /do-not-print-this-secret|wrong\/runtime/);
  assert.deepEqual(snapshot(project), before);
});

test('doctor reports malformed configuration without exposing source snippets or credentials', async t => {
  const { project } = fixture(t, { clients: ['claude'] });
  fs.writeFileSync(path.join(project, '.mcp.json'), '{"API_KEY":"private-config-credential",');
  const result = await doctorProject({ project });
  assert.equal(result.ok, false);
  assert.match(check(result, 'claude.mcp')[0].message, /malformed|syntax/);
  assert.doesNotMatch(JSON.stringify(result), /private-config-credential|API_KEY/);
});

test('doctor identifies altered and missing runtime files and version drift', async t => {
  const { project, paths } = fixture(t, { clients: ['codex'] });
  const outdated = await doctorProject({ project, expectedVersion: '99.0.0' });
  assert.equal(outdated.ok, true);
  assert.equal(outdated.runtime.status, 'outdated');
  fs.appendFileSync(path.join(paths.runtime, 'agent-chat.mjs'), '\n// changed locally\n');
  const altered = await doctorProject({ project });
  assert.equal(check(altered, 'runtime.files')[0].status, 'error');
  assert.equal(altered.runtime.status, 'changed');
  fs.rmSync(path.join(paths.runtime, 'lib/mailbox.mjs'));
  const missing = await doctorProject({ project });
  assert.equal(missing.ok, false);
  assert.equal(check(missing, 'runtime.entrypoints')[0].status, 'error');
});

test('doctor diagnoses optional hooks and pending binding as warnings without claiming trust', async t => {
  const { project } = fixture(t, { clients: ['codex', 'claude'], hooks: true });
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, 'attention');
  assert.equal(check(result, 'codex.notifications')[0].status, 'warning');
  assert.equal(check(result, 'claude.notifications')[0].status, 'warning');
  assert.ok(result.hints.some(value => /review and trust/.test(value)));
  assert.deepEqual(snapshot(project), before);
  const hookFile = path.join(project, '.claude/settings.local.json');
  const config = JSON.parse(fs.readFileSync(hookFile, 'utf8'));
  config.hooks.UserPromptSubmit[0].hooks[0].command = 'wrong-command';
  fs.writeFileSync(hookFile, JSON.stringify(config));
  assert.ok(check(await doctorProject({ project }), 'claude.hooks').some(value => value.status === 'error'));
});

test('doctor reports binding counts without exposing session IDs or room contents', async t => {
  const { project, paths } = fixture(t, { clients: ['codex'], hooks: true });
  bindNotification({ configFile: paths.notificationConfig, binding: { client: 'codex', hostSessionId: 'private-host-session',
    cwd: project, room: 'private-room', mailboxSessionId: 'private-mailbox-session' } });
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(check(result, 'codex.notifications')[0].status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /private-host-session|private-mailbox-session|private-room/);
  assert.deepEqual(snapshot(project), before);
});

test('doctor diagnoses duplicate or malformed bindings without writing to them', async t => {
  const { project, paths } = fixture(t, { clients: ['codex'], hooks: true });
  const binding = { client: 'codex', hostSessionId: 'host', cwd: project, room: 'room', mailboxSessionId: 'mailbox' };
  fs.writeFileSync(paths.notificationConfig, JSON.stringify({ version: 1, bindings: [binding, binding] }));
  assert.equal(check(await doctorProject({ project }), 'codex.notifications')[0].status, 'error');
  fs.writeFileSync(paths.notificationConfig, '{"secret":"binding-secret",');
  const result = await doctorProject({ project });
  assert.equal(check(result, 'codex.notifications')[0].status, 'error');
  assert.doesNotMatch(JSON.stringify(result), /binding-secret/);
});

test('doctor respects client selection and notices conflicting OpenCode JSONC settings', async t => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, 'opencode.jsonc'), '// user-managed settings\n{}');
  assert.equal(check(await doctorProject({ project }), 'opencode.config-format')[0].status, 'error');
  const claude = await doctorProject({ project, client: 'claude-code' });
  assert.equal(claude.ok, true);
  assert.deepEqual(claude.clients, ['claude']);
  assert.equal(check(claude, 'opencode.config-format').length, 0);
});

test('doctor treats malformed receipts and redirected managed files as actionable', async t => {
  const { project, paths } = fixture(t, { clients: ['codex'] });
  const receipt = fs.readFileSync(paths.receipt);
  fs.writeFileSync(paths.receipt, '{"private":"receipt-secret",');
  const malformed = await doctorProject({ project });
  assert.equal(malformed.ok, false);
  assert.doesNotMatch(JSON.stringify(malformed), /receipt-secret/);
  fs.writeFileSync(paths.receipt, receipt);
  const file = path.join(paths.runtime, 'lib/presentation.mjs');
  fs.rmSync(file);
  const elsewhere = path.join(project, 'elsewhere.mjs');
  fs.writeFileSync(elsewhere, 'export const CHAT_LABEL = "other";');
  try { fs.symlinkSync(elsewhere, file, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('symlink privilege unavailable'); return; } throw error; }
  const result = await doctorProject({ project });
  assert.equal(result.ok, false);
  assert.equal(check(result, 'installation')[0].status, 'error');
  assert.throws(() => inspectInstallation({ project }), /symlink/);
});

test('doctor detects a configured Node executable removed after installation without spawning it', async t => {
  const { project } = fixture(t, { install: false });
  const executable = path.join(project, process.platform === 'win32' ? 'old-node.exe' : 'old-node');
  fs.writeFileSync(executable, 'this is deliberately not a working Node executable\n', { mode: 0o755 });
  installProject({ project, clients: ['codex', 'claude', 'opencode'], nodePath: executable });
  const available = await doctorProject({ project });
  for (const client of available.clients) assert.equal(check(available, `${client}.node`)[0].status, 'ok');
  if (process.platform !== 'win32') {
    fs.chmodSync(executable, 0o644);
    assert.equal(check(await doctorProject({ project }), 'codex.node')[0].status, 'error');
  }
  fs.rmSync(executable);
  const missing = await doctorProject({ project });
  assert.equal(missing.ok, false);
  for (const client of missing.clients) assert.equal(check(missing, `${client}.node`)[0].status, 'error');
});

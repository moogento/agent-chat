import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { doctorProject } from '../lib/doctor.mjs';
import { installProject, updateProject, inspectInstallation, installationPaths } from '../lib/install.mjs';
import { bindNotification } from '../hooks/bind.mjs';
import { NOTIFICATION_LIMITS } from '../hooks/notifications.mjs';

function fixture(t, options = {}) {
  const project = (process.platform === 'win32' || process.platform === 'darwin' ? fs.realpathSync.native : fs.realpathSync)(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-doctor-')));
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

test('doctor explains named defaults and detects path/literal split using only room metadata', async t => {
  const { project } = fixture(t, { install: false });
  installProject({ project, clients: 'claude', room: 'm2-moo' });
  const home = path.join(project, 'mailbox');
  const priorHome = process.env.AGENT_CHAT_HOME;
  process.env.AGENT_CHAT_HOME = home;
  t.after(() => { if (priorHome === undefined) delete process.env.AGENT_CHAT_HOME; else process.env.AGENT_CHAT_HOME = priorHome; });
  const initial = await doctorProject({ project });
  assert.match(check(initial, 'claude.room')[0].message, /explicit named room "m2-moo"/);
  assert.equal(fs.existsSync(home), false);
  for (const room of [{ id: 'm2-moo', label: 'm2-moo' }, { id: 'm2-moo-123456', label: project }]) {
    const directory = path.join(home, 'rooms', room.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'room.json'), JSON.stringify(room));
    fs.mkdirSync(path.join(directory, 'messages.jsonl'));
    fs.writeFileSync(path.join(directory, 'private-body'), 'do-not-print-message');
  }
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(check(result, 'claude.room-mismatch')[0].status, 'warning');
  assert.match(check(result, 'claude.room-mismatch')[0].message, /m2-moo-123456/);
  assert.doesNotMatch(JSON.stringify(result), /do-not-print-message/);
  assert.deepEqual(snapshot(project), before);
});

test('doctor detects a basename split for path defaults and ignores unsafe room metadata', async t => {
  const { project } = fixture(t, { clients: 'claude' });
  const home = path.join(project, 'mailbox');
  const priorHome = process.env.AGENT_CHAT_HOME;
  process.env.AGENT_CHAT_HOME = home;
  t.after(() => { if (priorHome === undefined) delete process.env.AGENT_CHAT_HOME; else process.env.AGENT_CHAT_HOME = priorHome; });
  const name = path.basename(project);
  for (const room of [{ id: name, label: name }, { id: `${name}-123456`, label: project }]) {
    const directory = path.join(home, 'rooms', room.id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'room.json'), JSON.stringify(room));
  }
  const result = await doctorProject({ project });
  assert.match(check(result, 'claude.room')[0].message, /derived from the project path/);
  assert.equal(check(result, 'claude.room-mismatch').length, 1);
  fs.writeFileSync(path.join(home, 'rooms', name, 'room.json'), JSON.stringify({ id: '../bad', label: name }));
  assert.equal(check(await doctorProject({ project }), 'claude.room-mismatch').length, 0);
});
test('doctor warns when installed local clients have different configured defaults', async t => {
  const { project } = fixture(t, { clients: 'codex,claude' });
  updateProject({ project, clients: 'claude', room: 'm2-moo' });
  assert.equal(check(await doctorProject({ project }), 'rooms.defaults')[0].status, 'warning');
  updateProject({ project, room: 'm2-moo' });
  assert.equal(check(await doctorProject({ project }), 'rooms.defaults').length, 0);
});

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

test('doctor reports wake instructions as warnings without treating them as MCP entries', async t => {
  const { project } = fixture(t, { clients: ['codex', 'claude', 'opencode'], hooks: true });
  let result = await doctorProject({ project });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(['codex', 'claude', 'opencode'].map(client => check(result, `${client}.instructions`).map(value => value.status)), [['ok'], ['ok'], []]);
  assert.equal(check(result, 'claude.mcp').length, 1);
  const file = path.join(project, 'CLAUDE.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('without asking', 'after asking'));
  const before = snapshot(project);
  result = await doctorProject({ project });
  assert.equal(result.ok, true);
  assert.match(check(result, 'claude.instructions')[0].message, /were edited/);
  assert.equal(check(result, 'claude.instructions')[0].status, 'warning');
  assert.deepEqual(snapshot(project), before);
  const receiptFile = installationPaths(project).receipt;
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  receipt.entries = receipt.entries.filter(entry => entry.kind !== 'text-block');
  fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  result = await doctorProject({ project });
  for (const client of ['codex', 'claude', 'opencode']) {
    assert.match(check(result, `${client}.instructions`)[0].message, /not installed in (AGENTS|CLAUDE)\.md.*--no-wake-permission/, client);
  }
});

test('doctor prints managed binding commands with exact project paths and broker options', async t => {
  for (const client of ['codex', 'claude', 'opencode']) {
    for (const broker of [false, true]) {
      const { project, paths } = fixture(t, { install: false });
      const tokenFile = path.join(project, 'broker-token');
      if (broker) fs.writeFileSync(tokenFile, 'a'.repeat(64));
      installProject({ project, clients: [client], hooks: true, ...(broker ? {
        brokerUrl: 'http://127.0.0.1:1', brokerTokenFile: tokenFile, room: 'configured-room',
      } : {}) });
      const before = snapshot(project);
      const result = await doctorProject({ project });
      const command = result.hints.find(hint => hint.startsWith(`Manual binding for ${client} `));
      assert.ok(command, `${client}: ${broker ? 'broker' : 'local'}`);
      assert.ok(command.includes(`'${process.execPath}'`));
      assert.ok(command.includes(`'${path.join(paths.runtime, 'hooks/bind.mjs')}'`));
      assert.ok(command.includes(`--config '${paths.notificationConfig}'`));
      assert.ok(command.includes(`--client '${client === 'claude' ? 'claude-code' : client}'`));
      assert.ok(command.includes(`--cwd '${project}'`));
      assert.match(command, /--host-session 'HOST_CONVERSATION_ID'.*--session 'MAILBOX_SESSION_FROM_CHAT_WHO'/);
      if (broker) assert.match(command, /--room 'configured-room'.*--broker-url 'http:\/\/127\.0\.0\.1:1'/);
      else { assert.match(command, /--room 'ROOM_ID_FROM_CHAT_WHO'/); assert.doesNotMatch(command, /--broker-url/); }
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(snapshot(project), before, 'Binding guidance is read-only.');
    }
  }
});

test('doctor distinguishes missing lifecycle hooks from edited or duplicated launcher references', async t => {
  for (const client of ['codex', 'claude']) {
    const { project } = fixture(t, { clients: [client], hooks: true });
    const entry = inspectInstallation({ project }).receipt.entries.find(entry => entry.id === `${client}:hook:UserPromptSubmit`);
    const file = path.join(project, entry.path);
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const scenario of ['unrelated-only', 'empty', 'absent-event', 'absent-hooks', 'edited', 'windows-edited', 'duplicates', 'exact-and-edited']) {
      const config = structuredClone(original);
      const edited = structuredClone(entry.value);
      edited.hooks[0].command += ' --custom';
      if (scenario === 'windows-edited') {
        edited.hooks[0].command = 'another-command';
        edited.hooks[0].commandWindows = `node "${path.join(project, `.agent-chat/launchers/${client}.mjs`).replaceAll('/', '\\\\').toUpperCase()}" --custom`;
      }
      const event = entry.keyPath.at(-1);
      if (scenario === 'unrelated-only') config.hooks[event] = [{ hooks: [{ type: 'command', command: 'formatter' }] }];
      else if (scenario === 'empty') config.hooks[event] = [];
      else if (scenario === 'absent-event') delete config.hooks[event];
      else if (scenario === 'absent-hooks') delete config.hooks;
      else config.hooks[event] = scenario === 'duplicates' ? [entry.value, entry.value]
        : scenario === 'exact-and-edited' ? [entry.value, edited] : [edited];
      fs.writeFileSync(file, JSON.stringify(config, null, 4) + '\n');
      const before = snapshot(project);
      const result = await doctorProject({ project });
      const errors = check(result, `${client}.hooks`).filter(value => value.status === 'error');
      const changed = ['edited', 'windows-edited', 'duplicates', 'exact-and-edited'].includes(scenario);
      assert.ok(errors.length, `${client}: ${scenario}`);
      for (const error of errors) {
        assert.match(error.message, changed ? /differ.*Inspect your changes/ : /missing.*Run agent-chat update/);
        if (changed) assert.doesNotMatch(error.message, /restore missing/);
      }
      assert.deepEqual(snapshot(project), before, `${client}: ${scenario} is read-only`);
    }
  }
});

test('doctor distinguishes a removed Codex MCP block from an unmarked managed table', async t => {
  const { project } = fixture(t, { clients: ['codex'] });
  const file = path.join(project, '.codex/config.toml');
  fs.writeFileSync(file, '# unrelated setting\nmodel = "keep"\n');
  assert.match(check(await doctorProject({ project }), 'codex.mcp')[0].message, /missing.*Run agent-chat update/);
  fs.writeFileSync(file, '# unrelated setting\nmodel = "keep"\n[mcp_servers.agent-chat]\ncommand = "custom-node"\n');
  const before = snapshot(project);
  assert.match(check(await doctorProject({ project }), 'codex.mcp')[0].message, /differ.*Inspect your changes/);
  assert.deepEqual(snapshot(project), before);
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

test('doctor warns near notification history count and byte limits without modifying records', async t => {
  const { project, paths } = fixture(t, { clients: ['codex'], hooks: true });
  const binding = index => ({ client: 'codex', hostSessionId: `private-host-${index}`, cwd: project,
    room: 'private-room', mailboxSessionId: `private-mailbox-${index}`, boundAt: Date.now() });
  for (const count of [NOTIFICATION_LIMITS.warningBindings - 1, NOTIFICATION_LIMITS.warningBindings, NOTIFICATION_LIMITS.bindings]) {
    fs.writeFileSync(paths.notificationConfig, JSON.stringify({ version: 1, bindings: Array.from({ length: count }, (_, index) => binding(index)) }));
    const before = snapshot(project);
    const result = await doctorProject({ project });
    const near = count >= NOTIFICATION_LIMITS.warningBindings;
    assert.equal(result.ok, true);
    assert.equal(check(result, 'codex.notifications')[0].status, near ? 'warning' : 'ok');
    assert.equal(check(result, 'codex.notification-history').length, near ? 1 : 0);
    if (near) assert.match(check(result, 'codex.notification-history')[0].message, /evict older bindings.*Rebind/);
    assert.doesNotMatch(JSON.stringify(result), /private-host-|private-mailbox-|private-room/);
    assert.deepEqual(snapshot(project), before);
  }
  const config = JSON.stringify({ version: 1, bindings: [binding(0)] });
  fs.writeFileSync(paths.notificationConfig, config + ' '.repeat(NOTIFICATION_LIMITS.warningBytes - Buffer.byteLength(config)));
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(result.ok, true);
  assert.equal(check(result, 'codex.notifications')[0].status, 'warning');
  assert.equal(check(result, 'codex.notification-history')[0].status, 'warning');
  assert.deepEqual(snapshot(project), before);
});

test('doctor accepts alternate Windows drive casing and a legacy receipt path', { skip: process.platform !== 'win32' }, async t => {
  const { project, paths } = fixture(t, { clients: ['codex'] });
  const lowerDrive = project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const upperDrive = project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'));
  receipt.project = lowerDrive;
  fs.writeFileSync(paths.receipt, JSON.stringify(receipt));
  const before = snapshot(project);
  for (const variant of [lowerDrive, upperDrive]) {
    const result = await doctorProject({ project: variant });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.project, fs.realpathSync.native(project));
  }
  assert.deepEqual(snapshot(project), before);
});

test('doctor recognizes case-insensitive macOS project aliases and legacy receipt spelling read-only', { skip: process.platform !== 'darwin' }, async t => {
  const { project, paths } = fixture(t, { clients: ['codex', 'claude'] });
  const basename = path.basename(project);
  const alias = path.join(path.dirname(project), [...basename].map(letter => letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()).join(''));
  if (!fs.existsSync(alias)) return t.skip('Temporary volume is case-sensitive.');
  const originalStat = fs.statSync(project); const aliasStat = fs.statSync(alias);
  if (originalStat.dev !== aliasStat.dev || originalStat.ino !== aliasStat.ino) return t.skip('Opposite-case paths are distinct directories.');
  const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'));
  receipt.project = fs.realpathSync(alias);
  fs.writeFileSync(paths.receipt, JSON.stringify(receipt));
  const before = snapshot(project);
  const result = await doctorProject({ project: alias });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.project, fs.realpathSync.native(project));
  assert.equal(check(result, 'installation.location').length, 0);
  assert.deepEqual(snapshot(project), before);
});

test('doctor diagnoses a moved installation and recommends relocation without editing either location', async t => {
  const { project } = fixture(t, { clients: ['codex', 'claude', 'opencode'], hooks: true });
  const moved = `${project}-moved`;
  fs.renameSync(project, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'untouched.txt'), 'unrelated old location\n');
  const before = snapshot(moved); const oldBefore = snapshot(project);
  const result = await doctorProject({ project: moved });
  assert.equal(result.ok, false);
  assert.match(check(result, 'installation.location')[0].message, /Project moved.*update --dry-run.*agent-chat update/);
  assert.equal(check(result, 'installation')[0].status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /metadata is malformed/);
  assert.deepEqual(snapshot(moved), before);
  assert.deepEqual(snapshot(project), oldBefore);
  updateProject({ project: moved });
  const repaired = await doctorProject({ project: moved });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(check(repaired, 'installation.location').length, 0);
  assert.deepEqual(snapshot(project), oldBefore);
});

test('doctor recognizes live legacy Windows binding case variants without rewriting records', { skip: process.platform !== 'win32' }, async t => {
  const { project, paths } = fixture(t, { clients: ['codex'], hooks: true });
  const cwd = project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  fs.writeFileSync(paths.notificationConfig, JSON.stringify({ version: 1, bindings: [{ client: 'codex', hostSessionId: 'private-host',
    cwd, room: 'private-room', mailboxSessionId: 'private-mailbox' }] }));
  const before = snapshot(project);
  const result = await doctorProject({ project });
  assert.equal(check(result, 'codex.notifications')[0].status, 'ok');
  assert.deepEqual(snapshot(project), before);
  const config = JSON.parse(fs.readFileSync(paths.notificationConfig, 'utf8'));
  config.bindings.push({ ...config.bindings[0], cwd: project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`) });
  fs.writeFileSync(paths.notificationConfig, JSON.stringify(config));
  const duplicateBefore = snapshot(project);
  assert.equal(check(await doctorProject({ project }), 'codex.notifications')[0].status, 'error');
  assert.deepEqual(snapshot(project), duplicateBefore);
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

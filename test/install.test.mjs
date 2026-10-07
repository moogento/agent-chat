import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { installProject, updateProject, uninstallProject, inspectInstallation, inspectManagedEntry, detectClients, RUNTIME_FILES, quotePosix, quoteWindows } from '../lib/install.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, name = 'project with spaces') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-install-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, name); fs.mkdirSync(project);
  return { base, project, sourceRoot: root };
}
function write(project, relative, data) {
  const file = path.join(project, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
}
const read = (project, relative) => fs.readFileSync(path.join(project, relative), 'utf8');
const readJson = (project, relative) => JSON.parse(read(project, relative));
const canonical = project => (process.platform === 'win32' || process.platform === 'darwin' ? fs.realpathSync.native : fs.realpathSync)(project);
const crlf = text => text.replace(/\r?\n/g, '\r\n');

function useLegacyOpenCodeWrapper(f) {
  const current = '.opencode/plugins/agent-chat.js';
  const legacy = '.opencode/plugins/agent-chat.mjs';
  fs.renameSync(path.join(f.project, current), path.join(f.project, legacy));
  const receipt = inspectInstallation(f).receipt;
  receipt.files[legacy] = receipt.files[current];
  delete receipt.files[current];
  write(f.project, '.agent-chat/install.json', receipt);
  return { current, legacy };
}

test('Codex install and update preserve literal dollar patterns in runtime and token paths', t => {
  for (const pattern of ['$$', '$&']) {
    const f = fixture(t, `project ${pattern}`);
    const brokerTokenFile = path.join(f.project, `token ${pattern}`);
    fs.writeFileSync(brokerTokenFile, 'a'.repeat(64));
    const original = '# unrelated settings with $$ and $&\nmodel = "kept"\n';
    write(f.project, '.codex/config.toml', original);
    installProject({ ...f, clients: ['codex'], brokerUrl: 'http://broker:47321', brokerTokenFile, room: 'task' });
    assert.equal(updateProject(f).changes.length, 0);
    const replacementToken = path.join(f.project, `replacement token ${pattern}`);
    fs.writeFileSync(replacementToken, 'b'.repeat(64));
    updateProject({ ...f, brokerTokenFile: replacementToken });
    const text = read(f.project, '.codex/config.toml');
    const server = parseToml(text).mcp_servers['agent-chat'];
    const canonicalProject = canonical(f.project);
    assert.equal(server.cwd, canonicalProject);
    assert.deepEqual(server.args, [path.join(canonicalProject, '.agent-chat/runtime/agent-chat.mjs')]);
    assert.equal(server.env.AGENT_CHAT_BROKER_TOKEN_FILE, replacementToken);
    assert.ok(text.startsWith(original));
    assert.equal(updateProject(f).changes.length, 0);
    uninstallProject(f);
    assert.equal(read(f.project, '.codex/config.toml'), original);
  }
});

test('managed ignore blocks accept CRLF clones and converted files while preserving existing bytes', t => {
  const block = '\n# >>> agent-chat local state >>>\n/.agent-chat/\n# <<< agent-chat local state <<<\n';
  for (const state of ['fresh-clone', 'existing-receipt', 'crlf-receipt', 'new-block']) {
    const f = fixture(t, state);
    const prefix = '# user ignores\r\nnode_modules/\r\n';
    const suffix = '# later ignores\r\n*.cache\r\n';
    if (state === 'fresh-clone') write(f.project, '.gitignore', prefix + crlf(block) + suffix);
    else write(f.project, '.gitignore', prefix);
    installProject({ ...f, clients: ['codex'] });
    if (state === 'existing-receipt' || state === 'crlf-receipt') {
      write(f.project, '.gitignore', crlf(read(f.project, '.gitignore')) + suffix);
      if (state === 'crlf-receipt') {
        const receipt = inspectInstallation(f).receipt;
        receipt.ignore.content = crlf(receipt.ignore.content);
        write(f.project, '.agent-chat/install.json', receipt);
      }
    }
    const before = read(f.project, '.gitignore');
    assert.doesNotMatch(before, /(?<!\r)\n/, state);
    assert.ok(before.startsWith(prefix));
    assert.equal(updateProject(f).changes.length, 0, state);
    assert.equal(read(f.project, '.gitignore'), before);
    uninstallProject(f);
    assert.equal(read(f.project, '.gitignore'), before, 'Retained privacy rules keep their original line endings.');
    installProject({ ...f, clients: ['codex'] });
    assert.equal(read(f.project, '.gitignore'), before, 'A retained CRLF block is adopted without duplication.');
  }
});

test('Codex TOML handles CRLF conversion on update and uninstall with literal dollar paths', t => {
  for (const pattern of ['$$', '$&']) {
    for (const state of ['initial-crlf', 'converted-crlf', 'crlf-receipt']) {
      const f = fixture(t, `project ${pattern} ${state}`);
      const prefix = '# user settings $$ and $&\nmodel = "keep"\n';
      const suffix = '# later settings $$ and $&\r\n[custom]\r\nvalue = "$&"\r\n';
      write(f.project, '.codex/config.toml', state === 'initial-crlf' ? crlf(prefix) : prefix);
      const tokenFile = path.join(f.project, `token ${pattern}`);
      installProject({ ...f, clients: ['codex'], brokerUrl: 'http://broker:47321', brokerTokenFile: tokenFile, room: 'task' });
      write(f.project, '.codex/config.toml', crlf(read(f.project, '.codex/config.toml')) + suffix);
      if (state === 'crlf-receipt') {
        const receipt = inspectInstallation(f).receipt;
        receipt.entries.find(entry => entry.kind === 'toml-block').content = crlf(receipt.entries.find(entry => entry.kind === 'toml-block').content);
        write(f.project, '.agent-chat/install.json', receipt);
      }
      const entry = inspectInstallation(f).receipt.entries.find(entry => entry.kind === 'toml-block');
      assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'present');
      const replacementToken = path.join(f.project, `replacement ${pattern}`);
      updateProject({ ...f, brokerTokenFile: replacementToken });
      const text = read(f.project, '.codex/config.toml');
      assert.doesNotMatch(text, /(?<!\r)\n/);
      assert.ok(text.startsWith(crlf(prefix)));
      assert.ok(text.endsWith(suffix));
      const server = parseToml(text).mcp_servers['agent-chat'];
      assert.equal(server.cwd, canonical(f.project));
      assert.equal(server.env.AGENT_CHAT_BROKER_TOKEN_FILE, replacementToken);
      assert.equal(updateProject(f).changes.length, 0);
      uninstallProject(f);
      assert.equal(read(f.project, '.codex/config.toml'), crlf(prefix) + suffix);
    }
  }
});

test('Windows project drive casing and legacy short-name receipt aliases resolve to one installation', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, 'Project Mixed Case');
  const expected = fs.realpathSync.native(f.project);
  const lowerDrive = f.project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  const upperDrive = f.project.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`);
  assert.notEqual(lowerDrive, upperDrive);
  installProject({ ...f, project: lowerDrive, clients: ['codex', 'claude'] });
  assert.equal(inspectInstallation({ project: upperDrive }).project, expected);
  assert.equal(updateProject({ ...f, project: upperDrive }).changes.length, 0);
  const receipt = inspectInstallation(f).receipt;
  receipt.project = lowerDrive;
  write(f.project, '.agent-chat/install.json', receipt);
  assert.equal(inspectInstallation({ project: upperDrive }).receipt.project, expected);
  assert.equal(inspectInstallation({ project: upperDrive }).relocated, null);
  updateProject({ ...f, project: upperDrive });
  assert.equal(readJson(f.project, '.agent-chat/install.json').project, expected);
  assert.deepEqual(uninstallProject({ ...f, project: lowerDrive }).retainedClients, []);
  assert.equal(inspectInstallation({ project: upperDrive }).exists, false);
});

test('case-insensitive macOS aliases allow partial updates and normalize legacy receipts', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t, 'Project Mixed Case');
  const alias = path.join(f.base, 'pROJECT mIXED cASE');
  if (!fs.existsSync(alias)) return t.skip('Temporary volume is case-sensitive.');
  const originalStat = fs.statSync(f.project); const aliasStat = fs.statSync(alias);
  if (originalStat.dev !== aliasStat.dev || originalStat.ino !== aliasStat.ino) return t.skip('Opposite-case paths are distinct directories.');
  const expected = fs.realpathSync.native(f.project);
  installProject({ ...f, project: alias, clients: ['codex', 'claude'], hooks: true });
  assert.equal(inspectInstallation({ project: alias }).receipt.project, expected);
  assert.equal(inspectInstallation({ project: alias }).relocated, null);
  assert.equal(updateProject({ ...f, project: alias, clients: ['claude'] }).changes.length, 0);
  const receipt = inspectInstallation(f).receipt;
  receipt.project = fs.realpathSync(alias);
  assert.notEqual(receipt.project, expected, 'The fixture reproduces the legacy non-native case spelling.');
  write(f.project, '.agent-chat/install.json', receipt);
  assert.equal(inspectInstallation({ project: alias }).relocated, null);
  assert.deepEqual(updateProject({ ...f, project: alias, clients: ['claude'] }).clients, ['claude']);
  assert.equal(readJson(f.project, '.agent-chat/install.json').project, expected);
  uninstallProject({ ...f, project: alias, clients: ['claude'] });
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['codex']);
});

test('distinct directories on case-sensitive volumes remain relocation candidates', t => {
  const f = fixture(t, 'ProjectMixedCase');
  const other = path.join(f.base, 'projectmixedcase');
  if (fs.existsSync(other)) return t.skip('Temporary volume is case-insensitive.');
  installProject({ ...f, clients: ['codex', 'claude'] });
  fs.cpSync(f.project, other, { recursive: true });
  assert.notEqual(canonical(f.project), canonical(other));
  assert.deepEqual(inspectInstallation({ project: other }).relocated, { from: canonical(f.project), to: canonical(other) });
  assert.throws(() => updateProject({ ...f, project: other, clients: ['claude'] }), /all installed clients/);
  assert.equal(inspectInstallation(f).relocated, null);
});

function moveInstalledProject(f) {
  const oldProject = canonical(f.project);
  const moved = path.join(f.base, 'moved project $$ $&');
  fs.renameSync(f.project, moved);
  // An unrelated project may later occupy the old location. Never change it.
  fs.mkdirSync(oldProject);
  write(oldProject, 'untouched.txt', 'old location belongs to someone else\n');
  return { ...f, project: moved, oldProject };
}

test('a moved all-client installation previews and updates owned paths only in its new location', t => {
  const f = fixture(t);
  const otherHook = { hooks: [{ type: 'command', command: 'keep-hook' }] };
  write(f.project, '.mcp.json', { mcpServers: { other: { command: 'keep-server' } } });
  write(f.project, '.claude/settings.local.json', { hooks: { PostToolUse: [otherHook] }, permissions: { allow: ['Read'] } });
  installProject({ ...f, clients: ['codex', 'claude', 'opencode'], hooks: true });
  const moved = moveInstalledProject(f);
  const before = snapshot(moved.project);
  const oldBefore = snapshot(moved.oldProject);
  assert.deepEqual(inspectInstallation(moved).relocated, { from: moved.oldProject, to: canonical(moved.project) });
  const preview = updateProject({ ...moved, dryRun: true });
  assert.ok(preview.changes.some(change => change.path === '.mcp.json'));
  assert.ok(preview.changes.some(change => change.path === '.opencode/plugins/agent-chat.js'));
  assert.deepEqual(snapshot(moved.project), before);
  const runtimePreview = spawnSync(process.execPath, [path.join(moved.project, '.agent-chat/runtime/agent-chat.mjs'), 'update', '--dry-run'], { cwd: moved.project, encoding: 'utf8' });
  assert.equal(runtimePreview.status, 0, runtimePreview.stderr + runtimePreview.stdout);
  assert.deepEqual(snapshot(moved.project), before, 'The moved self-contained runtime can preview its own recovery.');
  assert.throws(() => updateProject({ ...moved, clients: ['claude'] }), /all installed clients/);
  assert.deepEqual(snapshot(moved.project), before);
  const updated = updateProject(moved);
  assert.ok(updated.warnings.some(warning => /Project moved.*restart/.test(warning)));
  const inspected = inspectInstallation(moved);
  assert.equal(inspected.relocated, null);
  assert.equal(inspected.receipt.project, canonical(moved.project));
  for (const entry of inspected.receipt.entries) assert.equal(inspectManagedEntry({ project: moved.project, entry }).status, 'present');
  for (const relative of ['.codex/config.toml', '.codex/hooks.json', '.mcp.json', 'opencode.json', '.claude/settings.local.json', '.agent-chat/launchers/codex.mjs', '.agent-chat/launchers/claude.mjs', '.opencode/plugins/agent-chat.js']) {
    assert.ok(!read(moved.project, relative).includes(moved.oldProject.replaceAll('\\', '\\\\')), relative);
  }
  assert.equal(readJson(moved.project, '.mcp.json').mcpServers.other.command, 'keep-server');
  assert.deepEqual(readJson(moved.project, '.claude/settings.local.json').hooks.PostToolUse[0], otherHook);
  assert.equal(updateProject(moved).changes.length, 0);
  assert.deepEqual(snapshot(moved.oldProject), oldBefore);
});

test('moved installation update refuses edited owned bytes or settings before any mutation', t => {
  for (const edited of ['runtime', 'launcher', 'mcp', 'duplicate-hook']) {
    const f = fixture(t, edited);
    installProject({ ...f, clients: ['codex', 'claude', 'opencode'], hooks: true });
    const moved = moveInstalledProject(f);
    if (edited === 'runtime') fs.appendFileSync(path.join(moved.project, '.agent-chat/runtime/lib/mailbox.mjs'), '// edited\n');
    if (edited === 'launcher') fs.appendFileSync(path.join(moved.project, '.agent-chat/launchers/claude.mjs'), '// edited\n');
    if (edited === 'mcp') {
      const config = readJson(moved.project, 'opencode.json');
      config.mcp['agent-chat'].command.push('edited'); write(moved.project, 'opencode.json', config);
    }
    if (edited === 'duplicate-hook') {
      const config = readJson(moved.project, '.codex/hooks.json');
      config.hooks.PostToolUse.push(config.hooks.PostToolUse[0]); write(moved.project, '.codex/hooks.json', config);
    }
    const before = snapshot(moved.project); const oldBefore = snapshot(moved.oldProject);
    for (const dryRun of [true, false]) assert.throws(() => updateProject({ ...moved, dryRun }), /cannot relocate/);
    assert.deepEqual(snapshot(moved.project), before);
    assert.deepEqual(snapshot(moved.oldProject), oldBefore);
  }
});

test('moved installation restores missing owned resources and uninstalls without touching the old location', t => {
  for (const action of ['update', 'uninstall']) {
    const f = fixture(t, action);
    installProject({ ...f, clients: ['codex', 'claude', 'opencode'], hooks: true });
    const moved = moveInstalledProject(f);
    const oldBefore = snapshot(moved.oldProject);
    fs.rmSync(path.join(moved.project, '.agent-chat/runtime/lib/mailbox.mjs'));
    fs.rmSync(path.join(moved.project, '.codex/config.toml'));
    if (action === 'update') {
      updateProject(moved);
      assert.equal(inspectInstallation(moved).relocated, null);
      assert.ok(fs.existsSync(path.join(moved.project, '.agent-chat/runtime/lib/mailbox.mjs')));
      assert.equal(parseToml(read(moved.project, '.codex/config.toml')).mcp_servers['agent-chat'].cwd, canonical(moved.project));
    } else {
      const before = snapshot(moved.project);
      assert.ok(uninstallProject({ ...moved, dryRun: true }).changes.length);
      assert.deepEqual(snapshot(moved.project), before);
      assert.deepEqual(uninstallProject(moved).retainedClients, []);
      assert.equal(inspectInstallation(moved).exists, false);
      assert.ok(!fs.existsSync(path.join(moved.project, '.agent-chat/runtime/agent-chat.mjs')));
    }
    assert.deepEqual(snapshot(moved.oldProject), oldBefore);
  }
});

test('relocation maps project-local broker tokens and preserves external or explicit token paths', t => {
  for (const kind of ['project-local', 'external', 'explicit-override']) {
    const f = fixture(t, kind);
    const tokenFile = path.join(kind === 'external' ? f.base : f.project, 'private token');
    fs.writeFileSync(tokenFile, 'a'.repeat(64));
    installProject({ ...f, clients: ['codex', 'claude', 'opencode'], hooks: true,
      brokerUrl: 'http://broker:47321', brokerTokenFile: tokenFile, room: 'shared-room' });
    const moved = moveInstalledProject(f);
    const oldBefore = snapshot(moved.oldProject);
    const override = path.join(f.base, 'explicit token');
    if (kind === 'explicit-override') fs.writeFileSync(override, 'b'.repeat(64));
    updateProject({ ...moved, ...(kind === 'explicit-override' ? { brokerTokenFile: override } : {}) });
    const expected = kind === 'project-local' ? path.join(canonical(moved.project), 'private token') : kind === 'external' ? tokenFile : override;
    for (const connection of Object.values(inspectInstallation(moved).receipt.connections)) assert.equal(connection.tokenFile, expected);
    assert.ok(fs.existsSync(expected));
    assert.equal(readJson(moved.project, '.mcp.json').mcpServers['agent-chat'].env.AGENT_CHAT_BROKER_TOKEN_FILE, expected);
    assert.ok(read(moved.project, '.agent-chat/launchers/codex.mjs').includes(JSON.stringify(expected)));
    assert.deepEqual(snapshot(moved.oldProject), oldBefore);
  }
});

test('a fully absent outer ignore block is restored while partial, edited and duplicate blocks conflict', t => {
  for (const missing of ['file', 'block']) {
    const f = fixture(t, missing);
    installProject({ ...f, clients: ['claude'] });
    const unrelated = '# user rules\r\n*.cache\r\n';
    if (missing === 'file') fs.unlinkSync(path.join(f.project, '.gitignore'));
    else write(f.project, '.gitignore', unrelated);
    const before = snapshot(f.project);
    assert.ok(updateProject({ ...f, dryRun: true }).changes.some(change => change.path === '.gitignore'));
    assert.deepEqual(snapshot(f.project), before);
    updateProject(f);
    const ignored = read(f.project, '.gitignore');
    assert.ok(ignored.includes('/.agent-chat/'));
    if (missing === 'block') { assert.ok(ignored.startsWith(unrelated)); assert.doesNotMatch(ignored, /(?<!\r)\n/); }
    assert.equal(read(f.project, '.agent-chat/.gitignore'), '*\n');
    assert.equal(updateProject(f).changes.length, 0);
  }
  for (const edited of ['start-only', 'end-only', 'changed', 'duplicate']) {
    const f = fixture(t, edited);
    installProject({ ...f, clients: ['claude'] });
    const block = inspectInstallation(f).receipt.ignore.content;
    write(f.project, '.gitignore', edited === 'start-only' ? block.replace('# <<< agent-chat local state <<<', '')
      : edited === 'end-only' ? block.replace('# >>> agent-chat local state >>>', '')
      : edited === 'changed' ? block.replace('/.agent-chat/', '/something-else/') : block + block);
    const before = snapshot(f.project);
    assert.throws(() => updateProject(f), /managed local-state ignore block was changed/);
    assert.deepEqual(snapshot(f.project), before);
  }
});

test('OpenCode hooks install a discoverable JavaScript wrapper that loads the shared adapter', async t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['opencode'], hooks: true });
  const relative = '.opencode/plugins/agent-chat.js';
  assert.ok(inspectInstallation(f).receipt.files[relative]);
  assert.equal(fs.existsSync(path.join(f.project, '.opencode/plugins/agent-chat.mjs')), false);
  const wrapper = await import(pathToFileURL(path.join(f.project, relative)).href);
  const adapter = await wrapper.AgentChat({ client: {}, directory: f.project });
  assert.equal(typeof adapter['tool.execute.after'], 'function');
  assert.equal(typeof adapter.event, 'function');
});

test('update migrates an unchanged legacy OpenCode wrapper and removal owns only the new file', t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['opencode'], hooks: true });
  const { current, legacy } = useLegacyOpenCodeWrapper(f);
  assert.ok(inspectInstallation(f).receipt.files[legacy], 'Legacy receipts remain readable.');
  const before = snapshot(f.project);
  const preview = updateProject({ ...f, dryRun: true });
  assert.ok(preview.changes.some(change => change.path === legacy && change.action === 'remove'));
  assert.ok(preview.changes.some(change => change.path === current && change.action === 'create'));
  assert.deepEqual(snapshot(f.project), before);
  updateProject(f);
  assert.equal(fs.existsSync(path.join(f.project, legacy)), false);
  const receipt = inspectInstallation(f).receipt;
  assert.ok(receipt.files[current]); assert.equal(receipt.files[legacy], undefined);
  assert.equal(updateProject(f).changes.length, 0);
  uninstallProject(f);
  assert.equal(fs.existsSync(path.join(f.project, current)), false);
});

test('legacy OpenCode migration preserves edited wrappers and unmanaged destination files', t => {
  for (const kind of ['edited-legacy', 'unmanaged-destination']) {
    const f = fixture(t, kind);
    installProject({ ...f, clients: ['opencode'], hooks: true });
    const { current, legacy } = useLegacyOpenCodeWrapper(f);
    write(f.project, kind === 'edited-legacy' ? legacy : current, '// user-owned plugin edits\n');
    const before = snapshot(f.project);
    assert.throws(() => updateProject(f), /edited|outside this installation/);
    assert.deepEqual(snapshot(f.project), before);
  }
});

test('legacy OpenCode receipts support disabling hooks and direct uninstall before migration', t => {
  for (const action of ['disable', 'uninstall']) {
    const f = fixture(t, action);
    installProject({ ...f, clients: ['opencode'], hooks: true });
    const { current, legacy } = useLegacyOpenCodeWrapper(f);
    if (action === 'disable') updateProject({ ...f, hooks: false });
    else uninstallProject(f);
    assert.equal(fs.existsSync(path.join(f.project, legacy)), false);
    assert.equal(fs.existsSync(path.join(f.project, current)), false);
    if (action === 'disable') assert.equal(inspectInstallation(f).receipt.hooks.opencode, false);
    else assert.equal(inspectInstallation(f).exists, false);
  }
});

test('broker install shares connection settings with hooks, preserves them on update, and supports returning to local', t => {
  const f = fixture(t);
  const brokerTokenFile = path.join(f.base, 'token');
  fs.writeFileSync(brokerTokenFile, 'private-token-not-copied-into-client-config');
  installProject({ ...f, clients: 'codex,claude,opencode', hooks: true, brokerUrl: 'http://broker:47321/', brokerTokenFile, room: 'test-task' });
  const connections = inspectInstallation(f).receipt.connections;
  for (const client of ['codex', 'claude', 'opencode']) assert.deepEqual(connections[client], { url: 'http://broker:47321', tokenFile: brokerTokenFile, room: 'test-task' });
  const envs = [parseToml(read(f.project, '.codex/config.toml')).mcp_servers['agent-chat'].env,
    readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env,
    readJson(f.project, 'opencode.json').mcp['agent-chat'].environment];
  for (const env of envs) {
    assert.equal(env.AGENT_CHAT_ROOM, 'test-task');
    assert.equal(env.AGENT_CHAT_BROKER_URL, 'http://broker:47321');
    assert.equal(env.AGENT_CHAT_BROKER_TOKEN_FILE, brokerTokenFile);
    assert.equal(env.AGENT_CHAT_BROKER_SESSION_DIR, path.join(canonical(f.project), '.agent-chat/broker-sessions'));
  }
  for (const file of ['.agent-chat/launchers/codex.mjs', '.agent-chat/launchers/claude.mjs', '.opencode/plugins/agent-chat.js']) {
    assert.match(read(f.project, file), /AGENT_CHAT_BROKER_URL/);
    assert.match(read(f.project, file), /test-task/);
  }
  assert.doesNotMatch(read(f.project, '.agent-chat/install.json'), /private-token-not-copied/);
  updateProject(f);
  assert.deepEqual(inspectInstallation(f).receipt.connections, connections);
  updateProject({ ...f, clients: 'claude', local: true });
  assert.equal(inspectInstallation(f).receipt.connections.claude, null);
  assert.deepEqual(inspectInstallation(f).receipt.connections.codex, connections.codex);
  assert.equal(readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env.AGENT_CHAT_BROKER_URL, '');
  uninstallProject({ ...f, clients: 'codex' });
  assert.equal(inspectInstallation(f).receipt.connections.codex, undefined);
  assert.equal(fs.readFileSync(brokerTokenFile, 'utf8'), 'private-token-not-copied-into-client-config');
});
test('incomplete or unsafe broker install settings fail before project mutation', t => {
  const f = fixture(t);
  const valid = { brokerUrl: 'http://broker:47321', brokerTokenFile: path.join(f.base, 'token'), room: 'task' };
  for (const options of [{ brokerUrl: valid.brokerUrl }, { ...valid, local: true }, { ...valid, room: '/workspace' },
    { ...valid, brokerUrl: 'http://secret@broker:47321' }, { ...valid, brokerUrl: 'file:///tmp/broker' },
    { ...valid, brokerUrl: 'http://broker:47321/?token=secret' }, { ...valid, brokerTokenFile: 'relative' }]) {
    assert.throws(() => installProject({ ...f, clients: 'claude', ...options }));
    assert.deepEqual(fs.readdirSync(f.project), []);
  }
});
test('named local defaults share hook settings and survive update, relocation and transport changes', t => {
  const f = fixture(t, 'm2-moo');
  installProject({ ...f, clients: 'codex,claude,opencode', hooks: true, room: 'm2-moo' });
  for (const client of ['codex', 'claude', 'opencode']) assert.equal(inspectInstallation(f).receipt.localRooms[client], 'm2-moo');
  const environments = () => [parseToml(read(f.project, '.codex/config.toml')).mcp_servers['agent-chat'].env,
    readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env, readJson(f.project, 'opencode.json').mcp['agent-chat'].environment];
  for (const env of environments()) { assert.equal(env.AGENT_CHAT_ROOM, 'm2-moo'); assert.equal(env.AGENT_CHAT_BROKER_URL, ''); }
  for (const file of ['.agent-chat/launchers/codex.mjs', '.agent-chat/launchers/claude.mjs', '.opencode/plugins/agent-chat.js']) assert.match(read(f.project, file), /AGENT_CHAT_ROOM.*m2-moo/);
  assert.equal(updateProject(f).changes.length, 0);
  const moved = path.join(f.base, 'renamed-project');
  fs.renameSync(f.project, moved); f.project = moved;
  updateProject(f);
  for (const env of environments()) assert.equal(env.AGENT_CHAT_ROOM, 'm2-moo');
  updateProject({ ...f, clients: 'claude', brokerUrl: 'http://broker:47321', brokerTokenFile: path.join(f.base, 'token'), room: 'broker-room' });
  updateProject({ ...f, clients: 'claude', local: true });
  assert.equal(readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env.AGENT_CHAT_ROOM, 'm2-moo');
  updateProject({ ...f, clients: 'claude', local: true, room: 'other-local-room' });
  assert.equal(readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env.AGENT_CHAT_ROOM, 'other-local-room');
  assert.equal(inspectInstallation(f).receipt.localRooms.codex, 'm2-moo');
  uninstallProject({ ...f, clients: 'claude' });
  assert.equal(inspectInstallation(f).receipt.localRooms.claude, undefined);
});
test('invalid local room options and edits fail before project mutation', t => {
  const f = fixture(t);
  for (const room of ['', ' ', '../outside', '.', 'a'.repeat(129)]) {
    assert.throws(() => installProject({ ...f, clients: 'claude', room }), /named local room/);
    assert.deepEqual(fs.readdirSync(f.project), []);
  }
  installProject({ ...f, clients: 'claude', room: 'm2-moo' });
  const config = readJson(f.project, '.mcp.json');
  config.mcpServers['agent-chat'].env.AGENT_CHAT_ROOM = 'user-edit';
  write(f.project, '.mcp.json', config);
  const before = snapshot(f.project);
  assert.throws(() => updateProject({ ...f, room: 'new-room' }), /changed|edited/);
  assert.deepEqual(snapshot(f.project), before);
});
test('new clients inherit one existing local named default without changing existing client settings', t => {
  const f = fixture(t);
  installProject({ ...f, clients: 'codex', room: 'm2-moo' });
  const codex = read(f.project, '.codex/config.toml');
  installProject({ ...f, clients: 'claude' });
  assert.equal(readJson(f.project, '.mcp.json').mcpServers['agent-chat'].env.AGENT_CHAT_ROOM, 'm2-moo');
  assert.equal(read(f.project, '.codex/config.toml'), codex);
  updateProject({ ...f, clients: 'claude', room: 'different' });
  installProject({ ...f, clients: 'opencode' });
  assert.equal(readJson(f.project, 'opencode.json').mcp['agent-chat'].environment.AGENT_CHAT_ROOM, canonical(f.project));
});
function snapshot(project) {
  const result = {};
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(project, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name); if (entry.isDirectory()) walk(child); else result[child] = fs.readFileSync(path.join(project, child));
    }
  };
  walk(''); return result;
}

test('dry-run plans explicit clients without creating files; detection only suggests', t => {
  const f = fixture(t); write(f.project, '.claude/settings.local.json', { theme: 'dark' });
  const before = snapshot(f.project);
  assert.deepEqual(detectClients(f), ['claude']);
  const result = installProject({ ...f, clients: 'codex,claude,opencode', hooks: true, dryRun: true });
  assert.ok(result.changes.some(change => change.path === '.codex/config.toml'));
  assert.equal(result.dryRun, true); assert.deepEqual(snapshot(f.project), before);
  assert.throws(() => installProject(f), /--clients/);
});

test('installs all clients, preserves unrelated settings and provides a self-contained runtime', t => {
  const f = fixture(t);
  const toml = '# Existing comment\nmodel = "test"\n[features]\nexample = true\n';
  write(f.project, '.codex/config.toml', toml);
  const otherHook = { matcher: 'Write', hooks: [{ type: 'command', command: 'other-check' }] };
  write(f.project, '.codex/hooks.json', { description: 'existing', hooks: { PostToolUse: [otherHook] } });
  write(f.project, '.claude/settings.local.json', { permissions: { deny: ['Bash(rm *)'] }, hooks: { PostToolUse: [otherHook] } });
  write(f.project, '.mcp.json', { mcpServers: { other: { command: 'other' } } });
  write(f.project, 'opencode.json', { model: 'test/model', mcp: { other: { type: 'local', command: ['other'] } } });
  const installed = installProject({ ...f, clients: 'codex,claude,opencode', hooks: true });
  assert.ok(installed.backup); assert.ok(read(f.project, '.codex/config.toml').startsWith(toml));
  const codex = parseToml(read(f.project, '.codex/config.toml'));
  assert.equal(codex.model, 'test'); assert.equal(codex.mcp_servers['agent-chat'].command, process.execPath);
  assert.equal(codex.mcp_servers['agent-chat'].cwd, canonical(f.project));
  assert.equal(readJson(f.project, '.mcp.json').mcpServers.other.command, 'other');
  assert.equal(readJson(f.project, 'opencode.json').model, 'test/model');
  assert.deepEqual(readJson(f.project, '.claude/settings.local.json').permissions, { deny: ['Bash(rm *)'] });
  for (const relative of ['.codex/hooks.json', '.claude/settings.local.json']) {
    const groups = readJson(f.project, relative).hooks.PostToolUse;
    assert.deepEqual(groups[0], otherHook); assert.equal(groups.length, 2);
  }
  assert.equal(Boolean(readJson(f.project, '.codex/hooks.json').hooks.PostToolUse[1].hooks[0].commandWindows), process.platform === 'win32');
  const inspection = inspectInstallation(f);
  for (const entry of inspection.receipt.entries) assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'present');
  for (const relative of RUNTIME_FILES) assert.ok(fs.existsSync(path.join(f.project, '.agent-chat/runtime', relative)), relative);
  const run = spawnSync(process.execPath, [path.join(f.project, '.agent-chat/runtime/agent-chat.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), '0.5.0');
  const diagnostic = spawnSync(process.execPath, [path.join(f.project, '.agent-chat/runtime/agent-chat.mjs'), 'doctor', '--project', f.project, '--json'], { encoding: 'utf8' });
  assert.equal(diagnostic.status, 0, diagnostic.stderr + diagnostic.stdout);
  assert.equal(JSON.parse(diagnostic.stdout).ok, true);
});

test('hooks are opt-in and update preserves choice unless explicitly changed', t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['codex', 'claude', 'opencode'] });
  assert.ok(!fs.existsSync(path.join(f.project, '.codex/hooks.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.claude/settings.local.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.opencode/plugins/agent-chat.js')));
  updateProject({ ...f, hooks: true });
  assert.equal(inspectInstallation(f).receipt.hooks.codex, true);
  updateProject(f); assert.equal(inspectInstallation(f).receipt.hooks.codex, true);
  updateProject({ ...f, hooks: false });
  assert.ok(!fs.existsSync(path.join(f.project, '.codex/hooks.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.opencode/plugins/agent-chat.js')));
  assert.equal(inspectInstallation(f).receipt.hooks.codex, false);
});

test('repeated install and update are idempotent and restore missing owned files/entries', t => {
  const f = fixture(t); installProject({ ...f, clients: ['codex', 'claude'] });
  assert.equal(updateProject(f).changes.length, 0);
  assert.equal(installProject({ ...f, clients: ['codex', 'claude'] }).changes.length, 0);
  fs.unlinkSync(path.join(f.project, '.agents/skills/agent-chat/SKILL.md'));
  fs.unlinkSync(path.join(f.project, '.codex/config.toml'));
  const mcp = readJson(f.project, '.mcp.json'); delete mcp.mcpServers['agent-chat']; write(f.project, '.mcp.json', mcp);
  updateProject(f);
  assert.ok(fs.existsSync(path.join(f.project, '.agents/skills/agent-chat/SKILL.md')));
  assert.ok(parseToml(read(f.project, '.codex/config.toml')).mcp_servers['agent-chat']);
  assert.ok(readJson(f.project, '.mcp.json').mcpServers['agent-chat']);
});

test('missing lifecycle hooks can be restored, disabled or uninstalled without trapping ownership', t => {
  for (const client of ['codex', 'claude']) {
    for (const missing of ['unrelated-only', 'empty', 'absent-event', 'absent-hooks']) {
      for (const action of ['update', 'disable', 'uninstall']) {
        const f = fixture(t, `${client}-${missing}-${action}`);
        installProject({ ...f, clients: [client], hooks: true });
        const entries = inspectInstallation(f).receipt.entries.filter(entry => entry.kind === 'json-hook');
        const relative = entries[0].path;
        const other = { matcher: 'keep', hooks: [{ type: 'command', command: 'unrelated-hook' }] };
        const config = { keep: { userSetting: true }, hooks: { CustomEvent: [other] } };
        for (const entry of entries) {
          if (missing === 'unrelated-only') config.hooks[entry.keyPath.at(-1)] = [other];
          if (missing === 'empty') config.hooks[entry.keyPath.at(-1)] = [];
        }
        if (missing === 'absent-hooks') delete config.hooks;
        const before = JSON.stringify(config, null, 4) + '\n';
        write(f.project, relative, before);
        for (const entry of entries) assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'missing');
        if (action === 'update') {
          updateProject(f);
          const restored = readJson(f.project, relative);
          for (const entry of entries) {
            const groups = restored.hooks[entry.keyPath.at(-1)];
            assert.equal(groups.filter(group => JSON.stringify(group) === JSON.stringify(entry.value)).length, 1);
            assert.deepEqual(groups, missing === 'unrelated-only' ? [other, entry.value] : [entry.value]);
          }
          assert.deepEqual(restored.keep, config.keep);
          if (config.hooks) assert.deepEqual(restored.hooks.CustomEvent, [other]);
          assert.equal(updateProject(f).changes.length, 0);
        } else {
          const result = action === 'disable' ? updateProject({ ...f, hooks: false }) : uninstallProject(f);
          assert.equal(read(f.project, relative), before, 'Already removed hooks leave the user config byte-for-byte unchanged.');
          assert.ok(!fs.existsSync(path.join(f.project, `.agent-chat/launchers/${client}.mjs`)));
          if (action === 'disable') {
            assert.equal(inspectInstallation(f).receipt.hooks[client], false);
            assert.equal(inspectInstallation(f).receipt.entries.some(entry => entry.kind === 'json-hook'), false);
          } else {
            assert.deepEqual(result.retainedClients, []);
            assert.equal(inspectInstallation(f).exists, false);
            assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
          }
        }
      }
    }
  }
});

test('edited and duplicated owned launcher references remain conflicts and retain dependencies', t => {
  for (const client of ['codex', 'claude']) {
    for (const changed of ['command', 'commandWindows', 'commandWindows-normalized', 'duplicates', 'exact-and-edited']) {
      for (const action of ['update', 'disable', 'uninstall']) {
        const f = fixture(t, `${client}-${changed}-${action}`);
        installProject({ ...f, clients: [client], hooks: true });
        const entries = inspectInstallation(f).receipt.entries.filter(entry => entry.kind === 'json-hook');
        const relative = entries[0].path;
        const config = readJson(f.project, relative);
        for (const entry of entries) {
          const edited = structuredClone(entry.value);
          if (changed.startsWith('commandWindows')) {
            edited.hooks[0].command = 'unrelated-posix-command';
            let launcher = path.join(f.project, `.agent-chat/launchers/${client}.mjs`).replaceAll('/', '\\');
            if (changed === 'commandWindows-normalized') launcher = launcher.toUpperCase().replaceAll('\\', '\\\\');
            edited.hooks[0].commandWindows = `node "${launcher}" --edited`;
          } else edited.hooks[0].command += ' --edited';
          config.hooks[entry.keyPath.at(-1)] = changed === 'duplicates' ? [entry.value, entry.value]
            : changed === 'exact-and-edited' ? [entry.value, edited] : [edited];
        }
        const beforeConfig = JSON.stringify(config, null, 4) + '\n';
        write(f.project, relative, beforeConfig);
        for (const entry of entries) assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'changed');
        const before = snapshot(f.project);
        if (action === 'uninstall') {
          const result = uninstallProject(f);
          assert.deepEqual(result.retainedClients, [client]);
          assert.ok(result.warnings.some(warning => /changed or duplicated notification hook/.test(warning)));
          assert.equal(inspectInstallation(f).receipt.entries.filter(entry => entry.kind === 'json-hook').length, entries.length);
          assert.ok(fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
          assert.ok(fs.existsSync(path.join(f.project, `.agent-chat/launchers/${client}.mjs`)));
        } else {
          assert.throws(() => updateProject({ ...f, ...(action === 'disable' ? { hooks: false } : {}) }), /changed|edited|duplicated/);
          assert.deepEqual(snapshot(f.project), before, 'Conflicting updates do not write any files.');
        }
        assert.equal(read(f.project, relative), beforeConfig, 'Conflicting hook groups are preserved byte-for-byte.');
      }
    }
  }
});

test('initial install rejects unmanaged launcher references with either path separator', t => {
  for (const client of ['codex', 'claude']) {
    for (const commandKey of ['command', 'commandWindows']) {
      const f = fixture(t, `${client}-${commandKey}`);
      const relative = client === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json';
      const launcher = '.agent-chat/launchers/opencode.mjs';
      write(f.project, relative, { hooks: { SessionStart: [{ hooks: [{ [commandKey]: `node ${commandKey === 'commandWindows' ? launcher.replaceAll('/', '\\') : launcher}` }] }] } });
      const before = snapshot(f.project);
      assert.throws(() => installProject({ ...f, clients: [client], hooks: true }), /unmanaged agent-chat notification hook/);
      assert.deepEqual(snapshot(f.project), before);
    }
  }
});

test('removed Codex MCP blocks restore on update and release ownership on uninstall', t => {
  for (const action of ['update', 'uninstall']) {
    const f = fixture(t, action);
    const unrelated = '# unrelated settings\nmodel = "kept"\n';
    write(f.project, '.codex/config.toml', unrelated);
    installProject({ ...f, clients: ['codex'] });
    const entry = inspectInstallation(f).receipt.entries.find(entry => entry.kind === 'toml-block');
    write(f.project, entry.path, unrelated);
    assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'missing');
    if (action === 'update') {
      updateProject(f);
      assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'present');
      assert.ok(read(f.project, entry.path).startsWith(unrelated));
    } else {
      assert.deepEqual(uninstallProject(f).retainedClients, []);
      assert.equal(read(f.project, entry.path), unrelated);
      assert.equal(inspectInstallation(f).exists, false);
      assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
    }
  }
});

test('an unmarked Codex MCP table is changed and preserves its runtime on uninstall', t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['codex'] });
  const entry = inspectInstallation(f).receipt.entries.find(entry => entry.kind === 'toml-block');
  const changed = '# user settings\nmodel = "kept"\n[mcp_servers.agent-chat]\ncommand = "custom-node"\n';
  write(f.project, entry.path, changed);
  assert.equal(inspectManagedEntry({ project: f.project, entry }).status, 'changed');
  const before = snapshot(f.project);
  assert.throws(() => updateProject(f), /managed agent-chat TOML block was changed/);
  assert.deepEqual(snapshot(f.project), before);
  assert.deepEqual(uninstallProject(f).retainedClients, ['codex']);
  assert.equal(read(f.project, entry.path), changed);
  assert.ok(fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
});

test('uninstall preserves user changes elsewhere and removes only its own entries', t => {
  const f = fixture(t); const toml = '# User comment\nmodel = "keep"\n'; write(f.project, '.codex/config.toml', toml);
  const other = { hooks: [{ type: 'command', command: 'keep' }] };
  write(f.project, '.claude/settings.local.json', { hooks: { PostToolUse: [other] }, permissions: { allow: ['Read'] } });
  installProject({ ...f, clients: ['codex', 'claude'], hooks: true });
  const settings = readJson(f.project, '.claude/settings.local.json'); settings.theme = 'later'; write(f.project, '.claude/settings.local.json', settings);
  const result = uninstallProject(f); assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /private backups/);
  assert.equal(read(f.project, '.codex/config.toml'), toml);
  const after = readJson(f.project, '.claude/settings.local.json'); assert.deepEqual(after.hooks.PostToolUse, [other]); assert.equal(after.theme, 'later');
  assert.ok(!fs.existsSync(path.join(f.project, '.mcp.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/install.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
});

test('edited managed entries and files survive uninstall with their runtime dependency', t => {
  const f = fixture(t); installProject({ ...f, clients: ['claude'], hooks: true });
  const mcp = readJson(f.project, '.mcp.json'); mcp.mcpServers['agent-chat'].args.push('user-argument'); write(f.project, '.mcp.json', mcp);
  write(f.project, '.claude/skills/agent-chat/SKILL.md', 'my custom skill');
  assert.throws(() => updateProject(f), /edited|changed/);
  const result = uninstallProject(f); assert.ok(result.warnings.length >= 2);
  assert.deepEqual(readJson(f.project, '.mcp.json'), mcp);
  assert.equal(read(f.project, '.claude/skills/agent-chat/SKILL.md'), 'my custom skill');
  assert.ok(fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['claude']);
});

test('partial uninstall keeps other clients and removes selected unchanged skills', t => {
  const f = fixture(t); installProject({ ...f, clients: ['codex', 'claude', 'opencode'], hooks: true });
  uninstallProject({ ...f, clients: ['claude'] });
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['codex', 'opencode']);
  assert.ok(!fs.existsSync(path.join(f.project, '.mcp.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.claude/skills/agent-chat/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.project, '.agent-chat/runtime/agent-chat.mjs')));
  assert.equal(updateProject(f).changes.length, 0);
});

test('malformed, duplicate and conflicting configs fail before any mutation', t => {
  for (const [relative, content, clients] of [
    ['.mcp.json', '{bad', ['claude']],
    ['.mcp.json', '{"mcpServers":{},"mcpServers":{}}', ['claude']],
    ['.mcp.json', '{"mcpServers":{"agent-chat":{"command":"mine"}}}', ['claude']],
    ['.codex/config.toml', 'model = [', ['codex']],
    ['.codex/config.toml', '[mcp_servers."agent-chat"]\ncommand="mine"', ['codex']],
    ['opencode.jsonc', '{ // keep comments\n}', ['opencode']],
    ['.claude/settings.local.json', '{"hooks":[]}', ['claude']],
  ]) {
    const f = fixture(t, `case-${Math.random()}`); write(f.project, relative, content); const before = snapshot(f.project);
    assert.throws(() => installProject({ ...f, clients, hooks: true }), /invalid|duplicate|exists|JSONC|must be/);
    assert.deepEqual(snapshot(f.project), before);
  }
});

test('unmanaged runtime or skills and symlink escapes are refused without overwriting', t => {
  for (const relative of ['.agent-chat/runtime/agent-chat.mjs', '.agents/skills/agent-chat/SKILL.md']) {
    const f = fixture(t, `case-${Math.random()}`); write(f.project, relative, 'mine'); const before = snapshot(f.project);
    assert.throws(() => installProject({ ...f, clients: ['codex'] }), /outside this installation/); assert.deepEqual(snapshot(f.project), before);
  }
  const f = fixture(t, 'symlink'); const external = path.join(f.base, 'external'); fs.mkdirSync(external);
  try { fs.symlinkSync(external, path.join(f.project, '.codex'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM' && process.platform === 'win32') return t.skip('symlink permission unavailable'); throw error; }
  assert.throws(() => installProject({ ...f, clients: ['codex'] }), /symlinks/);
  assert.deepEqual(fs.readdirSync(external), []);
});

test('transaction failure rolls back every written file and retains private backups', t => {
  const f = fixture(t); write(f.project, '.mcp.json', { mcpServers: { other: { command: 'original' } } });
  const before = read(f.project, '.mcp.json');
  assert.throws(() => installProject({ ...f, clients: ['codex', 'claude'], hooks: true, beforeWrite: ({ index }) => { if (index === 4) throw new Error('simulated disk failure'); } }), /rolled back/);
  assert.equal(read(f.project, '.mcp.json'), before);
  assert.ok(!fs.existsSync(path.join(f.project, '.codex/config.toml')));
  assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/install.json')));
  assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/install.lock')));
  const backups = fs.readdirSync(path.join(f.project, '.agent-chat/backups')); assert.equal(backups.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.project, '.agent-chat/backups', backups[0], '0.before')).mode & 0o777, 0o600);
});

test('concurrent edits and installer locks never overwrite the changed file', t => {
  const f = fixture(t); write(f.project, '.mcp.json', { preserve: true });
  assert.throws(() => installProject({ ...f, clients: ['claude'], beforeWrite: ({ path: relative }) => { if (relative === '.mcp.json') write(f.project, relative, { preserve: 'changed-during-transaction' }); } }), /changed during/);
  assert.deepEqual(readJson(f.project, '.mcp.json'), { preserve: 'changed-during-transaction' });
  write(f.project, '.agent-chat/install.lock', '{}');
  assert.throws(() => installProject({ ...f, clients: ['claude'] }), /locked/);
  assert.deepEqual(readJson(f.project, '.mcp.json'), { preserve: 'changed-during-transaction' });
});

test('receipt cannot claim arbitrary project files for deletion', t => {
  const f = fixture(t); installProject({ ...f, clients: ['claude'] }); write(f.project, 'precious.txt', 'preserve');
  const receipt = inspectInstallation(f).receipt; receipt.files['precious.txt'] = { sha256: '0'.repeat(64), clients: ['claude'] }; write(f.project, '.agent-chat/install.json', receipt);
  assert.throws(() => uninstallProject(f), /unexpected owned file/); assert.equal(read(f.project, 'precious.txt'), 'preserve');
});

test('portable hook command quoting handles spaces and POSIX metacharacters safely', t => {
  if (process.platform !== 'win32') {
    const f = fixture(t, "project '$` %! spaces");
    installProject({ ...f, clients: ['codex', 'claude'], hooks: true });
    for (const relative of ['.codex/hooks.json', '.claude/settings.local.json']) {
      const command = readJson(f.project, relative).hooks.SessionStart[0].hooks[0].command;
      const payload = JSON.stringify({ session_id: 'test', cwd: f.project, hook_event_name: 'SessionStart' });
      const result = spawnSync('/bin/sh', ['-c', command], { input: payload, encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Call chat_who once/);
    }
  }
  assert.equal(quotePosix("a'b"), "'a'\\''b'"); assert.equal(quoteWindows('C:\\with space\\node.exe'), '"C:\\with space\\node.exe"');
  assert.throws(() => quoteWindows('unsafe%PATH%'), /cannot contain/);
});

test('private backups stay ignored after uninstall and reinstall accepts the retained block', t => {
  const f = fixture(t); const original = 'node_modules/\n# user setting\n'; write(f.project, '.gitignore', original);
  installProject({ ...f, clients: ['claude'] });
  assert.ok(read(f.project, '.gitignore').startsWith(original));
  assert.match(read(f.project, '.gitignore'), /\/\.agent-chat\//);
  uninstallProject(f);
  assert.ok(read(f.project, '.gitignore').startsWith(original));
  installProject({ ...f, clients: ['claude'] });
  assert.equal(read(f.project, '.gitignore').split('# >>> agent-chat local state >>>').length, 2);
});

test('existing config modes survive install and rollback', t => {
  if (process.platform === 'win32') return t.skip('POSIX modes unavailable');
  const f = fixture(t); write(f.project, '.mcp.json', { keep: true }); fs.chmodSync(path.join(f.project, '.mcp.json'), 0o640);
  installProject({ ...f, clients: ['claude'] });
  assert.equal(fs.statSync(path.join(f.project, '.mcp.json')).mode & 0o777, 0o640);
  const f2 = fixture(t, 'rollback-mode'); write(f2.project, '.mcp.json', { keep: true }); fs.chmodSync(path.join(f2.project, '.mcp.json'), 0o640);
  assert.throws(() => installProject({ ...f2, clients: ['claude'], beforeWrite: ({ index }) => { if (index === 3) throw new Error('fail'); } }), /rolled back/);
  assert.equal(fs.statSync(path.join(f2.project, '.mcp.json')).mode & 0o777, 0o640);
});

test('concurrent receipt replacement cannot silently discard another client', t => {
  const f = fixture(t); installProject({ ...f, clients: ['claude'] });
  let triggered = false;
  const options = { ...f, hooks: true, get clients() { if (!triggered) { triggered = true; installProject({ ...f, clients: ['opencode'] }); } return ['claude']; } };
  assert.throws(() => installProject(options), /changed while|changed during/);
  assert.deepEqual(inspectInstallation(f).receipt.clients, ['claude', 'opencode']);
});

test('unsafe backup directory rejection never leaves an install lock', t => {
  const f = fixture(t); const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside); fs.mkdirSync(path.join(f.project, '.agent-chat'));
  const link = path.join(f.project, '.agent-chat/backups');
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('symlink permission unavailable'); throw error; }
  assert.throws(() => installProject({ ...f, clients: ['claude'] }), /symlinks/);
  assert.ok(!fs.existsSync(path.join(f.project, '.agent-chat/install.lock')));
  fs.unlinkSync(link);
  installProject({ ...f, clients: ['claude'] });
  assert.ok(inspectInstallation(f).exists);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed first install leaves all private backup snapshots ignored by Git', t => {
  const f = fixture(t); const git = spawnSync('git', ['init', '-q', f.project], { encoding: 'utf8' });
  if (git.error?.code === 'ENOENT') return t.skip('Git unavailable');
  assert.equal(git.status, 0, git.stderr);
  write(f.project, '.mcp.json', { privateSetting: 'fixture-secret' });
  assert.throws(() => installProject({ ...f, clients: ['claude'], beforeWrite: ({ index }) => { if (index === 2) throw new Error('fail'); } }), /rolled back/);
  assert.equal(fs.existsSync(path.join(f.project, '.gitignore')), false);
  const directory = fs.readdirSync(path.join(f.project, '.agent-chat/backups'))[0];
  const backup = `.agent-chat/backups/${directory}/0.before`;
  const ignored = spawnSync('git', ['-C', f.project, 'check-ignore', backup], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr); assert.match(ignored.stdout, /0.before/);
  assert.equal(read(f.project, '.agent-chat/.gitignore'), '*\n');
});

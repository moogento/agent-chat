import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-package-'));
const env = {
  ...process.env,
  AGENT_CHAT_HOME: path.join(temp, 'mailbox'),
  AGENT_CHAT_ROOM: 'package-smoke',
  AGENT_CHAT_NAME: 'package-smoke',
  AGENT_CHAT_SESSION: 'package-smoke-session',
  npm_config_cache: path.join(temp, 'npm-cache'),
  npm_config_update_notifier: 'false',
};
let packed;
let installed;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function npm(...args) {
  assert.ok(process.env.npm_execpath, 'Run package tests with npm test.');
  return run(process.execPath, [process.env.npm_execpath, ...args]);
}
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

before(() => {
  [packed] = JSON.parse(npm('pack', '--json', '--ignore-scripts', '--pack-destination', temp));
  const prefix = path.join(temp, 'install');
  npm('install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temp, packed.filename));
  installed = path.join(prefix, 'node_modules', pkg.name);
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('portable and client manifests agree and reference contained resources', () => {
  const portable = json('plugin.json');
  const codex = json('.codex-plugin/plugin.json');
  const claude = json('.claude-plugin/plugin.json');
  for (const manifest of [portable, codex, claude]) {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
  }
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  for (const key of ['skills', 'mcpServers', 'apps', 'interface']) assert.equal(portable[key], undefined);
  const openai = portable.extensions['com.openai'];
  assert.ok(openai.interface.shortDescription.length <= 30);
  assert.deepEqual(openai.interface, codex.interface);
  for (const ref of [openai.hooks, codex.hooks, codex.mcpServers, codex.skills, claude.hooks]) {
    assert.ok(ref.startsWith('./') && !ref.includes('..'), ref);
    assert.ok(fs.existsSync(path.join(root, ref)), ref);
  }
  const mcp = json('mcp.json').mcpServers['agent-chat'];
  assert.equal(mcp.type, 'stdio');
  assert.deepEqual(mcp.args, ['${PLUGIN_ROOT}/agent-chat.mjs']);
  assert.equal(mcp.cwd, undefined, 'Preserve the host project working directory.');
  const claudeMcp = json('.mcp.json').mcpServers['agent-chat'];
  assert.deepEqual(claudeMcp.args, ['${CLAUDE_PLUGIN_ROOT}/agent-chat.mjs']);
  assert.equal(claudeMcp.cwd, undefined);
});

test('packed inventory includes client adapters and excludes private or development files', () => {
  const files = new Set(packed.files.map(file => file.path));
  for (const required of ['agent-chat.mjs', 'lib/mailbox.mjs', 'lib/install.mjs', 'lib/doctor.mjs', 'lib/broker.mjs', 'lib/broker-client.mjs', 'lib/broker-cli.mjs', 'LICENSE', 'README.md', 'package.json', 'plugin.json', 'mcp.json', '.mcp.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'hooks/codex.json', 'hooks/claude-code.json', 'hooks/notify.mjs', 'hooks/notifications.mjs', 'hooks/bind.mjs', 'integrations/opencode/agent-chat.mjs', 'skills/agent-chat/SKILL.md', 'docs/notifications.md', 'docs/installation.md', 'docs/docker.md', 'examples/docker/Dockerfile', 'examples/docker/Dockerfile.dockerignore', 'examples/docker/compose.yaml', 'examples/docker/create-token.mjs', 'scripts/test-docker.mjs', 'node_modules/smol-toml/LICENSE']) {
    assert.ok(files.has(required), `Missing packed resource: ${required}`);
  }
  for (const file of files) {
    if (file.startsWith('node_modules/smol-toml/')) {
      assert.doesNotMatch(file, /(^|\/)(\.env[^/]*|test|private)(\/|$)|\.(tgz|zip|log)$/);
    } else {
      assert.doesNotMatch(file, /(^|\/)(\.temp|\.git|\.env[^/]*|node_modules|dist|test|coverage|private)(\/|$)|\.(tgz|zip|log)$/);
    }
    assert.ok(fs.lstatSync(path.join(root, file)).isFile(), `Only regular source files are allowed: ${file}`);
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['smol-toml']);
  assert.match(pkg.dependencies['smol-toml'], /^\d+\.\d+\.\d+$/, 'Bundle one exact parser version.');
  assert.deepEqual(pkg.bundleDependencies, ['smol-toml']);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) assert.equal(pkg.scripts[hook], undefined);
});

test('installed CLI can send and inspect a message without a source checkout', () => {
  const cli = path.join(installed, 'agent-chat.mjs');
  assert.equal(run(process.execPath, [cli, '--version']).trim(), pkg.version);
  assert.match(run(process.execPath, [cli, '--help']), /agent-chat send/);
  assert.match(run(process.execPath, [cli, 'broker', '--help']), /agent-chat broker --token-file/);
  assert.match(run(process.execPath, [cli, 'proxy', '--help']), /AGENT_CHAT_BROKER_URL/);
  assert.match(run(process.execPath, [cli, 'send', '--to', 'reviewer', 'packed message']), /Sent/);
  assert.match(run(process.execPath, [cli, 'log']), /human -> reviewer: packed message/);
  const installedPkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(installedPkg.bin['agent-chat'], './agent-chat.mjs');
  if (process.platform !== 'win32') assert.ok(fs.statSync(cli).mode & 0o111, 'npm installs the bin as executable.');
});

test('installed MCP starts and discovers tools with protocol-only stdout', () => {
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  const output = run(process.execPath, [path.join(installed, 'agent-chat.mjs')], { input: `${requests.map(req => JSON.stringify(req)).join('\n')}\n` });
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses.find(item => item.id === 1).result.serverInfo.version, pkg.version);
  const tools = responses.find(item => item.id === 2).result.tools.map(tool => tool.name);
  for (const name of ['chat_send', 'chat_read', 'chat_join', 'chat_who', 'chat_status', 'chat_rooms']) assert.ok(tools.includes(name));
});

test('installed OpenCode export loads the bundled shared notification implementation', () => {
  const code = 'import { AgentChatPlugin } from "agent-chat"; if (typeof AgentChatPlugin !== "function") process.exit(1);';
  run(process.execPath, ['--input-type=module', '-e', code], { cwd: path.dirname(path.dirname(installed)) });
});

test('offline installed package manages all clients without replacing unrelated project settings', () => {
  const project = path.join(temp, 'managed-project');
  fs.mkdirSync(path.join(project, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const writeJson = (relative, value) => fs.writeFileSync(path.join(project, relative), `${JSON.stringify(value, null, 2)}\n`);
  const readJson = relative => JSON.parse(fs.readFileSync(path.join(project, relative), 'utf8'));
  const codexConfig = '# unrelated project settings\nmodel = "kept-model"\n[mcp_servers.unrelated]\ncommand = "kept-server"\nargs = ["--kept"]\n';
  fs.writeFileSync(path.join(project, '.gitignore'), '# existing rules\n/keep-ignored/\n');
  fs.writeFileSync(path.join(project, '.codex/config.toml'), codexConfig);
  const unrelatedHook = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo keep-existing-hook' }] };
  writeJson('.codex/hooks.json', { hooks: { PostToolUse: [unrelatedHook] }, customSetting: 'codex-kept' });
  writeJson('.mcp.json', { mcpServers: { unrelated: { command: 'kept-server' } }, customSetting: 'claude-kept' });
  writeJson('.claude/settings.json', { hooks: { PostToolUse: [unrelatedHook] }, customSetting: 'claude-settings-kept' });
  writeJson('.claude/settings.local.json', { customSetting: 'claude-local-kept' });
  writeJson('opencode.json', { mcp: { unrelated: { type: 'local', command: ['kept-server'] } }, plugin: ['kept-plugin'], customSetting: 'opencode-kept' });
  const cli = path.join(installed, 'agent-chat.mjs');
  const invoke = (...args) => run(process.execPath, [cli, ...args, '--project', project]);
  const snapshot = () => {
    const result = {};
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else result[path.relative(project, file)] = fs.readFileSync(file).toString('base64');
      }
    }
    walk(project);
    return result;
  };
  const original = snapshot();
  invoke('install', '--clients', 'codex,claude,opencode', '--hooks', '--dry-run');
  assert.deepEqual(snapshot(), original, 'Install preview must not write any project files.');

  invoke('install', '--clients', 'codex,claude,opencode', '--hooks');
  const runtime = path.join(project, '.agent-chat/runtime');
  assert.ok(fs.existsSync(path.join(runtime, 'agent-chat.mjs')));
  assert.ok(fs.existsSync(path.join(project, '.agent-chat/install.json')));
  const installedIgnore = fs.readFileSync(path.join(project, '.gitignore'), 'utf8');
  assert.match(installedIgnore, /\/keep-ignored\//);
  assert.match(installedIgnore, /^\/\.agent-chat\/$/m);
  assert.equal(run(process.execPath, [path.join(runtime, 'agent-chat.mjs'), '--version']).trim(), pkg.version);
  assert.ok(readJson('.mcp.json').mcpServers['agent-chat']);
  assert.ok(readJson('opencode.json').mcp['agent-chat']);
  assert.ok(parseToml(fs.readFileSync(path.join(project, '.codex/config.toml'), 'utf8')).mcp_servers['agent-chat']);

  const beforeDoctor = snapshot();
  const doctor = JSON.parse(invoke('doctor', '--json'));
  assert.equal(doctor.ok, true, JSON.stringify(doctor.checks));
  const runtimeDoctor = JSON.parse(run(process.execPath, [path.join(runtime, 'agent-chat.mjs'), 'doctor', '--project', project, '--json']));
  assert.equal(runtimeDoctor.ok, true, JSON.stringify(runtimeDoctor.checks));
  assert.deepEqual(snapshot(), beforeDoctor, 'Doctor must remain read only.');
  const claude = readJson('.mcp.json');
  claude.addedAfterInstall = { keep: true };
  writeJson('.mcp.json', claude);
  const beforeUpdate = snapshot();
  invoke('update', '--dry-run');
  assert.deepEqual(snapshot(), beforeUpdate, 'Update preview must not write files.');
  invoke('update');
  assert.equal(JSON.parse(invoke('doctor', '--json')).ok, true);
  assert.deepEqual(readJson('.mcp.json').addedAfterInstall, { keep: true });

  const beforeUninstall = snapshot();
  invoke('uninstall', '--dry-run');
  assert.deepEqual(snapshot(), beforeUninstall, 'Removal preview must not write files.');
  invoke('uninstall');
  assert.equal(readJson('.mcp.json').mcpServers['agent-chat'], undefined);
  assert.equal(readJson('opencode.json').mcp['agent-chat'], undefined);
  const codexAfter = fs.readFileSync(path.join(project, '.codex/config.toml'), 'utf8');
  assert.match(codexAfter, /model = "kept-model"/);
  assert.match(codexAfter, /\[mcp_servers\.unrelated\]/);
  assert.equal(parseToml(codexAfter).mcp_servers['agent-chat'], undefined);
  assert.deepEqual(readJson('.mcp.json').mcpServers.unrelated, { command: 'kept-server' });
  assert.deepEqual(readJson('.mcp.json').addedAfterInstall, { keep: true });
  assert.equal(readJson('.mcp.json').customSetting, 'claude-kept');
  assert.equal(readJson('.claude/settings.json').customSetting, 'claude-settings-kept');
  assert.equal(readJson('.claude/settings.local.json').customSetting, 'claude-local-kept');
  assert.equal(readJson('.codex/hooks.json').customSetting, 'codex-kept');
  assert.deepEqual(readJson('.codex/hooks.json').hooks.PostToolUse, [unrelatedHook]);
  assert.deepEqual(readJson('.claude/settings.json').hooks.PostToolUse, [unrelatedHook]);
  assert.deepEqual(readJson('opencode.json').plugin, ['kept-plugin']);
  assert.deepEqual(readJson('opencode.json').mcp.unrelated, { type: 'local', command: ['kept-server'] });
  assert.equal(readJson('opencode.json').customSetting, 'opencode-kept');
  assert.equal(fs.existsSync(path.join(runtime, 'agent-chat.mjs')), false, 'Unmodified runtime files are removed after the last client.');
  assert.equal(fs.existsSync(path.join(project, '.agent-chat/install.json')), false);
  assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), installedIgnore, 'Retained private local data must remain ignored.');
});

test('release archives contain one complete plugin and both valid marketplace layouts', () => {
  const output = path.join(temp, 'release');
  run(process.execPath, [path.join(root, 'scripts/release.mjs'), output], { timeout: 60000 });
  const pluginArchive = path.join(output, `agent-chat-plugin-${pkg.version}.tgz`);
  const listing = run('tar', ['-tzf', pluginArchive]).split('\n').filter(Boolean);
  assert.ok(listing.every(file => file.startsWith('agent-chat/')));
  assert.ok(listing.includes('agent-chat/.codex-plugin/plugin.json'));
  assert.ok(listing.includes('agent-chat/.claude-plugin/plugin.json'));
  assert.ok(listing.includes('agent-chat/integrations/opencode/agent-chat.mjs'));
  assert.ok(listing.includes('agent-chat/INSTALL.txt'));
  assert.ok(listing.includes('agent-chat/node_modules/smol-toml/LICENSE'));
  assert.ok(listing.includes('agent-chat/lib/broker.mjs'));
  assert.ok(listing.includes('agent-chat/examples/docker/compose.yaml'));
  const checksums = fs.readFileSync(path.join(output, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(checksums.length, 3);
  for (const line of checksums) {
    assert.match(line, /^[a-f0-9]{64}  agent-chat.*\.tgz$/);
    const [expected, filename] = line.split('  ');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(output, filename))).digest('hex'), expected);
  }
  const extracted = path.join(temp, 'extracted');
  fs.mkdirSync(extracted);
  run('tar', ['-xzf', path.join(output, `agent-chat-marketplace-${pkg.version}.tgz`), '-C', extracted]);
  const marketRoot = path.join(extracted, 'agent-chat-marketplace');
  const codex = JSON.parse(fs.readFileSync(path.join(marketRoot, '.agents/plugins/marketplace.json'), 'utf8'));
  const claude = JSON.parse(fs.readFileSync(path.join(marketRoot, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(codex.name, 'agent-chat-local');
  assert.equal(claude.name, codex.name);
  assert.equal(codex.plugins[0].source.source, 'local');
  assert.equal(codex.plugins[0].source.path, claude.plugins[0].source);
  const manifest = path.join(marketRoot, codex.plugins[0].source.path, 'plugin.json');
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).version, pkg.version);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installProject } from '../lib/install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const standalonePath = path.join(root, 'integrations/opencode/agent-chat.standalone.mjs');

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-standalone-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  return { project, sourceRoot: root };
}

test('the shipped OpenCode adapter imports nothing from the filesystem', async () => {
  const source = fs.readFileSync(standalonePath, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(match => match[1]);
  const external = specifiers.filter(specifier => !specifier.startsWith('node:'));
  assert.deepEqual(external, [], 'runtime cannot resolve filesystem imports, so the bundle must be self-contained');
  assert.ok(source.includes('__AGENT_CHAT_NOTIFY_CONFIG__'), 'notify-config placeholder missing');
  assert.ok(source.includes('__AGENT_CHAT_EMBEDDED_ENV__'), 'embedded-env placeholder missing');
  const module = await import(`${pathToFileURL(standalonePath).href}?probe=${Date.now()}`);
  assert.deepEqual(Object.keys(module), ['AgentChat', 'default']);
  assert.equal(typeof module.default.id, 'string', 'the loader requires a non-empty id');
  assert.ok(module.default.id.length > 0);
  assert.equal(typeof module.default.setup, 'function', 'OpenCode 2.x calls setup(), not the module function');
});

test('the bundle still imports when argv[1] is a path the host only invents', async () => {
  const previous = process.argv[1];
  process.argv[1] = process.platform === 'win32' ? 'C:\\$bunfs\\root\\opencode' : '/$bunfs/root/opencode';
  try {
    const module = await import(`${pathToFileURL(standalonePath).href}?argv=${Date.now()}`);
    assert.equal(typeof module.default.setup, 'function');
  } finally {
    process.argv[1] = previous;
  }
});

test('installer writes a self-contained plugin without substituting an import path', t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['opencode'], hooks: true });
  const written = fs.readFileSync(path.join(f.project, '.opencode/plugins/agent-chat.js'), 'utf8');
  const specifiers = [...written.matchAll(/^\s*import[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.deepEqual(specifiers.filter(specifier => !specifier.startsWith('node:')), []);
  assert.ok(!written.includes('file:///'), 'installed adapter must not reference a runtime file URL');
  assert.ok(!written.includes('__AGENT_CHAT_NOTIFY_CONFIG__'), 'notify path was not substituted');
  assert.ok(written.includes('notifications.json'), 'notify config path missing from the adapter');
  assert.ok(/["']notifications\.json["']/.test(written), 'notify config path is not a quoted literal');
  const embedded = written.match(/var embeddedEnv = (".*?");/);
  assert.ok(embedded, 'embedded environment literal missing');
  const canonical = project => (process.platform === 'win32' ? fs.realpathSync.native : fs.realpathSync)(project);
  assert.deepEqual(JSON.parse(JSON.parse(embedded[1])), {
    AGENT_CHAT_BROKER_URL: '',
    AGENT_CHAT_BROKER_TOKEN_FILE: '',
    AGENT_CHAT_ROOM: canonical(f.project),
  });
});

test('the installed adapter exposes the default export the loader invokes', async t => {
  const f = fixture(t);
  installProject({ ...f, clients: ['opencode'], hooks: true });
  const installed = path.join(f.project, '.opencode/plugins/agent-chat.js');
  const probe = path.join(f.project, 'agent-chat.plugin.mjs');
  fs.copyFileSync(installed, probe);
  const module = await import(`${pathToFileURL(probe).href}?probe=${Date.now()}`);
  assert.deepEqual(Object.keys(module), ['AgentChat', 'default']);
  assert.equal(typeof module.default.setup, 'function');
});

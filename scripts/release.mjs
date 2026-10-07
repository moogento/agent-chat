import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] || path.join(root, 'dist'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-release-'));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false', npm_config_cache: path.join(temp, 'npm-cache') },
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

try {
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run release:local.');
  fs.mkdirSync(output, { recursive: true });
  const [packed] = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--ignore-scripts', '--pack-destination', output]));
  const packedPaths = new Set(packed.files.map(file => file.path));
  for (const required of ['lib/install.mjs', 'lib/doctor.mjs', 'lib/broker.mjs', 'lib/broker-client.mjs', 'lib/broker-cli.mjs', 'docs/installation.md', 'docs/docker.md', 'examples/docker/compose.yaml', 'examples/docker/Dockerfile', 'examples/docker/Dockerfile.dockerignore', 'scripts/test-docker.mjs', 'node_modules/smol-toml/LICENSE']) {
    if (!packedPaths.has(required)) throw new Error(`Release is missing ${required}; run npm ci --ignore-scripts before building.`);
  }
  const npmArchive = path.join(output, packed.filename);
  run('tar', ['-xzf', npmArchive, '-C', temp]);
  const pluginRoot = path.join(temp, 'agent-chat');
  fs.renameSync(path.join(temp, 'package'), pluginRoot);
  fs.writeFileSync(path.join(pluginRoot, 'INSTALL.txt'), `Agent Chat ${pkg.version}\n\nRequires Node.js 22 or newer. From this extracted folder:\n\n  node agent-chat.mjs install --project /absolute/path/to/your-project --clients codex,claude,opencode --hooks\n  node agent-chat.mjs doctor --project /absolute/path/to/your-project\n\nChoose only the clients you use. Omit --hooks for MCP and skills only.\nRestart those clients in the project, then review and trust hooks if prompted.\nSee docs/installation.md for dry runs, updates, removal, and notification setup.\n\nUpdates use this executable's bundled version, with no update download.\nUse a newer trusted package executable when adopting a newer release.\n`);
  const pluginArchive = path.join(output, `agent-chat-plugin-${pkg.version}.tgz`);
  run('tar', ['-czf', pluginArchive, '-C', temp, 'agent-chat']);

  const marketplaceName = 'agent-chat-local';
  const marketRoot = path.join(temp, 'agent-chat-marketplace');
  fs.mkdirSync(path.join(marketRoot, '.agents', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(marketRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(marketRoot, 'plugins'), { recursive: true });
  fs.cpSync(pluginRoot, path.join(marketRoot, 'plugins', 'agent-chat'), { recursive: true });
  const write = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  write(path.join(marketRoot, '.agents', 'plugins', 'marketplace.json'), {
    name: marketplaceName,
    plugins: [{ name: 'agent-chat', source: { source: 'local', path: './plugins/agent-chat' } }],
  });
  write(path.join(marketRoot, '.claude-plugin', 'marketplace.json'), {
    name: marketplaceName,
    owner: { name: 'agent-chat contributors' },
    plugins: [{ name: 'agent-chat', source: './plugins/agent-chat', version: pkg.version }],
  });
  const marketplaceArchive = path.join(output, `agent-chat-marketplace-${pkg.version}.tgz`);
  run('tar', ['-czf', marketplaceArchive, '-C', temp, 'agent-chat-marketplace']);
  const checksums = path.join(output, 'SHA256SUMS');
  fs.writeFileSync(checksums, [npmArchive, pluginArchive, marketplaceArchive].map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.basename(file)}`).join('\n') + '\n');
  process.stdout.write(`${JSON.stringify({ npm: npmArchive, plugin: pluginArchive, marketplace: marketplaceArchive, checksums }, null, 2)}\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

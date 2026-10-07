import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('Docker example creates a private random token without replacing an existing secret', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-token-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const directory = path.join(temp, 'secret');
  const generate = () => spawnSync(process.execPath, [path.join(root, 'examples/docker/create-token.mjs'), directory], { encoding: 'utf8' });
  const first = generate();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(directory, 'broker-token');
  const token = fs.readFileSync(file, 'utf8');
  assert.match(token, /^[a-f0-9]{96}\n$/);
  assert.doesNotMatch(first.stdout, new RegExp(token.trim()));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  }
  assert.notEqual(generate().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), token);
});

test('Docker build context excludes private source state and agents have no mailbox mount', () => {
  const ignore = fs.readFileSync(path.join(root, 'examples/docker/Dockerfile.dockerignore'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(ignore.startsWith('**\n'));
  assert.doesNotMatch(ignore, /!\.git|!\.env|!\.temp|!node_modules/);
  const compose = fs.readFileSync(path.join(root, 'examples/docker/compose.yaml'), 'utf8').replace(/\r\n/g, '\n');
  const agent = compose.split('  agent:\n')[1].split('\nsecrets:')[0];
  assert.doesNotMatch(agent, /volumes:|\/data|47321:47321/);
  assert.match(agent, /read_only: true/);
  assert.match(compose, /host_ip: 127\.0\.0\.1/);
  assert.match(compose, /file: \$\{AGENT_CHAT_TOKEN_FILE:\?/);
});

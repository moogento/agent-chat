import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function check(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile() && file.endsWith('.mjs')) check(file);
  }
}
check(path.join(root, 'agent-chat.mjs'));
for (const dir of ['lib', 'hooks', 'integrations', 'scripts', 'test', 'examples']) {
  const full = path.join(root, dir);
  if (fs.existsSync(full)) walk(full);
}

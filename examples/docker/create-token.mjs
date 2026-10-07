import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = path.resolve(process.argv[2] || '.agent-chat/docker');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const stat = fs.lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) {
  throw new Error('Choose a private directory with permissions 0700 for the Docker token.');
}
const file = path.join(directory, 'broker-token');
// Compose file secrets preserve host file modes. The private parent protects the
// host token while the read-only mounted file remains readable by container UID 1000.
fs.writeFileSync(file, crypto.randomBytes(48).toString('hex') + '\n', { flag: 'wx', mode: 0o444 });
if (process.platform !== 'win32') fs.chmodSync(file, 0o444);
process.stdout.write(`${file}\n`);

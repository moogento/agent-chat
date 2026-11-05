import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const NAME_LIMIT = 120;
export function agentType(client = '') {
  return ['codex', 'claude', 'opencode'].find(type => String(client).toLowerCase().includes(type)) || 'unknown';
}
const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function sessionRepo(cwd = process.cwd()) {
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const directory = path.resolve(cwd, common);
    if (path.basename(directory) === '.git') return path.dirname(directory);
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return path.resolve(cwd); }
}
export function sessionName({ client, cwd, repo = sessionRepo(cwd), title, sessionId = '' } = {}) {
  const prefix = `${agentType(client)}-${(slug(path.basename(repo)) || 'root').slice(0, 32)}-`;
  // Accept a complete identifier as well as a title without duplicating its prefix.
  const supplied = typeof title === 'string' ? title.trim().toLowerCase() : '';
  if (supplied.startsWith(prefix) && /^[a-z0-9-]+$/.test(supplied)) return supplied.slice(0, NAME_LIMIT);
  const suffix = slug(title || '') || `untitled-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 6)}`;
  return prefix + suffix.slice(0, NAME_LIMIT - prefix.length);
}

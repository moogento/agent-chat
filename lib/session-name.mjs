import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const NAME_LIMIT = 120;
export const LEGACY_NAME_LIMIT = 40;
export const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function agentType(client = '') {
  return ['codex', 'claude', 'opencode'].find(type => String(client).toLowerCase().includes(type)) || 'unknown';
}
export function parseSessionName(name) {
  const match = /^(codex|claude|opencode|unknown)-([a-z0-9]{1,32})-((?:untitled-[a-f0-9]{6}|[a-z0-9]+)(?:-[0-9]+)?)$/.exec(name || '');
  return match ? { agent: match[1], repo: match[2], title: match[3] } : null;
}
export function remoteRepo(cwd) {
  return (slug(String(cwd).replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'root') || 'root').slice(0, 32);
}
export function sessionRepo(cwd = process.cwd()) {
  try {
    const real = fs.realpathSync.native(cwd);
    const git = flag => execFileSync('git', ['-C', real, 'rev-parse', flag], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const common = path.resolve(real, git('--git-common-dir'));
    if (path.basename(common) === '.git' || path.basename(common) === '.bare') return path.dirname(common);
    // Bare repositories also own linked worktrees; the common directory identifies the repository.
    return common.endsWith('.git') ? common.slice(0, -4) : common;
  } catch { return path.resolve(cwd); }
}
export function sessionName({ client, cwd, repo = sessionRepo(cwd), title, sessionId = '', limit = NAME_LIMIT } = {}) {
  const family = agentType(client);
  const repoLimit = Math.min(32, limit - family.length - 2 - 15);
  const prefix = `${family}-${(slug(path.basename(repo)) || 'root').slice(0, repoLimit)}-`;
  let supplied = typeof title === 'string' ? title.trim().toLowerCase() : '';
  if (supplied.startsWith(prefix)) {
    if (parseSessionName(supplied)) return supplied.slice(0, limit).replace(/-+$/, '');
    supplied = supplied.slice(prefix.length);
  }
  const suffix = slug(supplied) || `untitled-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 6)}`;
  return prefix + suffix.slice(0, limit - prefix.length);
}

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
export function titleBase(title) {
  return /^untitled-[a-f0-9]{6}$/.test(title) ? title : title.replace(/-[0-9]+$/, '');
}
export function remoteRepo(cwd) {
  return (slug(String(cwd).replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'root') || 'root').slice(0, 32);
}
export function sessionRepo(cwd = process.cwd()) {
  try {
    const real = fs.realpathSync.native(cwd);
    const options = { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] };
    const dirs = execFileSync('git', ['-C', real, 'rev-parse', '--git-dir', '--git-common-dir'], options).trim().split(/\r?\n/).map(dir => fs.realpathSync.native(path.resolve(real, dir)));
    if (dirs[0] === dirs[1]) {
      try { return path.resolve(execFileSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], options).trim()); } catch { /* bare repository */ }
    }
    const output = execFileSync('git', ['-C', real, 'worktree', 'list', '--porcelain', '-z'], options);
    const fields = output.split('\0');
    const first = fields.slice(0, fields.indexOf(''));
    if (!first[0]?.startsWith('worktree ')) throw new Error('Missing primary worktree');
    const root = path.resolve(first[0].slice(9));
    if (!first.includes('bare')) return root;
    if (['.git', '.bare'].includes(path.basename(root))) return path.dirname(root);
    return root.endsWith('.git') ? root.slice(0, -4) : root;
  } catch { return path.resolve(cwd); }
}
export function sessionName({ client, cwd, repo = sessionRepo(cwd), title, sessionId = '', limit = NAME_LIMIT } = {}) {
  const family = agentType(client);
  const repoLimit = Math.min(32, limit - family.length - 2 - 15);
  const prefix = `${family}-${(slug(path.basename(repo)) || 'root').slice(0, repoLimit)}-`;
  let supplied = typeof title === 'string' ? title.trim().toLowerCase() : '';
  const qualified = /^(codex|claude|opencode|unknown)-[a-z0-9]{1,32}-(.*)$/.exec(supplied);
  if (qualified) {
    if (parseSessionName(supplied)) return (prefix + qualified[2]).slice(0, limit).replace(/-+$/, '');
    supplied = qualified[2];
  }
  const suffix = slug(supplied) || `untitled-${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 6)}`;
  return prefix + suffix.slice(0, limit - prefix.length);
}

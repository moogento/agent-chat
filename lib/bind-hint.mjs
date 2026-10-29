import fs from 'node:fs';
import path from 'node:path';

export const BIND_HINT_DIRECTORY = 'bind-hints';
export const BIND_HINT_MAX_BYTES = 4096;
export const BIND_HINT_MAX_AGE_MS = 15 * 60 * 1000;
export const BIND_HINT_MAX_SCAN = 500;
const PID_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;
const HINT_FILE_PATTERN = /^mcp-([0-9]{1,10})\.json$/;

const hintDirectory = home => path.join(home, BIND_HINT_DIRECTORY);

const positivePid = value => Number.isSafeInteger(value) && value > 0;

// A client may report a symlinked or differently cased path for the same directory.
function canonical(value) {
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return null;
  }
}

function sameDirectory(left, right) {
  if (typeof left !== 'string' || !path.isAbsolute(left)) return false;
  if (left === right) return true;
  const canonicalLeft = canonical(left);
  return canonicalLeft !== null && canonicalLeft === canonical(right);
}

function hintFile(home, mcpPid) {
  if (!positivePid(mcpPid)) throw new Error('mcpPid must be a positive integer');
  return path.join(hintDirectory(home), `mcp-${mcpPid}.json`);
}

function readBoundedJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > BIND_HINT_MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    if (stat.size > 0) fs.readSync(fd, buffer, 0, stat.size, 0);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeHint(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* a reader that cannot prune leaves an inert file */ }
}

/**
 * Record where an MCP server's own mailbox identity lives, so the client process that
 * spawned it can bind notifications without parsing tool output.
 */
export function writeBindHint({ home, hostPid, mcpPid, cwd, room, mailboxSessionId, name }) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('home must be an absolute path');
  if (!positivePid(hostPid)) throw new Error('hostPid must be a positive integer');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  if (typeof room !== 'string' || !room || room.length > 256) throw new Error('room must be a non-empty string');
  if (typeof mailboxSessionId !== 'string' || !mailboxSessionId || mailboxSessionId.length > 256) {
    throw new Error('mailboxSessionId must be a non-empty string');
  }
  const hint = {
    version: 1,
    hostPid,
    mcpPid,
    cwd,
    room,
    mailboxSessionId,
    name: typeof name === 'string' ? name.slice(0, 200) : '',
    at: Date.now(),
  };
  const serialized = JSON.stringify(hint) + '\n';
  if (Buffer.byteLength(serialized) > BIND_HINT_MAX_BYTES) throw new Error('bind hint exceeds the size limit');
  const file = hintFile(home, mcpPid);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return hint;
}

/**
 * Return the live hints written by MCP servers spawned by this host process for this
 * directory. Stale files are pruned as they are found so the directory cannot grow
 * without bound from servers that exited without claiming their hint.
 */
export function scanBindHints({ home, hostPid, cwd, now = Date.now(), maxAgeMs = BIND_HINT_MAX_AGE_MS }) {
  if (!positivePid(hostPid)) return [];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
  const directory = hintDirectory(home);
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!HINT_FILE_PATTERN.test(entry)) continue;
    const file = path.join(directory, entry);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    candidates.push({ entry, file, mtime });
  }
  // Newest first, so a capped scan cannot hide a live hint behind dead ones.
  candidates.sort((left, right) => right.mtime - left.mtime);
  const hints = [];
  for (const candidate of candidates.slice(0, BIND_HINT_MAX_SCAN)) {
    const value = readBoundedJson(candidate.file);
    const stale = !value || typeof value !== 'object' || value.version !== 1
      || !Number.isSafeInteger(value.at) || value.at > now + 60000 || now - value.at > maxAgeMs;
    if (stale) {
      removeHint(candidate.file);
      continue;
    }
    if (!PID_PATTERN.test(String(value.hostPid)) || !PID_PATTERN.test(String(value.mcpPid))) continue;
    if (Number(value.hostPid) !== hostPid) continue;
    if (candidate.entry !== `mcp-${Number(value.mcpPid)}.json`) continue;
    if (!sameDirectory(value.cwd, cwd)) continue;
    if (typeof value.room !== 'string' || !value.room || value.room.length > 256) continue;
    if (typeof value.mailboxSessionId !== 'string' || !value.mailboxSessionId || value.mailboxSessionId.length > 256) continue;
    hints.push({ ...value, name: typeof value.name === 'string' ? value.name.slice(0, 200) : '' });
  }
  hints.sort((left, right) => right.at - left.at);
  return hints;
}

/** Remove one claimed hint so a later session cannot bind from it. */
export function claimBindHint({ home, mcpPid }) {
  try {
    fs.rmSync(hintFile(home, mcpPid), { force: true });
    return true;
  } catch {
    return false;
  }
}

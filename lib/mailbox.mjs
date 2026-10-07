import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const LIMITS = Object.freeze({ messages: 20, maxMessages: 100, pageBytes: 32 * 1024, scanBytes: 128 * 1024, textBytes: 16 * 1024 });
export const IDENTITY_LIMITS = Object.freeze({ aliases: 8, aliasTtlMs: 24 * 60 * 60 * 1000 });
const PEER_TTL = 30 * 60 * 1000;
const pause = new Int32Array(new SharedArrayBuffer(4));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export function safeName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Name must be a nonempty string');
  const name = value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  if (name === '.' || name === '..') throw new Error('Name cannot be . or ..');
  return name;
}
export function safeSessionId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value)) throw new Error('Session ID must be 1 to 128 safe filename characters');
  return value;
}
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function readJson(file, fallback = null) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return isObject(value) ? value : fallback; } catch { return fallback; }
}
function atomicWrite(file, value) {
  return atomicWriteBytes(file, JSON.stringify(value) + '\n');
}
function atomicWriteBytes(file, bytes) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function plainDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Unsafe mailbox directory: ${dir}`);
}
function plainFile(file) {
  try { if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unsafe mailbox file: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}

export function createMailbox({ home = process.env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat'), cwd = process.cwd(), lockTimeoutMs = 5000, peerAlive = peer => pidAlive(peer.pid), peerMetadata = () => ({}), retainRecentPeers = true, allowBroker = false } = {}) {
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 30000) throw new Error('Invalid lock timeout');
  home = path.resolve(home);
  if (!allowBroker && fs.existsSync(path.join(home, '.broker-mode'))) throw new Error('This mailbox belongs to a broker. Connect through the authenticated adapter.');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const rooms = path.join(home, 'rooms');
  const locks = path.join(home, 'locks');
  plainDir(rooms); plainDir(locks);
  function resolveRoom(spec) {
    if (spec !== undefined && (typeof spec !== 'string' || !spec.trim())) throw new Error('Room must be a nonempty string');
    if (spec && !/[\\/]/.test(spec)) {
      const id = spec.trim().replace(/[^A-Za-z0-9._-]/g, '_');
      if (id === '.' || id === '..' || id.length > 128) throw new Error('Room name must be 1 to 128 characters and cannot be . or ..');
      return { id, label: spec };
    }
    let top = path.resolve(cwd, spec || cwd);
    try { top = execFileSync('git', ['-C', top, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* directory room */ }
    top = path.resolve(top);
    const base = path.basename(top).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'root';
    return { id: `${base}-${crypto.createHash('sha1').update(top).digest('hex').slice(0, 6)}`, label: top };
  }
  function roomPath(room) {
    if (!isObject(room) || typeof room.id !== 'string' || room.id === '.' || room.id === '..' || !/^[A-Za-z0-9._-]+$/.test(room.id)) throw new Error('Invalid room id');
    const dir = path.resolve(rooms, room.id);
    if (path.dirname(dir) !== rooms) throw new Error('Room escapes mailbox');
    return dir;
  }
  function roomDir(room) {
    const dir = roomPath(room); plainDir(dir);
    plainDir(path.join(dir, 'peers')); plainDir(path.join(dir, 'cursors'));
    plainDir(path.join(dir, 'identities')); plainDir(path.join(dir, 'handles'));
    const file = plainFile(path.join(dir, 'room.json'));
    try { fs.writeFileSync(file, JSON.stringify({ id: room.id, label: room.label }) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return dir;
  }
  function withLock(room, fn) {
    const file = plainFile(path.join(locks, `${path.basename(roomPath(room))}.lock`));
    const deadline = Date.now() + lockTimeoutMs;
    let fd; let permissionError;
    for (;;) {
      if (Date.now() >= deadline) { if (permissionError) throw permissionError; throw new Error('Mailbox busy; retry shortly'); }
      try { fd = fs.openSync(file, 'wx', 0o600); break; }
      catch (error) {
        // Windows may deny CREATE_NEW while the previous lock is pending deletion.
        // Retry without inspecting or removing ownership, and preserve persistent permission errors.
        if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
          permissionError = error; Atomics.wait(pause, 0, 0, Math.min(10, Math.max(1, deadline - Date.now()))); continue;
        }
        if (error.code !== 'EEXIST') throw error;
        permissionError = undefined;
        const owner = readJson(file);
        let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
        if ((owner && !pidAlive(owner.pid)) || (!owner && age > 10000)) {
          // Serialize stale-lock reclamation so two contenders cannot remove a newly acquired lock.
          const reclaim = `${file}.reclaim`;
          let reclaimFd;
          try {
            reclaimFd = fs.openSync(reclaim, 'wx', 0o600);
            const current = readJson(file);
            let currentAge = 0; try { currentAge = Date.now() - fs.statSync(file).mtimeMs; } catch { /* lock disappeared */ }
            if ((current && !pidAlive(current.pid)) || (!current && currentAge > 10000)) fs.rmSync(file, { force: true });
          } catch (reclaimError) { if (reclaimError.code !== 'EEXIST') throw reclaimError; }
          finally { if (reclaimFd !== undefined) { fs.closeSync(reclaimFd); fs.rmSync(reclaim, { force: true }); } }
          Atomics.wait(pause, 0, 0, 10);
          continue;
        }
        if (Date.now() >= deadline) throw new Error('Mailbox busy; retry shortly');
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); return fn(); }
    finally { fs.closeSync(fd); fs.rmSync(file, { force: true }); }
  }
  const readMeta = (room) => readJson(plainFile(path.join(roomDir(room), 'room.json')), { id: room.id, label: room.label });
  function listPeers(room, { includeStale = false } = {}) {
    const dir = path.join(roomPath(room), 'peers');
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return [];
      return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => readJson(plainFile(path.join(dir, name)))).filter((p) => p && typeof p.name === 'string' && (includeStale || peerAlive(p) || retainRecentPeers && Date.now() - Date.parse(p.lastSeen) < PEER_TTL));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function identityFile(room, sessionId) {
    return routingFile(room, 'identities', safeSessionId(sessionId));
  }
  function routingFile(room, directory, name) {
    const dir = path.join(roomPath(room), directory);
    try { if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Unsafe mailbox directory: ${dir}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return plainFile(path.join(dir, `${name}.json`));
  }
  function readIdentity(room, sessionId) {
    const record = readJson(identityFile(room, sessionId));
    return record?.sessionId === sessionId && typeof record.name === 'string' ? record : null;
  }
  function rememberedAliases(record, now = Date.now()) {
    return (Array.isArray(record?.aliases) ? record.aliases : []).filter(alias => isObject(alias) && typeof alias.name === 'string' && Number.isFinite(alias.expiresAt) && alias.expiresAt > now).slice(-IDENTITY_LIMITS.aliases);
  }
  function identityRecords(room) {
    const dir = path.join(roomPath(room), 'identities');
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Unsafe mailbox directory: ${dir}`);
      return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
        const sessionId = name.slice(0, -5);
        try { safeSessionId(sessionId); } catch { return null; }
        return readIdentity(room, sessionId);
      }).filter(Boolean);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  // A failed rename must leave the old peer and routing records usable.
  function mutateIdentityFiles(writes, removals) {
    const changed = [];
    const snapshots = new Map([...writes.map(([file]) => file), ...removals].map(file => {
      plainFile(file);
      try { return [file, fs.readFileSync(file)]; } catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
    }));
    try {
      for (const [file, value] of writes) { atomicWrite(file, value); changed.push(file); }
      for (const file of removals) { fs.rmSync(file, { force: true }); changed.push(file); }
    } catch (error) {
      for (const file of changed.reverse()) {
        const bytes = snapshots.get(file);
        try { if (bytes === null) fs.rmSync(file, { force: true }); else atomicWriteBytes(file, bytes); }
        catch (rollbackError) { error.message += `; identity rollback failed: ${rollbackError.message}`; }
      }
      throw error;
    }
  }
  function writeIdentity(room, base, client, sessionId, peers, metadata = {}, owner) {
    const dir = roomDir(room);
    const now = Date.now();
    const records = identityRecords(room);
    const priorPeer = peers.find(peer => peer.sessionId === sessionId);
    const previous = readIdentity(room, sessionId) || (priorPeer ? { name: priorPeer.name, claimedAt: priorPeer.lastSeen, firstClaim: true } : null);
    const reserved = name => peers.some(peer => peer.name === name && peer.sessionId !== sessionId && peerAlive(peer)) || records.some(record => record.sessionId !== sessionId && rememberedAliases(record, now).some(alias => alias.name === name && !alias.untilAt));
    let name = base;
    for (let i = 2; reserved(name); i++) { const suffix = `-${i}`; name = `${base.slice(0, 40 - suffix.length)}${suffix}`; }
    const handleFile = plainFile(path.join(dir, 'handles', `${name}.json`));
    const priorHandle = readJson(handleFile);
    const returningAlias = rememberedAliases(previous, now).find(alias => alias.name === name && !alias.untilAt);
    const claim = previous?.name === name && (!priorHandle || priorHandle.sessionId === sessionId) ? previous : returningAlias || { claimedAt: new Date(now).toISOString(), firstClaim: !priorHandle };
    let aliases = rememberedAliases(previous, now).filter(alias => alias.name !== name);
    if (previous && previous.name !== name) {
      aliases = aliases.filter(alias => alias.name !== previous.name);
      aliases.push({ name: previous.name, claimedAt: previous.claimedAt, firstClaim: previous.firstClaim, ...(previous.untilAt ? { untilAt: previous.untilAt } : {}), expiresAt: now + IDENTITY_LIMITS.aliasTtlMs });
    }
    aliases = aliases.slice(-IDENTITY_LIMITS.aliases);
    const identity = { ...priorPeer, room, name, sessionId, client, pid: owner?.pid ?? process.pid, cwd: owner?.cwd ?? cwd };
    Object.assign(identity, peerMetadata(identity));
    for (const key of ['nameSource', 'sessionTitle', 'titleSource', 'task', 'availability', 'model', 'effort']) if (typeof metadata[key] === 'string') identity[key] = metadata[key];
    if (Number.isSafeInteger(metadata.context_remaining_percent)) identity.context_remaining_percent = metadata.context_remaining_percent;
    const record = { sessionId, name, claimedAt: claim.claimedAt, firstClaim: claim.firstClaim === true, aliases };
    let previousOwner;
    if (priorHandle?.sessionId && priorHandle.sessionId !== sessionId) {
      previousOwner = readIdentity(room, safeSessionId(priorHandle.sessionId));
      if (previousOwner) {
        const untilAt = new Date(now).toISOString();
        previousOwner = { ...previousOwner, ...(previousOwner.name === name ? { untilAt } : {}), aliases: rememberedAliases(previousOwner, now).map(alias => alias.name === name ? { ...alias, untilAt } : alias) };
      }
    }
    const peerFile = plainFile(path.join(dir, 'peers', `${name}.json`));
    const removals = fs.readdirSync(path.join(dir, 'peers')).filter(entry => entry.endsWith('.json') && entry !== `${name}.json`).map(entry => plainFile(path.join(dir, 'peers', entry))).filter(file => readJson(file)?.sessionId === sessionId);
    mutateIdentityFiles([
      ...(previousOwner ? [[identityFile(room, previousOwner.sessionId), previousOwner]] : []),
      [identityFile(room, sessionId), record],
      [handleFile, { sessionId, claimedAt: record.claimedAt }],
      [peerFile, { ...identity, room: undefined, status: priorPeer?.status ?? '', lastSeen: new Date(now).toISOString() }],
    ], removals);
    return identity;
  }
  function claimIdentity(room, base, client = 'unknown', sessionId = crypto.randomUUID(), metadata = {}) {
    base = safeName(base);
    if (base === 'all') throw new Error('The handle all is reserved for broadcasts');
    sessionId = safeSessionId(sessionId);
    return withLock(room, () => {
      roomDir(room);
      const peers = listPeers(room, { includeStale: true });
      if (peers.some(peer => peer.sessionId === sessionId && peer.pid !== process.pid && peerAlive(peer))) throw new Error('Session is already active in another process; choose a unique AGENT_CHAT_SESSION');
      return writeIdentity(room, base, client, sessionId, peers, metadata);
    });
  }
  function getIdentity(identity) {
    if (!identity) return null;
    const peer = listPeers(identity.room, { includeStale: true }).find(peer => peer.sessionId === safeSessionId(identity.sessionId));
    return peer ? { ...peer, room: identity.room } : null;
  }
  function syncSessionTitle({ room, sessionId, title, client, cwd: expectedCwd, titleSource } = {}) {
    safeSessionId(sessionId);
    if (typeof title !== 'string' || !title.trim() || title.length > 256 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Session title must be 1 to 256 characters without controls');
    if (typeof expectedCwd !== 'string' || typeof client !== 'string') return null;
    return withLock(room, () => {
      const peers = listPeers(room, { includeStale: true });
      const peer = peers.find(peer => peer.sessionId === sessionId && peer.client === client && typeof peer.cwd === 'string' && path.resolve(peer.cwd) === path.resolve(expectedCwd));
      if (!peer) return null;
      const metadata = { sessionTitle: title.trim(), ...(titleSource ? { titleSource } : {}) };
      const name = peer.nameSource === 'explicit' ? peer.name : safeName(title.replace(/\s+/g, '-'));
      if (name === 'all') return null;
      return writeIdentity(room, name, peer.client, sessionId, peers, metadata, peer);
    });
  }
  function resolveRecipient(room, target) {
    try { target = safeSessionId(target); } catch { target = safeName(target); }
    if (target === 'all') return null;
    const peers = listPeers(room, { includeStale: true });
    const peer = peers.find(peer => peer.name === target && peerAlive(peer)) || peers.find(peer => peer.sessionId === target);
    if (peer) return { name: peer.name, sessionId: peer.sessionId, alias: peer.name !== target };
    const handle = readJson(routingFile(room, 'handles', target));
    let record = handle?.sessionId ? readIdentity(room, safeSessionId(handle.sessionId)) : null;
    if (!record) record = identityRecords(room).find(record => record.sessionId === target);
    if (record && (record.name === target || record.sessionId === target || rememberedAliases(record).some(alias => alias.name === target && !alias.untilAt))) return { name: record.name, sessionId: record.sessionId, alias: record.name !== target };
    // Existing installations may have peers that predate routing records.
    const legacy = peers.find(peer => peer.name === target);
    return legacy ? { name: legacy.name, sessionId: legacy.sessionId, alias: false } : null;
  }
  function touchPeer(identity, status) {
    return withLock(identity.room, () => {
      const file = plainFile(path.join(roomDir(identity.room), 'peers', `${safeName(identity.name)}.json`));
      const prev = readJson(file);
      if (prev?.sessionId !== identity.sessionId) return false;
      atomicWrite(file, { ...prev, ...peerMetadata(identity), status: status ?? prev.status ?? '', lastSeen: new Date().toISOString() });
      return true;
    });
  }
  function updatePeer(identity, changes) {
    return withLock(identity.room, () => {
      const file = plainFile(path.join(roomDir(identity.room), 'peers', `${safeName(identity.name)}.json`));
      const previous = readJson(file);
      if (previous?.sessionId !== identity.sessionId) return false;
      const allowed = ['task', 'availability', 'model', 'effort', 'context_remaining_percent'];
      const profile = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
      atomicWrite(file, { ...previous, ...profile, ...peerMetadata(identity), lastSeen: new Date().toISOString() });
      return true;
    });
  }
  function releaseIdentity(identity) {
    if (!identity || !fs.existsSync(roomPath(identity.room))) return;
    withLock(identity.room, () => {
      const file = plainFile(path.join(roomPath(identity.room), 'peers', `${safeName(identity.name)}.json`));
      if (readJson(file)?.sessionId === identity.sessionId) fs.rmSync(file, { force: true });
    });
  }
  function appendMessage(room, from, to, text, fromSessionId, recipientSessionId) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    if (Buffer.byteLength(text) > LIMITS.textBytes) throw new Error(`text exceeds ${LIMITS.textBytes} UTF-8 bytes`);
    return withLock(room, () => {
      const target = to ? safeName(to) : 'all';
      const toSessionId = target === 'all' ? undefined : recipientSessionId ? safeSessionId(recipientSessionId) : resolveRecipient(room, target)?.sessionId;
      const msg = { id: crypto.randomUUID(), ts: new Date().toISOString(), from: safeName(from), to: target, text, ...(fromSessionId ? { fromSessionId } : {}), ...(toSessionId ? { toSessionId } : {}) };
      const line = JSON.stringify(msg) + '\n';
      if (Buffer.byteLength(line) + 128 > LIMITS.pageBytes) throw new Error('Encoded message exceeds the default read page; shorten text');
      fs.appendFileSync(plainFile(path.join(roomDir(room), 'messages.jsonl')), line, { mode: 0o600 });
      return msg;
    });
  }
  function updateMeta(room, changes, by, sessionId) {
    return withLock(room, () => {
      const prev = readMeta(room);
      const changed = Object.fromEntries(Object.entries(changes).filter(([key, value]) => prev[key] !== value));
      if (!Object.keys(changed).length) return [];
      atomicWrite(plainFile(path.join(roomDir(room), 'room.json')), { ...prev, ...changed, updatedBy: by, updatedAt: new Date().toISOString() });
      const text = `[updated ${Object.entries(changed).map(([key, value]) => `room ${key}: ${value}`).join('; ')}]`;
      const msg = { id: crypto.randomUUID(), ts: new Date().toISOString(), from: by, to: 'all', text, ...(sessionId ? { fromSessionId: sessionId } : {}) };
      fs.appendFileSync(plainFile(path.join(roomDir(room), 'messages.jsonl')), JSON.stringify(msg) + '\n', { mode: 0o600 });
      return Object.keys(changed);
    });
  }
  function inspectNotifications({ room, name, sessionId, afterOffset, unreadOnly = false, limit = LIMITS.messages, maxBytes = LIMITS.pageBytes } = {}) {
    roomPath(room);
    if (unreadOnly && sessionId) {
      const cursor = readJson(plainFile(path.join(roomPath(room), 'cursors', `${safeSessionId(sessionId)}.json`)));
      if (Number.isSafeInteger(cursor?.offset) && cursor.offset >= 0) afterOffset = Math.max(afterOffset ?? 0, cursor.offset);
    }
    if (afterOffset !== undefined && (!Number.isSafeInteger(afterOffset) || afterOffset < 0)) throw new Error('afterOffset must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.maxMessages) throw new Error(`limit must be 1 to ${LIMITS.maxMessages}`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > LIMITS.scanBytes) throw new Error(`maxBytes must be 1024 to ${LIMITS.scanBytes}`);
    const file = plainFile(path.join(roomPath(room), 'messages.jsonl'));
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return { messages: [], nextOffset: 0, hasMore: false, size: 0, earliestOffset: 0 }; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      const first = afterOffset === undefined || afterOffset > size;
      let start = first ? Math.max(0, size - LIMITS.scanBytes) : afterOffset;
      const buf = Buffer.alloc(Math.min(LIMITS.scanBytes, size - start));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
      const data = buf.subarray(0, bytesRead);
      let pos = 0;
      if (first && start > 0) {
        const nl = data.indexOf(10);
        if (nl < 0) return { messages: [], nextOffset: size, hasMore: false, size, earliestOffset: start, blocked: 'No complete line in the bounded tail; initial cursor starts at transcript end. Inspect or repair the oversized historical line.' };
        pos = nl + 1;
      }
      const earliestOffset = start + pos;
      const lines = [];
      const routing = sessionId ? readIdentity(room, safeSessionId(sessionId)) : null;
      const legacyClaims = routing ? [{ name: routing.name, claimedAt: routing.claimedAt, firstClaim: routing.firstClaim, untilAt: routing.untilAt }, ...rememberedAliases(routing)] : [{ name, firstClaim: true }];
      const addressedToReader = message => {
        if (message.to === 'all') return true;
        if (message.toSessionId !== undefined) return !!sessionId && message.toSessionId === sessionId;
        return legacyClaims.some(claim => claim.name === message.to && (!claim.untilAt || Date.parse(message.ts) < Date.parse(claim.untilAt)) && (claim.firstClaim === true || Date.parse(message.ts) > Date.parse(claim.claimedAt)));
      };
      const eligible = (m) => m && typeof m.text === 'string' && typeof m.from === 'string' && typeof m.to === 'string' && (!name || ((sessionId ? m.fromSessionId !== sessionId : m.from !== name) && addressedToReader(m)));
      while (pos < data.length) {
        const end = data.indexOf(10, pos);
        if (end < 0) break;
        let msg; try { msg = JSON.parse(data.subarray(pos, end).toString('utf8')); } catch { /* malformed historical line */ }
        lines.push({ start: start + pos, end: start + end + 1, msg, eligible: eligible(msg) }); pos = end + 1;
      }
      let offset = earliestOffset;
      let selected = lines;
      if (first) {
        const matching = lines.filter((line) => line.eligible);
        if (matching.length > limit) offset = matching[matching.length - limit].start;
        selected = lines.filter((line) => line.start >= offset);
      }
      const messages = [];
      let used = 0;
      for (const line of selected) {
        if (line.eligible) {
          const cost = Buffer.byteLength(JSON.stringify(line.msg)) + 128;
          if (messages.length >= limit || used + cost > maxBytes) {
            // Never move past a valid undelivered message, including an oversized legacy message.
            return { messages, nextOffset: offset, hasMore: true, size, earliestOffset, ...(messages.length === 0 ? { blocked: 'Next message exceeds maxBytes; increase maxBytes or inspect the transcript.' } : {}) };
          }
          messages.push(line.msg); used += cost;
        }
        offset = line.end;
      }
      const blocked = !lines.length && data.length === LIMITS.scanBytes ? 'Next line exceeds the scan limit; inspect or repair the transcript before continuing.' : undefined;
      return { messages, nextOffset: offset, hasMore: offset < size && bytesRead === LIMITS.scanBytes, size, earliestOffset, ...(blocked ? { blocked } : {}) };
    } finally { fs.closeSync(fd); }
  }
  function commitCursor(identity, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid cursor offset');
    const file = plainFile(path.join(roomDir(identity.room), 'cursors', `${safeSessionId(identity.sessionId)}.json`));
    atomicWrite(file, { offset, sessionId: identity.sessionId });
  }
  function takeUnread(identity, { commit = true, ...options } = {}) {
    const file = plainFile(path.join(roomDir(identity.room), 'cursors', `${safeSessionId(identity.sessionId)}.json`));
    const cursor = readJson(file);
    const result = inspectNotifications({ room: identity.room, name: identity.name, sessionId: identity.sessionId, afterOffset: cursor?.offset, ...options });
    if (commit) commitCursor(identity, result.nextOffset);
    return result;
  }
  function roomInfo(id) {
    const room = { id, label: id }; const dir = roomPath(room);
    const meta = readJson(plainFile(path.join(dir, 'room.json')), {});
    let last = 0; let bytes = 0;
    for (const name of ['room.json', 'messages.jsonl']) {
      try { const stat = fs.statSync(plainFile(path.join(dir, name))); last = Math.max(last, stat.mtimeMs); if (name === 'messages.jsonl') bytes = stat.size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { id, label: meta.label || id, last, bytes, summary: meta.summary || '', status: meta.status || '' };
  }
  function listRooms() {
    return fs.readdirSync(rooms, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => { try { return roomInfo(entry.name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }).filter(Boolean).sort((a, b) => b.last - a.last);
  }
  function pruneReleasedIdentities(room, peers, now) {
    const active = new Set(peers.filter(peer => peerAlive(peer) || retainRecentPeers && now - Date.parse(peer.lastSeen) < PEER_TTL).map(peer => peer.sessionId));
    for (const record of identityRecords(room)) {
      if (active.has(record.sessionId) || rememberedAliases(record, now).length) continue;
      const file = identityFile(room, record.sessionId);
      let age;
      try { age = now - fs.statSync(file).mtimeMs; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (age < IDENTITY_LIMITS.aliasTtlMs) continue;
      fs.rmSync(file, { force: true });
      // Keep the small handle tombstone: it prevents a later holder from
      // inheriting name-only messages sent before the first Agent Chat claim.
    }
  }
  function tidyRooms({ force = false, ttlDays = 7, pruneOnly = false } = {}) {
    const stamp = path.join(home, '.last-tidy');
    try { if (!force && Date.now() - fs.statSync(stamp).mtimeMs < 3600000) return []; } catch { /* first tidy */ }
    atomicWrite(stamp, { at: new Date().toISOString() });
    const cutoff = Date.now() - ttlDays * 86400000;
    const removed = [];
    for (const room of listRooms()) {
      withLock(room, () => {
        let info; try { info = roomInfo(room.id); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        const peers = listPeers(room, { includeStale: true });
        const now = Date.now();
        if (peers.some((p) => peerAlive(p) || retainRecentPeers && now - Date.parse(p.lastSeen) < PEER_TTL)) { pruneReleasedIdentities(room, peers, now); return; }
        if (!pruneOnly && info.last && info.last < cutoff) { fs.rmSync(roomPath(room), { recursive: true, force: true }); removed.push(info.label); }
        else pruneReleasedIdentities(room, peers, now);
      });
    }
    return removed;
  }
  return { home, cwd, resolveRoom, roomDir, roomPath, readMeta, listPeers, claimIdentity, getIdentity, syncSessionTitle, resolveRecipient, touchPeer, updatePeer, releaseIdentity, appendMessage, updateMeta, inspectNotifications, takeUnread, commitCursor, isPeerAlive: peerAlive, listRooms, tidyRooms };
}

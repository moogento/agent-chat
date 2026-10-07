import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeSessionId } from './mailbox.mjs';

const MAX_HOSTS = 256;
const MAX_INVITES = 128;
const ACTIVE_MS = 30 * 60 * 1000;
const INVITE_MS = 24 * 60 * 60 * 1000;
const wait = new Int32Array(new SharedArrayBuffer(4));
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const hostId = (client, session) => `host-${hash(`${client}\0${session}`)}`;
const peerId = (room, session) => `peer-${hash(`${room}\0${session}`)}`;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function createPresence({ home = process.env.AGENT_CHAT_HOME } = {}) {
  if (!home) throw new Error('Presence requires a mailbox home');
  home = path.resolve(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const dir = path.join(home, 'presence');
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe presence directory');
  const file = path.join(dir, 'registry.json');
  const lock = path.join(dir, 'registry.lock');
  function read() {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe presence registry');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return plain(data) ? { hosts: Array.isArray(data.hosts) ? data.hosts : [], invites: Array.isArray(data.invites) ? data.invites : [] } : { hosts: [], invites: [] };
    } catch (error) { if (error.code === 'ENOENT') return { hosts: [], invites: [] }; throw error; }
  }
  function trim(data) {
    const now = Date.now();
    data.hosts = data.hosts.filter(x => plain(x) && typeof x.id === 'string' && now - x.seenAt < ACTIVE_MS).slice(-MAX_HOSTS);
    data.invites = data.invites.filter(x => plain(x) && typeof x.id === 'string' && x.expiresAt > now).slice(-MAX_INVITES);
    return data;
  }
  function mutate(fn) {
    const deadline = Date.now() + 3000;
    let fd;
    for (;;) {
      try { fd = fs.openSync(lock, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const age = (() => { try { return Date.now() - fs.statSync(lock).mtimeMs; } catch { return 0; } })();
        if (age > 10000) { fs.rmSync(lock, { force: true }); continue; }
        if (Date.now() >= deadline) throw new Error('Presence registry busy; retry shortly');
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    try {
      const data = trim(read());
      const result = fn(data);
      const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try { fs.writeFileSync(temp, JSON.stringify(trim(data)) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
      return result;
    } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
  function registerHost({ client, hostSessionId, cwd, title } = {}) {
    if (typeof client !== 'string' || !client.trim() || client.length > 80 || typeof hostSessionId !== 'string' || !hostSessionId.trim() || hostSessionId.length > 256 || typeof cwd !== 'string' || !cwd.trim()) return null;
    const id = hostId(client, hostSessionId);
    return mutate(data => {
      const prior = data.hosts.find(x => x.id === id);
      const next = { ...prior, id, client, hostSessionId, cwd: path.resolve(cwd), seenAt: Date.now() };
      if (typeof title === 'string' && title.trim()) next.title = title.trim().slice(0, 256);
      data.hosts = data.hosts.filter(x => x.id !== id);
      data.hosts.push(next);
      return { ...next };
    });
  }
  function linkHost({ client, hostSessionId, sessionId, room, name } = {}) {
    if (!plain(room) || typeof room.id !== 'string' || typeof name !== 'string') return null;
    safeSessionId(sessionId);
    const id = hostId(client, hostSessionId);
    return mutate(data => {
      const host = data.hosts.find(x => x.id === id);
      if (!host) return null;
      host.sessionId = sessionId;
      host.room = { id: room.id, label: room.label || room.id };
      host.name = name;
      host.seenAt = Date.now();
      return { ...host };
    });
  }
  function list(mailbox) {
    const data = trim(read());
    const peers = [];
    for (const room of mailbox.listRooms().slice(0, MAX_HOSTS)) for (const peer of mailbox.listPeers(room).slice(0, MAX_HOSTS)) {
      const linked = data.hosts.find(x => x.sessionId === peer.sessionId && x.room?.id === room.id);
      peers.push({ id: linked?.id || peerId(room.id, peer.sessionId), name: peer.name, title: linked?.title || peer.sessionTitle, client: peer.client, room: room.label, roomId: room.id, status: peer.status, sessionId: peer.sessionId, seenAt: Date.parse(peer.lastSeen) || Date.now() });
      if (peers.length >= MAX_HOSTS) break;
    }
    const linkedIds = new Set(peers.map(x => x.id));
    const unjoined = data.hosts.filter(x => !linkedIds.has(x.id)).map(x => ({ id: x.id, name: x.title || x.name || x.client, title: x.title, client: x.client, room: null, roomId: null, seenAt: x.seenAt, sessionId: x.sessionId }));
    return [...peers, ...unjoined].slice(0, MAX_HOSTS);
  }
  function invite({ from, toId, room, note, mailbox } = {}) {
    if (typeof toId !== 'string' || !/^((host|peer)-[a-f0-9]{24})$/.test(toId)) throw new Error('Select a presence ID from chat_presence');
    if (!plain(room) || typeof room.id !== 'string') throw new Error('Invalid invitation room');
    if (note !== undefined && (typeof note !== 'string' || Buffer.byteLength(note) > 500)) throw new Error('Invitation note exceeds 500 bytes');
    const target = list(mailbox).find(x => x.id === toId);
    if (!target) throw new Error('Session is not present; refresh chat_presence');
    if (target.sessionId === from.sessionId && target.roomId === from.room.id) throw new Error('Cannot invite yourself');
    return mutate(data => {
      const entry = { id: crypto.randomUUID(), toId, from: from.name, fromSessionId: from.sessionId, room: { id: room.id, label: room.label }, note: note?.trim() || '', createdAt: Date.now(), expiresAt: Date.now() + INVITE_MS };
      data.invites.push(entry);
      return entry;
    });
  }
  function invitations(ids) {
    const wanted = new Set(ids);
    return trim(read()).invites.filter(x => wanted.has(x.toId));
  }
  function pendingForHost({ client, hostSessionId } = {}) { return invitations([hostId(client, hostSessionId)]); }
  function linkedHostIds(room, sessionId) {
    return trim(read()).hosts.filter(x => x.sessionId === sessionId && x.room?.id === room.id).map(x => x.id);
  }
  function linkUniqueHost({ mailbox, client, cwd, sessionId, room, name }) {
    const family = value => {
      const lower = String(value || '').toLowerCase();
      return lower.includes('claude') ? 'claude' : lower.includes('codex') ? 'codex' : lower.includes('opencode') ? 'opencode' : lower;
    };
    const data = trim(read());
    const hosts = data.hosts.filter(x => x.cwd === path.resolve(cwd) && family(x.client) === family(client));
    if (hosts.length !== 1 || hosts[0].sessionId) return null;
    const peers = [];
    for (const candidate of mailbox.listRooms().slice(0, MAX_HOSTS)) {
      for (const peer of mailbox.listPeers(candidate).slice(0, MAX_HOSTS)) {
        if (peer.cwd && path.resolve(peer.cwd) === path.resolve(cwd) && family(peer.client) === family(client)
          && (!mailbox.isPeerAlive || mailbox.isPeerAlive(peer))
          && !data.hosts.some(host => host.sessionId === peer.sessionId && host.room?.id === candidate.id)) peers.push(peer);
      }
    }
    if (peers.length !== 1 || peers[0].sessionId !== sessionId) return null;
    return linkHost({ client: hosts[0].client, hostSessionId: hosts[0].hostSessionId, sessionId, room, name });
  }
  function consume(id, ids) {
    return mutate(data => {
      const entry = data.invites.find(x => x.id === id && ids.includes(x.toId));
      if (entry) data.invites = data.invites.filter(x => x.id !== id);
      return entry || null;
    });
  }
  return { registerHost, linkHost, linkUniqueHost, list, invite, invitations, pendingForHost, linkedHostIds, consume, peerId };
}

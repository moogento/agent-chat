import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { createMailbox, safeName } from './mailbox.mjs';
import { createServer, VERSION } from '../agent-chat.mjs';
import { readBrokerToken, validateRemoteRoom } from './broker-client.mjs';

const BODY_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const MIN_CACHE_BUDGET = 8 * 1024 * 1024;
const REQUESTS_PER_SESSION = 8;
const OWNER_LEASE = 5000;
const SESSION_RETENTION = 7 * 24 * 60 * 60 * 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const failure = (status, message) => Object.assign(new Error(message), { status });
function readJson(file, max = 8192) {
  let fd;
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe broker state file'); fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max) throw new Error('Invalid broker state file'); const buffer = Buffer.alloc(max + 1); const n = fs.readSync(fd, buffer, 0, buffer.length, 0); if (n > max) throw new Error('Invalid broker state file'); return JSON.parse(buffer.subarray(0, n).toString('utf8')); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function atomic(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(data) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function plainDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new Error('Unsafe broker data directory'); }
function constantEqual(left, right) { const a = Buffer.from(digest(left)); const b = Buffer.from(right); return a.length === b.length && crypto.timingSafeEqual(a, b); }
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw failure(415, 'JSON body required');
  if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > BODY_LIMIT) throw failure(413, 'Body too large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) throw failure(413, 'Body too large'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(value)) throw new Error(); return value; } catch { throw failure(400, 'Invalid JSON object'); }
}
function onlyKeys(value, allowed) { if (Object.keys(value).some(key => !allowed.includes(key))) throw failure(400, 'Unexpected request field'); }
function auth(req) { const header = req.headers.authorization; if (typeof header !== 'string' || !/^Bearer [^\s]{1,1024}$/.test(header)) throw failure(401, 'Authentication required'); return header.slice(7); }
function peerInfo(identity) { return identity ? { sessionId: identity.sessionId, name: identity.name, cwd: identity.cwd, clientCwd: identity.cwd, room: identity.room.id } : null; }

/** Starts an authenticated private HTTP broker. Its mailbox home is exclusively broker-owned. */
export async function createBroker({ home, tokenFile, token = tokenFile ? readBrokerToken(tokenFile) : undefined, host = '127.0.0.1', port = 0, leaseMs = 30000, maxSessions = 128, maxStoredSessions = 1024 } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+\/-]{32,512}={0,2}$/.test(token)) throw new Error('Broker requires a strong authentication token (at least 32 safe ASCII characters)');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('Broker requires an absolute exclusive mailbox home');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(leaseMs) || leaseMs < 300 || leaseMs > 300000 || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 1024 || !Number.isSafeInteger(maxStoredSessions) || maxStoredSessions < maxSessions || maxStoredSessions > 10000) throw new Error('Invalid broker limits');
  // Reserve one wait and one other RPC per allowed session, while retaining a hard bound.
  const cacheBudget = Math.max(MIN_CACHE_BUDGET, maxSessions * RESPONSE_LIMIT * 2);
  home = path.resolve(home); plainDir(home);
  const ownerFile = path.join(home, '.broker-owner.lock'); const marker = path.join(home, '.broker-mode');
  const epoch = crypto.randomUUID(); const masterHash = digest(token);
  if (!fs.existsSync(marker) && fs.existsSync(path.join(home, 'rooms')) && fs.readdirSync(path.join(home, 'rooms')).length) throw new Error('Broker needs a dedicated mailbox home; existing local rooms were found');
  let ownerFd;
  try { ownerFd = fs.openSync(ownerFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old; try { old = readJson(ownerFile); } catch { /* malformed lock must age out */ }
    let age; try { age = Date.now() - fs.statSync(ownerFile).mtimeMs; } catch { age = 0; }
    if (old?.expiresAt > Date.now() || !old && age < OWNER_LEASE) throw failure(409, 'Broker storage is in use or awaiting its previous owner lease expiry');
    const reclaim = `${ownerFile}.reclaim`; let fd;
    try {
      fd = fs.openSync(reclaim, 'wx', 0o600);
      let current; try { current = readJson(ownerFile); } catch { /* expired malformed lock */ }
      if (current?.expiresAt > Date.now()) throw failure(409, 'Broker storage is in use');
      fs.rmSync(ownerFile, { force: true }); ownerFd = fs.openSync(ownerFile, 'wx', 0o600);
    } finally { if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(reclaim, { force: true }); } }
  }
  fs.writeFileSync(ownerFd, JSON.stringify({ epoch, pid: process.pid, expiresAt: Date.now() + OWNER_LEASE })); fs.closeSync(ownerFd);
  const sessions = new Map(); let closed = false; let cacheBytes = 0; let reserved = 0;
  const descriptors = path.join(home, '.broker-sessions');
  let server; let leaseTimer; let ownerTimer;
  const ownsStorage = () => { try { return readJson(ownerFile).epoch === epoch; } catch { return false; } };
  function assertOwner() { if (closed || !ownsStorage()) throw failure(503, 'Broker storage ownership was lost'); }
  const fileFor = id => { if (!uuid(id)) throw failure(404, 'Session not found'); return path.join(descriptors, `${id}.json`); };
  function persist(session) { atomic(fileFor(session.id), { id: session.id, room: session.room, name: session.server.state.identity?.name || session.name, client: session.client, clientCwd: session.clientCwd, tokenHash: session.tokenHash, resumable: session.resumable, masterHash, updatedAt: Date.now() }); }
  function expire(session) {
    if (session.resumable && ownsStorage()) persist(session);
    sessions.delete(session.id); session.server.stop();
    if (!session.resumable && ownsStorage()) fs.rmSync(fileFor(session.id), { force: true });
    for (const entry of session.pending.values()) cacheBytes -= entry.bytes || 0;
    session.pending.clear();
  }
  function renew(session) { session.expiresAt = Date.now() + leaseMs; if (session.server.state.identity) session.mailbox.touchPeer(session.server.state.identity); }
  function activate(record) {
    if (sessions.size >= maxSessions) throw failure(429, 'Active session limit reached');
    const existed = fs.existsSync(fileFor(record.id));
    const session = { id: record.id, room: validateRemoteRoom(record.room), name: safeName(record.name), client: record.client, clientCwd: record.clientCwd, tokenHash: record.tokenHash, resumable: record.resumable === true, expiresAt: Date.now() + leaseMs, pending: new Map(), inflight: new Map(), activeRead: null };
    const isPeerAlive = peer => peer.brokerEpoch === epoch && sessions.get(peer.sessionId)?.expiresAt > Date.now();
    const mailbox = createMailbox({ home, cwd: session.clientCwd, allowBroker: true, retainRecentPeers: false, peerAlive: isPeerAlive, peerMetadata: identity => ({ brokerEpoch: epoch, leaseExpiresAt: sessions.get(identity.sessionId)?.expiresAt || 0 }) });
    const wrapped = { ...mailbox };
    for (const [key, operation] of Object.entries(mailbox)) if (typeof operation === 'function') wrapped[key] = (...args) => { assertOwner(); return operation(...args); };
    wrapped.releaseIdentity = identity => { if (ownsStorage()) mailbox.releaseIdentity(identity); };
    wrapped.takeUnread = (identity, options) => { assertOwner(); const page = mailbox.takeUnread(identity, { ...options, commit: false }); if (session.activeRead) session.activeRead.read = { identity, offset: page.nextOffset }; return page; };
    session.mailbox = wrapped;
    session.server = createServer({ mailbox: wrapped, sessionId: session.id, roomSpec: session.room, nameSpec: session.name, identityExtras: identity => ({ transport: 'broker', clientCwd: identity.cwd }) });
    sessions.set(session.id, session);
    try {
      session.server.state.client = session.client;
      session.server.state.identity = wrapped.claimIdentity(mailbox.resolveRoom(session.room), session.name, session.client, session.id);
      try { mailbox.tidyRooms({ pruneOnly: true }); } catch { /* cleanup must not prevent session activation */ }
      persist(session);
    }
    catch (error) {
      sessions.delete(session.id); session.server.stop();
      if (!existed && ownsStorage()) fs.rmSync(fileFor(session.id), { force: true });
      throw error;
    }
    return session;
  }
  function authenticated(req, id, { allowResume = false } = {}) {
    const supplied = auth(req);
    let session = sessions.get(id);
    if (session && session.expiresAt <= Date.now()) { expire(session); session = null; }
    if (session) { if (!constantEqual(supplied, session.tokenHash)) throw failure(401, 'Authentication failed'); if (allowResume) throw failure(409, 'This broker session already has an active adapter'); return session; }
    let record; try { record = readJson(fileFor(id)); } catch { throw failure(404, 'Session not found'); }
    if (record.masterHash !== masterHash || !constantEqual(supplied, record.tokenHash)) throw failure(401, 'Authentication failed');
    if (!record.resumable || Date.now() - record.updatedAt > SESSION_RETENTION) { fs.rmSync(fileFor(id), { force: true }); throw failure(410, 'Session retention expired; create a fresh adapter session'); }
    if (!allowResume) throw failure(410, 'Session lease expired; reconnect the authenticated adapter');
    return activate(record);
  }
  function respond(res, status, value) {
    if (res.destroyed || res.writableEnded) return;
    const data = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
  }
  try {
    atomic(marker, { version: 1 }); plainDir(descriptors);
    function pruneDescriptors() {
      for (const name of fs.readdirSync(descriptors)) if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const id = name.slice(0, -5); if (sessions.has(id)) continue;
        let record; try { record = readJson(fileFor(id)); } catch { continue; }
        if (!record.resumable || Date.now() - record.updatedAt > SESSION_RETENTION) fs.rmSync(fileFor(id), { force: true });
      }
    }
    pruneDescriptors();
    const roomLocks = path.join(home, 'locks');
    if (fs.existsSync(roomLocks)) {
      if (fs.lstatSync(roomLocks).isSymbolicLink()) throw new Error('Unsafe mailbox locks directory');
      // Exclusive broker leadership makes room locks from any previous epoch orphaned.
      for (const entry of fs.readdirSync(roomLocks, { withFileTypes: true })) if ((entry.isFile() || entry.isSymbolicLink()) && /\.lock(?:\.reclaim)?$/.test(entry.name)) fs.unlinkSync(path.join(roomLocks, entry.name));
    }
    server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000, maxHeaderSize: 16384, connectionsCheckingInterval: 1000 }, (req, res) => {
      void (async () => {
        const url = new URL(req.url, 'http://broker.invalid');
        if (req.method === 'GET' && url.pathname === '/health') return respond(res, 200, { ok: !closed && ownsStorage(), version: VERSION });
        if (req.headers.origin) throw failure(403, 'Browser origins are not supported');
        assertOwner();
        if (req.method === 'POST' && url.pathname === '/v1/sessions') {
          if (!constantEqual(auth(req), masterHash)) throw failure(401, 'Authentication failed');
          const value = await body(req); assertOwner(); onlyKeys(value, ['room', 'name', 'client', 'clientCwd', 'resumable']);
          validateRemoteRoom(value.room);
          if (value.resumable !== undefined && typeof value.resumable !== 'boolean') throw failure(400, 'Invalid resumable choice');
          if (typeof value.client !== 'string' || value.client.length > 128 || typeof value.clientCwd !== 'string' || Buffer.byteLength(value.clientCwd) > 4096 || value.clientCwd.includes('\0') || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value.clientCwd)) throw failure(400, 'Client and absolute clientCwd are required');
          if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 128)) throw failure(400, 'Invalid display name');
          pruneDescriptors();
          const files = fs.readdirSync(descriptors).filter(name => name.endsWith('.json'));
          if (files.length >= maxStoredSessions) throw failure(429, 'Stored session limit reached; administrator cleanup is required');
          const secret = crypto.randomBytes(32).toString('hex');
          const session = activate({ id: crypto.randomUUID(), room: value.room, name: value.name || (value.client.toLowerCase().includes('claude') ? 'claude' : value.client.toLowerCase().includes('codex') ? 'codex' : 'agent'), client: value.client, clientCwd: value.clientCwd, resumable: value.resumable === true, tokenHash: digest(secret) });
          return respond(res, 201, { sessionId: session.id, sessionToken: secret, leaseMs, room: session.room, peer: peerInfo(session.server.state.identity) });
        }
        const match = /^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(rpc|ack|heartbeat|resume|notifications))?$/.exec(url.pathname);
        if (!match) throw failure(404, 'Endpoint not found');
        const [, id, action] = match;
        const session = authenticated(req, id, { allowResume: action === 'resume' });
        if (req.method === 'DELETE' && !action) { expire(session); return respond(res, 200, { closed: true }); }
        if (req.method !== 'POST' || !action) throw failure(405, 'Method not allowed');
        const value = await body(req); assertOwner();
        if (!sessions.has(id) || session.expiresAt <= Date.now()) throw failure(410, 'Session lease expired');
        if (action === 'heartbeat' || action === 'resume') { onlyKeys(value, []); renew(session); return respond(res, 200, { leaseMs, peer: peerInfo(session.server.state.identity) }); }
        if (action === 'notifications') {
          onlyKeys(value, ['room', 'afterOffset', 'limit', 'maxBytes']);
          if (value.room !== session.room) throw failure(403, 'Session room mismatch');
          const me = session.server.state.identity;
          const page = session.mailbox.inspectNotifications({ room: me.room, name: me.name, sessionId: me.sessionId, afterOffset: value.afterOffset, limit: value.limit ?? 10, maxBytes: value.maxBytes ?? 65536, unreadOnly: true });
          return respond(res, 200, { messages: page.messages.map(message => ({ id: message.id })), nextOffset: page.nextOffset, hasMore: page.hasMore, size: page.size, peer: peerInfo(me) });
        }
        if (action === 'ack') {
          onlyKeys(value, ['receipt']); if (!uuid(value.receipt)) throw failure(400, 'Invalid receipt');
          const entry = session.pending.get(value.receipt);
          if (entry) { if (entry.read) session.mailbox.commitCursor(entry.read.identity, entry.read.offset); cacheBytes -= entry.bytes; session.pending.delete(value.receipt); }
          renew(session); return respond(res, 200, { acknowledged: true });
        }
        onlyKeys(value, ['requestId', 'rpc']);
        if (!uuid(value.requestId)) throw failure(400, 'A unique transport requestId is required');
        const fingerprint = digest(JSON.stringify(value.rpc));
        const cached = session.pending.get(value.requestId);
        if (cached) { if (cached.fingerprint !== fingerprint) throw failure(409, 'Transport requestId was reused'); return respond(res, 200, cached.result); }
        const running = session.inflight.get(value.requestId);
        if (running) { if (running.fingerprint !== fingerprint) throw failure(409, 'Transport requestId was reused'); return respond(res, 200, await running.promise); }
        const rpc = value.rpc;
        if (rpc?.method === 'tools/call' && rpc.params?.name === 'chat_join' && rpc.params?.arguments?.room !== undefined && rpc.params.arguments.room !== session.room) throw failure(403, 'This session is bound to its explicit room; open another adapter for a different room');
        const isRead = rpc?.method === 'tools/call' && rpc.params?.name === 'chat_read';
        if (session.inflight.size + session.pending.size >= REQUESTS_PER_SESSION || cacheBytes + reserved + RESPONSE_LIMIT > cacheBudget) {
          throw Object.assign(failure(429, 'Pending response limit reached'), { execution: 'not-started', requestId: value.requestId });
        }
        if (isRead && (session.activeRead || [...session.pending.values()].some(entry => entry.read))) throw failure(409, 'A previous read requires acknowledgement');
        renew(session);
        const context = { read: null, fingerprint };
        const responses = [];
        reserved += RESPONSE_LIMIT;
        if (isRead) session.activeRead = context;
        // Connection loss is not MCP cancellation: a same-ID retry must await this original execution.
        // Reads remain bounded by their wait deadline, explicit cancellation and session lease.
        const promise = (async () => {
          try {
            await session.server.handle(rpc, { respond: response => responses.push(response) });
            const result = { responses, ...(responses.length ? { receipt: value.requestId } : {}) };
            const bytes = Buffer.byteLength(JSON.stringify(result));
            if (bytes > RESPONSE_LIMIT) throw failure(413, 'Broker response exceeds the byte limit');
            if (responses.length && sessions.get(id) === session) { session.pending.set(value.requestId, { ...context, result, bytes }); cacheBytes += bytes; persist(session); }
            return result;
          } finally { reserved -= RESPONSE_LIMIT; session.inflight.delete(value.requestId); if (session.activeRead === context) session.activeRead = null; }
        })();
        session.inflight.set(value.requestId, { fingerprint, promise });
        return respond(res, 200, await promise);
      })().catch(error => { respond(res, error.status || 400, { error: error.status ? error.message : 'Invalid broker request',
        ...(error.status === 429 && error.execution === 'not-started' ? { execution: error.execution, requestId: error.requestId } : {}) }); });
    });
    server.maxConnections = Math.max(16, maxSessions * 4); server.maxRequestsPerSocket = 100; server.timeout = 65000;
    server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    leaseTimer = setInterval(() => { for (const session of sessions.values()) if (session.expiresAt <= Date.now()) expire(session); }, Math.max(100, Math.min(1000, leaseMs / 3))); leaseTimer.unref();
    ownerTimer = setInterval(() => { if (closed) return; if (!ownsStorage()) { void close(); return; } try { atomic(ownerFile, { epoch, pid: process.pid, expiresAt: Date.now() + OWNER_LEASE }); } catch { void close(); } }, 1000); ownerTimer.unref();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
    const address = server.address();
    return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`, close, stats: () => ({ activeSessions: sessions.size, pendingBytes: cacheBytes, pendingRequests: reserved / RESPONSE_LIMIT, cacheBudget }) };
  } catch (error) { await close(); throw error; }
  async function close() {
    if (closed) return; closed = true; clearInterval(leaseTimer); clearInterval(ownerTimer);
    for (const session of [...sessions.values()]) expire(session);
    if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (ownsStorage()) fs.rmSync(ownerFile, { force: true });
  }
}

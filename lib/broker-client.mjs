import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_RESPONSE = 512 * 1024;
const localResources = Symbol('local broker resources');
export function canonicalBrokerUrl(value) {
  let url; try { url = new URL(value); } catch { throw new Error('Broker URL must be an absolute HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Broker URL must be an origin without credentials, paths, query parameters or fragments');
  return url.href.replace(/\/+$/, '');
}
export function validateRemoteRoom(room) {
  if (typeof room !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(room)) throw new Error('Broker mode requires an explicit plain room name (1 to 128 letters, digits, dots, underscores or hyphens)');
  return room;
}
export function readBrokerToken(tokenFile) {
  if (typeof tokenFile !== 'string' || !path.isAbsolute(tokenFile)) throw new Error('An absolute broker token file path is required');
  let fd;
  try {
    if (fs.lstatSync(tokenFile).isSymbolicLink()) throw new Error('Broker token file cannot be a symlink');
    fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Broker token file must be a small regular file');
    const buffer = Buffer.alloc(4097); const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, length).toString('utf8').trim();
    if (length > 4096 || !/^[A-Za-z0-9._~+\/-]{32,512}={0,2}$/.test(token)) throw new Error('Broker token must contain 32 to 512 non-whitespace safe ASCII characters');
    return token;
  } catch (error) { if (error.code) throw new Error('Broker token file is missing or unreadable'); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
export function brokerSessionDirectory({ sessionDir, home } = {}) {
  const dir = sessionDir || process.env.AGENT_CHAT_BROKER_SESSION_DIR || path.join(home || process.env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat'), 'broker-sessions');
  if (!path.isAbsolute(dir)) throw new Error('Broker session directory must be absolute');
  return path.resolve(dir);
}
function sessionFile(dir, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid broker session ID');
  return path.join(dir, `${id}.json`);
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) throw new Error('Unsafe broker session directory');
}
function saveSession(session, { sessionDir, home, tokenFile, sessionFile: explicitFile } = {}) {
  const dir = brokerSessionDirectory({ sessionDir, home }); privateDir(dir);
  const file = sessionFile(dir, session.sessionId); const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify({ ...session, bootstrapHash: tokenHash(readBrokerToken(tokenFile)) }) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
  if (explicitFile) {
    if (!path.isAbsolute(explicitFile)) throw new Error('Broker session file must be absolute');
    privateDir(path.dirname(explicitFile));
    if (fs.existsSync(explicitFile) && fs.lstatSync(explicitFile).isSymbolicLink()) throw new Error('Unsafe broker session file');
    const temp = `${explicitFile}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, fs.readFileSync(file), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, explicitFile); } finally { fs.rmSync(temp, { force: true }); }
  }
  return file;
}
function loadSession({ url, tokenFile, sessionId, sessionDir, home }) {
  const dir = brokerSessionDirectory({ sessionDir, home });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe broker session directory');
  const file = sessionFile(dir, sessionId);
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8192) throw new Error('Unsafe broker session credential file');
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (session.sessionId !== sessionId || session.url !== canonicalBrokerUrl(url) || session.bootstrapHash !== tokenHash(readBrokerToken(tokenFile)) || typeof session.sessionToken !== 'string' || !/^[a-f0-9]{64}$/.test(session.sessionToken)) throw new Error('Broker session credentials do not match this endpoint and token file');
  return session;
}
async function request(url, endpoint, { token, method = 'POST', body, timeoutMs = 60000, signal } = {}) {
  const endpointUrl = canonicalBrokerUrl(url) + endpoint;
  const options = { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) };
  let response;
  try { response = await fetch(endpointUrl, options); }
  catch (error) { error.transportFailure = true; throw error; }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > MAX_RESPONSE) { throw Object.assign(new Error('Broker response exceeded the byte limit'), { responseLimit: true }); } chunks.push(chunk); }
  } catch (error) {
    if (!response.ok) throw Object.assign(new Error(`Broker request failed (HTTP ${response.status})`), { status: response.status });
    if (!error.responseLimit) error.transportFailure = true; throw error;
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { if (response.ok) throw new Error('Broker returned invalid JSON'); }
  if (!response.ok) throw Object.assign(new Error(`Broker request failed (HTTP ${response.status})`), { status: response.status,
    ...(response.status === 429 && result?.execution === 'not-started' && typeof result.requestId === 'string'
      ? { rejectedBeforeExecution: true, requestId: result.requestId } : {}) });
  return result;
}
function processInstance(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const started = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return `${namespace}:${started}`;
  } catch { return null; }
}
function prepareSessionStorage({ sessionDir, home, sessionFile: explicitFile }) {
  const dir = brokerSessionDirectory({ sessionDir, home });
  if (explicitFile !== undefined && (typeof explicitFile !== 'string' || !path.isAbsolute(explicitFile))) throw new Error('Broker session file must be absolute');
  privateDir(dir);
  let release = () => {};
  if (explicitFile) {
    privateDir(path.dirname(explicitFile));
    if (fs.existsSync(explicitFile) && (fs.lstatSync(explicitFile).isSymbolicLink() || !fs.statSync(explicitFile).isFile() || fs.statSync(explicitFile).size > 8192)) throw new Error('Unsafe broker session file');
    const lock = `${explicitFile}.lock`; const nonce = crypto.randomUUID();
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A dead local adapter can relinquish its launch lock. The broker separately enforces its lease.
      let reclaimFd; const reclaim = `${lock}.reclaim`;
      try {
        reclaimFd = fs.openSync(reclaim, 'wx', 0o600);
        if (fs.lstatSync(lock).isSymbolicLink() || fs.statSync(lock).size > 1024) throw new Error();
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error();
        let alive = true; try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        const instance = processInstance(owner.pid);
        if (alive && !(owner.instance && instance && owner.instance !== instance)) throw new Error();
        fs.unlinkSync(lock); fd = fs.openSync(lock, 'wx', 0o600);
      } catch { throw Object.assign(new Error('This private broker session file is already in use; stop its adapter before reconnecting'), { status: 409 }); }
      finally { if (reclaimFd !== undefined) { fs.closeSync(reclaimFd); fs.rmSync(reclaim, { force: true }); } }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, instance: processInstance(process.pid) })); } finally { fs.closeSync(fd); }
    release = () => { try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).nonce === nonce) fs.unlinkSync(lock); } catch { /* already released */ } };
  }
  return { dir, release };
}
export async function createRemoteSession({ url, tokenFile, room, name, client = 'unknown', clientCwd = process.cwd(), sessionDir, home, sessionFile: explicitFile, resumable = Boolean(explicitFile) } = {}) {
  url = canonicalBrokerUrl(url); validateRemoteRoom(room);
  const bootstrapHash = tokenHash(readBrokerToken(tokenFile));
  const storage = prepareSessionStorage({ sessionDir, home, sessionFile: explicitFile });
  let session;
  try {
    if (explicitFile && fs.existsSync(explicitFile)) {
      const previous = JSON.parse(fs.readFileSync(explicitFile, 'utf8'));
      if (previous.url !== url || previous.bootstrapHash !== bootstrapHash || previous.clientCwd !== clientCwd || previous.room !== room || typeof previous.sessionToken !== 'string') throw new Error('Stored broker session does not match this endpoint, room, token file and client directory');
      let resumed;
      try { resumed = await resumeRemoteSession(previous); }
      catch (error) {
        if (error.status === 404 || error.status === 410) throw Object.assign(new Error('Saved broker session expired or is no longer available. Stop adapters using this file, then remove the obsolete AGENT_CHAT_BROKER_SESSION_FILE or choose a fresh absolute path and restart. The saved credentials have been preserved.'), { status: error.status });
        throw error;
      }
      session = { ...previous, leaseMs: resumed.leaseMs };
      if (resumed.peer?.room !== room) throw new Error('Resumed broker room does not match');
    } else {
      const result = await request(url, '/v1/sessions', { token: readBrokerToken(tokenFile), body: { room, ...(name === undefined ? {} : { name }), client, clientCwd, resumable }, timeoutMs: 10000 });
      session = { ...result, url, clientCwd, resumable };
    }
    const credentialFile = saveSession(session, { sessionDir, home, tokenFile, sessionFile: explicitFile });
    Object.defineProperty(session, localResources, { value: { release: storage.release, credentialFile, ephemeral: !resumable } });
    return session;
  } catch (error) {
    if (session) { try { await closeRemoteSession(session); } catch { /* lease bounds failed startup */ } }
    if (session && !resumable) fs.rmSync(sessionFile(storage.dir, session.sessionId), { force: true });
    storage.release(); throw error;
  }
}
export async function resumeRemoteSession(session) { return request(session.url, `/v1/sessions/${session.sessionId}/resume`, { token: session.sessionToken, body: {}, timeoutMs: 10000 }); }
export async function heartbeatRemoteSession(session) { return request(session.url, `/v1/sessions/${session.sessionId}/heartbeat`, { token: session.sessionToken, body: {}, timeoutMs: 10000 }); }
export async function closeRemoteSession(session) {
  try { return await request(session.url, `/v1/sessions/${session.sessionId}`, { token: session.sessionToken, method: 'DELETE', timeoutMs: 10000 }); }
  finally { const local = session[localResources]; if (local?.ephemeral) fs.rmSync(local.credentialFile, { force: true }); local?.release(); }
}
export async function remoteRpc(session, rpc, { requestId: suppliedRequestId, signal, timeoutMs = 60000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2 || timeoutMs > 60000) throw new Error('RPC timeout must be 2 to 60000 milliseconds');
  const requestId = suppliedRequestId === undefined ? crypto.randomUUID() : suppliedRequestId;
  const body = JSON.parse(JSON.stringify({ requestId, rpc }));
  const deadline = performance.now() + timeoutMs;
  const recoveryMs = Math.min(5000, Math.max(1, Math.floor(timeoutMs / 4)));
  let result; let ambiguous = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      result = await request(session.url, `/v1/sessions/${session.sessionId}/rpc`, { token: session.sessionToken, body, signal,
        timeoutMs: attempt === 0 ? Math.max(1, remaining - recoveryMs) : remaining });
      break;
    } catch (error) {
      // Neither a reused ID nor a transport failure proves that an earlier attempt did not execute.
      error.definitelyNotExecuted = !ambiguous && suppliedRequestId === undefined && error.rejectedBeforeExecution === true && error.requestId === requestId;
      if (!error.transportFailure || signal?.aborted || attempt === 1 || performance.now() >= deadline) throw error;
      ambiguous = true;
      // The broker returns the cached result for this exact ID and RPC, including its read receipt.
    }
  }
  for (const response of result.responses || []) {
    const identity = response.result?.structuredContent?.agentChatIdentity;
    if (identity) { identity.transport = 'broker'; identity.brokerUrl = session.url; identity.clientCwd = session.clientCwd; }
  }
  return result;
}
export async function acknowledgeRemoteResponse(session, receipt) {
  if (!receipt) return;
  return request(session.url, `/v1/sessions/${session.sessionId}/ack`, { token: session.sessionToken, body: { receipt }, timeoutMs: 10000 });
}
export async function inspectRemoteNotifications({ url, tokenFile, room, sessionId, afterOffset, limit = 10, maxBytes = 65536, sessionDir, home } = {}) {
  url = canonicalBrokerUrl(url); validateRemoteRoom(room);
  const session = loadSession({ url, tokenFile, sessionId, sessionDir, home });
  return request(url, `/v1/sessions/${sessionId}/notifications`, { token: session.sessionToken, body: { room, ...(afterOffset === undefined ? {} : { afterOffset }), limit, maxBytes }, timeoutMs: 1500 });
}
/** Forwards MCP stdio without exposing the bootstrap or per-session credentials. */
export async function runProxy({ env = process.env, input = process.stdin, output = process.stdout, clientCwd = process.cwd() } = {}) {
  const url = canonicalBrokerUrl(env.AGENT_CHAT_BROKER_URL);
  const room = validateRemoteRoom(env.AGENT_CHAT_ROOM);
  const tokenFile = env.AGENT_CHAT_BROKER_TOKEN_FILE;
  readBrokerToken(tokenFile);
  const unacknowledged = new Set();
  let session; let stopped = false; let heartbeat; let heartbeatBusy = false;
  const controllers = new Set(); const jobs = new Set();
  const write = value => new Promise((resolve, reject) => output.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
  const clientName = env.AGENT_CHAT_CLIENT || env.AGENT_CHAT_NAME || 'unknown';
  const family = clientName.toLowerCase().includes('claude') ? 'claude' : clientName.toLowerCase().includes('codex') ? 'codex' : clientName.toLowerCase().includes('opencode') ? 'opencode' : 'agent';
  const suffix = crypto.randomBytes(3).toString('hex');
  const project = (path.basename(clientCwd) || 'root').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40 - family.length - suffix.length - 2);
  const startup = createRemoteSession({ url, tokenFile, room, name: env.AGENT_CHAT_NAME || `${family}-${project}-${suffix}`, client: clientName, clientCwd, sessionDir: env.AGENT_CHAT_BROKER_SESSION_DIR, home: env.AGENT_CHAT_HOME, sessionFile: env.AGENT_CHAT_BROKER_SESSION_FILE }).then(result => { session = result; return result; });
  const stop = async () => {
    if (stopped) return; stopped = true; clearInterval(heartbeat);
    for (const controller of controllers) controller.abort();
    try { await startup; if (session) await closeRemoteSession(session); } catch { /* lease expires if the network is gone */ }
  };
  const signalStop = () => { void stop().finally(() => { if (input === process.stdin) process.exit(0); }); };
  process.once('SIGTERM', signalStop); process.once('SIGINT', signalStop);
  try {
    await startup;
    const flushAcks = async () => { for (const receipt of unacknowledged) { try { await acknowledgeRemoteResponse(session, receipt); unacknowledged.delete(receipt); } catch { break; } } };
    heartbeat = setInterval(() => { if (stopped || heartbeatBusy) return; heartbeatBusy = true; void heartbeatRemoteSession(session).then(flushAcks).catch(() => {}).finally(() => { heartbeatBusy = false; }); }, Math.max(250, Math.floor(session.leaseMs / 3)));
    heartbeat.unref?.();
    let buffer = Buffer.alloc(0); let dropping = false;
    const handle = async line => {
      let rpc;
      try { rpc = JSON.parse(line.toString('utf8')); } catch { return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const controller = new AbortController(); controllers.add(controller);
      try {
        await flushAcks();
        const result = await remoteRpc(session, rpc, { signal: controller.signal });
        for (const response of result.responses || []) await write(response);
        if (result.receipt) { unacknowledged.add(result.receipt); await flushAcks(); }
      } catch (error) {
        if (!stopped && rpc && typeof rpc === 'object' && !Array.isArray(rpc) && Object.hasOwn(rpc, 'id')) await write({ jsonrpc: '2.0', id: rpc.id,
          error: error.definitelyNotExecuted ? { code: -32001, message: 'Broker is busy. This request was rejected before execution. Retry after pending requests finish.', data: { retryable: true, execution: 'not-started' } }
            : { code: -32000, message: 'Broker connection failed. The operation may have completed; confirm its result before retrying. Reconnect the broker adapter if its lease expired or the broker restarted.' } });
      } finally { controllers.delete(controller); }
    };
    for await (const chunk of input) {
      if (stopped) break;
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        if (dropping) { dropping = false; continue; }
        if (line.length > 256 * 1024 || jobs.size >= 16) { await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Proxy request or concurrency limit exceeded' } }); continue; }
        if (!line.toString('utf8').trim()) continue;
        const job = handle(line); jobs.add(job); void job.finally(() => jobs.delete(job)).catch(() => {});
      }
      if (buffer.length > 256 * 1024) { buffer = Buffer.alloc(0); if (!dropping) await write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Proxy request exceeds byte limit' } }); dropping = true; }
    }
    await stop();
    await Promise.allSettled(jobs);
  } finally { await stop(); process.removeListener('SIGTERM', signalStop); process.removeListener('SIGINT', signalStop); }
}

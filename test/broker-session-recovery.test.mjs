import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createBroker } from '../lib/broker.mjs';
import { createRemoteSession, closeRemoteSession } from '../lib/broker-client.mjs';

async function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-session-recovery-')));
  let broker;
  t.after(async () => { try { await broker?.close(); } finally { fs.rmSync(base, { recursive: true, force: true }); } });
  const tokenFile = path.join(base, 'token');
  fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const home = path.join(base, 'mailbox');
  broker = await createBroker({ home, tokenFile });
  const sessionFile = path.join(base, 'saved-session.json');
  const options = { url: broker.url, tokenFile, room: 'shared', clientCwd: base,
    sessionDir: path.join(base, 'credentials'), sessionFile };
  return { home, tokenFile, sessionFile, options };
}

for (const status of [404, 410]) test(`saved session HTTP ${status} explains explicit recovery without changing credentials`, async t => {
  const f = await fixture(t);
  const original = await createRemoteSession(f.options);
  await closeRemoteSession(original);
  const saved = fs.readFileSync(f.sessionFile);
  const descriptor = path.join(f.home, '.broker-sessions', `${original.sessionId}.json`);
  if (status === 404) fs.unlinkSync(descriptor);
  else {
    const record = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    record.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(descriptor, JSON.stringify(record));
  }
  // Repeated startup must release its own local lock each time and leave recovery to the user.
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(createRemoteSession(f.options), error => {
      assert.equal(error.status, attempt === 0 ? status : 404);
      assert.match(error.message, /Saved broker session expired or is no longer available/);
      assert.match(error.message, /Stop adapters.*AGENT_CHAT_BROKER_SESSION_FILE.*restart/);
      assert.doesNotMatch(error.message, new RegExp(original.sessionToken));
      assert.doesNotMatch(error.message, new RegExp(fs.readFileSync(f.tokenFile, 'utf8')));
      return true;
    });
    assert.deepEqual(fs.readFileSync(f.sessionFile), saved);
    assert.equal(fs.existsSync(`${f.sessionFile}.lock`), false);
  }
  // This explicit removal simulates the documented user recovery, not automatic cleanup.
  fs.unlinkSync(f.sessionFile);
  const fresh = await createRemoteSession(f.options);
  assert.notEqual(fresh.sessionId, original.sessionId);
  await closeRemoteSession(fresh);
});

test('saved session authentication and active adapter conflicts keep their original errors', async t => {
  const f = await fixture(t);
  const original = await createRemoteSession(f.options);
  const copy = path.join(path.dirname(f.sessionFile), 'copied-session.json');
  const saved = fs.readFileSync(f.sessionFile);
  fs.writeFileSync(copy, saved, { mode: 0o600 });
  await assert.rejects(createRemoteSession({ ...f.options, sessionFile: copy }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message, 'Broker request failed (HTTP 409)');
    return true;
  });
  assert.deepEqual(fs.readFileSync(copy), saved);
  assert.equal(fs.existsSync(`${copy}.lock`), false);
  await closeRemoteSession(original);
  const invalid = JSON.parse(saved.toString('utf8')); invalid.sessionToken = '0'.repeat(64);
  fs.writeFileSync(f.sessionFile, JSON.stringify(invalid));
  const invalidBytes = fs.readFileSync(f.sessionFile);
  await assert.rejects(createRemoteSession(f.options), error => {
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Broker request failed (HTTP 401)');
    return true;
  });
  assert.deepEqual(fs.readFileSync(f.sessionFile), invalidBytes);
  assert.equal(fs.existsSync(`${f.sessionFile}.lock`), false);
});

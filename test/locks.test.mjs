import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMailbox, LOCK_LIMITS } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';
import { guardDecision, commandText, loadGuards, GUARD_FILE } from '../lib/guards.mjs';
import { installProject } from '../lib/install.mjs';
import { bindNotification } from '../hooks/bind.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const canonical = dir => (process.platform === 'win32' || process.platform === 'darwin' ? fs.realpathSync.native : fs.realpathSync)(dir);

function fixture(t) {
  const base = canonical(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-locks-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'); const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const mailbox = createMailbox({ home, cwd: project });
  const room = mailbox.resolveRoom('release-room');
  const claim = (name, sessionId) => mailbox.claimIdentity(room, name, 'claude-code', sessionId);
  return { base, home, project, mailbox, room, claim };
}
function writeGuards(dir, guards, file = GUARD_FILE) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 1, guards }) + '\n');
}
const RELEASE = [{ lock: 'publish', pattern: '(?:^|[;&|(\\n])\\s*grunt\\s+release\\b', why: 'releases push main and rebuild Satis' }];
const bash = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: 'host-1', tool_name: 'Bash', tool_input: { command }, ...extra });

test('a lock is exclusive, announced, renewable by its holder and released only by its holder', t => {
  const { mailbox, room, claim } = fixture(t);
  const one = claim('releaser', 'session-one'); const two = claim('other', 'session-two');
  const first = mailbox.acquireResource(one, 'publish', 'productcontent 2.9.118');
  assert.equal(first.renewed, false);
  assert.throws(() => mailbox.acquireResource(two, 'publish', 'pulse 1.4.0'), /Not locked\. publish is held by releaser \(session session-one\) in release-room .*: productcontent 2\.9\.118/);
  assert.equal(mailbox.acquireResource(one, 'publish', 'still releasing', 30).renewed, true);
  assert.equal(mailbox.heldLock('publish').acquiredAt, first.record.acquiredAt);
  assert.throws(() => mailbox.releaseResource(two, 'publish'), /Only the holder can unlock it/);
  assert.deepEqual(mailbox.listLocks().map(lock => [lock.resource, lock.name]), [['publish', 'releaser']]);
  assert.equal(mailbox.releaseResource(one, 'publish', 'released 2.9.118').released, true);
  assert.equal(mailbox.heldLock('publish'), null);
  assert.equal(mailbox.acquireResource(two, 'publish', 'pulse 1.4.0').renewed, false);
  const log = mailbox.inspectNotifications({ room, limit: 20, maxBytes: 64 * 1024 }).messages.map(msg => msg.text);
  assert.ok(log.includes('UNLOCK publish: released 2.9.118'));
  assert.equal(log.filter(text => text.startsWith('LOCK publish: ')).length, 2);
  assert.ok(log.some(text => text.startsWith('LOCK RENEWED publish: still releasing')));
});

test('a lock ends with its holder session or its expiry, and anyone may clear an ended lock', t => {
  const { mailbox, claim } = fixture(t);
  const one = claim('releaser', 'session-one'); const two = claim('other', 'session-two');
  mailbox.acquireResource(one, 'publish', 'release');
  mailbox.releaseIdentity(one);
  assert.equal(mailbox.heldLock('publish'), null);
  assert.equal(mailbox.acquireResource(two, 'publish', 'next release').renewed, false);
  assert.equal(mailbox.heldLock('publish', Date.now() + 121 * 60000), null);
  const three = claim('third', 'session-three');
  mailbox.acquireResource(three, 'deploy', 'stage deploy', 1);
  mailbox.releaseIdentity(three);
  const cleared = mailbox.releaseResource(two, 'deploy');
  assert.deepEqual([cleared.released, cleared.stale], [true, true]);
  assert.equal(mailbox.releaseResource(two, 'deploy').released, false);
});

test('lock names, notes and durations are validated before anything is written', t => {
  const { mailbox, claim } = fixture(t);
  const one = claim('releaser', 'session-one');
  assert.throws(() => mailbox.acquireResource(one, '../escape', 'note'), /Lock name/);
  assert.throws(() => mailbox.acquireResource(one, 'publish', '  '), /note is required/);
  assert.throws(() => mailbox.acquireResource(one, 'publish', 'x'.repeat(LOCK_LIMITS.noteChars + 1)), /at most/);
  assert.throws(() => mailbox.acquireResource(one, 'publish', 'note', LOCK_LIMITS.maxMinutes + 1), /minutes must be/);
  assert.deepEqual(mailbox.listLocks(), []);
});

test('chat_lock and chat_unlock work through MCP and chat_who lists held locks', async t => {
  const { mailbox } = fixture(t);
  const servers = ['session-one', 'session-two'].map(sessionId => {
    const server = createServer({ mailbox, output: () => {}, sessionId, roomSpec: 'release-room', nameSpec: sessionId === 'session-one' ? 'releaser' : 'other' });
    t.after(() => server.stop());
    return server;
  });
  assert.match(await servers[0].callTool('chat_lock', { lock: 'publish', note: 'productcontent 2.9.118' }), /^Locked publish until .* and announced it in release-room/);
  await assert.rejects(servers[1].callTool('chat_lock', { lock: 'publish', note: 'pulse' }), /publish is held by releaser/);
  assert.match(await servers[1].callTool('chat_who'), /Held locks:\n- publish: releaser in release-room until .*: productcontent 2\.9\.118/);
  assert.match(await servers[0].callTool('chat_who'), /- publish: releaser \[you\]/);
  assert.match(await servers[1].callTool('chat_read'), /releaser -> all: LOCK publish: productcontent 2\.9\.118/);
  assert.match(await servers[0].callTool('chat_unlock', { lock: 'publish', note: 'released' }), /^Unlocked publish and announced/);
  assert.match(await servers[0].callTool('chat_unlock', { lock: 'publish' }), /was not locked/);
  await assert.rejects(servers[0].callTool('chat_lock', { lock: 'publish' }), /note is required/);
});

test('only shell tools carry a guarded command', () => {
  assert.equal(commandText('Bash', { command: 'grunt release:x' }), 'grunt release:x');
  assert.equal(commandText('mcp__terminal__run_in_terminal', { command: 'ls' }), 'ls');
  assert.equal(commandText('shell', { command: ['bash', '-lc', 'grunt release'] }), 'bash -lc grunt release');
  assert.equal(commandText('Edit', { command: 'grunt release' }), null);
  assert.equal(commandText('Bash', null), null);
});

test('guard files come from the nearest project directory and the mailbox home', t => {
  const { base, home, project } = fixture(t);
  writeGuards(base, [{ lock: 'outer', pattern: 'outer' }]);
  const nested = path.join(project, 'worktree', 'deep'); fs.mkdirSync(nested, { recursive: true });
  writeGuards(project, RELEASE);
  writeGuards(home, [{ lock: 'deploy', pattern: 'deploy\\.sh' }], 'guards.json');
  assert.deepEqual(loadGuards([nested], home).map(guard => guard.lock), ['publish', 'deploy']);
  fs.writeFileSync(path.join(project, GUARD_FILE), '{"version":1,"guards":[{"lock":"x","pattern":"("}]}');
  assert.throws(() => loadGuards([nested], home), /pattern is invalid/);
});

test('the guard passes unguarded commands without the mailbox and blocks guarded ones until this session holds the lock', async t => {
  const { home, project, mailbox, room, claim } = fixture(t);
  writeGuards(project, RELEASE);
  const env = { AGENT_CHAT_HOME: home, AGENT_CHAT_NOTIFY_CONFIG: path.join(home, 'notifications.json') };
  const untouchable = new Proxy({}, { get() { throw new Error('mailbox must not be read'); } });
  const decide = (command, options = {}) => guardDecision({ client: 'codex', payload: bash(command, { cwd: project }), env, mailbox, ...options });

  assert.deepEqual(await decide('git status', { mailbox: untouchable }), { allow: true });
  assert.deepEqual(await decide('grep "grunt release" docs.md', { mailbox: untouchable }), { allow: true });
  assert.deepEqual(await guardDecision({ client: 'codex', payload: { ...bash('grunt release'), tool_name: 'Read', cwd: project }, env, mailbox: untouchable }), { allow: true });

  const unbound = await decide('cd build && grunt release:productcontent');
  assert.equal(unbound.allow, false);
  assert.match(unbound.reason, /needs the publish lock \(releases push main and rebuild Satis\)\. This session is not linked to agent-chat yet: call chat_who once, then Call chat_lock\(lock: "publish"/);

  const me = claim('releaser', 'mailbox-me'); const other = claim('other', 'mailbox-other');
  bindNotification({ configFile: env.AGENT_CHAT_NOTIFY_CONFIG, binding: { client: 'codex', hostSessionId: 'host-1', cwd: project, room: room.id, mailboxSessionId: me.sessionId } });
  assert.match((await decide('grunt release:productcontent')).reason, /Call chat_lock\(lock: "publish", note: "<what you are doing>"\) first/);
  mailbox.acquireResource(other, 'publish', 'pulse 1.4.0');
  assert.match((await decide('grunt release:productcontent')).reason, /publish is held by other .*: pulse 1\.4\.0\. Wait for its UNLOCK/);
  mailbox.releaseResource(other, 'publish');
  mailbox.acquireResource(me, 'publish', 'productcontent 2.9.118');
  assert.deepEqual(await decide('grunt release:productcontent'), { allow: true, locks: ['publish'] });
  mailbox.releaseResource(me, 'publish');
  assert.equal((await decide('grunt release:productcontent')).allow, false);
  assert.match((await decide('grunt release', { env: { ...env, AGENT_CHAT_BROKER_URL: 'http://127.0.0.1:1' } })).reason, /not supported in broker mode/);

  fs.writeFileSync(path.join(project, GUARD_FILE), 'not json');
  const broken = await decide('git status', { mailbox: untouchable });
  assert.equal(broken.allow, false);
  assert.match(broken.reason, /Fix the guard file/);
});

test('installed launchers register the guard and block a guarded command through the real hook process', t => {
  const { home, project, mailbox, room, claim } = fixture(t);
  installProject({ project, sourceRoot: root, clients: ['codex', 'claude'], hooks: true });
  const claudeHook = JSON.parse(fs.readFileSync(path.join(project, '.claude/settings.local.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(claudeHook.length, 1);
  assert.equal(claudeHook[0].matcher, 'Bash|mcp__terminal__run_in_terminal');
  assert.ok(claudeHook[0].hooks[0].command.endsWith(' claude-code guard'));
  const codexHook = JSON.parse(fs.readFileSync(path.join(project, '.codex/hooks.json'), 'utf8')).hooks.PreToolUse;
  assert.deepEqual([codexHook[0].matcher, codexHook[0].hooks[0].command.endsWith(' codex guard')], ['.*', true]);
  writeGuards(project, RELEASE);
  const launcher = path.join(project, '.agent-chat/launchers/claude.mjs');
  const env = { ...process.env, AGENT_CHAT_HOME: home, CLAUDE_PROJECT_DIR: project, AGENT_CHAT_BROKER_URL: '', AGENT_CHAT_BROKER_TOKEN_FILE: '' };
  const run = command => spawnSync(process.execPath, [launcher, 'claude-code', 'guard'], { input: JSON.stringify(bash(command, { cwd: project })), env, encoding: 'utf8' });

  assert.deepEqual([run('git status').status, run('git status').stderr], [0, '']);
  const blocked = run('grunt release:productcontent');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /needs the publish lock/);

  const me = claim('releaser', 'mailbox-me');
  bindNotification({ configFile: path.join(project, '.agent-chat/notifications.json'), binding: { client: 'claude-code', hostSessionId: 'host-1', cwd: project, room: room.id, mailboxSessionId: me.sessionId } });
  mailbox.acquireResource(me, 'publish', 'productcontent 2.9.118');
  assert.equal(run('grunt release:productcontent').status, 0);
});

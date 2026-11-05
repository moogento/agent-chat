import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentType, sessionName, sessionRepo, NAME_LIMIT } from '../lib/session-name.mjs';
import { createMailbox } from '../lib/mailbox.mjs';
import { createServer } from '../agent-chat.mjs';
import { createPresence } from '../lib/presence.mjs';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-names-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'm2-moo');
  fs.mkdirSync(cwd);
  const mailbox = createMailbox({ home: path.join(directory, 'mailbox'), cwd });
  return { directory, cwd, mailbox };
}

test('canonical names show agent, repository and recognizable title', () => {
  for (const [client, expected] of [['codex-mcp-client', 'codex'], ['claude-code', 'claude'], ['opencode', 'opencode'], ['unrecognized', 'unknown']]) {
    assert.equal(agentType(client), expected);
    assert.equal(sessionName({ client, repo: '/repos/m2-moo', title: 'Review and merge PR 4649' }), `${expected}-m2moo-reviewandmergepr4649`);
  }
  assert.equal(sessionName({ client: 'claude', repo: '/repos/ReplyRabbit', title: 'Réview code & plugin options!' }), 'claude-replyrabbit-reviewcodepluginoptions');
});

test('full identifiers are idempotent and unknown titles have a stable explicit fallback', () => {
  const args = { client: 'codex', repo: '/repos/m2-moo', sessionId: 'stable-session' };
  const name = sessionName({ ...args, title: 'Review PR 4649' });
  assert.equal(sessionName({ ...args, title: name }), name);
  const fallback = sessionName(args);
  assert.match(fallback, /^codex-m2moo-untitled-[a-f0-9]{6}$/);
  assert.equal(sessionName(args), fallback);
  assert.notEqual(sessionName({ ...args, sessionId: 'another-session' }), fallback);
  assert.equal(sessionName({ ...args, title: '日本語' }), fallback);
  assert.equal(sessionName({ ...args, title: 'x'.repeat(256) }).length, NAME_LIMIT);
});

test('nested directories and Git worktrees keep the parent repository name', t => {
  const { directory, cwd } = fixture(t);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  const nested = path.join(cwd, 'src'); fs.mkdirSync(nested);
  const worktree = path.join(directory, 'pr-4649-review');
  git('worktree', 'add', '--detach', worktree);
  assert.equal(fs.realpathSync.native(sessionRepo(nested)), fs.realpathSync.native(cwd));
  assert.equal(fs.realpathSync.native(sessionRepo(worktree)), fs.realpathSync.native(cwd));
  assert.equal(sessionName({ client: 'codex', cwd: worktree, title: 'Review PR' }), 'codex-m2moo-reviewpr');
});

test('manual rename, host title sync and duplicate sessions retain prefixes and routing', async t => {
  const { mailbox } = fixture(t);
  const first = createServer({ mailbox, roomSpec: 'names', sessionId: 'first' });
  const second = createServer({ mailbox, roomSpec: 'names', sessionId: 'second' });
  t.after(() => { first.stop(); second.stop(); });
  for (const server of [first, second]) {
    server.state.client = 'codex-mcp-client';
    await server.callTool('chat_join', { name: 'Review PR 4649' });
  }
  assert.equal(first.state.identity.name, 'codex-m2moo-reviewpr4649');
  assert.equal(second.state.identity.name, 'codex-m2moo-reviewpr4649-2');
  await first.callTool('chat_send', { to: second.state.identity.name, text: 'before rename' });
  const old = second.state.identity.name;
  await second.callTool('chat_rename', { name: 'Review code and plugin options' });
  assert.equal(second.state.identity.name, 'codex-m2moo-reviewcodeandpluginoptions');
  await first.callTool('chat_send', { to: old, text: 'old handle still works' });
  assert.match(await second.callTool('chat_read'), /before rename[\s\S]*old handle still works/);
  const peer = second.state.identity;
  mailbox.syncSessionTitle({ room: peer.room, sessionId: peer.sessionId, client: peer.client, cwd: peer.cwd, title: 'Host changed' });
  assert.equal(mailbox.getIdentity(peer).name, peer.name, 'explicit title remains pinned');
});

test('host presence and bound automatic titles use the same canonical identifier', t => {
  const { mailbox, cwd } = fixture(t);
  const presence = createPresence({ home: mailbox.home });
  const host = presence.registerHost({ client: 'opencode', hostSessionId: 'host', cwd, title: 'Review code' });
  const room = mailbox.resolveRoom('names');
  const peer = mailbox.claimIdentity(room, 'legacy-random-123456', 'opencode', 'peer');
  mailbox.appendMessage(room, 'sender', peer.name, 'queued before title sync');
  const updated = mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, client: peer.client, cwd, title: 'Review code' });
  assert.equal(host.name, 'opencode-m2moo-reviewcode');
  assert.equal(updated.name, host.name);
  assert.equal(mailbox.takeUnread(updated).messages[0].text, 'queued before title sync');
  assert.equal(mailbox.resolveRecipient(room, peer.name).sessionId, peer.sessionId);
});

test('title shorthand is accepted only when one repository matches and never overrides an alias', t => {
  const { mailbox, cwd } = fixture(t);
  const room = mailbox.resolveRoom('names');
  const one = mailbox.claimIdentity(room, 'codex-m2moo-review', 'codex', 'one');
  assert.equal(mailbox.resolveRecipient(room, 'review').sessionId, one.sessionId);
  const other = path.join(path.dirname(cwd), 'replyrabbit'); fs.mkdirSync(other);
  const secondMailbox = createMailbox({ home: mailbox.home, cwd: other });
  secondMailbox.claimIdentity(room, 'claude-replyrabbit-review', 'claude', 'two');
  assert.equal(mailbox.resolveRecipient(room, 'review'), null);
  const legacy = mailbox.claimIdentity(room, 'review', 'codex', 'legacy');
  mailbox.claimIdentity(room, 'renamed-legacy', 'codex', legacy.sessionId);
  assert.equal(mailbox.resolveRecipient(room, 'review').sessionId, legacy.sessionId);
});

// Administrative migration uses the same owner-preserving, alias-aware title path.
test('an explicit owner-requested title replacement preserves the active process and routing', t => {
  const { mailbox, cwd } = fixture(t);
  const room = mailbox.resolveRoom('names');
  const peer = mailbox.claimIdentity(room, 'legacy-truncated-title', 'codex', 'active-session', { nameSource: 'explicit' });
  mailbox.appendMessage(room, 'sender', peer.name, 'pending');
  const updated = mailbox.syncSessionTitle({ room, sessionId: peer.sessionId, client: peer.client, cwd,
    title: 'Standardize session identifiers', replaceExplicitTitle: true });
  assert.equal(updated.name, 'codex-m2moo-standardizesessionidentifiers');
  assert.equal(updated.pid, peer.pid);
  assert.equal(updated.sessionId, peer.sessionId);
  assert.equal(updated.nameSource, 'explicit');
  assert.equal(mailbox.resolveRecipient(room, peer.name).sessionId, peer.sessionId);
  assert.equal(mailbox.takeUnread(updated).messages[0].text, 'pending');
});

test('held locks show the current canonical owner after a title change', t => {
  const { mailbox, cwd } = fixture(t);
  const room = mailbox.resolveRoom('names');
  const owner = mailbox.claimIdentity(room, 'random-owner-123456', 'codex', 'lock-owner');
  const other = mailbox.claimIdentity(room, 'other', 'claude', 'other');
  const original = mailbox.acquireResource(owner, 'runtime', 'update runtime').record;
  const renamed = mailbox.syncSessionTitle({ room, sessionId: owner.sessionId, client: owner.client, cwd, title: 'Review PR 4649' });
  const lock = mailbox.heldLock('runtime');
  assert.equal(lock.name, renamed.name);
  assert.equal(lock.sessionId, original.sessionId);
  assert.equal(lock.expiresAt, original.expiresAt);
  assert.equal(mailbox.listLocks()[0].name, renamed.name);
  assert.throws(() => mailbox.acquireResource(other, 'runtime', 'another update'), /held by codex-m2moo-reviewpr4649/);
  assert.equal(mailbox.releaseResource(renamed, 'runtime').released, true);
});

test('unknown punctuation recipients never resolve to an untitled session', t => {
  const {mailbox,cwd}=fixture(t), room=mailbox.resolveRoom('names');
  const peer=mailbox.claimIdentity(room,sessionName({client:'codex',cwd,sessionId:'untitled'}),'codex','untitled');
  assert.equal(mailbox.resolveRecipient(room,'---'),null);
  assert.equal(mailbox.resolveRecipient(room,'レビュー'),null);
  assert.equal(mailbox.resolveRecipient(room,peer.name).sessionId,peer.sessionId);
});

test('full identifiers normalize punctuation and cannot omit the title', () => {
  const args={client:'codex',repo:'m2moo',sessionId:'same'};
  assert.equal(sessionName({...args,title:'codex-m2moo-Review-PR-4649'}),'codex-m2moo-reviewpr4649');
  assert.match(sessionName({...args,title:'codex-m2moo-'}),/^codex-m2moo-untitled-[a-f0-9]{6}$/);
});

test('automatic title sync caps legacy runtimes and a reconnect enables long names', t => {
  const {mailbox,cwd}=fixture(t), room=mailbox.resolveRoom('names');
  let peer=mailbox.claimIdentity(room,'legacy','opencode','legacy-runtime');
  const file=path.join(mailbox.roomPath(room),'peers',`${peer.name}.json`);
  const stored=JSON.parse(fs.readFileSync(file));delete stored.nameLimit;fs.writeFileSync(file,JSON.stringify(stored));
  const input={room,sessionId:peer.sessionId,client:peer.client,cwd,title:'Review code and plugin options in a long session'};
  peer=mailbox.syncSessionTitle(input);
  assert.equal(peer.nameLimit,40);assert.equal(peer.name.length,40);
  mailbox.updatePeer(peer,{task:'still active'});
  peer=mailbox.claimIdentity(room,peer.name,peer.client,peer.sessionId);
  assert.equal(peer.nameLimit,120);
  peer=mailbox.syncSessionTitle(input);assert.ok(peer.name.length>40);
});

test('canonical pinned handles survive missing worktrees and Git', t => {
  const {mailbox,cwd}=fixture(t),room=mailbox.resolveRoom('names');
  const peer=mailbox.claimIdentity(room,'codex-m2moo-review','codex','pinned',{nameSource:'explicit'});
  fs.rmSync(cwd,{recursive:true});
  const updated=mailbox.syncSessionTitle({room,sessionId:peer.sessionId,client:peer.client,cwd,title:'Different host title'});
  assert.equal(updated.name,peer.name);
});

test('a unique title shorthand can still target a released session', t => {
  const {mailbox}=fixture(t),room=mailbox.resolveRoom('names');
  const peer=mailbox.claimIdentity(room,'codex-m2moo-review','codex','released');
  mailbox.releaseIdentity(peer);
  assert.equal(mailbox.resolveRecipient(room,'review').sessionId,peer.sessionId);
});

test('bare repository worktrees and symlinked directories use the repository identity', t => {
  const {directory,cwd}=fixture(t);
  const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('-C',cwd,'init','-q');
  git('-C',cwd,'-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture');
  const bare=path.join(directory,'parent.git');git('clone','--bare',cwd,bare);
  const worktree=path.join(directory,'pr-1');git('--git-dir',bare,'worktree','add','--detach',worktree);
  assert.equal(sessionName({client:'codex',cwd:worktree,title:'Review'}),'codex-parent-review');
  const link=path.join(directory,'different-name');
  fs.symlinkSync(cwd,link,process.platform==='win32'?'junction':'dir');
  assert.equal(sessionName({client:'codex',cwd:link,title:'Review'}),'codex-m2moo-review');
});

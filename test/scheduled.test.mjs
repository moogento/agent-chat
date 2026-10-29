import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isScheduledHook } from '../hooks/scheduled.mjs';

function fixture(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript_path = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript_path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { transcript_path };
}
const meta = source => ({ type: 'session_meta', payload: { thread_source: source } });
const turn = (trigger, id = 'turn') => ({ type: 'event_msg', payload: { type: 'task_started', turn_id: id, turn_attribution: { turn_trigger: trigger } } });

test('cron and heartbeat markers skip, manual triggers and other clients continue', () => {
  for (const kind of ['cron', 'heartbeat']) for (const mode of ['scheduled', 'run_now']) {
    assert.equal(isScheduledHook('codex', { turn_trigger: `automation_${kind}_${mode}` }), true);
  }
  assert.equal(isScheduledHook('codex', { turn_trigger: 'user' }), false);
  assert.equal(isScheduledHook('claude-code', { turn_trigger: 'automation_cron_scheduled' }), false);
  assert.equal(isScheduledHook('codex', { prompt: 'automation_cron_scheduled' }), false);
});
test('automation SessionStart skips before first turn', t => {
  assert.equal(isScheduledHook('codex', fixture(t, [meta('automation')])), true);
});
test('latest turn distinguishes heartbeat from subsequent manual work', t => {
  assert.equal(isScheduledHook('codex', fixture(t, [meta('cli'), turn('automation_heartbeat_scheduled')])), true);
  assert.equal(isScheduledHook('codex', fixture(t, [meta('automation'), turn('automation_heartbeat_scheduled'), turn('user', 'manual')])), false);
});
test('turn id does not confuse current turn with previous manual turn', t => {
  const payload = fixture(t, [meta('automation'), turn('user', 'old')]);
  assert.equal(isScheduledHook('codex', { ...payload, turn_id: 'new' }), true);
});
test('large tool output and partial trailing records do not hide trigger', t => {
  const payload = fixture(t, [meta('cli'), turn('automation_heartbeat_scheduled'), { type: 'response_item', payload: 'x'.repeat(200000) }]);
  fs.appendFileSync(payload.transcript_path, '{"partial":');
  assert.equal(isScheduledHook('codex', payload), true);
});
test('missing, invalid and symlink metadata preserve normal hooks', t => {
  assert.equal(isScheduledHook('codex', { transcript_path: '/nonexistent/rollout.jsonl' }), false);
  const payload = fixture(t, []);
  fs.writeFileSync(payload.transcript_path, 'invalid\n');
  assert.equal(isScheduledHook('codex', payload), false);
  const link = payload.transcript_path + '.link';
  fs.symlinkSync(payload.transcript_path, link);
  assert.equal(isScheduledHook('codex', { transcript_path: link }), false);
});
test('notification, idle-watch and guard entry points exit silently before loading runtime', () => {
  for (const args of [[], ['idle-watch'], ['codex-idle-watch'], ['guard']]) {
    const payload = JSON.stringify({ turn_trigger: 'automation_cron_scheduled' });
    const result = spawnSync(process.execPath, ['hooks/notify.mjs', 'codex', ...args], {
      cwd: new URL('..', import.meta.url), input: payload, encoding: 'utf8',
      env: { ...process.env, AGENT_CHAT_NOTIFY_CONFIG: '/not-used', AGENT_CHAT_IDLE_WATCH_PAYLOAD: payload, AGENT_CHAT_NOTIFY_DEBUG: '1' }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

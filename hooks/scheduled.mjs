import fs from 'node:fs';
import path from 'node:path';

const scheduledTrigger = value => typeof value === 'string'
  && /^automation_(?:cron|heartbeat)_(?:scheduled|run_now)$/.test(value);

// Use host metadata, never prompt text, to distinguish scheduled work.
export function isScheduledHook(client, payload) {
  if (client !== 'codex' || !payload) return false;
  const trigger = payload.turn_attribution?.turn_trigger ?? payload.turn_trigger;
  if (typeof trigger === 'string') return scheduledTrigger(trigger);
  if (typeof payload.transcript_path !== 'string' || !path.isAbsolute(payload.transcript_path)) return false;
  let fd;
  try {
    fd = fs.openSync(payload.transcript_path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return false;
    // Search backwards so a manual turn after a heartbeat restores normal hooks.
    let position = stat.size;
    let remainder = '';
    while (position > 0) {
      const length = Math.min(position, 64 * 1024);
      position -= length;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, position);
      const lines = (buffer.toString('latin1') + remainder).split('\n');
      remainder = position > 0 ? lines.shift() : '';
      for (const line of lines.reverse()) {
        let record;
        try { record = JSON.parse(Buffer.from(line, 'latin1').toString('utf8')); } catch { continue; }
        if (record.type === 'event_msg' && record.payload?.type === 'task_started') {
          const turn = record.payload;
          if (payload.turn_id && turn.turn_id !== payload.turn_id) continue;
          const value = turn.turn_attribution?.turn_trigger;
          if (typeof value === 'string') return scheduledTrigger(value);
        }
        if (record.type === 'session_meta') return record.payload?.thread_source === 'automation';
      }
    }
  } catch { /* Missing or unreadable metadata preserves normal hook behavior. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return false;
}

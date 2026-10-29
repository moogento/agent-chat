#!/usr/bin/env node
// PreToolUse guard: exit 2 blocks the tool call and returns stderr to the agent.
const MAX_INPUT = 1024 * 1024;
const client = process.argv[2];
try {
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT) throw new Error('hook payload exceeds 1 MiB');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const { isScheduledHook } = await import('./scheduled.mjs');
  if (isScheduledHook(client, payload)) process.exit(0);
  const { guardDecision } = await import('../lib/guards.mjs');
  const decision = await guardDecision({ client, payload });
  if (!decision.allow) {
    process.stderr.write(`${decision.reason}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  // A payload this hook cannot read names no command to guard.
  if (process.env.AGENT_CHAT_NOTIFY_DEBUG === '1') process.stderr.write(`agent-chat guard: ${error.message}\n`);
}

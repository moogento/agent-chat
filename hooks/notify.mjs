#!/usr/bin/env node
const MAX_INPUT = 1024 * 1024;
const client = process.argv[2];
// A disabled optional hook should not parse a tool result or load mailbox code.
if (!process.env.AGENT_CHAT_NOTIFY_CONFIG && process.env.AGENT_CHAT_NOTIFY_DEBUG !== '1') process.exit(0);
try {
  const { commandIdentity, runCommandHook } = await import('./notifications.mjs');
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT) throw new Error('hook payload exceeds 1 MiB');
    chunks.push(chunk);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const identity = commandIdentity(client, payload);
  if (process.env.AGENT_CHAT_NOTIFY_DEBUG === '1' && identity) {
    process.stderr.write(`agent-chat hook identity: ${JSON.stringify(identity)}\n`);
  }
  const result = await runCommandHook({ client, payload, mode: process.argv[3], write: value => new Promise((resolve, reject) => {
    process.stdout.write(value, error => error ? reject(error) : resolve());
  }) });
  // asyncRewake hooks wake an idle Claude session only on exit code 2.
  if (result?.wake) process.exitCode = 2;
} catch (error) {
  // Optional notifications never block a host operation or expose tool payloads.
  if (process.env.AGENT_CHAT_NOTIFY_DEBUG === '1') process.stderr.write(`agent-chat hook: ${error.message}\n`);
}

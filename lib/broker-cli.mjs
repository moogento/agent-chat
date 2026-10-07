import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createBroker } from './broker.mjs';

export async function brokerCli(argv = []) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, strict: true, options: { host: { type: 'string' }, port: { type: 'string' }, home: { type: 'string' }, 'token-file': { type: 'string' }, 'lease-ms': { type: 'string' }, 'max-sessions': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log('agent-chat broker --token-file PATH [--host 127.0.0.1] [--port 47321] [--home PATH] [--lease-ms 30000] [--max-sessions 128]'); return; }
  const options = { tokenFile: values['token-file'] || process.env.AGENT_CHAT_BROKER_TOKEN_FILE, home: path.resolve(values.home || process.env.AGENT_CHAT_BROKER_HOME || path.join(os.homedir(), '.agent-chat-broker')), host: values.host || '127.0.0.1', port: Number(values.port ?? 47321), leaseMs: Number(values['lease-ms'] ?? 30000), maxSessions: Number(values['max-sessions'] ?? 128) };
  let broker;
  const deadline = Date.now() + 11000;
  for (;;) { try { broker = await createBroker(options); break; } catch (error) { if (error.status !== 409 || Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 250)); } }
  process.stderr.write(`Agent Chat broker listening at ${broker.url}\n`);
  const stop = () => { void broker.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return broker;
}

// Entry point for the standalone OpenCode adapter. scripts/build-opencode.mjs bundles
// this file into integrations/opencode/agent-chat.standalone.mjs, and the installer copies
// that bundle into a project after replacing the placeholders below. The OpenCode desktop
// runtime cannot import files outside its own bundle, so the copied adapter must have no
// filesystem imports at all.
import os from 'node:os';
import path from 'node:path';
import { AgentChatPlugin } from './agent-chat.mjs';

const embeddedNotifyConfig = '__AGENT_CHAT_NOTIFY_CONFIG__';
const embeddedEnv = '__AGENT_CHAT_EMBEDDED_ENV__';

function resolvedEnv() {
  const configured = process.env.AGENT_CHAT_NOTIFY_CONFIG;
  const notifyConfig = configured && configured.trim()
    ? configured
    : embeddedNotifyConfig.startsWith('__')
      ? path.join(os.homedir(), '.agent-chat', 'notifications.json')
      : embeddedNotifyConfig;
  const extra = embeddedEnv.startsWith('__') ? {} : JSON.parse(embeddedEnv);
  return { ...process.env, ...extra, AGENT_CHAT_NOTIFY_CONFIG: notifyConfig };
}

export const AgentChat = async context => AgentChatPlugin(context, { env: resolvedEnv() });

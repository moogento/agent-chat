import os from 'node:os';
import path from 'node:path';
import { notifySession, supportedSessionTitle, syncBoundSessionTitle, registerHostPresence, notifyHostInvitations } from '../../hooks/notifications.mjs';
import { CHAT_LABEL } from '../../lib/presentation.mjs';

/** OpenCode local plugin. No session.prompt, prompt_async, or peer replies. */
export const AgentChatPlugin = async ({ client, directory }, options = {}) => {
  const env = options.env ?? process.env;
  const mailbox = options.mailbox;
  const remoteInspector = options.remoteInspector;
  const titles = new Map();
  const childSessions = new Set();
  const syncTitle = sessionID => {
    const title = titles.get(sessionID);
    return title ? syncBoundSessionTitle({ client: 'opencode', hostSessionId: sessionID, cwd: directory,
      ...title, env, mailbox, remoteInspector }) : undefined;
  };
  const notify = (sessionID, deliver) => notifySession({ client: 'opencode', hostSessionId: sessionID,
    cwd: directory, env, mailbox, remoteInspector, deliver });
  const safely = async operation => {
    try { await operation(); } catch (error) {
      if (env.AGENT_CHAT_NOTIFY_DEBUG === '1') console.error(`agent-chat OpenCode hook: ${error.message}`);
    }
  };
  return {
    'tool.execute.after': async (input, output) => {
      if (typeof input?.sessionID !== 'string' || childSessions.has(input.sessionID) || typeof output?.output !== 'string') return;
      await registerHostPresence({ client: 'opencode', hostSessionId: input.sessionID, cwd: directory,
        activity: 'working', env, mailbox });
      await safely(() => syncTitle(input.sessionID));
      await safely(() => notifyHostInvitations({ client: 'opencode', hostSessionId: input.sessionID,
        cwd: directory, env, mailbox, deliver: async notice => { output.output += `\n\n[${notice}]`; } }));
      await safely(() => notify(input.sessionID, async notice => { output.output += `\n\n[${notice}]`; }));
    },
    event: async ({ event } = {}) => {
      if (event?.type === 'message.updated') {
        const info = event.properties?.info;
        const sessionID = event.properties?.sessionID || info?.sessionID;
        if (typeof sessionID === 'string' && !childSessions.has(sessionID) && info?.role === 'assistant'
          && typeof info.providerID === 'string' && typeof info.modelID === 'string') {
          await registerHostPresence({ client: 'opencode', hostSessionId: sessionID, cwd: directory,
            model: `${info.providerID}/${info.modelID}`, variant: info.variant, activity: 'working', env, mailbox });
        }
        return;
      }
      // OpenCode documents these events as properties.info: Session (id, title).
      // Keep a bounded cache so a title seen before manual binding can sync on the next tool.
      if (['session.created', 'session.updated'].includes(event?.type)) {
        const info = event.properties?.info;
        if (typeof info?.id !== 'string' || !info.id || info.id.length > 256) return;
        if (info.parentID) {
          titles.delete(info.id);
          childSessions.delete(info.id);
          childSessions.add(info.id);
          if (childSessions.size > 100) childSessions.delete(childSessions.values().next().value);
          return;
        }
        if (childSessions.has(info.id)) return;
        const title = supportedSessionTitle(info?.title);
        if (title) {
          titles.delete(info.id);
          titles.set(info.id, { sessionTitle: title, titleSource: `opencode:${event.type}` });
          if (titles.size > 100) titles.delete(titles.keys().next().value);
          await safely(() => syncTitle(info.id));
        }
        await registerHostPresence({ client: 'opencode', hostSessionId: info.id, cwd: directory, title,
          activity: 'idle', env, mailbox });
        return;
      }
      if (event?.type === 'session.deleted' && typeof event.properties?.info?.id === 'string') {
        const { createPresence } = await import('../../lib/presence.mjs');
        if (env.AGENT_CHAT_NOTIFY_CONFIG) createPresence({ home: mailbox?.home || env.AGENT_CHAT_HOME || path.join(os.homedir(), '.agent-chat') }).endHost({ client: 'opencode', hostSessionId: event.properties.info.id });
        return;
      }
      if (event?.type !== 'session.idle' || typeof event.properties?.sessionID !== 'string' || childSessions.has(event.properties.sessionID)) return;
      await registerHostPresence({ client: 'opencode', hostSessionId: event.properties.sessionID, cwd: directory,
        activity: 'idle', env, mailbox });
      if (env.AGENT_CHAT_NOTIFY_DEBUG === '1') console.error(`agent-chat hook identity: ${JSON.stringify({ client: 'opencode', hostSessionId: event.properties.sessionID, cwd: directory })}`);
      const deliver = async notice => {
        if (typeof client?.tui?.showToast !== 'function') throw new Error('OpenCode TUI toast API unavailable');
        const result = await client.tui.showToast({ signal: AbortSignal.timeout(1500),
          body: { title: CHAT_LABEL, message: notice, variant: 'info', duration: 6000 } });
        if (result?.error || result?.data === false || result === false) throw new Error('OpenCode rejected toast');
      };
      await safely(() => notifyHostInvitations({ client: 'opencode', hostSessionId: event.properties.sessionID,
        cwd: directory, env, mailbox, channel: 'toast', deliver }));
      await safely(() => notifySession({ client: 'opencode', hostSessionId: event.properties.sessionID,
        cwd: directory, env, mailbox, remoteInspector, channel: 'toast', deliver }));
    },
  };
};

import { notifySession, supportedSessionTitle, syncBoundSessionTitle, registerHostPresence, notifyHostInvitations } from '../../hooks/notifications.mjs';
import { CHAT_LABEL } from '../../lib/presentation.mjs';

/** OpenCode local plugin. No session.prompt, prompt_async, or peer replies. */
export const AgentChatPlugin = async ({ client, directory }, options = {}) => {
  const env = options.env ?? process.env;
  const mailbox = options.mailbox;
  const remoteInspector = options.remoteInspector;
  const titles = new Map();
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
      if (typeof input?.sessionID !== 'string' || typeof output?.output !== 'string') return;
      await safely(() => syncTitle(input.sessionID));
      await safely(() => notifyHostInvitations({ client: 'opencode', hostSessionId: input.sessionID,
        cwd: directory, env, mailbox, deliver: async notice => { output.output += `\n\n[${notice}]`; } }));
      await safely(() => notify(input.sessionID, async notice => { output.output += `\n\n[${notice}]`; }));
    },
    event: async ({ event } = {}) => {
      // OpenCode documents these events as properties.info: Session (id, title).
      // Keep a bounded cache so a title seen before manual binding can sync on the next tool.
      if (['session.created', 'session.updated'].includes(event?.type)) {
        const info = event.properties?.info;
        const title = supportedSessionTitle(info?.title);
        if (typeof info?.id !== 'string' || !info.id || info.id.length > 256 || !title || info.parentID) return;
        titles.delete(info.id);
        titles.set(info.id, { sessionTitle: title, titleSource: `opencode:${event.type}` });
        if (titles.size > 100) titles.delete(titles.keys().next().value);
        await safely(() => syncTitle(info.id));
        await registerHostPresence({ client: 'opencode', hostSessionId: info.id, cwd: directory, title,
          env, mailbox });
        return;
      }
      if (event?.type !== 'session.idle' || typeof event.properties?.sessionID !== 'string') return;
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

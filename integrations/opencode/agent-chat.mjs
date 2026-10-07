import { notifySession } from '../../hooks/notifications.mjs';
import { CHAT_LABEL } from '../../lib/presentation.mjs';

/** OpenCode local plugin. No session.prompt, prompt_async, or peer replies. */
export const AgentChatPlugin = async ({ client, directory }, options = {}) => {
  const env = options.env ?? process.env;
  const mailbox = options.mailbox;
  const remoteInspector = options.remoteInspector;
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
      await safely(() => notify(input.sessionID, async notice => { output.output += `\n\n[${notice}]`; }));
    },
    event: async ({ event } = {}) => {
      if (event?.type !== 'session.idle' || typeof event.properties?.sessionID !== 'string') return;
      if (env.AGENT_CHAT_NOTIFY_DEBUG === '1') console.error(`agent-chat hook identity: ${JSON.stringify({ client: 'opencode', hostSessionId: event.properties.sessionID, cwd: directory })}`);
      await safely(() => notifySession({ client: 'opencode', hostSessionId: event.properties.sessionID,
        cwd: directory, env, mailbox, remoteInspector, channel: 'toast', deliver: async notice => {
        if (typeof client?.tui?.showToast !== 'function') throw new Error('OpenCode TUI toast API unavailable');
        const result = await client.tui.showToast({ signal: AbortSignal.timeout(1500),
          body: { title: CHAT_LABEL, message: notice, variant: 'info', duration: 6000 } });
        if (result?.error || result?.data === false || result === false) throw new Error('OpenCode rejected toast');
      } }));
    },
  };
};

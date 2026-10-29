import { AgentChatPlugin } from './agent-chat.mjs';

// OpenCode 2.x loads a plugin module as `{ id, setup }` and hands `setup` the V2 server context.
// The adapter below speaks the older hooks shape, so this file is the only place that knows both.
const EVENT_TYPES = ['session.created', 'session.updated', 'session.deleted', 'session.status', 'session.idle', 'message.updated'];

const warn = message => { console.warn(`[agent-chat] ${message}`); };

const disposable = value => {
  if (typeof value === 'function') return value;
  if (value && typeof value.dispose === 'function') return () => value.dispose();
  return () => {};
};

// The runtime re-derives content from (content, output) after the hook, so either field can carry a notice.
const mutableResult = payload => {
  if (payload?.status !== 'completed' || !payload.result) return null;
  if (Array.isArray(payload.result.content)) return { field: 'content', value: { content: payload.result.content } };
  if (typeof payload.result.output === 'string') return { field: 'output', value: { output: payload.result.output } };
  return null;
};

export const createV2Client = ctx => ({
  session: {
    get: async ({ path: { id } }) => ({ data: await ctx.session.get({ sessionID: id }) }),
    // The V2 prompt call starts a turn and may resolve only when that turn ends, so the wake must not be awaited.
    promptAsync: async ({ path: { id }, body }) => {
      const pending = ctx.session.prompt({ sessionID: id, ...body });
      if (pending && typeof pending.then === 'function') {
        pending.then(() => {}, error => warn(`wake prompt failed: ${error?.message || error}`));
      }
      return { data: true };
    },
  },
});

export const createV2Plugin = async (ctx, options = {}) => {
  const directory = ctx?.location?.directory || ctx?.worktree || process.cwd();
  const hooks = await AgentChatPlugin({ client: createV2Client(ctx), directory }, options);
  const cleanups = [
    disposable(await ctx.event.subscribe({ types: EVENT_TYPES }, event => hooks.event({ event }))),
    disposable(await ctx.tool.hook('execute.after', async payload => {
      const target = mutableResult(payload);
      if (!target) return;
      await hooks['tool.execute.after']({ sessionID: payload.sessionID, tool: payload.tool }, target.value);
      payload.result[target.field] = target.value[target.field];
    })),
  ];
  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (error) { warn(`cleanup failed: ${error?.message || error}`); }
    }
  };
};

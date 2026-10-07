# Optional client notifications

These adapters display an inbox hint at supported client lifecycle events. They do not start turns, launch agents, reply to peers, or grant permission to act. The hint contains a message count, never message bodies. Messages remain available to `chat_read`.

| Client | Adapter | Delivery timing |
| --- | --- | --- |
| Codex | `hooks/codex.json` | `SessionStart`, `UserPromptSubmit`, and `PostToolUse` add `hookSpecificOutput.additionalContext` to the next model request. |
| Claude Code | `hooks/claude-code.json` | The same three events add a context reminder. |
| OpenCode | `integrations/opencode/agent-chat.mjs` | `tool.execute.after` appends a hint to the existing tool output. `session.idle` can show a TUI toast. |

An event must occur before a check runs. In particular, a peer message arriving **after OpenCode is already idle** does not trigger a toast. There is no filesystem watcher or idle model wakeup. OpenCode toasts belong to the TUI, rather than being a model message or a session-targeted UI surface. Some tool paths do not emit the after-tool hook. Codex and Claude retain their normal tool results.

Codex plugin lifecycle hooks currently require manual desktop installation and the client's trust review. Other Codex surfaces can use supported user/project hook configuration. Hook support depends on the installed client version. See the [Codex hook guide](https://learn.chatgpt.com/docs/hooks), [OpenAI plugin packaging requirements](https://developers.openai.com/plugins/build/plugins), and [Claude hook reference](https://code.claude.com/docs/en/hooks).

## Bind one conversation

First connect the MCP server using [the README](../README.md). Install the Codex or Claude plugin there, or merge the corresponding hook JSON into your client's existing hook settings. For a user/project hook rather than a plugin, replace `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}` in each command with the absolute checkout path. Keep the client argument (`codex` or `claude-code`). Preserve other hooks and review the resulting commands in your client.

Notification bindings are intentionally explicit. Each matches the **client, host conversation ID, exact working directory, room, and mailbox session ID**. Two conversations in one worktree do not share an inbox. Worktree paths are compared by their canonical directory path, never by the repository root. The adapter resolves the current peer name from the mailbox session, so renamed or suffixed names work.

1. Set `AGENT_CHAT_NOTIFY_CONFIG` to an absolute JSON path in the **hook process environment**, for example `/Users/you/.agent-chat/notifications.json`. If your server uses a custom `AGENT_CHAT_HOME`, supply that same value to the hook. Values in the MCP server's `env` settings do **not** automatically configure hooks.
2. Temporarily set `AGENT_CHAT_NOTIFY_DEBUG=1` for the hook process. A supported event writes `agent-chat hook identity: {"client":...,"hostSessionId":...,"cwd":...}` to the hook's stderr/debug log. This contains no prompts, tool results, or peer messages. OpenCode emits this at `session.idle`. Copy its exact ID and working directory, then turn debug off.
3. In that same conversation, call `chat_join` with your desired room and then `chat_who`. Copy the `Session:` value and `Room id:` value. These identify the running MCP session, rather than the client's host conversation.
4. Run the binding helper from your checkout, replacing the values below:

```sh
node /absolute/path/to/agent-chat/hooks/bind.mjs \
  --config /Users/you/.agent-chat/notifications.json \
  --client codex \
  --host-session HOST_CONVERSATION_ID \
  --cwd /absolute/path/to/worktree \
  --room ROOM_ID_FROM_CHAT_WHO \
  --session MAILBOX_SESSION_FROM_CHAT_WHO
```

Use `--client claude-code` or `--client opencode` for those clients. Within one client, worktree, and endpoint, the helper replaces the same conversation binding or an older binding for the same mailbox session. Bindings for other clients, worktrees, and broker endpoints remain separate. The config is reloaded at each event, so a new binding does not require restarting the client. A missing config, unmatched conversation, missing peer, wrong worktree, or conflicting duplicate bindings produces no notice.

The config retains recent binding history within 100 records and 64 KiB. Each bind records `boundAt`, an epoch-millisecond timestamp. Successful Codex and Claude identity-tool hooks refresh it at most once per hour, so ordinary tool events do not rewrite the config. When a new binding would exceed either limit, the helper evicts the oldest records until it fits, always keeping the new binding. Legacy records without timestamps leave first, in stored order. If an older conversation loses its binding, call `chat_who` to auto-bind again, or rerun the manual helper. OpenCode uses the manual helper.

Stored worktree paths are validated structurally. A deleted or unavailable worktree remains inert and does not disable other bindings; its record may later be evicted with old history. New bindings still require an existing directory, and notices require a matching live host and peer directory. On macOS and Windows, native path canonicalization handles case variants, plus legacy Windows short-name aliases, after checking both paths for symlinks or junctions. Distinct directories on case-sensitive filesystems remain separate. Stored paths are never redirected into another worktree by a replacement link. You may also remove obsolete records manually while hooks are stopped.

For a command hook, an explicit command can configure its own environment, independently of MCP settings:

```text
AGENT_CHAT_NOTIFY_CONFIG="/Users/you/.agent-chat/notifications.json" AGENT_CHAT_NOTIFY_DEBUG=1 node "/absolute/path/to/agent-chat/hooks/notify.mjs" codex
```

This command syntax is for POSIX shells. Use the equivalent environment setup in your Windows host. Update each of the three handler commands consistently. For a desktop app, changing an unrelated terminal's environment does not configure the running app. After inspecting the identity, remove the debug assignment and keep the config assignment. If a custom mailbox home is needed, add `AGENT_CHAT_HOME="/absolute/mailbox"` to the command as well.

## Keep the mailbox session across reconnects

By default, a new MCP process creates a new session ID. A manual binding must then be updated. To retain it, give this one MCP connection a distinct stable `AGENT_CHAT_SESSION`, for example `codex-checkout-review`. Never reuse that value for simultaneous conversations. The core rejects simultaneous processes claiming the same session. Generated IDs are UUIDs; explicit IDs may contain 1 to 128 safe filename characters.

For Codex, set the values on the actual MCP connection in `config.toml`:

```toml
[mcp_servers.agent-chat]
command = "node"
args = ["/absolute/path/to/agent-chat/agent-chat.mjs"]
env = { AGENT_CHAT_SESSION = "codex-checkout-review", AGENT_CHAT_ROOM = "checkout-refactor", AGENT_CHAT_NAME = "reviewer" }
```

For Claude's MCP JSON, put the values under the server's `env` object:

```json
{
  "mcpServers": {
    "agent-chat": {
      "command": "node",
      "args": ["/absolute/path/to/agent-chat/agent-chat.mjs"],
      "env": { "AGENT_CHAT_SESSION": "claude-checkout-review", "AGENT_CHAT_ROOM": "checkout-refactor", "AGENT_CHAT_NAME": "reviewer" }
    }
  }
}
```

For OpenCode, place those variables in the MCP entry's `environment` object shown in the README. Configure the one existing connection, rather than registering a second copy alongside a plugin-bundled server. After joining a different room, rerun the helper with that room ID. The host conversation ID can also change when starting a new conversation.

## Optional structured auto-binding for Codex and Claude

Clients that preserve the complete MCP result in `PostToolUse.tool_response` can bind after a successful `chat_join` or `chat_who`. This is opt-in. Set all three values in the hook environment:

```text
AGENT_CHAT_NOTIFY_CONFIG=/absolute/path/notifications.json
AGENT_CHAT_NOTIFY_AUTO_BIND=1
AGENT_CHAT_NOTIFY_IDENTITY_TOOLS=mcp__agent-chat__chat_join,mcp__agent-chat__chat_who
```

Use the **exact tool names** from your client's tool listing. Claude plugin-bundled names are scoped, so this package's names are `mcp__plugin_agent-chat_agent-chat__chat_join` and `mcp__plugin_agent-chat_agent-chat__chat_who`. Add only the names for your trusted agent-chat connection. The [Claude hook reference](https://code.claude.com/docs/en/hooks#match-mcp-tools) describes the naming rules. Codex names can depend on its registration and normalization, so inspect them rather than guessing.

The adapter accepts only `structuredContent.agentChatIdentity` version 1 from an allowlisted identity tool and verifies the reported mailbox peer and working directory. It never derives a binding from `chat_read`, message text, room summaries, or transcript files. Missing or stripped structured data falls back to the manual binding workflow. This fallback matters for client versions that reshape MCP output. The OpenCode adapter does not auto-bind because its MCP tool wrapper does not promise to preserve this structured field.

## OpenCode local plugin

Create `.opencode/plugins/agent-chat.js` in the project you want to enable:

```js
export { AgentChatPlugin } from "/absolute/path/to/agent-chat/integrations/opencode/agent-chat.mjs";
```

Keep the full agent-chat checkout or extracted package at that path. Copying only the adapter breaks its relative imports. Start OpenCode with the hook config available in its process environment:

```sh
AGENT_CHAT_NOTIFY_CONFIG=/absolute/path/notifications.json \
AGENT_CHAT_NOTIFY_DEBUG=1 opencode
```

After the first turn finishes, read its host identity from the debug output, call `chat_join`/`chat_who`, and run the helper above. Restart without debug when convenient. The plugin reads config on every check. It checks only the session ID delivered by that event and never loops through every configured conversation. Tool-output notices and TUI toasts deduplicate independently, so a toast does not consume the model's later context hint. OpenCode's [plugin guide](https://opencode.ai/docs/plugins/) documents local plugin discovery and lifecycle events; its [SDK guide](https://opencode.ai/docs/sdk/) documents `client.tui.showToast`.

## Limits and verification

Each check scans at most 128 KiB of transcript data, returns at most 10 eligible messages with a 64 KiB payload cap, and produces a fixed count-only hint under 500 characters. The initial check uses a bounded recent tail. It is a hint, not an exact total unread counter. `chat_read` follows its independent cursor and cold-start policy; full older history is available through the transcript CLI. A separate per-binding byte offset and 128 recent message IDs suppress duplicate notices. Hooks inspect the MCP read cursor to skip messages already read, without changing that cursor, peer status, or the transcript. Concurrent checks use a nonblocking lock, and failed host delivery can be retried. A chat_read occurring concurrently with a check can still race with a notice.

State lives under `AGENT_CHAT_HOME/notifications/`. Missing config is a silent no-op. Invalid config, inaccessible storage, or host API failures are also silent in command hooks; enable debug to diagnose them. Command handlers have a five-second host timeout, and OpenCode toast requests use a 1.5-second abort signal. A dead process's lock is reclaimed; a live owner's lock is respected. If a crash leaves an empty lock file or stale `.reclaim` sentinel, remove only that notification lock after confirming no hook owns it. Do not delete MCP read cursors to reset notification hints. Stop hooks and subagent hooks are deliberately excluded.

`node --test "test/hooks*.test.mjs"` checks the documented command payloads, exact binding isolation, bounded history and stale worktrees, macOS and Windows path case variants, deduplication and concurrent events, failed delivery, bounds, read-cursor preservation, structured auto-binding, and OpenCode tool/toast APIs. Broker integration tests use a temporary loopback server. These are automated adapter tests, not live end-to-end acceptance tests of installed client versions. No client config is changed or plugin installed by those tests.

Implementation references checked on 2026-10-07: [Codex schemas and PostToolUse behavior](https://github.com/openai/codex/tree/main/codex-rs/hooks), [Claude hook inputs and output](https://code.claude.com/docs/en/hooks), [OpenCode plugin hook types](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts), [OpenCode session event and toast request types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts), and [OpenCode MCP tool output handling](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts).

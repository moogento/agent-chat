# Optional client notifications

These adapters display an inbox hint at supported client lifecycle events. Ordinary hints do not start turns, launch agents, reply to peers, or grant permission to act. The hint contains a message count, never message bodies. Messages remain available to `chat_read`. An agent can separately opt into a bounded [reply watch](reply-waits.md) for one peer.

When a bound agent gets a hint, it should call `chat_read` itself during that turn. The user should not need to prompt it to check the inbox. A newly installed desktop hook may need a client restart and hook trust review before its first event. For managed installs made with `agent-chat install --hooks`, restart a client that was already running, then call `chat_who` once in the conversation to create its exact local mailbox binding. Manually registered plugins and broker OpenCode connections require the binding steps below. Future matching events check for messages automatically.

| Client | Adapter | Delivery timing |
| --- | --- | --- |
| Codex | `hooks/codex.json` | `SessionStart`, `UserPromptSubmit`, and `PostToolUse` add `hookSpecificOutput.additionalContext` to the next model request. `Stop` marks idle or, for an explicit reply watch, waits in bounded slices and continues the current turn. `SessionEnd` removes presence. |
| Claude Code | `hooks/claude-code.json` | The same three events add a context reminder. `Stop` runs a background idle watcher that wakes the session for a directed message, `SessionEnd` removes presence, and `PostModelSwitch` updates the model. |
| OpenCode | `integrations/opencode/agent-chat.mjs` | `tool.execute.after` appends a hint to the existing tool output. `session.idle` can show a TUI toast. An explicit reply watch may resume the exact idle session through `promptAsync`. |

The lifecycle adapters also register local session presence. Codex and Claude `SessionStart` make a provisional repository and handle discoverable before the first MCP tool call; `Stop` marks activity idle and `SessionEnd` removes ended host presence. The MCP connection itself joins its configured room on initialization. Codex and Claude hooks publish a model only when their payload includes one. OpenCode can publish a model and variant from assistant message events. Claude custom titles and OpenCode titles sync to bound peer handles. Codex hooks do not expose a documented chat title, so Codex `/rename` needs a matching `chat_join(name: "...")` call. Effort and context remaining must be self-reported with `chat_status` when known. No hook clears a conversation after a merge.

For ordinary inbox hints, a lifecycle event must occur before a check runs. A peer message arriving **after OpenCode is already idle** does not trigger an ordinary toast. An explicit reply watch is different: OpenCode checks that watch while its backend stays open, and Codex can continue a current turn from `Stop`. A completed Codex background hook cannot start a new turn. Claude Code is different again: its idle watcher can start a new turn for any directed message, as described below. OpenCode toasts belong to the TUI, rather than being a model message or a session-targeted UI surface. Some tool paths do not emit the after-tool hook. Codex and Claude retain their normal tool results.

Codex plugin lifecycle hooks currently require manual desktop installation and the client's trust review. Other Codex surfaces can use supported user/project hook configuration. Hook support depends on the installed client version. See the [Codex hook guide](https://learn.chatgpt.com/docs/hooks), [OpenAI plugin packaging requirements](https://developers.openai.com/plugins/build/plugins), and [Claude hook reference](https://code.claude.com/docs/en/hooks).

## Managed project installations

If you used `agent-chat install --hooks`, every managed adapter reads exactly `<project>/.agent-chat/notifications.json`. The managed Codex/Claude launchers and OpenCode wrapper override an inherited `AGENT_CHAT_NOTIFY_CONFIG`; pointing that environment variable at another file does not change their binding location. Use the project's bundled helper at `<project>/.agent-chat/runtime/hooks/bind.mjs` and that exact project-local config file.

Managed Codex and Claude hooks already enable auto-binding after trusted structured `chat_join` or `chat_who` results. Managed local OpenCode uses its exact `chat_who` or `chat_join` result and host session ID to bind, even when several sessions share the same project. If those results are unavailable, bind manually as below. Do not create a second plugin wrapper.

1. Enable `AGENT_CHAT_NOTIFY_DEBUG=1` in the process that starts the client or its hooks. For example, start the managed OpenCode client with `AGENT_CHAT_NOTIFY_DEBUG=1 opencode` on a POSIX shell. A supported event prints `agent-chat hook identity` with the client, `hostSessionId`, and `cwd` to the client's hook/debug log. OpenCode prints it at `session.idle`. Copy the exact host ID and working directory, then disable debug. Changing an unrelated terminal's environment does not configure an already running desktop client.
2. In that same conversation, call `chat_join` and `chat_who`. Copy the exact `Room id:` and `Session:` values. The mailbox session is different from the host conversation ID. The host and MCP peer must use the same working directory.
3. Run this command with your project path and the copied values. `--cwd` must be the exact working directory from the debug identity, which can differ from the project root if you launched the client in a subdirectory.

```sh
node /absolute/path/to/project/.agent-chat/runtime/hooks/bind.mjs \
  --config /absolute/path/to/project/.agent-chat/notifications.json \
  --client opencode \
  --host-session HOST_CONVERSATION_ID \
  --cwd /absolute/path/to/exact/working-directory \
  --room ROOM_ID_FROM_CHAT_WHO \
  --session MAILBOX_SESSION_FROM_CHAT_WHO
```

Use `--client codex` or `--client claude-code` for those clients. In broker mode, append `--broker-url` with the exact installed broker origin, for example `--broker-url http://127.0.0.1:47321`, and use the configured explicit broker room shown by `chat_who`. The installed proxy and adapter already share the token path and private broker-session credential directory; the helper does not need or copy the token. Keep the MCP session running while testing notices.

`agent-chat doctor` prints the project-specific helper command, including the broker URL when configured. Replace its host/session placeholders and the local room placeholder with the values above. The adapter reloads the config at each event, so manual binding does not require a restart. The history and delivery limits below apply to managed and manual setups alike.

## Manual connections and plugin registrations

First connect the MCP server using [the README](../README.md). Install the Codex or Claude plugin there, or merge the corresponding hook JSON into your client's existing hook settings. For a user/project hook rather than a plugin, replace `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}` in each command with the absolute checkout path. Keep the client argument (`codex` or `claude-code`). Preserve other hooks and review the resulting commands in your client.

This section applies when you registered the adapters yourself. For a managed project installation, use the exact project-local config and runtime helper above instead of the custom paths below.

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

The config retains recent binding history within 100 records and 64 KiB. Each bind records `boundAt`, an epoch-millisecond timestamp. Successful Codex and Claude identity-tool hooks refresh it at most once per hour; OpenCode does not rewrite an unchanged binding. Ordinary tool events do not rewrite the config. When a new binding would exceed either limit, the helper evicts the oldest records until it fits, always keeping the new binding. Legacy records without timestamps leave first, in stored order. If an older conversation loses its binding, call `chat_who` to auto-bind again, or rerun the manual helper.

Stored worktree paths are validated structurally. A deleted or unavailable worktree remains inert and does not disable other bindings; its record may later be evicted with old history. New bindings still require an existing directory, and notices require a matching live host and peer directory. On macOS and Windows, native path canonicalization handles case variants, plus legacy Windows short-name aliases, after checking both paths for symlinks or junctions. Distinct directories on case-sensitive filesystems remain separate. Stored paths are never redirected into another worktree by a replacement link. You may also remove obsolete records manually while hooks are stopped.

For a command hook, an explicit command can configure its own environment, independently of MCP settings:

```text
AGENT_CHAT_NOTIFY_CONFIG="/Users/you/.agent-chat/notifications.json" AGENT_CHAT_NOTIFY_DEBUG=1 node "/absolute/path/to/agent-chat/hooks/notify.mjs" codex
```

This command syntax is for POSIX shells. Use the equivalent environment setup in your Windows host. Update each of the three handler commands consistently. For a desktop app, changing an unrelated terminal's environment does not configure the running app. After inspecting the identity, remove the debug assignment and keep the config assignment. If a custom mailbox home is needed, add `AGENT_CHAT_HOME="/absolute/mailbox"` to the command as well.

## Keep the mailbox session across reconnects

The configuration examples in this section are for manually registered MCP connections. Do not edit managed entries behind the installer's ownership receipt. Managed Codex/Claude conversations can auto-bind their replacement session; rerun the managed helper for OpenCode or when auto-binding is unavailable.

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

## Idle wake for Claude Code

A Claude Code session that has finished its turn gets no hook events until someone types. Managed Claude installs therefore register the `Stop` hook as a background `asyncRewake` hook (`notify.mjs claude-code idle-watch`). While the bound session is idle, it checks the mailbox every five seconds. When a message addressed to this session arrives, it exits with code 2 and Claude starts a new turn with a short notice to call `chat_read`. The notice asks the agent to stay within the user's task and not to send acknowledgements.

- Only directed messages wake a session. Broadcasts such as room-wide LOCK and UNLOCK notices wait for the session's next event and are then included in the count.
- Each message wakes a session at most once, because the watcher shares the inbox notice record with the other hooks. An expired reply watch wakes it once.
- A session is woken at most six times per hour, so two idle agents cannot keep waking each other.
- A new prompt, a newer `Stop`, or the end of the session retires the previous watcher. The watcher exits on its own after just under two hours; later messages wait for the next event.
- Unbound sessions are not watched. Call `chat_who` once to bind, as usual.
- In broker mode the broker reports which unread messages are directed. An older broker that does not report this never wakes a session.

Codex has no hook that can start a turn from an idle session. Codex keeps the bounded `Stop` reply watch and ordinary inbox notices.

## Optional structured auto-binding for Codex and Claude

Managed project launchers already set these values. The setup below is for manually registered hooks and plugins.

Clients that preserve the complete MCP result in `PostToolUse.tool_response` can bind after a successful `chat_join` or `chat_who`. This is opt-in. Set all three values in the hook environment:

```text
AGENT_CHAT_NOTIFY_CONFIG=/absolute/path/notifications.json
AGENT_CHAT_NOTIFY_AUTO_BIND=1
AGENT_CHAT_NOTIFY_IDENTITY_TOOLS=mcp__agent-chat__chat_join,mcp__agent-chat__chat_who
```

Use the **exact tool names** from your client's tool listing. Claude plugin-bundled names are scoped, so this package's names are `mcp__plugin_agent-chat_agent-chat__chat_join` and `mcp__plugin_agent-chat_agent-chat__chat_who`. Add only the names for your trusted agent-chat connection. The [Claude hook reference](https://code.claude.com/docs/en/hooks#match-mcp-tools) describes the naming rules. Codex names can depend on its registration and normalization, so inspect them rather than guessing.

The adapter accepts only `agentChatIdentity` version 1 from an allowlisted identity tool and verifies the reported mailbox peer and working directory. Codex must supply it as `structuredContent.agentChatIdentity`. Claude Code passes the structured content as a JSON string, so the Claude adapter also accepts a string that parses to an object containing only `agentChatIdentity`.

Claude Code reports the shell's current directory in each hook event, which changes after `cd` or a worktree switch, while the MCP server stays in the directory where the session started. The Claude adapter therefore binds and matches on `CLAUDE_PROJECT_DIR` when it names an existing directory, and falls back to the event's `cwd` otherwise. It never derives a binding from `chat_read`, message text, room summaries, or transcript files. Missing or stripped structured data falls back to the manual binding workflow. This fallback matters for client versions that reshape MCP output. The OpenCode adapter does not auto-bind because its MCP tool wrapper does not promise to preserve this structured field.

## Manual OpenCode local plugin

This is an alternative to the managed OpenCode wrapper. If you used `agent-chat install --clients opencode --hooks`, keep its existing wrapper and use the managed binding steps above; its project-local config path overrides this section's environment example.

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

State lives under `AGENT_CHAT_HOME/notifications/`. Missing config is a silent no-op. Invalid config, inaccessible storage, or host API failures are also silent in command hooks; enable debug to diagnose them. Ordinary command handlers have a five-second host timeout; the optional Codex `Stop` reply watch has a bounded 540-second timeout, and the Claude idle watcher runs for at most two hours per idle period. OpenCode toast requests use a 1.5-second abort signal. A dead process's lock is reclaimed; a live owner's lock is respected. If a crash leaves an empty lock file or stale `.reclaim` sentinel, remove only that notification lock after confirming no hook owns it. Do not delete MCP read cursors to reset notification hints. Subagent hooks do not run the reply watch. See [bounded reply waits](reply-waits.md).

`node --test "test/hooks*.test.mjs"` checks the documented command payloads, exact binding isolation, bounded history and stale worktrees, macOS and Windows path case variants, deduplication and concurrent events, failed delivery, bounds, read-cursor preservation, structured auto-binding, and OpenCode tool/toast APIs. Broker integration tests use a temporary loopback server. These are automated adapter tests, not live end-to-end acceptance tests of installed client versions. No client config is changed or plugin installed by those tests.

Implementation references checked on 2026-10-07: [Codex schemas and PostToolUse behavior](https://github.com/openai/codex/tree/main/codex-rs/hooks), [Claude hook inputs and output](https://code.claude.com/docs/en/hooks), [OpenCode plugin hook types](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts), [OpenCode session event and toast request types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts), and [OpenCode MCP tool output handling](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts).

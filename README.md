# agent-chat

Lets Claude Code and Codex sessions on the same machine send each other messages. One file, no dependencies,
Node 18+.

Both tools load it as an MCP server. Messages go into a shared append-only file under `~/.agent-chat/rooms/`.

## Install

```bash
claude mcp add -s user agent-chat -- node ~/repos/agent-chat/agent-chat.mjs
codex mcp add agent-chat -- node ~/repos/agent-chat/agent-chat.mjs
ln -s ~/repos/agent-chat/agent-chat.mjs ~/.local/bin/agent-chat   # optional CLI
```

For Codex, also add this to `~/.codex/config.toml` so it doesn't prompt you before every call:

```toml
[mcp_servers.agent-chat]
tool_timeout_sec = 120
default_tools_approval_mode = "approve"
```

## Tools the agents get

| Tool | What it does |
| --- | --- |
| `chat_send(text, to?)` | Sends a message to a named agent, or to `all` (the default) |
| `chat_read(wait_seconds?)` | Returns unread messages. Can wait up to 50s for one to arrive |
| `chat_who()` | Shows who is active in the room |
| `chat_rooms()` | Lists rooms with message counts and last activity |
| `chat_join(name?, room?)` | Renames you or moves you to another room |

## Names and rooms

- **Rooms:** by default a session's room is its git repo, so each worktree gets its own room. For a group
  working on one task, every agent joins the same plain room name with `chat_join(room: "checkout-refactor")`
  (or starts with `AGENT_CHAT_ROOM=checkout-refactor`). Messages to `all` reach everyone in the room, and a
  new joiner sees the last 20 messages on their first read. Any number of rooms can run side by side.
- **Names:** a Claude Code session is `claude` and a Codex session is `codex`. If the name is already taken by
  a live session in that room, the newcomer becomes `claude-2`, `claude-3` and so on. Pick a clearer name
  with `chat_join(name: "reviewer")`.
- **Tidying:** a room with no new messages for 7 days is deleted automatically (checked at most once an hour,
  whenever a session starts or `agent-chat rooms` runs). `agent-chat tidy` runs it now.

## Usage

Tell one agent something like:

> Ask codex to review the diff in this worktree via agent-chat, then wait for its reply.

Tell the other one:

> Check agent-chat and do what claude asks, then reply.

MCP is pull-only, so an agent only sees a message when it calls `chat_read`. An agent that is waiting for a
reply calls `chat_read` with `wait_seconds` in a loop.

## CLI for the human

```bash
agent-chat log -f                    # follow this repo's room
agent-chat send --to codex "hi"      # sent as "human"
agent-chat who
agent-chat rooms
agent-chat tidy                      # delete rooms idle for 7+ days now
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_CHAT_NAME` | `claude` / `codex` | Your name |
| `AGENT_CHAT_ROOM` | the git repo | A room name or a directory |
| `AGENT_CHAT_HOME` | `~/.agent-chat` | Where the data is stored |
| `AGENT_CHAT_TTL_DAYS` | `7` | Days without messages before a room is deleted |
| `AGENT_CHAT_MAX_WAIT` | `50` | Longest `chat_read` wait, in seconds. Keep it below the client's tool timeout |

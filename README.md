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
| `chat_join(name?, room?)` | Renames you or moves you to another room |

## Names and rooms

- **Names:** a Claude Code session is `claude` and a Codex session is `codex`. If two sessions of the same kind
  share a room, rename one with `chat_join` or `AGENT_CHAT_NAME`.
- **Rooms:** the room is the session's git repo, so each worktree gets its own room. Pass a plain name to
  `chat_join` (for example `pairing`) or set `AGENT_CHAT_ROOM` to connect sessions in different directories.

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
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_CHAT_NAME` | `claude` / `codex` | Your name |
| `AGENT_CHAT_ROOM` | the git repo | A room name or a directory |
| `AGENT_CHAT_HOME` | `~/.agent-chat` | Where the data is stored |
| `AGENT_CHAT_MAX_WAIT` | `50` | Longest `chat_read` wait, in seconds. Keep it below the client's tool timeout |

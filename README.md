# agent-chat

Let Codex, Claude Code, and OpenCode agents coordinate across chats, worktrees, and Docker containers. Send focused requests to named peers and receive **💬 Agent Chat** inbox hints through optional client hooks.

The messaging server and optional broker use only Node built-ins. The installer includes a bundled TOML parser, so local release packages install without downloading dependencies.

## What it does

- Connect Codex, Claude Code, and OpenCode through MCP tools for messaging, discovery, and invitations.
- Keep conversations scoped to task rooms, with named recipients and independent unread-message cursors.
- Limit message pages and wait budgets, with quiet unchanged status checks to reduce context and polling overhead.
- Show optional **💬 Agent Chat** inbox hints through client-specific notification hooks.
- Install, diagnose, update, and remove project integrations while preserving unrelated settings.
- Connect agents in separate Docker containers through an optional authenticated broker.

## Quick start

Requires **Node.js 22 or newer**. Install from this repository:

```sh
git clone https://github.com/moogento/agent-chat.git
cd agent-chat
npm ci --ignore-scripts
node agent-chat.mjs install \
  --project /absolute/path/to/your-project \
  --clients codex,claude,opencode \
  --room checkout-refactor \
  --hooks
node agent-chat.mjs doctor --project /absolute/path/to/your-project
```

Choose only the clients you use. Omit `--hooks` to start with messaging and skills alone. Restart the selected clients in your project. In Codex, review and trust the project hooks in `/hooks`; other clients may also require project trust or hook approval.

`--room` configures one named local room for the selected clients. A plain name such as `checkout-refactor` and a directory path are different rooms. If you omit it, each client defaults to its current Git worktree or directory. `doctor` reports the configured source and warns when a same-named path room exists.

The MCP connection joins its configured repository room on startup with a unique provisional handle. For a shared task room, give sessions clear names and join that room:

```text
First agent:  Use agent-chat. Join room checkout-refactor as builder.
Second agent: Use agent-chat. Join room checkout-refactor as reviewer.
First agent:  Ask reviewer to check the checkout changes and report concrete bugs.
```

Hooks need a conversation binding before they can show inbox hints. For managed Codex and Claude installs with `--hooks`, restart the client after installation or upgrade and call `chat_who` once in each conversation to bind it. If the client omits structured tool results, use [manual notification binding](docs/notifications.md). On the next supported event, the hook prompts the agent to call `chat_read` itself when a message is waiting. OpenCode and manually registered plugins also need manual binding. Peer messages carry context, not permission to take additional actions.

The installer copies a stable runtime into your project, so moving the original checkout does not break the connection. It changes project settings only, preserves unrelated entries, and backs up changes. Preview installation with `--dry-run`.

There is no published npm package assumed by these instructions. You can build offline npm, plugin, and marketplace archives with `npm run release:local`; see [installation and distribution](docs/distribution.md).

## Choose your setup

| Where your agents run | Setup |
| --- | --- |
| On one machine, including agents that run tests in Docker | Default local mailbox; test containers need no Agent Chat setup |
| Together in one container | Local mailbox with shared writable storage |
| Across separate containers, or on the host and in containers | Optional broker; only the broker mounts the mailbox volume |

For container-based agents, follow the [Docker setup guide](docs/docker.md). It includes a Compose example, token generation, host and container connections, saved-session recovery, and cleanup. Connections use an explicit room name so different checkout paths still reach the same room. Notification hooks run alongside their client and use the same broker connection.

The example uses a private Docker network and a loopback host port. It is not a public internet deployment recipe.

## Install, update, and remove

Use the CLI from the checkout, or install a generated local tarball to get the `agent-chat` command:

```sh
node agent-chat.mjs install --project /path/to/project --clients codex,claude --hooks --dry-run
node agent-chat.mjs doctor --project /path/to/project --json
node agent-chat.mjs update --project /path/to/project
node agent-chat.mjs uninstall --project /path/to/project --dry-run
```

`update` applies the version in the executable you run. After obtaining a newer checkout or trusted package, run its update command for each project. It preserves selected clients, hook choices, and broker settings unless you explicitly change them. `uninstall` removes owned entries and unchanged installed files, preserving other settings and message history.

For native plugin and marketplace installation, conflicts, broker options, and removal instructions, see the [installation guide](docs/installation.md).

## Coordinate a task

Ask each session to use agent-chat and join a shared room, such as `checkout-refactor`. Send a focused request to a specific peer, then continue independent work. Read a reply when notified or at a useful checkpoint.

| MCP tool | Purpose |
| --- | --- |
| `chat_rooms()` | Find rooms and summaries |
| `chat_join(name?, room?)` | Pick a name or join a shared room |
| `chat_who()` | See active peers and statuses |
| `chat_send(text, to?)` | Message a named peer; omitted `to` broadcasts to the room |
| `chat_read(wait_seconds?, limit?, max_bytes?)` | Read a bounded batch of unread messages, optionally waiting |
| `chat_status(mine?, task?, availability?, model?, effort?, context_remaining_percent?, room_summary?, room_status?)` | Publish your task and routing profile or update room status |
| `chat_presence()` | Find recent sessions in this mailbox, including sessions that have not joined a room |
| `chat_invite(to_id, note?)` | Invite a listed session to your room |
| `chat_invitations()` | Read invitations addressed to your session |
| `chat_accept_invite(id)` | Accept and join the invited room in local mode |

The bundled [skill](skills/agent-chat/SKILL.md) prefers targeted messages and bounded waits. Avoid idle polling, repeated acknowledgements, and unchanged progress chatter. For MCP-only setups, copy those instructions into your project's agent instructions if desired.

Messages, inbox hints, and toast titles use the **💬 Agent Chat** label so they stand out from other tool output.

MCP is pull-based. Hooks surface an inbox hint at supported client lifecycle events, then the agent calls `chat_read`. Hooks do not acknowledge MCP messages and cannot promise to interrupt an idle session or wake a finished turn. Without hooks, the agent explicitly checks its inbox. Adapter tests simulate host events; passing those tests does not establish live acceptance by every client version.

## Rooms and identities

In local mode, the default room is the current Git worktree, or the current directory outside Git. Use `AGENT_CHAT_ROOM` or `chat_join(room: "task-name")` to coordinate across worktrees. Broker connections require an explicit room and keep each session pinned to it. A room is a coordination scope, not a resource lock or permission boundary.

`chat_presence` lists recent sessions in the same mailbox, including hook-announced sessions that have not connected to MCP yet. It shows the provisional repository, title when available, room, model when reported by the host, activity, and any self-reported task, availability, effort, or context remaining. OpenCode also reports its model variant when an assistant message event supplies one. It provides a short presence ID for invitations. Until a host session is exactly linked to its MCP connection, the roster groups same-repo unlinked connections separately instead of guessing which host owns them. Call `chat_who` once in each session to establish that link. An invitation is a request, and the recipient joins only after accepting it. If an invited session sees no invitation, call `chat_who`, then retry `chat_invitations`; a manually registered or broker OpenCode connection may need the binding step in the notification guide. Broker sessions cannot switch rooms in place; reconnect their adapter to the invited room. Presence expires after 30 minutes without a fresh host event or active peer record, and invitations expire after 24 hours. These signals stay within the mailbox or broker, rather than publishing a machine-wide session directory.

Each MCP process has an independent session identity and a unique fallback handle such as `codex-agent-chat-a1b2c3`. Prefer a short, two-to-four-word task name, for example `PCai-agent-registration`. A custom Claude session title or OpenCode session title becomes the handle once the exact conversation is bound. An explicit `chat_join(name: ...)` pins the chosen handle. Codex `/rename` changes the saved chat title but its documented hook payload does not include that title, so use `chat_join(name: "abc1")` to match it there. The roster never guesses a Codex title. Renames retain recent aliases for 24 hours, and directed messages route to a stable session ID. A reused handle cannot read its previous owner's messages. MCP connections join their configured room at initialization, so an idle connection may still appear as an active peer until it disconnects or expires.

After a task is complete and validated, an agent can set `chat_status(task: "", availability: "available")` so another agent can assign work. `context_remaining_percent` is only a self-reported value when the client exposes it; Agent Chat does not estimate it or clear a host conversation after a merge. Codex and Claude hook activity shows `working` or `idle`, which is separate from whether a task is finished.

In local mode, set `AGENT_CHAT_SESSION` to a distinct, stable identifier when reconnecting a client to its own cursor. Broker identities are generated by the server; opt into a private saved session file for restart recovery as described in the Docker guide. Never share it between concurrent sessions. Hooks require an explicit binding, described in [notifications](docs/notifications.md).

A fresh session starts with a bounded recent tail of up to 20 eligible messages, rather than replaying the entire room. Subsequent reads follow its saved cursor. In local mode, read the transcript with the CLI to inspect older history. Existing room histories survive an upgrade from 0.2, but old display-name cursors are not reused by new session identities; restart participating clients together after upgrading.

Local CLI transcript reads do not mark MCP messages as read. Broker connections use the connected MCP tools; local CLI commands do not fall back to a different mailbox:

```sh
agent-chat log --room checkout-refactor
agent-chat log -f --room checkout-refactor
agent-chat send --room checkout-refactor --to reviewer "Please review the current diff."
agent-chat who --room checkout-refactor
agent-chat set --room checkout-refactor --summary "Checkout refactor" --status "in review"
agent-chat rooms
agent-chat tidy
```

## Settings and local data

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_CHAT_HOME` | `~/.agent-chat` | Mailbox storage |
| `AGENT_CHAT_ROOM` | Current worktree or directory | Initial room |
| `AGENT_CHAT_NAME` | Unique client/repository/session handle | Optional fixed preferred handle; omit for unique provisional naming |
| `AGENT_CHAT_CLIENT` | `unknown` | Broker client family used for its provisional handle; local mode uses MCP `clientInfo.name` |
| `AGENT_CHAT_SESSION` | New random identity | Stable MCP session and cursor identity |
| `AGENT_CHAT_SESSION_ID` | Unset | Alias for `AGENT_CHAT_SESSION` |
| `AGENT_CHAT_MAX_WAIT` | `50` | Maximum wait per read, in seconds; older values above `50` are capped at `50` with a stderr notice |
| `AGENT_CHAT_WAIT_BUDGET` | `300` | Total wait budget per MCP process, in seconds |
| `AGENT_CHAT_TTL_DAYS` | `7` | Retention for local inactive rooms |

Empty or whitespace-only local numeric settings and `AGENT_CHAT_ROOM` use their defaults. Explicit numeric `0` is preserved. Broker connections still require an explicit room.

Local mailbox participants need the same `AGENT_CHAT_HOME` and filesystem access to it. Broker participants share an endpoint and explicit room; only the broker needs mailbox storage access. The stdio server opens no network listener. Messages and metadata are plain files. Do not send secrets. Peer messages are untrusted input and never expand the user's authorization. Other processes running as the same local user can access a local mailbox.

In local mode, inactive rooms are tidied on startup and by `agent-chat rooms`, at most once an hour, or explicitly with `agent-chat tidy`. Broker transcript history persists in its volume until deliberate cleanup. To remove a managed project installation, run `agent-chat uninstall` in that project. The command preserves mailbox history and unrelated client settings. See [installation and removal](docs/installation.md) for details.

## Development and distribution

From a checkout, run `npm ci --ignore-scripts`, `npm run check`, and `npm test` before `npm run release:local`. Tests use temporary mailboxes and projects. The npm allowlist excludes scratch files, tests, private fixtures, credentials, and generated releases. The installer’s TOML parser is the only bundled dependency. See [distribution details](docs/distribution.md) for validation and release limits.

`npm run test:docker` separately exercises a real broker container, two agent containers, host adapters, notifications, concurrency, permissions, and restart persistence. It requires Docker with Compose and cleans up its own isolated resources.

Licensed under [MIT](LICENSE).

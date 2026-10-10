# Install Agent Chat

The project installer sets up the shared MCP server and coordination skill for the clients you select. Add `--hooks` to install the optional inbox notification adapters. It uses the local package you run and does not contact a registry or modify global client settings.

## From a local release

Requires Node.js 22 or newer. Install the npm tarball, then open your project:

```sh
npm install --global /absolute/path/to/agent-chat-0.8.4.tgz
cd /absolute/path/to/your-project
agent-chat install --clients codex,claude,opencode --hooks
agent-chat doctor
```

The clients are `codex`, `claude`, and `opencode`. Pass a comma-separated list of the ones you use. `--project /absolute/path/to/project` selects a different project; otherwise commands use the current directory. There is no global client installation mode.

To make every selected client in a project start in the same named local room, provide `--room`:

```sh
agent-chat install --clients codex,claude,opencode --hooks --room m2-moo
# For an existing managed installation:
agent-chat update --local --room m2-moo
```

The named room becomes that project's default for the selected clients and their notification adapters. Updates and project moves preserve it. A newly added client inherits the existing local named default when all installed local clients agree on one. If you omit `--room` on a new local installation, the default is derived from the project path. A literal room named `m2-moo` and a room derived from `/absolute/path/to/m2-moo` have different room IDs, so agents in those rooms cannot see each other. Use `chat_who` to compare Room id in each client. Changing the default does not move existing history or a running session; restart affected clients and join the shared room.

If you prefer not to install a global executable, extract `agent-chat-plugin-0.8.4.tgz` and run its CLI directly:

```sh
node /absolute/path/to/agent-chat/agent-chat.mjs install --project /absolute/path/to/project --clients codex,claude,opencode --hooks
node /absolute/path/to/agent-chat/agent-chat.mjs doctor --project /absolute/path/to/project
```

The extracted package contains the installer and its parser. Client connections use the stable project runtime instead of this source directory. The runtime also contains maintenance commands, so moving the extracted package does not break the project installation.

## From a checkout

```sh
git clone https://github.com/moogento/agent-chat.git
cd agent-chat
npm ci --ignore-scripts
node agent-chat.mjs install --project /absolute/path/to/project --clients codex,claude,opencode --hooks
node agent-chat.mjs doctor --project /absolute/path/to/project
```

A source checkout needs `npm ci` once to install the parser. Release archives already bundle it. npm name availability has not been checked; do not substitute an unverified `npx agent-chat` command for these local paths.

## Preview and activate

Preview the same installation without writing files:

```sh
agent-chat install --project /absolute/path/to/project --clients codex,claude,opencode --hooks --dry-run
```

Installation writes only inside the selected project: a stable MCP/hooks runtime under `.agent-chat/runtime/`, ownership metadata in `.agent-chat/install.json`, and the selected clients’ MCP, skill, and optional hook entries. With hooks, it also adds [wake instructions](#wake-instructions) to `CLAUDE.md` or `AGENTS.md`. It validates existing configuration before changing it. Existing entries owned by another setup, malformed files, or edited managed entries can require manual resolution; the installer reports the conflict instead of replacing unrelated configuration.

The installer adds a marked `/.agent-chat/` block to the project's `.gitignore`, preserving existing rules, and keeps an internal ignore guard for private local data. This directory contains local runtime paths, conversation bindings, and transaction backups of configuration files, which can include private settings. Backups under `.agent-chat/backups/` remain available after updates and removal; inspect them if an interrupted transaction needs recovery, and confirm no installer is running before removing a leftover install lock.

If the outer ignore block is completely absent, install or update restores it. Partial, edited, or duplicate markers require manual resolution. The internal private-data ignore guard remains in place. Managed ignore and Codex TOML blocks accept LF or CRLF line endings and preserve unrelated file text.

| Client | MCP configuration | Skill | Optional hooks |
| --- | --- | --- | --- |
| Codex | `.codex/config.toml` | `.agents/skills/agent-chat/` | `.codex/hooks.json` |
| Claude Code | `.mcp.json` | `.claude/skills/agent-chat/` | `.claude/settings.local.json` |
| OpenCode | `opencode.json` | `.opencode/skills/agent-chat/` | `.opencode/plugins/agent-chat.js` |

Existing strict JSON is merged while unrelated values are preserved; its whitespace can be reformatted. JSON comments, trailing commas, or duplicate keys are refused. The installer also refuses an existing OpenCode JSONC configuration rather than silently replacing it with a separate JSON file. Resolve the reported configuration conflict before retrying.

### Wake instructions

When hooks are enabled for a client, the installer also adds a managed "Agent Chat" block to that client's project instruction file:

| Client | Instruction file |
| --- | --- |
| Codex | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| OpenCode | `AGENTS.md` |

The block says a woken agent may call `chat_read` to read messages addressed to it without asking, while their content stays untrusted. Automatic approval reviewers trust only user messages and these files, so this lets them accept the read after a wake notice. See [approval reviewers](notifications.md#approval-reviewers).

The block sits between `<!-- >>> agent-chat managed instructions >>> -->` and `<!-- <<< agent-chat managed instructions <<< -->` markers at the end of the file, with blank lines that Markdown formatters keep as they are. Existing text and its LF or CRLF line endings are preserved, and a new file gets normal readable permissions. Codex and OpenCode share one block in `AGENTS.md`. If `CLAUDE.md` is a symbolic link to the project's `AGENTS.md`, Claude Code shares that block too, even when `AGENTS.md` does not exist yet. A shared block stays while any client that reads it is installed with hooks and wake permission. Without hooks, no block is added, and `--wake-permission` on a client without hooks prints a note saying it needs `--hooks`. Updates replace an unchanged block written by an older version with the current wording. Whenever install or update adds a block to a file or creates the file, it prints a note naming the file and `--no-wake-permission`, so the change does not surprise you in a diff. Updating an installation made before this feature adds the block for clients that already use hooks.

The block is optional, so a problem with it never stops an install, update, or uninstall. The installer skips the block with a warning, leaves the file untouched, and completes the rest of the change when:

- the block was edited, or other Agent Chat instruction markers are already in the file;
- the file is a symbolic link to anything other than the project's other instruction file;
- the file cannot be read as a regular file of at most 1 MiB, for example a directory, a pipe, or a file without read permission;
- the file is not plain UTF-8 text.

If the file already contains the exact block, for example because it was committed from another checkout, the installer adopts it as it is. It never rewrites an adopted block, warns once if a later version uses newer wording, and leaves it in place on removal.

To skip the block, pass `--no-wake-permission` to `install` or `update`. Updates keep that choice; `--wake-permission` adds the block again. Opting out, disabling hooks, or uninstalling the last client that uses a file removes an unchanged block and restores the file's previous text. If you added lines after the block, only the block's own lines are removed. A file the installer created, or recreated after you deleted it, is deleted when nothing else remains in it. A file you create yourself at that path afterwards is kept. If a block cannot be removed because it was edited or the file cannot be read, it is left in place with a warning and stays recorded, so a later update or uninstall can remove it once the file is readable or restored. If you turn wake permission off for one client while another client that reads the same file still uses the block, the block stays and the installer says which client keeps it. Doctor checks the file each client reads now, reports a missing, edited, or skipped block as a warning, and reports an opted-out client that still reads a shared block as information.

Restart your clients in that project. Review any project trust or hook approval requests. In Codex, open `/hooks` and approve Agent Chat's project hooks after reviewing them. Updating a hook definition can require approval again. The installer cannot grant trust on your behalf.

Hooks are optional. To start with MCP and skills only:

```sh
agent-chat install --clients codex,claude,opencode
```

For notifications, follow the [managed project binding steps](notifications.md#managed-project-installations). All managed adapters read exactly `<project>/.agent-chat/notifications.json`; an inherited `AGENT_CHAT_NOTIFY_CONFIG` cannot redirect them. Use `<project>/.agent-chat/runtime/hooks/bind.mjs` with that config path for manual binding. The managed Codex and Claude launchers enable auto-binding from their allowlisted structured `chat_join`/`chat_who` results. Managed local OpenCode binds from an exact `chat_who` or `chat_join` result. Ask the session to call one of those tools after installation. If the host strips the result, use the manual helper. Copy the host conversation ID and exact working directory from hook debug output, and the mailbox `Session:` and `Room id:` from `chat_who`. Broker bindings also require `--broker-url` with the installed origin. Doctor prints the project-specific command. Installing a hook file alone does not prove live client delivery. Ordinary hooks provide inbox hints at supported events. An explicit [reply watch](reply-waits.md) can keep a Codex or Claude turn waiting or resume an idle OpenCode session while that client remains open.

## Check the installation

```sh
agent-chat doctor
agent-chat doctor --project /absolute/path/to/project --json
```

Doctor inspects the local installation, runtime resources, client entries, skills, hooks, and notification setup. It prints findings and actionable next steps without editing files or starting a client. A missing binding, pending client restart, or hook trust requirement can be a warning even when the installed files are healthy. An installation check does not replace a real message round trip between your chosen client versions.

Doctor explains whether each local default is a named room or comes from the project path. It also checks a bounded set of existing room metadata for likely named/path duplicates in the same mailbox and suggests how to align the clients. This check reads no message bodies and creates no rooms; separate mailbox homes or brokers still require an actual cross-client check.

After restarting, ask each agent to use `chat_join` for the same room and `chat_who` to inspect its identity. Send a short targeted message from one to the other, then call `chat_read` in the receiver. Complete the notification guide's binding and check that the receiver gets an inbox hint at its next supported event.

## Update from a newer local package

Install the new trusted tarball first, then apply that executable’s version to the project:

```sh
npm install --global /absolute/path/to/new/agent-chat-0.8.4.tgz
cd /absolute/path/to/your-project
agent-chat update --dry-run
agent-chat update
agent-chat doctor
```

The filename above is the current development version; use the actual filename of the release you received. `update` preserves the installed client selection, hook setting, and wake permission choice unless you provide an explicit selection. `--clients codex,claude` targets those clients, `--hooks` enables their hooks, and `--no-hooks` disables them. `--no-wake-permission` and `--wake-permission` remove or restore the [wake instructions](#wake-instructions). Updating an installation that already has hooks adds the wake instructions unless you opt out. It performs no background update check or download.

Restart affected clients after updating, and review hook trust if prompted. You can run maintenance commands through `node .agent-chat/runtime/agent-chat.mjs` if the original executable is unavailable. That runtime's `update` reapplies its own version; adopting a newer release requires running the newer trusted package executable.

OpenCode automatically discovers `.js` and `.ts` plugins. Updating an older managed OpenCode installation migrates its unmodified `.opencode/plugins/agent-chat.mjs` wrapper to `agent-chat.js`; edited wrappers or an existing unmanaged destination require manual resolution. The shared runtime implementation remains an `.mjs` module. See [OpenCode's loader](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/config/plugin.ts) for the discovery pattern.

## After moving or renaming a project

The receipt and client configuration contain the project's original absolute paths. From the new directory, check and repair the installation:

```sh
node .agent-chat/runtime/agent-chat.mjs doctor
node .agent-chat/runtime/agent-chat.mjs update --dry-run
node .agent-chat/runtime/agent-chat.mjs update
```

You can also use the trusted executable from your installed release. Doctor reports the move without changing files. Update verifies recorded ownership in the current project before rewriting the MCP connections, hook launchers, and OpenCode adapter for all installed clients. Missing owned resources can be restored; edited resources or conflicting managed entries require resolution first. A partial `--clients` update is refused until all installed clients have been relocated. The command does not write to the old project location.

Project-local broker token paths move with the project unless you explicitly provide `--broker-token-file`; external token paths remain unchanged. Restart all installed clients and establish fresh notification bindings after the move. Stored bindings for the old path do not apply to the new directory and can remain safely in bounded history. You can uninstall directly from the new location using the recorded ownership without first updating.

## Remove the managed installation

```sh
agent-chat uninstall --dry-run
agent-chat uninstall
```

Add `--project /absolute/path/to/project` to select another project, or `--clients codex` to remove only one client. The command removes entries it owns and files that still match the recorded installation. It preserves unrelated settings, message history, and changed files or entries it cannot safely remove. When preserved entries still reference the runtime, it keeps their dependencies and reports what needs attention.

Unchanged wake instruction blocks are removed from `CLAUDE.md` and `AGENTS.md`, and a file the installer created is deleted once empty. The shared `AGENTS.md` block stays while Codex, OpenCode, or Claude Code through a `CLAUDE.md` link still uses it, and a block stays while its client is kept because of other edited settings. Edited or unreadable blocks and blocks that existed before installation are left in place with a note.

An edited skill or other file is preserved without keeping its client installed. If no remaining client owns that edited file, uninstall releases its ownership and reports the preserved file; a later update does not restore the removed client. Edited client settings that still reference the runtime retain their dependencies until you resolve them.

Removal retains the ignore block because transaction backups and optional notification or mailbox data remain under `.agent-chat/`. Remove that block only after reviewing or removing the remaining local data.

## Optional broker connection

The default installation uses the local filesystem mailbox. When agents run in separate containers, use one broker instead of mounting its mailbox into every agent. See the [Docker example](docker.md) for starting it and generating a private token.

```sh
agent-chat install --clients codex,claude,opencode --hooks \
  --broker-url http://127.0.0.1:47321 \
  --broker-token-file /absolute/private/path/broker-token \
  --room checkout-refactor
agent-chat doctor
```

The URL, token file path, and explicit room are required together for an initial broker installation. The installer records the path without copying the master token. MCP and notification adapters share the selected transport and private `.agent-chat/broker-sessions/` credentials. Ensure the token file is readable in the environment that starts the client.

Updates preserve each installed client's transport unless you change it. Use `agent-chat update --clients codex --local` to return that client to the local mailbox, restoring its previously selected named local default if present or using the project path. Add `--room m2-moo` to select a new named local default. `--local` also clears inherited broker settings for that client and cannot be combined with broker URL or token options. On an existing broker connection, `--room NAME` alone changes the broker room; use `--local --room NAME` to select a local room instead. When changing broker settings, restart the affected client and establish its notification binding again. Doctor checks local setup and token readability; use an actual message round trip to check broker reachability and permissions.

The optional global npm executable is separate from project installation. Remove project integrations first, then use `npm uninstall --global agent-chat` if you no longer need the command. A previous manual or marketplace installation must be removed through that original method; do not register it alongside a managed MCP connection.

## Advanced: manual connections and plugins

Use these when you deliberately want to manage client configuration yourself. They are alternatives to the project installer and do not share its ownership receipt or update/uninstall behavior. Choose one registration per client to avoid duplicate mailbox sessions.

For MCP-only Codex:

```sh
codex mcp add agent-chat -- node /absolute/path/to/agent-chat/agent-chat.mjs
```

For MCP-only Claude Code:

```sh
claude mcp add --scope user agent-chat -- node /absolute/path/to/agent-chat/agent-chat.mjs
```

For OpenCode, merge an entry into `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-chat": {
      "type": "local",
      "command": ["node", "/absolute/path/to/agent-chat/agent-chat.mjs"],
      "environment": {},
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Omitting `AGENT_CHAT_NAME` gives each MCP session a unique provisional handle. Set it only when you want to pin a fixed handle, and use `chat_join(name: "...")` to match a named host conversation later.

Claude Code can load the full plugin with `claude --plugin-dir /absolute/path/to/agent-chat`. For a persistent marketplace install, extract `agent-chat-marketplace-0.8.4.tgz`, register its `agent-chat-marketplace/` folder with `claude plugin marketplace add PATH` or `codex plugin marketplace add PATH`, then install `agent-chat@agent-chat-local` with the respective client's plugin command. Codex plugin lifecycle hooks currently have narrower surface support than project hooks; see [distribution details](distribution.md).

Official references: [Codex MCP](https://developers.openai.com/codex/mcp/), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Code plugins](https://code.claude.com/docs/en/plugins), and [OpenCode MCP](https://opencode.ai/docs/mcp-servers/).

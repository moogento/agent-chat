# Local distribution

Agent Chat has one CLI/MCP entrypoint, `agent-chat.mjs`, and a mailbox library in `lib/`. Client adapters expose inbox hints; they share the same mailbox implementation. The recommended setup is the [project installer](installation.md), followed by `agent-chat doctor`.

## Artifacts

`npm run release:local` creates these archives in `dist/`. Pass another output directory with `npm run release:local -- /absolute/output/directory`.

| Archive | Layout and use |
| --- | --- |
| `agent-chat-0.9.0.tgz` | npm `package/` layout, for installation from a local tarball and `agent-chat install` |
| `agent-chat-plugin-0.9.0.tgz` | One `agent-chat/` directory with a direct executable, `INSTALL.txt`, portable and client manifests |
| `agent-chat-marketplace-0.9.0.tgz` | One `agent-chat-marketplace/` directory with both marketplace manifests and `plugins/agent-chat/` |
| `SHA256SUMS` | SHA-256 checksums of the three archives |

One npm allowlist feeds all archives, with a generated `INSTALL.txt` added to the plugin copies. The MCP core uses only Node built-ins. The installer bundles one pinned `smol-toml` parser and its BSD-3-Clause license for safe Codex configuration validation and offline installation. Other dependency directories are excluded. There are no automatic npm install scripts. Release construction needs Node.js, npm, and `tar`, and uses temporary staging outside the source tree. Archives include the MIT license and README. `.temp/`, tests, private fixtures, `.env` files, `.git`, and generated archives are excluded.

All archives include the optional built-in broker/proxy modules and [Docker example](docker.md), including its Compose file, restricted build context, token generator, and integration runner. They contain no generated token or mailbox volume. Docker runs from source or extracted releases; it is not needed for the normal local mailbox workflow.

The release script does not publish to a registry, upload an account plugin, register a marketplace, alter client settings, create tags, or install adapters.

The project installer copies a stable runtime into the selected project and records its owned entries and file hashes. `update` uses the package executable's current version, without a network update check. `uninstall` preserves changed files, unrelated settings, and any runtime dependencies still needed by retained entries. These managed commands are separate from the advanced marketplace/plugin route, whose installation is owned by the client.

For parallel verification, pass a unique temporary output directory rather than having multiple processes write the same archive names in `dist/`.

## Client layouts

- Portable metadata lives in root `plugin.json`; `skills/` and `mcp.json` use their fixed portable paths. OpenAI presentation and Codex hooks live in `extensions.com.openai`.
- `.codex-plugin/plugin.json` provides the compatibility manifest, referencing the same skill directory, `mcp.json`, and `hooks/codex.json`.
- `.claude-plugin/plugin.json` references `hooks/claude-code.json`; Claude Code discovers root `.mcp.json` and `skills/`. Its stdio command uses `CLAUDE_PLUGIN_ROOT`.
- OpenCode uses its documented `mcp` configuration and optional adapter in `integrations/opencode/agent-chat.mjs`. Install a local loader as described in [notifications](notifications.md).

Codex's portable stdio command uses `PLUGIN_ROOT`. The MCP server inherits the client's project directory; do not override it with the plugin installation directory. Set `AGENT_CHAT_ROOM` explicitly if your host starts MCP processes elsewhere.

## Validation

`npm test` includes package metadata, packed-file inventory, extracted archives, installed CLI/MCP startup, and an offline tarball install → doctor → update → uninstall workflow. The workflow uses a temporary project, checks that previews and doctor are read only, and verifies unrelated client configuration survives. CI is configured to repeat the suite and release build on Node 22 and 24 across Linux, macOS, and Windows. Check actual workflow results before claiming a release passed every platform.

`npm run test:docker` is a separate real-container suite and CI job. It covers authenticated host/container MCP transport, concurrent messages, broker-backed notifications, volume permissions, and restart/cursor persistence with isolated cleanup. The default suite only checks the Docker example's packaged resources and token generation, so a missing Docker daemon does not block local development.

When Claude Code is available, validate source or extracted manifests with `claude plugin validate /absolute/path/to/agent-chat`. Manifest validation and simulated adapter tests do not prove live notifications. Run a session binding and notification smoke check in each target client version before claiming live support. See [notifications](notifications.md).

## Release checklist

1. Run syntax checks, tests, release construction, and inspect the archives. Verify no local data, credentials, review artifacts, or symlinks were included.
2. Check CI results for the supported Node/platform matrix, then perform live client notification checks separately. Record the exact client versions tested.
3. Review MIT attribution and repository metadata before the first public release.
4. Verify npm package name availability and registry ownership before publishing. Neither is established by a local build. No npm publish or account upload has been performed.
5. Keep local distribution distinct from OpenAI public directory submission. Current submission requirements exclude lifecycle hooks and generally require a remote HTTPS MCP endpoint. This local stdio mailbox package is not prepared for that directory or web-only clients.

## Distribution design

The project setup flow draws on the public [Impeccable installer documentation](https://github.com/pbakaus/impeccable#installation) and [update guidance](https://impeccable.style/faq/): a clear install command, client-specific integration, predictable updates, and explicit host trust steps. Agent Chat's implementation is independent; no Impeccable source was copied. Its managed scope is project-local, and its update command intentionally uses a supplied local version.

## Sources

These official sources informed the layouts; host capabilities can change independently:

- [OpenAI plugin packages and hook limits](https://developers.openai.com/plugins/build/plugins)
- [Claude Code plugin manifests](https://code.claude.com/docs/en/plugins/manifest-reference)
- [Claude Code local plugins](https://code.claude.com/docs/en/plugins)
- [OpenCode MCP configuration](https://opencode.ai/docs/mcp-servers/)
- [OpenCode local plugins](https://opencode.ai/docs/plugins/)

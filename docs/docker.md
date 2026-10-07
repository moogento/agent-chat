# Host and container agents

If Docker runs only your application tests, keep Codex, Claude Code, and OpenCode on the host with the default local mailbox. Test containers do not need Agent Chat or a mailbox mount.

Use the optional broker when the agents themselves run in separate containers or cannot share a filesystem. One broker owns the mailbox volume. Each stdio adapter connects over HTTP, obtains a unique authenticated session, and forwards the same MCP tools. Notification adapters use the same broker and never acknowledge messages.

## Start the example

Requires Node.js 22 or newer, Docker Engine, and Docker Compose. Start from a checkout or extracted release containing `examples/docker/`. The image uses Node 24 Alpine and only the built-in broker/proxy dependencies. The first build may download that public base image.

The following commands generate a token in a private directory and start a uniquely named project:

```sh
export AGENT_CHAT_TOKEN_FILE="$(node examples/docker/create-token.mjs)"
export AGENT_CHAT_COMPOSE_PROJECT="agent-chat-demo-$(date +%s)"
export AGENT_CHAT_IMAGE="$AGENT_CHAT_COMPOSE_PROJECT:local"
export AGENT_CHAT_ROOM=checkout-refactor
docker compose --project-name "$AGENT_CHAT_COMPOSE_PROJECT" --file examples/docker/compose.yaml up --build --detach --wait broker
docker compose --project-name "$AGENT_CHAT_COMPOSE_PROJECT" --file examples/docker/compose.yaml port broker 47321
```

The last command prints `127.0.0.1:47321`. The port is bound only to loopback. Keep the same project name and token path for subsequent commands. Set `AGENT_CHAT_PORT` to a different available port before starting if `47321` is occupied. Keep that port stable when resuming an authenticated session; Docker can reassign ports published as `0` during a restart.

The generated token is never checked in or printed. Its containing directory has permissions `0700`; its file is `0444` so the unprivileged container can read the read-only Compose secret. File-based Compose secrets preserve the host file's permissions. Keep the parent directory private, and do not place the token in a public or shared folder. Generate a separate token for each broker deployment; the master token permits creation of sessions and should be shared only with trusted agents.

The broker runs as UID 1000 and owns the named mailbox volume at `/data`. Agent containers mount only the token and a writable temporary directory, not `/data`. Their root filesystems are read only, capabilities are dropped, and privilege escalation is disabled. The Dockerfile-specific ignore file excludes repository metadata, local settings, mailbox files, and dependencies from the build context.

## Connect a host client

Use the printed port and the generated absolute token path:

```sh
agent-chat install --clients codex,claude,opencode --hooks \
  --broker-url http://127.0.0.1:PORT \
  --broker-token-file "$AGENT_CHAT_TOKEN_FILE" \
  --room "$AGENT_CHAT_ROOM"
agent-chat doctor
```

Select only the clients you use. Restart them and follow their hook trust and [notification binding](notifications.md) steps. Local installation remains the default for projects where you do not select a broker.

For a manually configured stdio client, use `node /absolute/path/to/agent-chat.mjs proxy` with:

| Variable | Purpose |
| --- | --- |
| `AGENT_CHAT_BROKER_URL` | Host URL, or `http://broker:47321` on the Compose network |
| `AGENT_CHAT_BROKER_TOKEN_FILE` | Readable absolute master token path |
| `AGENT_CHAT_ROOM` | Explicit shared room name, independent of container paths |
| `AGENT_CHAT_BROKER_SESSION_DIR` | Private local credential directory shared with that client's hooks |
| `AGENT_CHAT_BROKER_SESSION_FILE` | Optional explicit credential file for resuming one adapter session |

Default MCP startup also selects the proxy when `AGENT_CHAT_BROKER_URL` is set. Broker sessions receive distinct server-generated identities; `AGENT_CHAT_SESSION` does not choose them. Never share an explicit session file between concurrently running adapters. Each client environment needs its own private credential storage, and its hooks must see the same storage. A broker connection must not silently fall back to a separate local mailbox when the broker is unavailable.

Resuming an explicit session file while its adapter is still active fails with a conflict. After an abrupt adapter crash, wait for its lease to expire (30 seconds by default) before retrying. A normal shutdown releases the lease. Without an explicit session file, restarting an adapter creates a fresh session and a bounded recent inbox tail. The broker removes ephemeral session descriptors on close or expiry. A clean proxy shutdown also removes its ephemeral local credentials; a hard crash can leave local credential files for manual cleanup.

If a response is lost during a brief network interruption, the adapter retries once with the same request ID. The broker can return the saved response without repeating a send or consuming an unread message twice. If recovery also fails, check whether the operation completed before retrying manually; reconnect the adapter if reads remain blocked. A capacity rejection explicitly marked as not executed is safe to retry after pending requests finish.

Explicit session files also have a local `.lock`. Linux checks process start time and PID namespace to distinguish a replaced container from its previous adapter. On other platforms, PID reuse can require inspecting and manually removing a stale lock, only after confirming the previous adapter has stopped.

The example's private Docker network and loopback host port use HTTP. This is not a public network deployment recipe. Use a trusted transport with appropriate TLS and access controls when extending beyond this local setup.

## Connect a container client

The `agent` service runs a stdio proxy. Configure your containerized client's MCP command to launch it with stdin open and no TTY:

```sh
docker compose --project-name "$AGENT_CHAT_COMPOSE_PROJECT" --file examples/docker/compose.yaml run --rm --no-deps -T agent
```

Each launch obtains an independent session. The sample uses temporary per-container credentials; add a separate private credential directory for each persistent client if it needs hooks or session resumption across container replacement. Do not mount the broker mailbox into those clients. Your actual client container can use the same environment and secret mount instead of spawning the sample service.

## Restart and clean up

```sh
docker compose --project-name "$AGENT_CHAT_COMPOSE_PROJECT" --file examples/docker/compose.yaml restart broker
docker compose --project-name "$AGENT_CHAT_COMPOSE_PROJECT" --file examples/docker/compose.yaml down
```

The named mailbox volume survives `down`. Sessions created with an explicit `AGENT_CHAT_BROKER_SESSION_FILE` preserve authenticated cursors across a broker restart, with seven days of inactive descriptor retention and a bounded stored-session cap (1024 by default). Ephemeral sessions cannot resume and need fresh notification bindings after reconnecting. Reuse the same project name, stable port, token, and explicit local session credentials when resuming. Broker restarts can take several seconds while ownership locks expire.

Session descriptor retention is separate from message history. The broker does not automatically apply local room cleanup; transcript history remains in its volume until you deliberately remove it.

To delete this example's mailbox history deliberately, use the same command with `down --volumes`. That removes this project's named volume. Project integration removal, mailbox volume deletion, and token deletion are separate actions.

## Run the container integration checks

```sh
npm run test:docker
```

This optional runner creates a unique Compose project, random token, dynamic loopback port, image, and mailbox volume. It tests a host adapter and two container adapters, concurrent targeted messages, real hook counts without message text, non-root volume permissions, authentication rejection, broker restart, and cursor resumption. It cleans up only its own containers, network, volume, image, and temporary credentials. It does not invoke any shared test-environment pool. The default `npm test` remains Docker-independent.

These are real transport and adapter tests. They do not run the Codex, Claude Code, or OpenCode UI, grant hook trust, or prove live client notification acceptance. The separate CI Docker job runs the same integration checks on Linux; check its actual result before claiming CI passed.

References: [Compose startup dependencies](https://docs.docker.com/compose/how-tos/startup-order/), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [build contexts and ignore files](https://docs.docker.com/build/concepts/context/), and [Compose down](https://docs.docker.com/reference/cli/docker/compose/down/).

# Await a peer reply

An agent can opt into a bounded reply watch when it sends a directed request to an active peer:

```text
chat_send(to: "reviewer", text: "Review the checkout change and report concrete issues.", await_reply_minutes: 120)
```

`await_reply_minutes` accepts 1 through 120. It registers one watch for the sending MCP session, its current room, and the recipient's stable session ID. A later directed message from that exact peer satisfies it. Broadcasts, other peers, renamed handles owned by another session, and old messages do not. A new watched request replaces the previous watch for that sending session. The watch stores routing metadata and a deadline, not message bodies. `chat_read` remains the way to receive the reply, and reading the matching reply clears the watch.

Use `chat_wait_status()` to inspect the watch without reading messages. It reports `waiting`, `replied`, `expired`, or `none`. `chat_cancel_wait()` stops it early. Cancel when the task no longer needs the reply, including after a user changes direction. A watch does not authorize new work requested by a peer.

## Automatic continuation

First bind the exact host conversation to its MCP peer with `chat_who`, as described in [notifications](notifications.md). Automatic continuation is available only while the relevant client remains open and its adapter is enabled and trusted.

| Client | When a watched reply arrives |
| --- | --- |
| Codex | An opt-in `Stop` hook waits in bounded slices and continues the current turn with a short instruction to call `chat_read`. It cannot revive a chat after the client closes or the turn is interrupted. |
| Claude Code | The `Stop` hook uses the same bounded current-turn continuation. It asks the agent to call `chat_wait_status` between slices, which avoids Claude's cap on consecutive Stop continuations without tool use. |
| OpenCode | While the backend is running, its plugin checks active watches for an exactly bound idle root session. It calls `session.promptAsync` with a fixed instruction to call `chat_read` when the reply arrives. If OpenCode does not confirm activity, it shows a TUI toast instead of repeatedly prompting. |

Codex and Claude wait hooks do nothing when no watch is active. A waiting turn can make one model continuation per bounded slice, so this opt-in mode can use tokens during a long wait. OpenCode's checks do not invoke the model until a reply or deadline is detected. All three clients stop at the deadline. A connection failure, disabled hook, missing binding, closed client, or unsupported host API means the agent may still need a manual prompt. `chat_wait_status` and `chat_read` remain usable in that case.

The wait is keyed to a specific MCP session. Restarting with a new session identity does not transfer it to a different agent. Broker watches live with the authenticated broker session and require the notification adapter's matching broker credentials. No client should silently start a separate CLI process to resume another client's transcript.

This feature reacts to the actual reply instead of guessing a completion time. An agent can choose a shorter `await_reply_minutes` when the request has a known deadline. Agent Chat does not infer a peer's ETA or keep waiting past two hours.

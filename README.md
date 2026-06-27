# Claude Code harness

OpenClaw plugin — spawn, monitor, stop Claude Code sessions. Hooks auto-installed, state auto-tracked, notifications pushed.

## Breaking changes in 0.8.0

- `targetSessionKey` renamed to `defaultNotifySessionKey`. Update your config.
- `wecomWebhookUrl` removed. Notifications now route to the caller's agent session via OpenClaw's system-event channel; the LLM there composes the user-facing reply.
- `notifyStates` removed. Was never read by code.
- `SessionState.requesterSessionKey` → `notifySessionKey` (+ new `notifyDeliveryContext`). On-disk state files from 0.7.x are forward-compatible: the old field is ignored, missing new fields fall back to `defaultNotifySessionKey`.

## How notifications work

Each tool invocation captures the caller's `sessionKey` and `deliveryContext` from OpenClaw's plugin tool context (via `OpenClawPluginToolFactory`). `claude_code_spawn` stores them on the Claude Code session it creates. When that session later hits a notify state (WAITING / QUESTION / PERMISSION / ERROR / DONE / FATAL), the plugin:

1. Enqueues an `exec completed (claude-code-<id>, code 0) :: ...` system event addressed to the caller's `sessionKey`, with `deliveryContext` attached so OpenClaw routes any reply back through the original channel.
2. Calls `requestHeartbeatNow({source:"hook"})` to wake the caller's session.

The receiving agent sees the event as a background-task-completion prompt, generates a user-visible reply, and OpenClaw delivers it back to the caller (WeCom, Slack, CLI, whatever the original channel was).

**Caveat: `agent:main:main` blocking.** OpenClaw serializes heartbeat runs against a global `main` command lane (`getSize("main") > 0` blocks any wake). If the caller is `agent:main:main` and the user is currently chatting there, notifications queue until the user's next turn. For reliable push, point `defaultNotifySessionKey` at a dedicated session like `agent:notifications:claude-code`.

## Notification architecture

See `docs/openclaw-background-task-notification.md` for a full analysis of OpenClaw's internal notification system (heartbeat wake, system events, ACP spawn, background task patterns).

## Tools

| Tool | What it does |
|------|--------------|
| `claude_code_spawn` | Start a Claude Code session in tmux with task, budget, workdir. Pre-flight checks hooks are configured. |
| `claude_code_status` | List tracked sessions with state, tmux session, last hook event. |
| `claude_code_read` | Capture the current tmux pane contents. |
| `claude_code_send` | Send text or keys to a running session. |
| `claude_code_stop` | Kill a session's tmux pane. |
| `claude_code_restore` | Re-attach to a previous session by `--resume` id. |
| `claude_code_setup_hooks` | Install hook config into a repo (`.claude/settings.local.json` or `shared=true` for `.claude/settings.json`). |

## Configuration

| Field | Default | Purpose |
|-------|---------|---------|
| `defaultNotifySessionKey` | `agent:main:main` | Fallback target session when a tool caller's `sessionKey` is unavailable (e.g. HTTP spawn route, or invocations without an active session context) |
| `permissionMode` | `bypassPermissions` | Claude Code `--permission-mode` for spawn/restore |
| `routePrefix` | `/claude-code` | HTTP route prefix |
| `sessionTimeoutSeconds` | `300` | Idle threshold before FATAL |
| `stateFileDir` | `~/.cache/claude-code-hooks` | Per-session state and debug logs |
| `sendKeysRateLimitPerMinute` | `10` | Rate limit for `/send` route |
| `debugLog` | `false` | Append per-session hook log to `<stateFileDir>/<sessionId>.log` |

## Example config

```json
{
  "plugins": {
    "entries": {
      "claude-code-openclaw-plugin": {
        "enabled": true,
        "config": {
          "defaultNotifySessionKey": "agent:notifications:claude-code",
          "permissionMode": "bypassPermissions"
        }
      }
    },
    "load": {
      "paths": ["/path/to/claude-code-openclaw-plugin"]
    }
  }
}
```

## State machine

| State | Triggered by | Action |
|-------|-------------|-----------|
| `WORKING` | SessionStart, UserPromptSubmit, PostToolUse | none |
| `WAITING` | Stop | exec-completion event + wake |
| `QUESTION` | Elicitation | exec-completion event + wake |
| `PERMISSION` | PermissionRequest | exec-completion event + wake |
| `ERROR` | PostToolUseFailure | exec-completion event + wake |
| `DONE` | SessionEnd | exec-completion event + wake |
| `FATAL` | Idle timeout (`sessionTimeoutSeconds`) | exec-completion event + wake |

## Build

```bash
npm install
npm run build       # tsc → dist/
npm test            # 154 tests across 19 files
```

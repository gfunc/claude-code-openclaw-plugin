# Claude Code harness

OpenClaw plugin — spawn, monitor, stop Claude Code sessions. Hooks auto-installed, state auto-tracked, notifications pushed.

## How it works

1. **Setup hooks** (`claude_code_setup_hooks`) — writes `.claude/settings.local.json` into a repo so Claude Code pushes hook events to the plugin.
2. **Spawn** (`claude_code_spawn`) — launches `claude` in a detached tmux session with `--session-id` and `--permission-mode`.
3. **Track** — every Claude Code hook event (`PostToolUse`, `Stop`, `SessionEnd`, …) hits `POST /claude-code/hook`. The plugin maps events to a 7-state machine: `WORKING → WAITING/QUESTION/PERMISSION/ERROR → DONE/FATAL`.
4. **Notify** — on terminal state (DONE/FATAL), two channels fire:
   - **wecom webhook** (if `wecomWebhookUrl` configured): instant Markdown push, bypasses OpenClaw's heartbeat system
   - **system event + wake**: enqueues an exec-format event (`exec completed (claude-code-<id>, code 0) :: <result>`) to `targetSessionKey` and calls `requestHeartbeatNow({source:"hook"})` to wake the agent

The exec-format event survives in the system-event queue until the user's next turn, when `drainFormattedSystemEvents` renders it as a `System:` line for the agent to process.

## Notification architecture

See `docs/openclaw-background-task-notification.md` for a full analysis of OpenClaw's internal notification system (heartbeat wake, system events, ACP spawn, background task patterns).

In short: OpenClaw has no "push notification" API for plugins. The `enqueueSystemEvent` + `requestHeartbeatNow` path works, but the `getSize("main")` global command lane blocks all heartbeat runs while the user is chatting. The wecom webhook bypasses this entirely.

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
| `targetSessionKey` | `agent:main:main` | Session that receives system events + wake calls |
| `wecomWebhookUrl` | — | If set, POSTs Markdown to this WeCom webhook on session completion |
| `permissionMode` | `bypassPermissions` | Claude Code `--permission-mode` for spawn/restore |
| `routePrefix` | `/claude-code` | HTTP route prefix |
| `sessionTimeoutSeconds` | `300` | Idle threshold before FATAL |
| `stateFileDir` | `~/.cache/claude-code-hooks` | Per-session state and debug logs |
| `notifyStates` | `[WAITING,QUESTION,PERMISSION,ERROR,DONE]` | States that enqueue a system event |
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
          "targetSessionKey": "agent:main:main",
          "wecomWebhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
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

| State | Triggered by | Notifies? |
|-------|-------------|-----------|
| `WORKING` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, FileChanged, CwdChanged, ElicitationResult | No |
| `WAITING` | Stop (default fallback) | ⚠️ enqueue only, no wake |
| `DONE` | SessionEnd | 🚨 exec-format event + wake + wecom webhook |
| `QUESTION` | Elicitation | ⚠️ enqueue only |
| `PERMISSION` | PermissionRequest | ⚠️ enqueue only |
| `ERROR` | PostToolUseFailure | ⚠️ enqueue only |
| `FATAL` | Idle timeout (`sessionTimeoutSeconds`) | 🚨 exec-format event + wake + wecom webhook |

## Build

```bash
npm install
npm run build       # tsc → dist/
npm test            # 137 tests across 19 files
```

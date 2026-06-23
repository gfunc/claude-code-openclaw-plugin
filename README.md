# Claude Code harness

Standalone OpenClaw plugin that **spawns, monitors, and stops Claude Code sessions** entirely from inside OpenClaw — no external CLI scripts, no shell wrappers, no manual hook setup. Drop the plugin in, register a target repo, and Claude Code lifecycles are tracked automatically.

## What it does

1. **Spawn** a Claude Code session in tmux with a task, budget, and workdir.
2. **Track** every state change through Claude Code's native hook events (Stop, SessionEnd, Elicitation, PermissionRequest, PostToolUseFailure, ...).
3. **Notify** the target session via `enqueueSystemEvent` whenever a tracked session enters a watched state (WAITING / QUESTION / PERMISSION / ERROR / DONE / FATAL).
4. **Wake** the target session immediately via `requestHeartbeatNow` so it sees the notification on its next turn instead of waiting for the periodic heartbeat.
5. **Stop** or **resume** sessions by name.
6. **Auto-install** hook config into a target repo (`.claude/settings.local.json`) so Claude Code pushes events back to the plugin.

All six capabilities are exposed as both:

- **OpenClaw tools** (callable from any agent session), and
- **HTTP routes** (callable from external scripts, if ever needed).

No bash wrappers, no manual `tmux` invocations, no JSONL tailing, no external state files outside the plugin's own cache.

## Tools (call from any agent)

| Tool | What it does |
|------|--------------|
| `claude_code_spawn` | Start an interactive Claude Code session in a new tmux pane, with task, budget, and workdir. |
| `claude_code_status` | List tracked sessions; optional `state` filter. |
| `claude_code_send` | Type text into a running session (answer a question, approve, or tell it to continue); submits by default. |
| `claude_code_stop` | Kill a session's tmux pane. |
| `claude_code_restore` | Spawn a new tmux pane that `--resume`s a previous session by id. |
| `claude_code_setup_hooks` | Write hook config into a target repo's `.claude/settings.local.json` (or `.settings.json` with `shared=true`). |

## HTTP routes

| Route | Purpose |
|-------|---------|
| `POST /claude-code/hook` | Receives Claude Code hook events. |
| `POST /claude-code/spawn` | Programmatic spawn (same as `claude_code_spawn` tool). |
| `POST /claude-code/setup-hooks` | Programmatic setup (same as `claude_code_setup_hooks` tool). |
| `/{routePrefix}/<tmux>/send` | Send keys to a tmux session (rate-limited). |
| `/{routePrefix}/<session>/stop` | Stop by session id. |
| `/{routePrefix}/<session>/restore` | Restore by session id. |

The HTTP routes exist so external callers (cron jobs, wecom bot, etc.) can drive the plugin without going through the OpenClaw tool runtime. They are **not** required for normal use — the plugin works fully from inside an agent session.

## State machine

Claude Code hook events are mapped to a 7-state machine:

| State | Triggered by | Notifies target session? |
|-------|--------------|--------------------------|
| `WORKING` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, FileChanged, CwdChanged, ElicitationResult | No (busy) |
| `WAITING` | Stop (default fallback) | ⚠️ waiting for input |
| `DONE` | SessionEnd | ℹ️ completed |
| `QUESTION` | Elicitation | ⚠️ needs answer |
| `PERMISSION` | PermissionRequest | ⚠️ needs authorization (trust bypass default) |
| `ERROR` | PostToolUseFailure | 🚨 failed |
| `FATAL` | 5-min idle timeout (configurable) | 🚨 one-shot only |

Notifications go through OpenClaw's `enqueueSystemEvent` API, which injects a system event directly into the target session queue.

## Active turn trigger

By default, `enqueueSystemEvent` only inserts text into the target session's system-event queue; the target still waits for its next periodic heartbeat before acting on it. This plugin also calls `requestHeartbeatNow` so the target agent is woken immediately.

How it works:

1. A watched state change (e.g. `WAITING`) calls `enqueueSystemEvent(text, { sessionKey, contextKey: "cron:claude-code:<sessionId>" })`. The event text includes any question / error / result detail extracted from the hook payload, so the watcher sees *what* happened, not just *that* something happened.
2. If the enqueue succeeds, the dispatcher calls `api.runtime.system.requestHeartbeatNow({ reason: "claude-code-state-change", sessionKey, agentId })`.
3. OpenClaw queues a pending wake with a coalesce timer, then runs the heartbeat for the target session.
4. The heartbeat prompt drains the queued system event (the `cron:` context key marks it as a cron event) and the target agent receives it on the current turn.
5. A 1-second per-session throttle prevents duplicate heartbeat requests when a session flaps through multiple hook events.

`enqueueSystemEvent` is the primary notification path; `requestHeartbeatNow` is a best-effort wake isolated in its own try/catch so a heartbeat failure never breaks hook processing.

## Ideal workflow

1. **Configure the target session.** In `~/.openclaw/openclaw.json`, point the plugin at the session that should watch Claude Code state:
   ```json
   {
     "plugins": {
       "entries": {
         "claude-code-openclaw-plugin": {
           "enabled": true,
           "config": {
             "targetSessionKey": "agent:main:main",
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
   `targetSessionKey` is the session that will receive system-event notifications and heartbeat wakes. The default is `agent:main:main`; set it to a dedicated watcher agent (for example `agent:cc-watcher:main`) if you want a separate session to monitor Claude Code state.
  `permissionMode` controls how Claude Code handles permission prompts when spawning or restoring sessions. Default is `bypassPermissions` (current behavior). Set `"permissionMode": "default"` if you want Claude Code to enforce normal permission prompts.

2. **Install hooks in the repo you want to monitor.** From any OpenClaw agent session, run:
   ```text
   claude_code_setup_hooks({ repoPath: "/path/to/target/repo" })
   ```
   This writes `.claude/settings.local.json` so Claude Code in that repo emits hook events back to the plugin.

3. **Spawn a Claude Code session.** From OpenClaw:
   ```text
   claude_code_spawn({ workdir: "/path/to/target/repo", task: "Refactor the auth module", tmuxSession: "cc-auth", budgetMinutes: 30 })
   ```
   The session starts inside tmux and begins reporting hook events.

4. **Let it run.** The plugin receives events, tracks state, and pushes notifications to `targetSessionKey`. When the session hits `WAITING`, `QUESTION`, `PERMISSION`, `ERROR`, `DONE`, or `FATAL`, the target session is woken immediately.

5. **Watcher responds.** The watcher agent sees the cron event in its heartbeat prompt — e.g. "⚠️ Claude Code session cc-auth is waiting for an answer: Which database should I use?" — and can decide to answer it directly with `claude_code_send({ tmuxSession: "cc-auth", text: "postgres" })`, tell it to continue, ask you, or forward a summary to another agent such as `agent:main:main`.

6. **Clean up.** Use `claude_code_stop` or the HTTP route when the session is no longer needed.

## Build

```bash
npm install
npm run build       # tsc → dist/
npm test            # 90 tests across 18 files
```

## Configuration

All fields optional; defaults shown.

| Field | Default | Purpose |
|-------|---------|---------|
| `routePrefix` | `/claude-code` | HTTP route prefix. |
| `stateFileDir` | `~/.cache/claude-code-hooks` | Where per-session state JSON lives. |
| `notifyStates` | `[WAITING, QUESTION, PERMISSION, ERROR, DONE]` | States that trigger a system event push. |
| `targetSessionKey` | `agent:main:main` | Which session receives the enqueued system events. |
| `permissionMode` | `bypassPermissions` | Permission handling for spawn/restore: `bypassPermissions` (no prompts) or `default` (normal prompts). |
| `sendKeysRateLimitPerMinute` | `10` | Per-session rate limit for `/send`. |
| `sessionTimeoutSeconds` | `300` | Idle threshold for FATAL. |
| `eventTypes` | `["*"]` | Hook event filter. |

## Why no shell wrappers

Previous versions shipped `bin/claude-task*` and `bin/setup-claude-hooks` as HTTP-first shell wrappers. **As of v0.3.0 these are removed.** Every function they performed is available as a plugin tool or HTTP route, so the plugin is fully self-contained: drop it in, build, restart gateway, done.

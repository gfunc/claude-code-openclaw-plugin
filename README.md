# Claude Code harness

Standalone OpenClaw plugin that **spawns, monitors, and stops Claude Code sessions** entirely from inside OpenClaw — no external CLI scripts, no shell wrappers, no manual hook setup. Drop the plugin in, register a target repo, and Claude Code lifecycles are tracked automatically.

## What it does

1. **Spawn** a Claude Code session in tmux with a task, budget, and workdir.
2. **Track** every state change through Claude Code's native hook events (Stop, SessionEnd, Elicitation, PermissionRequest, PostToolUseFailure, ...).
3. **Notify** the main session via `enqueueSystemEvent` whenever a tracked session enters a watched state (WAITING / QUESTION / PERMISSION / ERROR / DONE / FATAL).
4. **Stop** or **resume** sessions by name.
5. **Auto-install** hook config into a target repo (`.claude/settings.local.json`) so Claude Code pushes events back to the plugin.

All five capabilities are exposed as both:

- **OpenClaw tools** (callable from any agent session), and
- **HTTP routes** (callable from external scripts, if ever needed).

No bash wrappers, no manual `tmux` invocations, no JSONL tailing, no external state files outside the plugin's own cache.

## Tools (call from any agent)

| Tool | What it does |
|------|--------------|
| `claude_code_spawn` | Start an interactive Claude Code session in a new tmux pane, with task, budget, and workdir. |
| `claude_code_status` | List tracked sessions; optional `state` filter. |
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

| State | Triggered by | Notifies main session? |
|-------|--------------|------------------------|
| `WORKING` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, FileChanged, CwdChanged, ElicitationResult | No (busy) |
| `WAITING` | Stop (default fallback) | ⚠️ waiting for input |
| `DONE` | SessionEnd | ℹ️ completed |
| `QUESTION` | Elicitation | ⚠️ needs answer |
| `PERMISSION` | PermissionRequest | ⚠️ needs authorization (trust bypass default) |
| `ERROR` | PostToolUseFailure | 🚨 failed |
| `FATAL` | 5-min idle timeout (configurable) | 🚨 one-shot only |

Notifications go through OpenClaw's `enqueueSystemEvent` API, which injects a system event directly into the main session queue — bypassing the heartbeat runner's silent-skip paths and showing up on the next turn.

## Build

```bash
npm install
npm run build       # tsc → dist/
npm test            # 77 tests across 17 files
```

## Configuration

All fields optional; defaults shown.

| Field | Default | Purpose |
|-------|---------|---------|
| `routePrefix` | `/claude-code` | HTTP route prefix. |
| `stateFileDir` | `~/.cache/claude-code-hooks` | Where per-session state JSON lives. |
| `notifyStates` | `[WAITING, QUESTION, PERMISSION, ERROR, DONE]` | States that trigger a system event push. |
| `targetSessionKey` | `agent:main:main` | Which session receives the enqueued system events. |
| `sendKeysRateLimitPerMinute` | `10` | Per-session rate limit for `/send`. |
| `sessionTimeoutSeconds` | `300` | Idle threshold for FATAL. |
| `eventTypes` | `["*"]` | Hook event filter. |

## Why no shell wrappers

Previous versions shipped `bin/claude-task*` and `bin/setup-claude-hooks` as HTTP-first shell wrappers. **As of v0.2.2 these are removed.** Every function they performed is available as a plugin tool or HTTP route, so the plugin is fully self-contained: drop it in, build, restart gateway, done.

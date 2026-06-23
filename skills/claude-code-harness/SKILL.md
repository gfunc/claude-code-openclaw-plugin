---
name: claude-code-harness
description: Spawn, monitor, and stop Claude Code sessions from inside OpenClaw via the claude-code-openclaw-plugin. Standalone — no external CLI scripts.
---

# Claude Code harness

Use this skill when the `claude-code-openclaw-plugin` plugin is loaded and you need to drive Claude Code sessions from an OpenClaw agent session.

## When to use

- Run a non-trivial task asynchronously in Claude Code (a multi-hour refactor, a long debug, a TDD cycle) and stay in the loop without blocking the channel.
- Monitor the state of one or more Claude Code sessions (WAITING / QUESTION / PERMISSION / ERROR / DONE / FATAL) and react when they reach a watched state.
- Restore a previous Claude Code session by id (`--resume`) in a new tmux pane, preserving the original transcript.
- Wire Claude Code hook events into OpenClaw for a target repo (so the plugin can track sessions there).

Do **not** use this skill for:

- Interactive one-shot prompts — call `claude` directly, or `claude_code_spawn` if the task should survive a channel disconnect.
- Non-Claude-Code CLIs (aider, codex, etc.) — this plugin is specific to Claude Code hook events.

## The tools (call from any agent)

| Tool | Use it when... |
|------|----------------|
| `claude_code_spawn` | you want to start a fresh Claude Code task in a tmux pane |
| `claude_code_status` | you want to know what's running (optional `state` filter) |
| `claude_code_read` | you need to see the live pane (current prompt, menu options, result) before acting |
| `claude_code_send` | you want to answer a question, approve, type `continue`, switch mode, or drive a menu |
| `claude_code_stop` | a session is hung or you want to abort |
| `claude_code_restore` | you have a session id and want to continue (`--resume`) |
| `claude_code_setup_hooks` | a target repo doesn't have hook config yet |

The tools are the preferred call form. The plugin also exposes HTTP routes under `/claude-code/*` for external callers (cron jobs, bots), but inside an agent session the tools are the right entry point.

## The state machine

Claude Code hook events are mapped to a 7-state machine inside the plugin:

| State | Triggered by hook events | Should I react? |
|-------|--------------------------|-----------------|
| `WORKING` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, FileChanged, CwdChanged, ElicitationResult | No — Claude Code is busy, leave it alone. |
| `WAITING` | Stop (default fallback) | **Yes** — Claude Code has finished a turn and is waiting for you. |
| `DONE` | SessionEnd | **Yes** — the session has fully ended. |
| `QUESTION` | Elicitation | **Yes** — Claude Code asked the user a clarifying question. |
| `PERMISSION` | PermissionRequest | **Yes** if you want to be involved; the trust default is "yes" (bypass). |
| `ERROR` | PostToolUseFailure | **Yes** — a tool failed. |
| `FATAL` | 5-min idle timeout (configurable) | **Yes, once** — the session is dead. |

Notification behavior is controlled by the `notifyStates` plugin config (default `[WAITING, QUESTION, PERMISSION, ERROR, DONE]`). `FATAL` is one-shot: a dead session announces itself exactly once.

## How notifications reach you

When a tracked session enters a state that's in `notifyStates`, the plugin calls OpenClaw's `enqueueSystemEvent` API. This injects a text event into the main session's queue. On the next turn, you'll see it in your prompt context, formatted like:

> `[<timestamp>] ⚠️ Claude Code session <tmux-session> is waiting for input`

The prefix (`⚠️` / `🚨` / `ℹ️`) and message template come from the plugin's `STATE_BEHAVIOR` table — one entry per state, no branching per call site. The event text also carries any question / error / result detail pulled from the hook payload, so you see *what* happened, not just *that* something did.

`enqueueSystemEvent` is the **primary** path: it goes straight into the target session queue and is consumed on the next turn unconditionally. On top of that, the plugin calls `requestHeartbeatNow` (best-effort, in its own try/catch) to **wake the target session immediately** instead of waiting for the next periodic heartbeat. If the wake fails, the queued event is still delivered on the next turn — so the notification is never lost.

## Permission and session mode

Claude Code has a **permission mode** that decides how it handles tool use and file edits. The plugin controls it two ways.

**At launch (config).** `permissionMode` in plugin config is passed to `claude --permission-mode <mode>` for every `claude_code_spawn` / `claude_code_restore`. The values mirror Claude Code:

- `default` — Claude prompts before sensitive actions (normal interactive permissions).
- `acceptEdits` — auto-accepts file edits, still prompts for other sensitive actions.
- `plan` — plan mode: Claude only plans, makes **no** changes.
- `bypassPermissions` — no prompts at all; fully autonomous. **This is the plugin default**, which is why `PERMISSION`/`QUESTION` rarely fire.

Set a stricter mode when you want a human or OpenClaw in the loop:

```json
{ "plugins": { "entries": { "claude-code-openclaw-plugin": { "config": { "permissionMode": "plan" } } } } }
```

**Live, mid-session.** Claude Code cycles its mode with **Shift+Tab**. tmux's name for Shift+Tab is `BTab`, so send it via `claude_code_send`:

```text
claude_code_read({ tmuxSession: "<tmux-session>" })           // see the current mode first
claude_code_send({ tmuxSession: "<tmux-session>", keys: ["BTab"] }) // cycle mode (Shift+Tab)
claude_code_send({ tmuxSession: "<tmux-session>", keys: ["Tab"] })  // plain Tab
```

**Answering a PERMISSION / QUESTION prompt** (only happens in a non-bypass mode):

1. `claude_code_read({ tmuxSession })` — read the prompt and its options.
2. `claude_code_send(...)` — type the answer (`text: "yes"`), pick a numbered option (`text: "2"`), or drive an arrow-highlight menu (`keys: ["Down", "Enter"]`).

With the default `bypassPermissions`, Claude Code never raises these prompts — it just proceeds.

## Standalone — no external scripts

This plugin is fully self-contained. Specifically:

- **No `bin/` shell wrappers.** Earlier versions shipped `claude-task`, `claude-task-restore`, `claude-task-stop`, `setup-claude-hooks` as HTTP-first shell scripts. Removed in v0.2.2. The plugin's tools and HTTP routes cover everything those scripts did.
- **No manual hook wiring for the user.** `claude_code_setup_hooks` writes `.claude/settings.local.json` into a target repo with the right URL and event list. The user only has to run that tool once per repo.
- **State persists in `~/.cache/claude-code-hooks/*.json`**, owned by the plugin. No external state files.
- **The only external runtime dependency is `tmux`** (Claude Code itself runs in a tmux pane). Everything else — `node:child_process`, `node:fs/promises`, `zod`, `typebox` — is in-process.

## Setup checklist for a fresh repo

1. `claude_code_setup_hooks({repoPath: "/path/to/repo"})` — writes the hook config.
2. Next time Claude Code runs in that repo, it pushes events to the plugin automatically.
3. The plugin's store gains a session entry on the first hook event.

That's it. No `tmux` commands, no JSONL watchers, no env vars, no symlinks.

## When to be careful

- **Budget is enforced by an idle watchdog** (`sessionTimeoutSeconds` × heartbeat interval), not by wall-clock. As long as Claude Code keeps producing hook events, the session lives. If it goes silent for 5 minutes, the plugin marks it FATAL and the main session gets a one-shot notification.
- **`targetSessionKey` defaults to `agent:main:main`.** If you want notifications delivered to a different session (e.g. a dedicated wecom channel), set this in plugin config.
- **`PERMISSION` only fires in a non-bypass mode.** With the default `permissionMode: bypassPermissions`, Claude Code never raises permission prompts — it just proceeds. Set `permissionMode` to `default` / `acceptEdits` / `plan` to get `PERMISSION` / `QUESTION` gates, then answer them with `claude_code_read` + `claude_code_send`.
- **FATAL is one-shot** because the session is dead — re-arming the notification would just spam the main session on every heartbeat forever.

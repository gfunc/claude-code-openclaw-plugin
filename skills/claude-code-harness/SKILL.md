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

## The 5 tools (call from any agent)

| Tool | Use it when... |
|------|----------------|
| `claude_code_spawn` | you want to start a fresh Claude Code task in a tmux pane |
| `claude_code_status` | you want to know what's running (optional `state` filter) |
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

> `[2026-06-21 20:32:07 GMT+8] ⚠️ Claude Code session cc-fix-bug is waiting for input`

The prefix (`⚠️` / `🚨` / `ℹ️`) and message template come from the plugin's `STATE_BEHAVIOR` table — one entry per state, no branching per call site.

This path **bypasses OpenClaw's heartbeat runner** deliberately. Earlier versions used `requestHeartbeat`, but that API has silent-skip paths (active reply runs, interval gating) that make it unreliable for "I just need to know right now" notifications. `enqueueSystemEvent` goes straight into the session queue and is consumed on the next turn unconditionally.

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
- **`PERMISSION` notifications are advisory.** The plugin trusts the `bypassPermissions` default and does not block; it only surfaces the request. If you want PERMISSION to halt, you must orchestrate that yourself.
- **FATAL is one-shot** because the session is dead — re-arming the notification would just spam the main session on every heartbeat forever.

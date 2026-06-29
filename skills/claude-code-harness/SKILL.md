---
name: claude-code-harness
description: Drive Claude Code sessions from inside OpenClaw via the claude-code-openclaw-plugin ACP runtime backend.
---

# Claude Code harness

Use this skill when the `claude-code-openclaw-plugin` plugin is loaded and you need to run long-running Claude Code tasks from an OpenClaw agent session.

## When to use

- Run a non-trivial task asynchronously in Claude Code (multi-hour refactor, long debug, TDD cycle) and let OpenClaw's ACP layer handle completion delivery.
- Resume a previous Claude Code session by its Claude Code session id.
- Check whether a Claude Code backend session is alive.
- Wire Claude Code hook events into OpenClaw for a target repo.

Do **not** use this skill for:

- Interactive one-shot prompts — call `claude` directly.
- Non-Claude-Code CLIs (aider, codex, etc.).

## Session identifiers

Three ids are involved. The naming is confusing because OpenClaw and Claude Code both call their ids "session".

| Id | Where you see it | What it is |
|----|------------------|------------|
| **ACP session key** | Return value of `sessions_spawn`; argument to `sessions_send` / `sessions_cancel` / `sessions_status` | OpenClaw's handle for the ACP backend session. |
| **OpenClaw session id** | `sessionId` field in `sessions_list` | OpenClaw's own session UUID (used for transcript files). **Not** the Claude Code session id. |
| **Claude Code session id** | `claudeCodeSessionId` field inside `~/.cache/claude-code-hooks/{sessionKey}.acp.json` | The value passed to `claude --session-id` and `claude --resume`. It survives tmux restarts. |
| **tmux session name** | `tmuxSessionName` field inside the sidecar file | The tmux pane name, e.g. `cc-a1b2c3d4`. |

The `sessions_spawn` tool returns only the ACP `sessionKey`. Even though the plugin's runtime adapter internally tracks `backendSessionId` and `runtimeSessionName`, the OpenClaw tool layer does **not** expose them in the tool result. To get the Claude Code session id or tmux name, read the sidecar:

```bash
cat ~/.cache/claude-code-hooks/{sessionKey}.acp.json
```

Example sidecar:

```json
{
  "sessionKey": "openclaw-acp-key-...",
  "claudeCodeSessionId": "<claude-code-session-id>",
  "tmuxSessionName": "cc-a1b2c3d4",
  ...
}
```

## The ACP API (call from any agent)

The plugin registers an ACP runtime backend with id `claude-code`. Use OpenClaw's generic session tools against it:

| Action | Legacy tool (removed in v0.8) | ACP replacement |
|--------|------------------------------|-----------------|
| Start / spawn | `claude_code_spawn` | `sessions_spawn(runtime: "acp", agentId: "claude-code")` |
| Send input | `claude_code_send` | `sessions_send(sessionKey, "your prompt text")` |
| Read output | `claude_code_read` | Read the turn result / text deltas returned by ACP |
| Stop / cancel | `claude_code_stop` | `sessions_cancel(sessionKey)` |
| Restore | `claude_code_restore` | `sessions_spawn(runtime: "acp", agentId: "claude-code", resume: "<claude-code-session-id>")` (get the id from the sidecar's `claudeCodeSessionId` field) |
| Status | `claude_code_status` | `sessions_status(sessionKey)` |
| Setup hooks | `claude_code_setup_hooks` | `claude_code_setup_hooks({ repoPath: "/path/to/repo" })` |

## The state machine

Claude Code hook events are mapped to terminal and non-terminal states. ACP turns complete on `DONE`, `ERROR`, `WAITING`, `PERMISSION`, or `QUESTION`.

| State | Triggered by hook events | Meaning |
|-------|--------------------------|---------|
| `WORKING` | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, FileChanged, CwdChanged, ElicitationResult | Claude Code is busy; ACP turn is still running. |
| `WAITING` | Stop | Turn completed; Claude Code is waiting. |
| `DONE` | SessionEnd | Session ended; ACP turn completes successfully. |
| `QUESTION` | Elicitation | Claude Code asked a clarifying question (only in non-bypass mode). |
| `PERMISSION` | PermissionRequest | Tool permission requested (only in non-bypass mode). |
| `ERROR` | PostToolUseFailure | A tool failed; ACP turn completes as failed. |
| `FATAL` | `sessionTimeoutSeconds` idle timeout | The tmux session is presumed dead. |

## Permission mode

`acpPermissionMode` in plugin config is passed to `claude --permission-mode <mode>` for every spawned or resumed session:

- `default` — prompts before sensitive actions.
- `acceptEdits` — auto-accepts file edits, prompts for other sensitive actions.
- `plan` — plans only, makes no changes.
- `bypassPermissions` — no prompts; fully autonomous. **Plugin default.**

Set a stricter mode when you want `PERMISSION` / `QUESTION` gates:

```json
{
  "plugins": {
    "entries": {
      "claude-code-openclaw-plugin": {
        "config": { "acpPermissionMode": "plan" }
      }
    }
  }
}
```

## Plugin configuration

```json
{
  "claude-code": {
    "routePrefix": "/claude-code",
    "stateFileDir": "~/.cache/claude-code-hooks",
    "sessionTimeoutSeconds": 300,
    "debugLog": false,
    "acpBudgetMinutes": 30,
    "acpPermissionMode": "bypassPermissions",
    "acpAllowedTools": [],
    "acpBackendId": "claude-code"
  }
}
```

- `acpBudgetMinutes` — idle budget for ACP sessions.
- `acpAllowedTools` — tools passed through to Claude Code.
- `acpBackendId` — the registered ACP backend id (`claude-code` by default).

## Setup checklist for a fresh repo

1. `claude_code_setup_hooks({ repoPath: "/path/to/repo" })` — writes `.claude/settings.local.json` with the hook URL and event list.
2. Next time Claude Code runs in that repo, it pushes events to `/claude-code/hook`.
3. The plugin's `EventStreamer` drives ACP turn completion from those hook events.

## HTTP routes

Only two routes remain in v0.8:

- `POST /claude-code/hook` — receives Claude Code hook events.
- `POST /claude-code/setup-hooks` — installs hook config into a repo (also available as the `claude_code_setup_hooks` tool).

## When to be careful

- **Session timeout** is enforced by an idle watchdog (`sessionTimeoutSeconds`). If Claude Code stops emitting hook events, the session is marked `FATAL`.
- **`PERMISSION` / `QUESTION` only fire in a non-bypass mode.** With `acpPermissionMode: bypassPermissions`, Claude Code never raises these prompts.
- **FATAL is one-shot** — the dead session is announced once.

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

Three different ids are involved. Don't confuse them:

| Id | Name in code | What it is |
|----|--------------|------------|
| **ACP session key** | `sessionKey` | OpenClaw's handle for the ACP session. You pass this to `sessions_spawn`, `sessions_send`, `sessions_cancel`, `sessions_status`. |
| **Claude Code session id** | `sessionId` / `backendSessionId` | The value passed to `claude --session-id <id>` and later `claude --resume <id>`. It survives tmux restarts. |
| **tmux session name** | `tmuxSession` / `runtimeSessionName` | The tmux pane that hosts the running `claude` process, e.g. `cc-a1b2c3d4`. |

After `sessions_spawn(runtime: "acp", agentId: "claude-code")`, the returned `AcpRuntimeHandle` contains:

```ts
{
  sessionKey,          // OpenClaw ACP key
  backendSessionId,    // Claude Code session id
  runtimeSessionName,  // tmux session name
  cwd,
}
```

The plugin persists the mapping in `{stateFileDir}/{sessionKey}.acp.json`, so `backendSessionId` is durable even if the tmux session is recreated.

## The ACP API (call from any agent)

The plugin registers an ACP runtime backend with id `claude-code`. Use OpenClaw's generic session tools against it:

| Action | Legacy tool (removed in v0.8) | ACP replacement |
|--------|------------------------------|-----------------|
| Start / spawn | `claude_code_spawn` | `sessions_spawn(runtime: "acp", agentId: "claude-code")` |
| Send input | `claude_code_send` | `sessions_send(sessionKey, "your prompt text")` |
| Read output | `claude_code_read` | Read the turn result / text deltas returned by ACP |
| Stop / cancel | `claude_code_stop` | `sessions_cancel(sessionKey)` |
| Restore | `claude_code_restore` | `sessions_spawn(runtime: "acp", agentId: "claude-code", resume: "<backendSessionId>")` (or the ACP resume equivalent) |
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

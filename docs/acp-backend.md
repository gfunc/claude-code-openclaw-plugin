# Claude Code ACP Backend

The plugin exposes Claude Code as an OpenClaw ACP runtime backend (`id: "claude-code"`). This lets OpenClaw dispatch long-running tasks to a detached Claude Code session via `sessions_spawn`, with durable completion delivery handled by OpenClaw's ACP layer.

## Enabling the backend

Add the agent to your OpenClaw config:

```json
{
  "acp": {
    "enabled": true,
    "defaultAgent": "claude-code",
    "backend": "claude-code"
  },
  "agents": {
    "list": [
      {
        "id": "claude-code",
        "runtime": {
          "type": "acp",
          "acp": { "agent": "claude-code" }
        }
      }
    ]
  }
}
```

You can also spawn directly:

```
sessions_spawn(runtime: "acp", agentId: "claude-code")
```

## Plugin config

These values are read from the plugin config block (`claude-code` key):

| Key | Default | Description |
|-----|---------|-------------|
| `acpBudgetMinutes` | `30` | Idle budget for ACP sessions |
| `acpPermissionMode` | `bypassPermissions` | Default Claude Code `--permission-mode` |
| `acpAllowedTools` | `[]` | Allowed tools passed to Claude Code |
| `acpBackendId` | `claude-code` | Registered ACP backend id |

## Session lifecycle

- `ensureSession` spawns a new tmux session running `claude` or resumes an existing one.
- Sidecar files in `stateFileDir` (`*.acp.json`) map ACP `sessionKey` to tmux session name and Claude Code `sessionId`.
- On plugin startup, live sidecars are rehydrated; dead tmux sessions are respawned with `claude --resume <sessionId>`.
- `close` kills the tmux session for `oneshot` mode or when `discardPersistentState` is true.
- `cancel` sends `Ctrl+C` to the tmux session.

## Turn execution

1. `startTurn` sends the prompt text to the running Claude Code session.
2. The runtime emits a `status` event and waits for a terminal hook (`DONE`, `FATAL`, `ERROR`, `WAITING`, `PERMISSION`, `QUESTION`).
3. On terminal hook, it reads the session output and emits `text_delta` + `done`/`error` events.
4. The terminal `AcpRuntimeTurnResult` resolves as `completed`, `failed`, or `cancelled`.

## Prerequisites

The `doctor()` method checks that both `claude` and `tmux` binaries are on `PATH`. Hooks must also be configured (the plugin's `/claude-code/setup-hooks` route or `claude_code_setup_hooks`) so Claude Code can emit hook events.

## Migration from HTTP spawn/send/read

The legacy `/claude-code/spawn`, `/send`, `/read`, `/stop`, and `/restore` routes and their associated tools have been removed in v0.8. Use the ACP runtime instead:

```
sessions_spawn(runtime: "acp", agentId: "claude-code")
```

Legacy action → ACP replacement:

| Legacy action | ACP replacement |
|---------------|-----------------|
| `spawn` | `sessions_spawn(runtime: "acp", agentId: "claude-code")` |
| `send` | `sessions_send(sessionId, "your prompt text")` |
| `read` | Read the turn result returned by ACP |
| `stop` | `sessions_cancel(sessionId)` |
| `restore` | `sessions_spawn(runtime: "acp", agentId: "claude-code", resume: "<sessionId>")` (or the ACP resume equivalent) |
| `status` | `sessions_status(sessionId)` |

The `src/task-registry.ts` heartbeat notification path has been removed.

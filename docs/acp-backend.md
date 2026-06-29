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

## Session identifiers

Three ids are involved. They are easy to confuse because OpenClaw and Claude Code both use the word "session".

| Id | In code / sidecar | What it is |
|----|-------------------|------------|
| **ACP session key** | `sessionKey` | The id OpenClaw returns from `sessions_spawn` and expects for `sessions_send` / `sessions_cancel` / `sessions_status`. |
| **OpenClaw session id** | `sessionId` in `sessions_list` | OpenClaw's own session UUID (used for transcript files, e.g. `386b46e0-16d3-...`). **Not** the Claude Code session id. |
| **Claude Code session id** | `sessionId` in `{sessionKey}.acp.json` | The value passed to `claude --session-id` and `claude --resume`. This is what lets the plugin resurrect a dead tmux session. |
| **tmux session name** | `tmuxSession` in the sidecar | The tmux pane name, e.g. `cc-a1b2c3d4`. |

`sessions_spawn(runtime: "acp", agentId: "claude-code")` returns an OpenClaw ACP session key. It does **not** expose `backendSessionId` or `runtimeSessionName` through the tool layer, even though the runtime adapter populates those fields internally. To find the Claude Code session id or tmux name, read the sidecar file written by the plugin:

```bash
cat ~/.cache/claude-code-hooks/{acp-session-key}.acp.json
```

The sidecar contains:

```json
{
  "sessionKey": "...",
  "sessionId": "<claude-code-session-id>",
  "tmuxSession": "cc-...",
  ...
}
```

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
| `send` | `sessions_send(sessionKey, "your prompt text")` |
| `read` | Read the turn result returned by ACP |
| `stop` | `sessions_cancel(sessionKey)` |
| `restore` | `sessions_spawn(runtime: "acp", agentId: "claude-code", resume: "<claude-code-session-id>")` (or the ACP resume equivalent) |
| `status` | `sessions_status(sessionKey)` |

For `restore`, get the Claude Code session id from `~/.cache/claude-code-hooks/{sessionKey}.acp.json` (field `sessionId`).

The `src/task-registry.ts` heartbeat notification path has been removed.

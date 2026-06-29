# OpenClaw Background Task Notification

> This document describes the current mechanism used by `claude-code-openclaw-plugin` to surface Claude Code background task results to users.

## Current architecture: ACP runtime backend

The plugin registers itself as an OpenClaw ACP runtime backend with id `claude-code`:

```
OpenClaw sessions_spawn(agentId: "claude-code")
        │
        ▼
   ClaudeCodeAcpRuntime  (AcpRuntime implementation)
        │
        ├── SessionManager  (ACP sessionKey ↔ tmux/Claude Code session)
        ├── TmuxRuntime     (send/read/stop tmux sessions)
        ├── EventStreamer   (hook-driven event emission)
        └── TurnResult      (terminal success/failure)
```

The ACP runtime implements `ensureSession`, `startTurn`, `runTurn`, `cancel`, `close`, `getStatus`, and `doctor`. OpenClaw's `AcpSessionManager` owns task lifecycle, retries, and completion delivery, so the plugin no longer needs to manage a heartbeat/notification queue itself.

## Why this replaced the heartbeat path

The previous implementation used `enqueueSystemEvent` + `requestHeartbeatNow` to wake a heartbeat runner. This was fragile because it depended on:

- heartbeat-runner heuristics and wake-payload whitelisting,
- `deliveryContext` passthrough from the original caller,
- the global `main` command lane being idle.

ACP solves the same problem natively: background task lifecycle, durable completion delivery, retries, and thread binding are handled by OpenClaw's existing ACP infrastructure.

## Plugin configuration

```json
{
  "claude-code": {
    "routePrefix": "/claude-code",
    "stateFileDir": "~/.cache/claude-code-hooks",
    "acpBudgetMinutes": 30,
    "acpPermissionMode": "bypassPermissions",
    "acpAllowedTools": [],
    "acpBackendId": "claude-code"
  }
}
```

See [acp-backend.md](./acp-backend.md) for OpenClaw agent list config and usage examples.

## Legacy hook/heartbeat path (removed)

The old notification flow via `src/task-registry.ts`, `enqueueSystemEvent`, and `requestHeartbeatNow` has been removed. The `/claude-code/hook` route still receives Claude Code hook events, but only to drive ACP turn terminal state via the `EventStreamer`.

## Key files

| File | Purpose |
|------|---------|
| `src/acp/index.ts` | Registers the `claude-code` ACP backend |
| `src/acp/claude-code-acp-runtime.ts` | `AcpRuntime` adapter |
| `src/acp/session-manager.ts` | Sidecar persistence and resume |
| `src/acp/tmux-runtime.ts` | tmux send/read/stop wrapper |
| `src/acp/event-streamer.ts` | Hook-driven event emission |
| `src/routes.ts` | `/hook` route forwards terminal state transitions to `EventStreamer` |

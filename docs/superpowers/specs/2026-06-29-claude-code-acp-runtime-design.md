# Claude Code ACP Runtime Backend

## Problem

The current plugin notification path (`enqueueSystemEvent` + `requestHeartbeatNow`) is fragile because it depends on heartbeat-runner heuristics, `deliveryContext` passthrough, and wake-payload whitelisting. OpenClaw's ACP infrastructure already solves the same problem — background task lifecycle, durable completion delivery, retries, and thread binding — but Claude Code is not exposed as an ACP backend. We want Claude Code sessions to be first-class ACP citizens.

## Goal

Register the plugin as an ACP runtime backend (`id: "claude-code"`) so OpenClaw's `sessions_spawn` can dispatch Claude Code tasks through `AcpSessionManager`, using the same task-registry, completion-delivery, and retry machinery that ACP agents use.

## Non-goals

- Advanced ACP controls (`session/set_mode`, `session/set_config_option`) for the first version.
- Live token-level streaming; we emit events on meaningful hook-driven boundaries.
- Thread binding beyond what OpenClaw's ACP binding layer already provides.

## Architecture

```
OpenClaw AcpSessionManager
        │
        ▼
   ClaudeCodeAcpRuntime  (implements AcpRuntime)
        │
        ├── SessionManager  (maps ACP sessionKey ↔ tmux session)
        ├── TmuxRuntime     (exec/send keys/read output)
        ├── EventStreamer   (parses output → AcpRuntimeEvent)
        └── TurnResult      (terminal success/failure)
```

### Components

- **`ClaudeCodeAcpRuntime`**: adapter registered via `registerAcpRuntimeBackend({ id: "claude-code", runtime })`. Translates ACP calls into plugin operations.
- **`SessionManager`**: maps `AcpRuntimeHandle.sessionKey` to tmux session name, Claude Code session id, working directory, and spawn metadata. Persists state in `{sessionId}.acp.json` sidecars.
- **`TmuxRuntime`**: wraps existing `sendKeys`, `readSession`, `stopSession` helpers and adds blocking turn execution.
- **`EventStreamer`**: driven by hook events; emits `text_delta`, `tool_call`, `status`, `done`, and `error` events.

## Prerequisites and health checks

The runtime depends on external binaries. We implement `AcpRuntime.doctor()` to report readiness:

1. **`claude`** CLI is installed and on `PATH`.
2. **`tmux`** is installed and on `PATH`.
3. The plugin hook script is installed in the target working directory (or globally) so Claude Code can emit hook events.

`doctor()` returns `ok: true` when all checks pass, otherwise `ok: false` with an `installCommand` or message. `ensureSession` also performs a lightweight existence check and throws `ACP_SESSION_INIT_FAILED` if a required binary is missing, so failures surface early rather than mid-turn.

## Session lifecycle

### `ensureSession(input)`

1. If `resumeSessionId` is provided, look up the existing tmux session and rebuild the handle.
2. Otherwise spawn a new tmux session with `claude -d <cwd> --allowed-tools ...` using existing spawn logic.
3. Write a sidecar file `{sessionId}.acp.json` mapping `sessionKey` → `tmuxSession`, `sessionId`, `cwd`, `mode`, `startedAt`.
4. Return `AcpRuntimeHandle` with `sessionKey`, `backend: "claude-code"`, `runtimeSessionName: tmuxSession`.

### `close(input)`

- `mode: "oneshot"` → kill tmux session and delete sidecar.
- `mode: "persistent"` + `discardPersistentState: true` → kill tmux and delete sidecar.
- `mode: "persistent"` without discard → keep tmux alive, release runtime cache; next `ensureSession` resumes.

### `cancel(input)`

1. Send `Ctrl+C` via tmux to the Claude Code process.
2. If the process does not stop within a grace period, kill the tmux session.

### Restart / reconnect

On plugin startup, scan `.acp.json` sidecars:

- If tmux session is alive → rehydrate the handle.
- If tmux session is dead but sidecar has `sessionId` → respawn tmux with `claude --resume <sessionId> -d <cwd>` and rebuild the handle.
- If `claude --resume` fails or no `sessionId` is recorded → delete the sidecar; next `ensureSession` starts fresh.

## Turn execution

`startTurn(input)` is the preferred API.

1. Send the prompt text to tmux via existing `sendKeys`.
2. Register a one-time listener for the next hook event on this session that is terminal: `DONE`, `FATAL`, `ERROR`, or waiting states (`WAITING`, `PERMISSION`, `QUESTION`).
3. Optionally emit a single `status` event ("working...") after sending.
4. When the hook fires:
   - Read the session output/log once.
   - Emit one `text_delta` containing the assistant's final message or error detail.
   - Emit `done` for `DONE`; emit `error` for `FATAL`/`ERROR`.
   - For `WAITING`/`PERMISSION`/`QUESTION`, treat the turn as completed but include the prompt/request in the `text_delta` so the parent can send a follow-up turn.
5. Resolve `result` promise with `AcpRuntimeTurnResult`:
   - `status: "completed"` for `DONE`.
   - `status: "failed"` for `FATAL`/`ERROR`.
   - `status: "cancelled"` if `cancel()` was called before terminal state.

Hook state is the source of truth for terminal detection. A timeout fallback based on `runTimeoutSeconds` emits `error` if no hook arrives.

## Integration with OpenClaw

### Plugin registration

In `src/index.ts`, after plugin startup:

```ts
registerAcpRuntimeBackend({
  id: "claude-code",
  runtime: createClaudeCodeAcpRuntime({ ...deps }),
});
```

### OpenClaw config

```json
{
  "acp": {
    "enabled": true,
    "defaultAgent": "claude-code",
    "backend": "claude-code"
  }
}
```

Users can also call `sessions_spawn(runtime: "acp", agentId: "claude-code")`.

### Agent list

```json
{
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

### Plugin config

Extend `PluginConfig` with ACP-specific defaults: permission mode, budget minutes, allowed tools. These become defaults for `ensureSession`.

## Migration from hook/notify flow

### Remove

- `src/task-registry.ts` and its tests.
- `taskRegistry` wiring in `src/index.ts`.
- `requestHeartbeatNow` calls for notifications.
- `notifySessionKey` / `notifyDeliveryContext` propagation through `store.setNotifyContext` for notification routing.

### Keep but narrow

- The `/hook` route still receives Claude Code hook events, but only to drive ACP turn terminal state.
- `SessionStore` keeps session state, but notify fields become read-only metadata.

### Repurpose

- `src/spawn.ts` becomes the internal implementation of `AcpRuntime.ensureSession`, not a public HTTP route.
- `/send` and `/read` routes can remain as debugging/manual overrides, but are no longer the primary API.

### User migration

- Existing sessions spawned via old HTTP `/spawn` continue until they terminate.
- New sessions use `sessions_spawn`.
- Documentation is updated to remove the HTTP spawn/send/read workflow.

## Error handling

- **Tmux session dies during turn** → emit `error` (`ACP_TURN_FAILED`), clean up sidecar.
- **Hook never arrives** → timeout, send `Ctrl+C`, emit `error`, close session if `oneshot`.
- **Cancellation** → send `Ctrl+C`; route subsequent terminal hook to `cancelled` if cancel preceded it.
- **Restart/reconnect** → rehydrate live sessions, resume dead ones with `claude --resume`, delete unrecoverable sidecars.
- **Duplicate hooks** → existing `seenStates` dedupe in `store.ts` prevents duplicate processing.

## Testing strategy

- **Unit tests for `ClaudeCodeAcpRuntime`**: mock `TmuxRuntime` and hook delivery; verify `ensureSession` → `startTurn` → `DONE` event stream and `result`.
- **Unit tests for `SessionManager`**: sidecar persistence, `claude --resume` resurrection, dead-session cleanup.
- **Integration test with fake `AcpSessionManager`**: import `getAcpSessionManager` from plugin SDK in test mode; register runtime; call `runTurn`; assert stream and terminal result.
- **End-to-end test**: spin up plugin, register backend, use `sessions_spawn` against it, verify a full task completes.
- **Removed coverage**: delete or repurpose `task-registry.ts` and heartbeat notification tests.

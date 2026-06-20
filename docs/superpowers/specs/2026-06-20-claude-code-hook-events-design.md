# Claude Code Hook Events Integration Design

**Date:** 2026-06-20  
**Plugin:** `claude-code-openclaw-plugin`  
**Status:** Approved — ready for implementation planning

## 1. Goal

Replace (or augment) the tmux pane-text scraping in `claude-code-watcher.sh` with deterministic Claude Code HTTP hook events so OpenClaw can:

- Know Claude Code session state in real time.
- Lower LLM usage by avoiding text classification.
- DM the user via WeCom channels in a timely manner.
- Optionally send commands back into the Claude Code tmux session.

The user keeps the ability to `tmux attach` and interact directly.

## 2. Architecture

```
┌─────────────────┐      HTTP hooks      ┌─────────────────────────────┐
│  Claude Code    │  ──────────────────▶ │  OpenClaw gateway plugin    │
│  (interactive   │   all lifecycle      │  claude-code-openclaw-plugin│
│   tmux session) │      events          │  :18789 /claude-code/hook   │
└─────────────────┘                      └──────────────┬──────────────┘
                                                        │
                                                        ▼
                                          ┌─────────────────────────┐
                                          │  Session state store    │
                                          │  + raw hook payload     │
                                          └────────────┬────────────┘
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                     ┌─────────────┐          ┌─────────────┐          ┌──────────────┐
                     │ OpenClaw    │          │ REST API    │          │ WeCom DM     │
                     │ heartbeat / │          │ /send       │          │ (via         │
                     │ agent loop  │          │ (tmux       │          │ OpenClaw     │
                     │             │          │  send-keys) │          │ agent)       │
                     └─────────────┘          └─────────────┘          └──────────────┘
```

## 3. Data Flow

1. `claude-task` spawns an interactive Claude Code session in tmux with `--session-id <uuid>`.
2. Claude Code is configured (via `~/.claude/settings.json`) to POST all hook events to `http://127.0.0.1:18789/claude-code/hook`.
3. The OpenClaw gateway dispatches the request to the plugin via `api.registerHttpRoute({ path: "/claude-code/hook", auth: "plugin" })`.
4. The plugin receives the hook, correlates it with the existing session via `session_id`, and updates the state snapshot.
5. The plugin emits an internal OpenClaw event `claude-code:stateChanged`.
6. OpenClaw's existing heartbeat or an event subscriber reads the state and decides whether to DM the user.
7. If OpenClaw wants to reply, it calls `POST /claude-code/:tmuxSession/send`; the plugin injects text via `tmux send-keys`.

### 3.1 Session Correlation

The `session_id` from the hook payload is the primary key. On first hook for a new `session_id`, the plugin creates a state file. A binding file maps `session_id` → `tmuxSession` → `openclawSessionKey` so OpenClaw can correlate across subsystems.

```json
{
  "sessionId": "uuid",
  "tmuxSession": "cc-bugfix",
  "openclawSessionKey": "...",
  "workdir": "/home/georgefu/Projects/uco"
}
```

### 3.2 Route Registration

The plugin registers inbound routes on the OpenClaw gateway using `api.registerHttpRoute`:

```ts
api.registerHttpRoute({
  path: "/claude-code/hook",
  auth: "plugin",      // no gateway token required
  match: "exact",
  handler: async (req, res) => { /* ... */ },
});

api.registerHttpRoute({
  path: "/claude-code/",
  auth: "plugin",
  match: "prefix",
  handler: async (req, res) => { /* ... */ },
});
```

Because `auth: "plugin"` is used, no gateway token is required, satisfying the "localhost only, no auth" requirement while still running on the existing gateway port (`18789`).

## 4. State Machine & Event Storage

### 4.1 State snapshot per session

```json
{
  "sessionId": "uuid",
  "tmuxSession": "cc-bugfix",
  "openclawSessionKey": "...",
  "workdir": "/home/georgefu/Projects/uco",
  "logFile": "/home/georgefu/.cache/claude-tasks/cc-bugfix.log",
  "state": "WORKING",
  "lastHookEvent": "PostToolUse",
  "lastHookPayload": { /* full Claude Code hook JSON */ },
  "stateSince": 1750435200,
  "lastSeenAt": 1750435260,
  "budgetMinutes": 30,
  "budgetDeadline": 1750437000,
  "history": [
    { "ts": 1750435200, "state": "WORKING", "event": "PreToolUse", "tool": "Bash" },
    { "ts": 1750435250, "state": "WAITING", "event": "Stop" }
  ]
}
```

The raw origin hook event type (`lastHookEvent`) and full payload (`lastHookPayload`) are stored alongside the derived state, as required. The `logFile` path points at the `tmux pipe-pane` log written by `claude-task` so OpenClaw can extract the latest output for DM summaries.

### 4.2 State derivation rules (v1)

| Claude Code hook | Derived state | Notes |
|---|---|---|
| `SessionStart` | `WORKING` | Session just began/resumed. |
| `UserPromptSubmit` | `WORKING` | New prompt entered. |
| `PreToolUse` / `PostToolUse` | `WORKING` | Tool in progress or just finished. |
| `PostToolUseFailure` | `ERROR` | Tool failed; notify. |
| `PermissionRequest` | `PERMISSION` | Notify (rare with bypass). |
| `Stop` + empty prompt | `WAITING` | Claude finished, ready for input. |
| `Stop` + user still typing | `WORKING` | Likely intermediate stop. |
| `SessionEnd` | `DONE` | Clean exit. |
| No hook for >N seconds + tmux gone | `FATAL` | Detected by a lightweight plugin interval/service, not a separate cron job. |

## 5. Triggering OpenClaw Actions

**No new cron job.** The plugin does not DM the user directly. Instead, it emits internal OpenClaw events and stores state where OpenClaw's existing 2-minute heartbeat (`agents.defaults.heartbeat.every: 2m`) can pick it up.

### 5.1 Why event-driven rather than direct plugin action

- The plugin does not know the user's notification policy or how to summarize Claude Code output into a useful reply.
- OpenClaw already has the USER.md rules, WeCom channel integration, and LLM access.
- Keeps the plugin a dumb state mirror; intelligence and DM composition live in OpenClaw.

### 5.2 Event payload example

```json
{
  "type": "claude-code:stateChanged",
  "sessionId": "uuid",
  "tmuxSession": "cc-bugfix",
  "state": "WAITING",
  "originEvent": "Stop",
  "outputExcerpt": "✓ Tests passed (14/14)",
  "budgetDeadline": 1750437000,
  "notifyUrgency": "normal"
}
```

For "background task finished/ended", the state transitions to `DONE` or `ERROR`; the heartbeat or an event subscriber turns that into a DM if configured.

### 5.3 Output capture for DM summaries

Claude Code hooks do not carry full session output. The plugin stores the `logFile` path from `claude-task` so OpenClaw can tail the last N lines of the `tmux pipe-pane` log when composing a DM. Optionally, the plugin can pre-read a short excerpt and include it in the `claude-code:stateChanged` event.

## 6. Bidirectional Control

Claude Code Remote Control is for human remote access only and has no programmatic API. We use `tmux send-keys` as the practical command injection path.

### 6.1 Control flow

1. OpenClaw agent decides to send a command (e.g., reply to a Claude question, inject a follow-up).
2. OpenClaw calls plugin route: `POST /claude-code/:tmuxSession/send` with JSON body `{ "text": "yes, proceed", "submit": true }`.
3. Plugin validates the tmux session exists and is tracked.
4. Plugin runs: `tmux send-keys -t <session> -l <escaped-text>`.
5. If `submit: true`, plugin appends `Enter`.
6. Plugin returns `{ "sent": true, "sessionId": "..." }`.

### 6.2 Safety guards

- Only allow send-keys to sessions the plugin has registered via a hook.
- Use `tmux send-keys -l` literal mode to avoid meta-sequence injection.
- Rate-limit to prevent spam (configurable per minute).
- Log every injection.

### 6.3 Use cases

- Answer a Claude `PERMISSION` prompt while away.
- Inject a follow-up task when a background job ends.
- Send `Ctrl+C` if budget is exceeded.

## 7. Configuration

### 7.1 OpenClaw plugin config (`~/.openclaw/openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "claude-code-openclaw-plugin": {
        "enabled": true,
        "config": {
          "routePrefix": "/claude-code",
          "eventTypes": ["*"],
          "stateFileDir": "~/.cache/claude-code-hooks",
          "notifyStates": ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"],
          "sendKeysRateLimitPerMinute": 10,
          "sessionTimeoutSeconds": 300
        }
      }
    }
  }
}
```

### 7.2 Claude Code settings (`~/.claude/settings.json` or project `.claude/settings.json`)

```json
{
  "hooks": {
    "url": "http://127.0.0.1:18789/claude-code/hook",
    "events": ["*"]
  }
}
```

### 7.3 `claude-task` changes

`claude-task` remains responsible for spawning the tmux session. It should continue to generate `session_id`, write the state/log files, and start `tmux pipe-pane`. No additional hook setup is required because Claude Code reads `hooks` from `settings.json`.

### 7.4 Plugin entry shape

The plugin currently uses `defineToolPlugin`. To register HTTP routes it will switch to (or extend with) the lower-level `definePluginEntry` lifecycle and expose a `register(api)` function:

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "claude-code-openclaw-plugin",
  name: "Claude Code harness",
  description: "Add Claude Code harness tools to OpenClaw.",
  configSchema: { /* ... */ },
  register(api) {
    api.registerHttpRoute({ path: "/claude-code/hook", auth: "plugin", match: "exact", handler: hookHandler });
    api.registerHttpRoute({ path: "/claude-code/", auth: "plugin", match: "prefix", handler: controlHandler });
  },
});
```

## 8. Security

- The hook route is registered with `auth: "plugin"` on the OpenClaw gateway, so no gateway token is required.
- The gateway itself binds to loopback (`bind: "loopback"` in `openclaw.json`), keeping the endpoint localhost-only.
- No additional token/auth on the hook endpoint — relies on the local machine boundary (per user request).
- Validate hook payload shape; drop unknown events.
- The `/send` endpoint requires the tmux session to be pre-registered by a hook, preventing injection into unrelated tmux sessions.
- Sanitize all input for tmux literal mode.

## 9. Error Handling

- **Hook endpoint failure:** Return 200 quickly so Claude Code doesn't block; log errors locally.
- **Duplicate `session_id`:** Update the existing snapshot rather than create a new one.
- **tmux session missing:** Return 404 on `/send`; OpenClaw can retry or notify the user.
- **State timeout:** If no hook arrives for `sessionTimeoutSeconds` and the tmux session is gone, the plugin's internal interval marks the state `FATAL` and emits an event.
- **Plugin crash on startup:** Log fatal error; OpenClaw surfaces it on the next heartbeat.

## 10. Testing

### 10.1 Unit tests

- State derivation function for every hook type.
- Hook payload validation.
- tmux send-keys escaping.

### 10.2 Integration tests

- Start plugin, POST sample hooks, read state snapshot.
- POST `/send` to a real tmux session and verify keys arrive.

### 10.3 End-to-end test

- Run `claude-task`, confirm hooks reach the plugin, and confirm OpenClaw heartbeat sees the state change.

## 12. Rollout & Setup

### 12.1 Project-level Claude Code settings

Add `.claude/settings.json` to the current project (`claude-code-openclaw-plugin`) so `claude-task` run from this directory automatically sends hooks:

```json
{
  "hooks": {
    "*": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18789/claude-code/hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

For global coverage across all Claude Code sessions, the same config can be placed in `~/.claude/settings.json`.

### 12.2 Activation sequence

1. Implement the HTTP routes in `claude-code-openclaw-plugin`.
2. Add the project `.claude/settings.json` above.
3. Rebuild and reload the OpenClaw plugin.
4. Run `claude-task` from this repo and verify hooks update the plugin state file.

## 13. Decisions & Future Work

- **Pane-scraper fallback:** Not needed. Hooks replace `claude-code-watcher.sh`.
- **WebSocket / SSE:** Not needed. Polling the state store via OpenClaw heartbeat is sufficient.
- **In-memory cache:** Yes. The plugin should keep hot session state in memory and flush to `stateFileDir` asynchronously to reduce disk writes. The cache is rebuilt from disk on plugin startup.

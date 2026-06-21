# v0.2.1 Heartbeat Notification Design

## Goal

Make Claude Code session state visible during OpenClaw heartbeat turns by:
1. Keeping the Claude Code hook client (`.claude/settings.local.json`) a dumb pipe.
2. Centralizing all state-to-behavior mapping inside the plugin.
3. Injecting active session context into heartbeat prompts via `heartbeat_prompt_contribution`.

## Design Principles

- **Hooks endpoint zero logic**: `curl POST .../claude-code/hook` remains unchanged.
- **Plugin-side mapping**: `ClaudeCodeState` → `Behavior` via a single source-of-truth table.
- **Backward compatibility**: existing `notifyStates` config becomes a filter override; default behavior comes from the mapping table.

## Behavior Mapping

| State      | Wake HB | Prompt Inject | Announce DM | Reason |
|------------|---------|---------------|-------------|--------|
| WORKING    | ❌     | —             | ❌          | Background work, no user attention needed |
| WAITING    | ✅     | ⚠️ waiting    | ✅          | Needs user input |
| QUESTION   | ✅     | ⚠️ question   | ✅          | Needs user answer |
| PERMISSION | ✅     | ⚠️ permission | ❌          | Trust dialog handled by Claude Code |
| ERROR      | ✅     | 🚨 error      | ✅          | Tool/run failure |
| DONE       | ✅     | ℹ️ done       | ✅          | Task finished |
| FATAL      | ❌     | 🚨 fatal      | ✅ one-shot | Session timed out; wake won't help |

- **Wake HB**: request an immediate heartbeat run.
- **Prompt Inject**: contribute formatted session lines to the heartbeat prompt via `heartbeat_prompt_contribution`.
- **Announce DM**: enqueue a system event (best-effort DM) when an OpenClaw `sessionKey` is available.
  - The `/claude-code/hook` route does not know the OpenClaw `sessionKey`, so it marks the session as `pendingAnnounce` and wakes the heartbeat.
  - The `heartbeat_prompt_contribution` hook receives the OpenClaw `sessionKey` and flushes pending announcements for that key.
  - FATAL is announced once per session (one-shot guard).

## Files

| File | Change |
|------|--------|
| `src/behavior.ts` | New. `ClaudeCodeBehavior` interface + `STATE_BEHAVIOR` table + helpers to resolve effective behavior honoring `notifyStates`. |
| `src/dispatcher.ts` | New. `BehaviorDispatcher` receives state changes, wakes heartbeat, tracks pending announcements, and flushes them when a `sessionKey` is supplied. |
| `src/context.ts` | Rewrite. `buildClaudeCodeContext` uses `STATE_BEHAVIOR` prompt templates and prefixes (⚠️ / 🚨 / ℹ️). |
| `src/context.test.ts` | Rewrite/extend. Assert context lines include emoji prefixes and behavior-driven templates. |
| `src/routes.ts` | Slim `hook` handler: `applyHook` → `dispatcher.onStateChanged(state)`. No state checks. |
| `src/routes.test.ts` | Update. Assert dispatcher is invoked; remove `requestHeartbeatNow` direct assertions (moved to dispatcher tests). |
| `src/index.ts` | Register `heartbeat_prompt_contribution` hook; wire dispatcher into routes and heartbeat hook. |
| `src/index.test.ts` | Extend. Assert hook registration and contribution output. |
| `src/behavior.test.ts` | New. Assert mapping table and `notifyStates` override. |
| `src/dispatcher.test.ts` | New. Assert wake, pending announce, one-shot FATAL, and flush behavior. |

## Interfaces

```ts
// src/behavior.ts
export type ClaudeCodeBehavior = {
  state: ClaudeCodeState;
  wake: boolean;
  prompt: boolean;
  announce: boolean;
  prefix: string;        // emoji prefix for context lines
  message: string;       // short human-readable label
  oneShotAnnounce?: boolean;
};

export const STATE_BEHAVIOR: Record<ClaudeCodeState, ClaudeCodeBehavior>;

export function resolveBehavior(
  state: ClaudeCodeState,
  notifyStates: ClaudeCodeState[],
): ClaudeCodeBehavior;
```

```ts
// src/dispatcher.ts
export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  flushAnnouncements(sessionKey: string): { text: string; enqueued: boolean }[];
  getPendingAnnounceSessionIds(): string[];
};

export function createBehaviorDispatcher(options: {
  requestHeartbeat: (opts?: { reason?: string }) => void;
  enqueueSystemEvent?: (text: string, opts: { sessionKey: string }) => void;
  getState: (sessionId: string) => SessionState | undefined;
}): BehaviorDispatcher;
```

## Flow

### Hook arrives from Claude Code

1. `POST /claude-code/hook` → `routes.hook`.
2. `store.applyHook(payload)` updates session state.
3. `dispatcher.onStateChanged(state)`:
   - Looks up `resolveBehavior(state.state, config.notifyStates)`.
   - If `behavior.wake`: calls `requestHeartbeat({ reason: "claude-code:<state>" })`.
   - If `behavior.announce`: marks session `pendingAnnounce = true` (one-shot guard for FATAL).
4. Returns `200 { ok: true }`.

### Heartbeat runs and asks for prompt contribution

1. Gateway fires `heartbeat_prompt_contribution` hook.
2. Plugin handler builds context from `store.listStates()` using `buildClaudeCodeContext`.
3. Handler calls `dispatcher.flushAnnouncements(sessionKey)` and enqueues system events for any pending announcements.
4. Returns `{ appendContext: contextString }`.

### Timeout service marks FATAL

1. `store.markFatal(sessionId, reason)` updates state.
2. Timeout service calls `dispatcher.onStateChanged(state)` (or a dedicated `dispatcher.onFatal(state)`).
3. Dispatcher marks FATAL pending announce (one-shot). No wake.

## Configuration

`notifyStates` remains in `pluginConfigSchema` with the same default. It acts as a coarse filter:
- If a state is **not** in `notifyStates`, `resolveBehavior` returns `wake=false`, `prompt=false`, `announce=false` regardless of the table.
- If a state is in `notifyStates`, the table's flags are used.

This preserves existing user configs while making `STATE_BEHAVIOR` the source of truth for defaults.

## Testing

- `behavior.test.ts`: table correctness, `notifyStates` override, invalid state handling.
- `dispatcher.test.ts`: wake called for WAITING/QUESTION/ERROR/DONE; no wake for WORKING/FATAL; pending announce tracking; one-shot FATAL; flush enqueues system event.
- `context.test.ts`: context includes emoji prefixes and behavior messages; WORKING omitted; FATAL included.
- `routes.test.ts`: hook handler delegates to dispatcher; no direct `requestHeartbeatNow` call in routes.
- `index.test.ts`: `heartbeat_prompt_contribution` registered; handler returns expected appendContext format.

## Acceptance Criteria

- `npm run build` passes.
- Existing 62 tests + new tests pass.
- Smoke test: simulate WAITING/DONE/ERROR hooks and verify `heartbeat_prompt_contribution` output matches the mapping table.
- No changes to `.claude/settings.local.json`.
- v0.2.0 commit `0ca2fc7` kept as-is.
- No push.

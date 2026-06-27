# Per-Caller Notification Routing

## Problem

Today the plugin notifies a single global `targetSessionKey` (default `agent:main:main`) for every Claude Code session it spawns. Two consequences make notifications unreliable for the user's actual workflow:

1. **All notifications collide on `agent:main:main`.** When the user is talking to `agent:main:main`, `getSize("main") > 0` on the global command lane (`heartbeat-runner-Df4cCdpO.js:964`), every wake heartbeat is skipped, and the event sits in the queue until the next user turn. The user wants the LLM to actively respond — webhooks are not acceptable.

2. **No route back to the caller's channel.** If a WeCom-integrated agent (`agent:wecom:user-001`) spawns a Claude Code task on the user's behalf, the result currently goes to `agent:main:main`, which has no path back to the WeCom user. The webhook escape hatch exists but isn't what we want — we want the LLM to compose a contextual reply.

Additionally, intermediate states (`WAITING`, `PERMISSION`, `QUESTION`, `ERROR`) enqueue plain text instead of `exec completed (...)` format, so even when the heartbeat does run, `isExecCompletionEvent` returns false, `resolveHeartbeatRunPrompt` returns null, and the agent never generates a reply (`heartbeat-runner-Df4cCdpO.js:866-925`).

## Solution

Capture the caller's `sessionKey` and `deliveryContext` at tool invocation time using OpenClaw's documented `OpenClawPluginToolFactory` pattern, persist both in `SessionState`, and route hook-driven notifications back to that exact session/channel. This is the same mechanism `bash` background tasks use (`bash-tools-Bvyb7cWG.js:2760` `notifySessionKey = defaults?.sessionKey` — `defaults` populated per agent in `agent-tools-XUrUI5bQ.js:2725-2773`).

Webhook delivery is removed. The `notifyStates` config field (declared but never read) is removed.

Intermediate states are unified with terminal states: both emit `exec completed (claude-code-<id>, code 0) :: <body>` text and call `requestHeartbeatNow({source:"hook"})`, so `isExecCompletionEvent → buildExecEventPrompt → agent reply` works uniformly.

## SDK foundations (verified against `openclaw/plugin-sdk/types-B70zVumi.d.ts`)

```ts
// 8623
registerTool: (tool: AnyAgentTool | OpenClawPluginToolFactory, opts?) => void

// 2403
type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => AnyAgentTool

// 2370
type OpenClawPluginToolContext = {
  sessionKey?: string;          // caller agent session
  deliveryContext?: DeliveryContext;  // caller channel/to/threadId
  agentId?: string;
  // ...
}

// plugin-sdk/system-events-BLt5iC5_.d.ts
declare function enqueueSystemEvent(
  text: string,
  options: { sessionKey: string; contextKey?: string; deliveryContext?: DeliveryContext },
): boolean
```

`deliveryContext` shape (`plugin-sdk/delivery-context.types-DyNhFIjW.d.ts`):
```ts
type DeliveryContext = {
  channel?: string;    // e.g. "wecom"
  to?: string;         // channel-local destination id
  accountId?: string;
  threadId?: string | number;
  deliveryIntent?: { id: string; kind: "outbound_queue"; queuePolicy?: ... };
}
```

ACP's spawn path (`acp-spawn-BEA0VnCe.js:282`) already proves this routes back to the originating channel when `deliveryContext` is passed through.

## Data flow

```
Caller agent invokes claude_code_spawn
  ↓
Tool factory closure has captured:
  - ctx.sessionKey       e.g. "agent:wecom:user-001"
  - ctx.deliveryContext  e.g. {channel:"wecom", to:"user-001", accountId:"ww123"}
  ↓
spawnSession() runs, then calls store.setNotifyContext(sessionId, {
  notifySessionKey, notifyDeliveryContext
})
  ↓
SessionState persisted to <stateFileDir>/<sessionId>.json (survives restart)
  ↓
Claude Code hook arrives at POST /claude-code/hook
  → store.applyHook(payload) → state transition
  → taskRegistry.onStateTransition(state)  // signature now takes full state
      ↓
      target = state.notifySessionKey ?? config.defaultNotifySessionKey
      enqueueSystemEvent(execCompletedText, {
        sessionKey: target,
        contextKey: `task:claude-code:${sessionId}`,
        deliveryContext: state.notifyDeliveryContext,   // ★
      })
      requestHeartbeatNow({ source:"hook", sessionKey: target, agentId: parse(target) })
  ↓
heartbeat-runner wakes target session
  → isExecCompletionEvent ✓ → buildExecEventPrompt ✓
  → target agent LLM generates "Claude Code finished ..., here's what happened ..."
  → reply routes via deliveryContext back to WeCom user
```

## Components

### 1. `src/config.ts`

- **Rename** `targetSessionKey` → `defaultNotifySessionKey` (default `agent:main:main` for backward compat with single-user setups).
- **Remove** `wecomWebhookUrl` (functionality removed).
- **Remove** `notifyStates` (never read by code — `NOTIFY_STATES`/`TERMINAL_STATES` are hardcoded sets in task-registry).

No backward-compat alias for `targetSessionKey` — this is a 0.x plugin, version bump to 0.8.0, breaking change documented in README.

### 2. `src/state.ts`

Extend `SessionState`:

```ts
type SessionState = {
  // existing fields ...
  notifySessionKey?: string;       // captured from caller; replaces requesterSessionKey
  notifyDeliveryContext?: DeliveryContext;  // captured from caller
};
```

`DeliveryContext` is imported from `openclaw/plugin-sdk/types`. Both fields are persisted by `store` (JSON.stringify already handles them — they're plain serializable objects).

**Remove** old `requesterSessionKey` field. It was only ever set by `store.setRequesterContext`, which we replace with `setNotifyContext`.

### 3. `src/store.ts`

Rename `setRequesterContext` → `setNotifyContext`, signature:

```ts
function setNotifyContext(
  sessionId: string,
  params: {
    runId: string;
    notifySessionKey: string;
    notifyDeliveryContext?: DeliveryContext;
  },
): void
```

Field semantics:
- `runId` stays as-is (we already use `sessionId === runId`).
- `notifySessionKey`: where to enqueue events and wake.
- `notifyDeliveryContext`: channel route hint for OpenClaw's delivery router.

### 4. `src/task-registry.ts`

`onStateTransition` signature changes from a flat object to taking the full `SessionState`:

```ts
type TaskRegistry = {
  createTask(...): void;
  onStateTransition(state: SessionState): void;
};

type TaskRegistryDeps = {
  enqueueSystemEvent: (text: string, opts: {
    sessionKey: string;
    contextKey: string;
    deliveryContext?: DeliveryContext;   // ★ new
  }) => boolean;
  requestHeartbeatNow: (opts: { source: string; intent: string; reason: string; sessionKey: string; agentId?: string }) => void;
  defaultNotifySessionKey: string;       // ★ renamed from requesterSessionKey
  log?: (text: string) => void;
};
```

Inside `onStateTransition`:

```ts
const target = state.notifySessionKey ?? defaultNotifySessionKey;
const agentId = target.split(":")[1] ?? "";
const deliveryContext = state.notifyDeliveryContext;
// ... build exec-completion text per state ...
enqueueSystemEvent(text, { sessionKey: target, contextKey, deliveryContext });
wake(reason, { sessionKey: target, agentId });
```

**All notify states use exec-completion format.** Replace the two-branch split (TERMINAL vs NOTIFY) with one unified path:

| state | verb | exitCode | mood | wake? |
|---|---|---|---|---|
| DONE | completed | code 0 | finished | yes |
| FATAL | failed | code 1 | timed out | yes |
| WAITING | completed | code 0 | needs attention (waiting) | yes |
| PERMISSION | completed | code 0 | needs attention (permission) | yes |
| QUESTION | completed | code 0 | needs attention (question) | yes |
| ERROR | completed | code 0 | needs attention (error) | yes |

Why `code 0` for intermediate states: `code 1` makes `buildExecEventPrompt` say "failed", which is wrong for "task is paused waiting for input". The body text carries the actual semantic.

`seenStates` deduplication is **kept** for intermediate states (`WAITING:sessionId` key) so a chatty `Stop` hook doesn't spam — but it's reset when the state moves out of intermediate (otherwise we'd miss a re-entry into WAITING).

Actually simpler: keep `seenStates` as-is per `(sessionId, state)` pair. A genuinely new state transition produces a new key. Re-entering WAITING with the same sessionId is unusual, and if it happens, the agent already knows. Don't over-engineer.

### 5. `src/spawn.ts`

Add to `SpawnDeps`:
```ts
notifySessionKey?: string;             // captured from ctx
notifyDeliveryContext?: DeliveryContext;  // captured from ctx
```

After successful spawn, replace:
```ts
if (taskRegistry && requesterSessionKey) taskRegistry.createTask({...})
```
with:
```ts
store.setNotifyContext(sessionId, {
  runId: sessionId,
  notifySessionKey: notifySessionKey ?? defaultNotifySessionKey,
  notifyDeliveryContext,
});
```

The `taskRegistry.createTask` call is a no-op today (the function body is empty per `task-registry.ts:72`). Remove it.

### 6. `src/index.ts` — the actual factory wiring

All seven tools become factories. The setup-hooks/status/stop/read/send/restore tools don't need caller info today, but converting them too keeps the registration call site uniform — and gives us room to use `ctx.sessionKey` for per-caller scoping later (e.g. "list only sessions I spawned").

```ts
api.registerTool((ctx) =>
  createClaudeCodeSpawnTool({
    permissionMode: config.permissionMode,
    store,
    defaultNotifySessionKey: config.defaultNotifySessionKey,
    notifySessionKey: ctx.sessionKey,
    notifyDeliveryContext: ctx.deliveryContext,
  }),
);

// status/stop/read/send/restore/setup-hooks:
api.registerTool((_ctx) => createClaudeCodeStatusTool(store));
// etc.
```

`taskReg` no longer needs `requesterSessionKey` at construction time — it reads from the state passed into `onStateTransition`. So:

```ts
const taskReg = createTaskRegistry({
  enqueueSystemEvent: (text, opts) =>
    api.runtime.system.enqueueSystemEvent(text, opts),  // passes through deliveryContext
  requestHeartbeatNow: (opts) =>
    api.runtime.system.requestHeartbeatNow(opts),
  defaultNotifySessionKey: config.defaultNotifySessionKey,
  log: (t) => api.logger?.info?.(t),
});
```

Remove the entire `onTerminalState` webhook block (`src/index.ts:97-111`).

### 7. HTTP routes

`POST /claude-code/spawn` (the HTTP route mirror of the tool) has no `ctx` — it's not a tool call. Body may include optional `notifySessionKey` and `notifyDeliveryContext` fields. If absent, fall back to `defaultNotifySessionKey`. This preserves the route for external integrations (curl, scripts, other plugins).

`POST /claude-code/hook` is unchanged — it only consumes hooks, doesn't initiate.

## Backward compatibility & migration

This is a 0.x → 0.x change. Breaking:
- Config field renamed (`targetSessionKey` → `defaultNotifySessionKey`)
- Config fields removed (`wecomWebhookUrl`, `notifyStates`)
- `SessionState.requesterSessionKey` → `notifySessionKey` + new `notifyDeliveryContext`

Existing state files on disk: when `store.loadFromDisk()` reads them, missing `notifySessionKey` is treated as undefined → falls back to `defaultNotifySessionKey` at notify time. No migration step needed. The unused `requesterSessionKey` field on disk is ignored harmlessly.

Bump plugin version to `0.8.0`. README documents the breaking change.

## Testing strategy

New unit tests:
- `state.test.ts`: `SessionState` shape includes `notifySessionKey`, `notifyDeliveryContext`.
- `store.test.ts`: `setNotifyContext` writes both fields; `loadFromDisk` round-trips them.
- `task-registry.test.ts`: 
  - `onStateTransition(state)` reads `state.notifySessionKey`, falls back to default when undefined.
  - Passes `deliveryContext` through to `enqueueSystemEvent`.
  - All notify states (WAITING/QUESTION/PERMISSION/ERROR/DONE/FATAL) produce `exec completed` or `exec failed` text matching the `isExecCompletionEvent` regex.
  - Wake is called for every notified state.
  - `seenStates` dedup works for intermediate states.
- `spawn.test.ts`: when `notifySessionKey` is passed in, `store.setNotifyContext` is called with it; otherwise default is used.
- `index.test.ts`: tool registration uses factory; factory invoked with `{sessionKey, deliveryContext}` produces a tool that delegates correctly.

Integration test: simulate a hook → state transition → assert `enqueueSystemEvent` is called with the right `sessionKey` + `deliveryContext` + exec-format text.

Tests we delete:
- Any test asserting on `requesterSessionKey` field name.
- Webhook-related tests (`onTerminalState` callback, wecom POST formatting).
- `notifyStates` config tests.

## Edge cases

- **HTTP spawn with no notifySessionKey**: falls back to `defaultNotifySessionKey` with no `deliveryContext` — delivery context will be absent, OpenClaw uses session's default channel route. Documented in README.
- **Caller's sessionKey changes (session reset)**: the spawned Claude Code session keeps the old `notifySessionKey`. This matches `bash` background task behavior (captured at spawn). Result lands in a stale session — acceptable, same trade-off everywhere else.
- **`agent:main:main` is busy (getSize("main") > 0)**: still happens for callers on the main session. Not solvable from the plugin side. Document that callers on dedicated sessions get instant delivery, while `main` users may see delayed delivery on their next turn. Users wanting reliable push set up a dedicated notification session (e.g. `agent:notifications:claude-code`) as `defaultNotifySessionKey`.
- **DeliveryContext omitted by caller**: OpenClaw falls back to the target session's stored channel route. Functions correctly without it.
- **Tool factory called with `ctx.sessionKey === undefined`** (e.g. cold-boot context): tool still works, `notifySessionKey` becomes undefined → falls back to default at notify time.

## Non-goals

- Migrating to the agent-harness-task-runtime SDK (deferred — the spec at `2026-06-26-task-registry-notification-design.md` covers that, separate effort).
- Changing the hook event set or state machine transitions.
- Adding `gatewayMethodDispatch` (requires SDK scope we don't have, per `docs/openclaw-background-task-notification.md` §4.1).

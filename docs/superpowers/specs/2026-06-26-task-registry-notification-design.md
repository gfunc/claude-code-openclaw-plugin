# Replace Dispatcher with Task-Registry Notifications

## Problem

The dispatcher path (`enqueueSystemEvent` + `requestHeartbeatNow` with `cron:` contextKey + `source:"exec-event"`) never reliably wakes the frontend agent. Two root causes:

1. **Heartbeat-runner suppresses output.** Model receives cron-event prompt, replies `HEARTBEAT_OK`. Runner's `stripHeartbeatToken` sets `shouldSkip=true`, `showOk:false` default suppresses the ack. User sees nothing.

2. **Flood guard throttles re-fires.** 5 runs in 60s trips the guard. Our 10s re-fire produces 6/min, all deferred after first batch.

The heartbeat-runner is designed for scheduled polling with agent discretion — not for event-driven "background task needs attention" notifications.

## Solution

Replace the dispatcher entirely with OpenClaw's `agent-harness-task-runtime` SDK. This is the documented surface for CLI-based agent harnesses (`TaskRuntime = "cli"`). The task-registry handles delivery through `maybeDeliverTaskTerminalUpdate` / `maybeDeliverTaskStateChangeUpdate` — the same path bash-bg, detached tasks, and ACP subagents use.

## Data flow

```
claude_code_spawn tool
  → spawnSession() assigns runId = sessionId
  → createHarnessTask({runId, task, label:tmuxSession, notifyPolicy:"state_changes"})

Hook POST /claude-code/hook
  → store.applyHook(payload) → state transitions
  → if state changed to WAITING/QUESTION/PERMISSION (first transition only):
      recordProgress({runId, eventSummary:"session is waiting for input"})
  → if state changed to DONE:
      finalizeTask({runId, endedAt, status:"succeeded"})
      deliverCompletion({result: last_assistant_message})

timeout service (FATAL)
  → finalizeTask({runId, endedAt, status:"timed_out"})
  → deliverCompletion({result: fatalReason})

claude_code_stop
  → finalizeTask({runId, endedAt, status:"cancelled"})
```

## Components

### 1. `src/task-registry.ts` (new)

Thin wrapper around `openclaw/plugin-sdk/agent-harness-task-runtime`:

- `createHarnessTask(params)` — `createRunningTaskRun` with `runtime:"cli"`, owner/requester from config.targetSessionKey, `scopeKind:"session"`, `notifyPolicy:"state_changes"`
- `recordProgress(params)` — `recordTaskRunProgressByRunId`
- `finalizeAndDeliver(params)` — `finalizeTaskRunByRunId` then `deliverAgentHarnessTaskCompletion` with result text
- `createHarnessScope()` — builds `AgentHarnessTaskRuntimeScope` from config.targetSessionKey

### 2. SessionState additions

Two new fields:
- `runId?: string` — task-registry run id (= sessionId)
- `requesterSessionKey?: string` — from config.targetSessionKey

### 3. spawn.ts changes

After successful spawn, calls `createHarnessTask()` to register in task-registry. Sets `runId` and `requesterSessionKey` on the session state (via store).

### 4. routes.ts::hook changes

After `store.applyHook`, if state transitioned to a notify-state:
- WAITING/QUESTION/PERMISSION (first transition) → `recordProgress()`
- DONE → `finalizeAndDeliver()` with `last_assistant_message` as result

First-transition guard: check `state.history` — only fire if this is the first entry with this state (no prior entry in history has the same state).

### 5. timeout service changes

On FATAL → `finalizeAndDeliver()` with `fatalReason` as result. Remove the re-fire dispatcher call.

### 6. stop.ts changes

On manual stop → `finalizeAndDeliver()` with status "cancelled".

## What we remove

- `src/dispatcher.ts` — entire file
- `src/behavior.ts` — only used by dispatcher
- `src/dispatcher.test.ts`
- `dispatcher` construction + wiring from `src/index.ts`
- `dispatcher.onStateChanged()` from `src/routes.ts::hook`
- Peek/queue instrumentation added during debugging

## What stays

- `src/store.ts`, `src/state.ts` — hook state machine unchanged
- `src/tools.ts` (`claude_code_status`) — unchanged, reads in-memory store
- `src/spawn.ts`, `src/stop.ts` — core logic stays, task-registry calls at edges
- `src/routes.ts` — route wiring stays, hook handler updated
- `src/index.ts` — timeout service updated, dispatcher section removed

## Notification behavior

| Hook event | State transition | Action |
|---|---|---|
| Stop | WAITING (first time) | `recordProgress(eventSummary)` |
| Stop | WAITING (again) | no-op |
| Elicitation | QUESTION (first time) | `recordProgress(eventSummary)` |
| PermissionRequest | PERMISSION (first time) | `recordProgress(eventSummary)` |
| SessionEnd | DONE | `finalizeAndDeliver(result)` |
| PostToolUseFailure | ERROR | `recordProgress(eventSummary)` |
| Timeout | FATAL | `finalizeAndDeliver(fatalReason)` |
| Manual stop | — | `finalizeAndDeliver(status:"cancelled")` |

## Delivery mechanism

Task-registry's `maybeDeliverTaskTerminalUpdate` for terminal states: steers into active ACP/embedded turn, falls back to direct channel send, falls back to system-event queue with `source:"background-task"` + `contextKey:"task:<taskId>"`.

`deliverAgentHarnessTaskCompletion` wraps the result text as an agent internal event and calls `deliverSubagentAnnouncement` — the same push path media generation uses. This surfaces the CC session's `last_assistant_message` to the requester agent with a reply instruction.

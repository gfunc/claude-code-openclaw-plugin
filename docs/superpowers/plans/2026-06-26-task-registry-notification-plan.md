# Task-Registry Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken dispatcher/heartbeat notification path with OpenClaw's `agent-harness-task-runtime` SDK, making Claude Code sessions behave as background tasks that wake the frontend session on state changes.

**Architecture:** New `src/task-registry.ts` wraps `openclaw/plugin-sdk/agent-harness-task-runtime`. Spawn creates a task record (`runtime:"cli"`, `notifyPolicy:"state_changes"`). Hook handler calls progress/finalize functions on state transitions. Dispatcher and behavior modules deleted entirely.

**Tech Stack:** TypeScript, OpenClaw plugin SDK (`agent-harness-task-runtime`), zod, typebox

---

### Task 1: Create `src/task-registry.ts`

**Files:**
- Create: `src/task-registry.ts`
- Create: `src/task-registry.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/task-registry.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "./state.js";

// We mock the SDK module so we can verify calls without a running gateway.
vi.mock("openclaw/plugin-sdk/agent-harness-task-runtime", () => ({
  createAgentHarnessTaskRuntime: vi.fn(() => ({
    createRunningTaskRun: vi.fn(() => ({ runId: "test-run", taskId: "task-1" })),
    recordTaskRunProgressByRunId: vi.fn(() => [{ runId: "test-run" }]),
    finalizeTaskRunByRunId: vi.fn(() => [{ runId: "test-run" }]),
  })),
  deliverAgentHarnessTaskCompletion: vi.fn(() => Promise.resolve({ delivered: true, path: "direct" })),
}));

import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createTaskRegistry } from "./task-registry.js";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "sid-1",
    state: "WORKING",
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: "sid-1" },
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
    ...overrides,
  };
}

describe("createTaskRegistry", () => {
  const requesterSessionKey = "agent:main:main";

  it("creates a harness task on createTask", () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const record = registry.createTask({
      runId: "run-1",
      task: "do something",
      label: "cc-test",
    });
    expect(record).toBeDefined();
    expect(record.runId).toBe("test-run");
  });

  it("records progress for a notify-state transition", () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const state = makeState({ state: "WAITING", runId: "run-1", requesterSessionKey });
    registry.onStateTransition(state, "WORKING");
    // Should fire progress since WORKING -> WAITING is a notify transition
    const rt = vi.mocked(createAgentHarnessTaskRuntime).mock.results[0].value;
    expect(rt.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1" }),
    );
  });

  it("does not fire progress for non-notify transitions", () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const state = makeState({ state: "WORKING", runId: "run-1", requesterSessionKey });
    registry.onStateTransition(state, "WORKING");
    const rt = vi.mocked(createAgentHarnessTaskRuntime).mock.results[0].value;
    expect(rt.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
  });

  it("does not re-fire for same state transition twice", () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const state = makeState({
      state: "WAITING",
      runId: "run-1",
      requesterSessionKey,
      history: [
        { ts: 1, state: "WORKING", event: "UserPromptSubmit" },
        { ts: 2, state: "WAITING", event: "Stop" },
        { ts: 3, state: "WORKING", event: "UserPromptSubmit" },
        { ts: 4, state: "WAITING", event: "Stop" },
      ],
    });
    registry.onStateTransition(state, "WORKING");
    const rt = vi.mocked(createAgentHarnessTaskRuntime).mock.results[0].value;
    expect(rt.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
  });

  it("finalizes and delivers for terminal states", async () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const state = makeState({
      state: "DONE",
      runId: "run-1",
      requesterSessionKey,
      lastHookPayload: {
        hook_event_name: "SessionEnd",
        session_id: "sid-1",
        last_assistant_message: "all done",
      },
    });
    await registry.onStateTransition(state, "WAITING");
    const rt = vi.mocked(createAgentHarnessTaskRuntime).mock.results[0].value;
    expect(rt.finalizeTaskRunByRunId).toHaveBeenCalled();
    expect(deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "all done" }),
    );
  });

  it("skips when state has no runId", () => {
    const registry = createTaskRegistry({ requesterSessionKey });
    const state = makeState({ state: "WAITING" }); // no runId
    registry.onStateTransition(state, "WORKING");
    const rt = vi.mocked(createAgentHarnessTaskRuntime).mock.results[0].value;
    expect(rt.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/task-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/task-registry.ts
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { SessionState, ClaudeCodeHookPayload } from "./state.js";

export type TaskRegistry = ReturnType<typeof createTaskRegistry>;

// States that trigger a progress/finalize update to the requester session.
const NOTIFY_STATES = new Set(["WAITING", "QUESTION", "PERMISSION", "ERROR"]);
const TERMINAL_STATES = new Set(["DONE", "FATAL"]);

export function createTaskRegistry(opts: {
  requesterSessionKey: string;
}) {
  const { requesterSessionKey } = opts;

  const harness: AgentHarnessTaskRuntime = createAgentHarnessTaskRuntime({
    runtime: "cli",
    scope: { requesterSessionKey },
    taskKind: "claude-code",
    runIdPrefix: "",
  });

  function createTask(params: {
    runId: string;
    task: string;
    label?: string;
  }): ReturnType<AgentHarnessTaskRuntime["createRunningTaskRun"]> {
    return harness.createRunningTaskRun({
      runId: params.runId,
      task: params.task,
      label: params.label ?? params.runId,
      notifyPolicy: "state_changes",
    });
  }

  // ponytail: global lock; per-state mutex if multiple CC sessions fire simultaneously
  const seenStates = new Set<string>(); // `${sessionId}:${state}`

  async function onStateTransition(
    state: SessionState,
    prevState: string,
  ): Promise<void> {
    if (!state.runId || !state.requesterSessionKey) return;

    const key = `${state.sessionId}:${state.state}`;

    if (TERMINAL_STATES.has(state.state)) {
      try {
        harness.finalizeTaskRunByRunId({
          runId: state.runId,
          endedAt: state.stateSince,
          status: state.state === "FATAL" ? "timed_out" : "succeeded",
          terminalSummary: extractResultText(state.lastHookPayload),
        });
      } catch (err) {
        console.error("claude-code: finalizeTaskRunByRunId failed:", err);
      }

      try {
        await deliverAgentHarnessTaskCompletion({
          scope: { requesterSessionKey },
          childSessionKey: `claude-code:${state.sessionId}`,
          childSessionId: state.sessionId,
          announceId: `claude-code:${state.sessionId}:${state.state.toLowerCase()}`,
          status: state.state === "FATAL" ? "failed" : "succeeded",
          statusLabel: state.state === "FATAL"
            ? state.fatalReason ?? "Timed out"
            : "Completed",
          result: extractResultText(state.lastHookPayload)
            || `Claude Code session ${state.tmuxSession ?? state.sessionId} ${state.state === "FATAL" ? "timed out" : "finished"}.`,
          taskLabel: state.tmuxSession,
          announceType: "Claude Code session",
        });
      } catch (err) {
        console.error("claude-code: deliverAgentHarnessTaskCompletion failed:", err);
      }
      return;
    }

    if (!NOTIFY_STATES.has(state.state)) return;
    if (seenStates.has(key)) return;
    seenStates.add(key);

    try {
      harness.recordTaskRunProgressByRunId({
        runId: state.runId,
        eventSummary: `session ${state.tmuxSession ?? state.sessionId} is ${state.state.toLowerCase()}`,
      });
    } catch (err) {
      console.error("claude-code: recordTaskRunProgressByRunId failed:", err);
    }
  }

  return { createTask, onStateTransition };
}

function extractResultText(payload: ClaudeCodeHookPayload): string | undefined {
  const msg = payload.last_assistant_message;
  if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 2000);
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/task-registry.test.ts`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/task-registry.ts src/task-registry.test.ts
git commit -m "feat: add task-registry wrapper for agent-harness-task-runtime"
```

---

### Task 2: Add `runId` and `requesterSessionKey` to `SessionState`

**Files:**
- Modify: `src/state.ts`
- Modify: `src/store.ts`

- [ ] **Step 1: Add fields to SessionState type**

In `src/state.ts`, add to `SessionState`:

```typescript
export type SessionState = {
  sessionId: string;
  tmuxSession?: string;
  openclawSessionKey?: string;
  workdir?: string;
  logFile?: string;
  state: ClaudeCodeState;
  lastHookEvent: ClaudeCodeHookName;
  lastHookPayload: ClaudeCodeHookPayload;
  stateSince: number;
  lastSeenAt: number;
  budgetMinutes?: number;
  budgetDeadline?: number;
  fatalReason?: string;
  // task-registry fields
  runId?: string;
  requesterSessionKey?: string;
  history: Array<{
    ts: number;
    state: ClaudeCodeState;
    event: ClaudeCodeHookName;
    tool?: string;
  }>;
};
```

- [ ] **Step 2: Add `setRequesterContext` to the Store**

In `src/store.ts`, add after `getState()`:

```typescript
function setRequesterContext(
  sessionId: string,
  runId: string,
  requesterSessionKey: string,
): void {
  const state = sessions.get(sessionId);
  if (state) {
    state.runId = runId;
    state.requesterSessionKey = requesterSessionKey;
    scheduleFlush();
  }
}

function setRequesterContextForId(
  sessionId: string,
  update: { runId?: string; requesterSessionKey?: string },
): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  if (update.runId !== undefined) state.runId = update.runId;
  if (update.requesterSessionKey !== undefined) state.requesterSessionKey = update.requesterSessionKey;
  scheduleFlush();
}
```

Add to the return object:
```typescript
return {
  applyHook,
  markFatal,
  getState,
  listStates,
  loadFromDisk,
  dispose,
  setRequesterContext,
  setRequesterContextForId,
};
```

Update `SessionStore` type:
```typescript
export type SessionStore = {
  applyHook: (payload: ..., discover?: ...) => Promise<SessionState>;
  markFatal: (sessionId: string, reason: string) => SessionState | undefined;
  getState: (sessionId: string) => SessionState | undefined;
  listStates: () => SessionState[];
  loadFromDisk: () => Promise<number>;
  dispose: () => Promise<void>;
  setRequesterContext: (sessionId: string, runId: string, requesterSessionKey: string) => void;
  setRequesterContextForId: (sessionId: string, update: { runId?: string; requesterSessionKey?: string }) => void;
};
```

- [ ] **Step 3: Update existing store tests that check SessionState**

In `src/store.test.ts`, verify a test exists that sets and reads requester context. No change needed if existing tests don't assert on new fields — they're optional.

Run: `npx vitest run src/store.test.ts`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/state.ts src/store.ts
git commit -m "feat: add runId and requesterSessionKey to SessionState and Store"
```

---

### Task 3: Integrate task creation in `spawn.ts`

**Files:**
- Modify: `src/spawn.ts`

- [ ] **Step 1: Add `taskRegistry` to SpawnDeps and wire into spawnSession**

In `src/spawn.ts`, after the existing `SpawnDeps` type:

```typescript
import type { TaskRegistry } from "./task-registry.js";

export type SpawnDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
  uuid?: () => string;
  sleepMs?: number;
  taskRegistry?: TaskRegistry;
  requesterSessionKey?: string;
};
```

In `spawnSession`, after the successful state write (line ~160, right after `await writeState(stateFile, stateLine)`):

```typescript
// Register as a background task so the requester session gets notified
// on state changes (WAITING, DONE, etc.).
if (taskRegistry && requesterSessionKey) {
  taskRegistry.createTask({
    runId: sessionId,
    task: task,
    label: tmuxSession,
  });
}
```

Return `sessionId` as `runId` in the result so it's available for state mapping:

```typescript
return {
  success: true,
  tmuxSession,
  sessionId,
  runId: sessionId,
  budgetMinutes,
  workdir,
  logFile,
  stateFile,
};
```

- [ ] **Step 2: Update spawn tool to pass taskRegistry and requesterSessionKey**

`createClaudeCodeSpawnTool` needs to accept and forward a `taskRegistry` + `requesterSessionKey`. Add to its config:

```typescript
export function createClaudeCodeSpawnTool(config?: {
  permissionMode?: ClaudePermissionMode;
  taskRegistry?: TaskRegistry;
  requesterSessionKey?: string;
}): AnyAgentTool {
```

In the `execute` function, pass through to `spawnSession`:

```typescript
async execute(_toolCallId: string, params: unknown) {
  const { tmuxSession, task, budgetMinutes, workdir } = params as { ... };
  const result = await spawnSession({
    tmuxSession,
    task,
    budgetMinutes,
    permissionMode: config?.permissionMode,
    workdir,
    taskRegistry: config?.taskRegistry,
    requesterSessionKey: config?.requesterSessionKey,
  });
  return jsonResult(result);
}
```

- [ ] **Step 3: Run existing spawn tests**

Run: `npx vitest run src/spawn.test.ts`
Expected: All tests pass (taskRegistry is optional, omitted in tests)

- [ ] **Step 4: Update integration test expectations if needed**

Run: `npx vitest run src/integration.test.ts`
Expected: PASS (task registry calls optional)

- [ ] **Step 5: Commit**

```bash
git add src/spawn.ts
git commit -m "feat: integrate task-registry creation into spawn flow"
```

---

### Task 4: Wire task-registry into hook handler and timeout service

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/index.ts`
- Modify: `src/stop.ts`

- [ ] **Step 1: Replace dispatcher call in routes.ts::hook**

In `src/routes.ts`, replace the `dispatcher` import and usage:

Remove:
```typescript
import type { BehaviorDispatcher } from "./dispatcher.js";
```

Add:
```typescript
import type { TaskRegistry } from "./task-registry.js";
```

Replace `dispatcher?: BehaviorDispatcher` with `taskRegistry?: TaskRegistry` in the options.

In the `hook` function, replace:
```typescript
const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
dispatcher?.onStateChanged(state);
```

With:
```typescript
const prevState = store.getState(payload.session_id);
const wasNew = !prevState;
const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));

// If this is a new session and we have a requester context, set it on the store.
// The spawn tool writes requesterSessionKey + runId; hooks that arrive before
// the spawn function returns are handled by the store's setRequesterContextForId
// which is idempotent.

// On state transition, notify via task-registry.
if (taskRegistry) {
  await taskRegistry.onStateTransition(state, prevState?.state ?? "");
}
```

- [ ] **Step 2: Wire task-registry in index.ts**

In `src/index.ts`:

Remove dispatcher import and construction:
```typescript
// REMOVE:
import { createBehaviorDispatcher } from "./dispatcher.js";
```

Add task-registry import:
```typescript
import { createTaskRegistry } from "./task-registry.js";
```

Replace dispatcher construction with task-registry construction:
```typescript
// REMOVE all createBehaviorDispatcher({...}) code block

// ADD:
const taskReg = createTaskRegistry({
  requesterSessionKey: config.targetSessionKey,
});
```

Update the routes call to pass `taskRegistry` instead of `dispatcher`:
```typescript
const routes = createClaudeCodeRoutes({
  store,
  config,
  taskRegistry: taskReg,  // was: dispatcher
  discoverSession: async (sessionId) => discoverSession({ sessionId }),
  sendKeys: async ({ tmuxSession, text, submit, keys }) => { ... },
});
```

Update tool creation to pass taskRegistry:
```typescript
api.registerTool(createClaudeCodeSpawnTool({
  permissionMode: config.permissionMode,
  taskRegistry: taskReg,
  requesterSessionKey: config.targetSessionKey,
}));
```

- [ ] **Step 3: Update timeout service**

In `src/index.ts` timeout service, replace the re-fire dispatcher call with task-registry:

Remove:
```typescript
// REMOVE the re-fire block:
if (
  config.notifyStates.includes(state.state) &&
  now - state.stateSince > REFIRE_AFTER_MS &&
  now - state.stateSince < timeoutMs
) {
  api.logger?.info(
    `claude-code: re-fire wake sessionId=${state.sessionId}...`,
  );
  dispatcher.onStateChanged(state);
}
```

Replace the FATAL handler to also finalize the task. After `dispatcher.onStateChanged(updated)`:

```typescript
// ALSO REMOVE: dispatcher.onStateChanged(updated);

// ADD task-registry finalization for FATAL:
if (updated) {
  taskReg.onStateTransition(updated, "WORKING").catch(() => {});
}
```

- [ ] **Step 4: Wire task-registry into stop.ts**

In `src/stop.ts`, add `taskRegistry` as an optional dep. After `stopSession` kills the tmux session and writes STOPPED:

```typescript
import type { TaskRegistry } from "./task-registry.js";
// ... in stopSession params:
taskRegistry?: TaskRegistry;
// ... after writing STOPPED:
if (taskRegistry) {
  try {
    await taskRegistry.onStateTransition({
      sessionId: sessionName,
      state: "DONE",
      // ... minimal session state, or use a dedicated finalize method
    }, "WORKING");
  } catch { /* best-effort */ }
}
```

But `stopSession` doesn't have a `SessionState` — only a `sessionName` (tmux name). We'd need to look it up. Simpler: **skip stop.ts task finalization for now.** The hook handler handles DONE via SessionEnd, and the timeout service handles FATAL. Manual `claude_code_stop` kills the tmux session — CC fires SessionEnd hook before dying, which triggers DONE through the hook handler. If CC is already dead, the timeout service catches the stall.

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: At least 105+ tests pass (we remove dispatcher tests later)

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts src/index.ts src/stop.ts
git commit -m "feat: wire task-registry into hook handler and timeout service"
```

---

### Task 5: Remove dispatcher and behavior

**Files:**
- Delete: `src/dispatcher.ts`
- Delete: `src/dispatcher.test.ts`
- Delete: `src/behavior.ts`
- Delete (if exists): `src/behavior.test.ts`
- Modify: `src/routes.ts` (remove dead TypeBox import if any)
- Modify: `src/index.ts` (remove dead imports)
- Modify: `src/stop.ts` (remove BehaviorDispatcher ref if any)

- [ ] **Step 1: Remove dispatcher files**

```bash
rm src/dispatcher.ts src/dispatcher.test.ts
```

- [ ] **Step 2: Remove behavior files**

```bash
rm src/behavior.ts
```

If `src/behavior.test.ts` exists:
```bash
rm src/behavior.test.ts
```

- [ ] **Step 3: Clean any remaining references**

```bash
grep -rn "dispatcher\|behavior" src/ --include="*.ts" | grep -v node_modules | grep -v task-registry
```

If `routes.ts` still has `BehaviorDispatcher` import line, remove it.  
If `stop.ts` references any dispatcher types, remove them.  
If `index.ts` has the `dispatcher` const or the `REFIRE_AFTER_MS`/`WATCHDOG_TICK_MS` constants left from the re-fire path, remove them.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All remaining tests pass (estimate ~90-95 tests after removing dispatcher/behavior tests)

- [ ] **Step 6: Commit**

```bash
git add -u src/
git commit -m "chore: remove dispatcher and behavior modules"
```

---

### Task 6: E2E verification

No code changes — verify the full chain works end-to-end.

- [ ] **Step 1: Build and restart gateway**

```bash
cd ~/Projects/claude-code-openclaw-plugin
npm run build
openclaw gateway restart
sleep 8
```

- [ ] **Step 2: Inject Stop hook and verify task-registry logs**

```bash
curl -s -X POST http://127.0.0.1:18789/claude-code/hook \
  -H "content-type: application/json" \
  -d '{"hook_event_name":"Stop","session_id":"e2e-test-001","cwd":"/tmp","last_assistant_message":"task complete, here are the results"}'
```

- [ ] **Step 3: Check OpenClaw log for task-registry activity**

```bash
grep -E "claude-code|task.*cli|delivery|announce" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -20
```

Expected: No crashes, task finalization logged (possibly at debug level).

- [ ] **Step 4: Verify via agent's session — did the notification reach the prompt?**

Check `~/.openclaw/agents/main/sessions/*.jsonl` for a task-completion entry (system event with `"task completion"` content). Or wait for the next wecom heartbeat and check for "task complete" text in the message.

- [ ] **Step 5: Verify state file written**

```bash
cat ~/.cache/claude-code-hooks/e2e-test-001.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['state'], d.get('runId'), d.get('requesterSessionKey'))"
```

Expected: shows `WAITING` and `null` for runId/requesterSessionKey (no spawn preceded this hook, so task wasn't created — expected).

- [ ] **Step 6: Final commit if any cleanup needed**

---

### Task 7: Remove debug instrumentation

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Remove peekSystemEventEntries instrumentation added during debugging**

Remove the `peekSystemEventEntries` import and the peek logging inside `enqueueSystemEvent` callback. This instrumentation was added during the debugging session and is no longer needed since we're removing the dispatcher entirely.

Remove:
```typescript
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
```
And the `peek` block inside `enqueueSystemEvent`.

- [ ] **Step 2: Build and test**

Run: `npm run build && npx vitest run`
Expected: Build clean, tests pass

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "chore: remove peek-system-events debug instrumentation"
```

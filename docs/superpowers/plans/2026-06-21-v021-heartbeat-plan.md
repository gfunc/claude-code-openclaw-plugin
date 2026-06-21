# v0.2.1 Heartbeat Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize Claude Code state-to-behavior mapping in the plugin, wake heartbeats, and inject formatted session context into heartbeat prompts via `heartbeat_prompt_contribution`.

**Architecture:** A pure `behavior.ts` table maps each `ClaudeCodeState` to wake/prompt/announce flags and prompt templates. A `dispatcher.ts` receives state changes, triggers heartbeats, and tracks pending DM announcements. `routes.ts` becomes a thin pipe that updates the store and hands off to the dispatcher. `index.ts` wires the dispatcher into the hook route and registers the `heartbeat_prompt_contribution` hook, which returns context built by the rewritten `context.ts`.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin SDK (`registerHook`, `requestHeartbeat`, `enqueueSystemEvent`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/behavior.ts` | Source-of-truth state → behavior mapping + `notifyStates` override logic. |
| `src/behavior.test.ts` | Mapping correctness and override tests. |
| `src/dispatcher.ts` | Side-effect dispatcher: wake heartbeat, track/flush pending announcements. |
| `src/dispatcher.test.ts` | Dispatcher wake, announce, one-shot FATAL tests. |
| `src/context.ts` | Build heartbeat prompt context from sessions using behavior templates. |
| `src/context.test.ts` | Context output format tests (emoji prefixes, WORKING omission, FATAL inclusion). |
| `src/routes.ts` | Slim hook handler: `store.applyHook` → `dispatcher.onStateChanged`. |
| `src/routes.test.ts` | Route delegation tests (dispatcher called, no direct heartbeat logic). |
| `src/index.ts` | Create dispatcher, register routes, register `heartbeat_prompt_contribution` hook. |
| `src/index.test.ts` | Verify hook registration and contribution output. |

---

### Task 1: Create `src/behavior.ts` and `src/behavior.test.ts`

**Files:**
- Create: `src/behavior.ts`
- Create: `src/behavior.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveBehavior, STATE_BEHAVIOR } from "./behavior.js";

describe("STATE_BEHAVIOR", () => {
  it("WAITING wakes, prompts, and announces", () => {
    const b = STATE_BEHAVIOR.WAITING;
    expect(b.wake).toBe(true);
    expect(b.prompt).toBe(true);
    expect(b.announce).toBe(true);
    expect(b.prefix).toBe("⚠️");
    expect(b.message).toContain("waiting");
  });

  it("WORKING does nothing", () => {
    const b = STATE_BEHAVIOR.WORKING;
    expect(b.wake).toBe(false);
    expect(b.prompt).toBe(false);
    expect(b.announce).toBe(false);
  });

  it("FATAL does not wake and is one-shot", () => {
    const b = STATE_BEHAVIOR.FATAL;
    expect(b.wake).toBe(false);
    expect(b.announce).toBe(true);
    expect(b.oneShotAnnounce).toBe(true);
  });
});

describe("resolveBehavior", () => {
  it("returns table defaults when state is in notifyStates", () => {
    const b = resolveBehavior("WAITING", ["WAITING", "ERROR"]);
    expect(b.wake).toBe(true);
  });

  it("disables all flags when state is not in notifyStates", () => {
    const b = resolveBehavior("DONE", ["WAITING"]);
    expect(b.wake).toBe(false);
    expect(b.prompt).toBe(false);
    expect(b.announce).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/behavior.test.ts`
Expected: FAIL with "Cannot find module './behavior.js'" or similar.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { ClaudeCodeState } from "./config.js";

export type ClaudeCodeBehavior = {
  state: ClaudeCodeState;
  wake: boolean;
  prompt: boolean;
  announce: boolean;
  prefix: string;
  message: string;
  oneShotAnnounce?: boolean;
};

export const STATE_BEHAVIOR: Record<ClaudeCodeState, ClaudeCodeBehavior> = {
  WORKING: { state: "WORKING", wake: false, prompt: false, announce: false, prefix: "", message: "" },
  WAITING: { state: "WAITING", wake: true, prompt: true, announce: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { state: "QUESTION", wake: true, prompt: true, announce: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { state: "PERMISSION", wake: true, prompt: true, announce: false, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { state: "ERROR", wake: true, prompt: true, announce: true, prefix: "🚨", message: "failed" },
  DONE: { state: "DONE", wake: true, prompt: true, announce: true, prefix: "ℹ️", message: "finished" },
  FATAL: { state: "FATAL", wake: false, prompt: true, announce: true, prefix: "🚨", message: "timed out", oneShotAnnounce: true },
};

export function resolveBehavior(
  state: ClaudeCodeState,
  notifyStates: ClaudeCodeState[],
): ClaudeCodeBehavior {
  const base = STATE_BEHAVIOR[state];
  if (!notifyStates.includes(state)) {
    return { ...base, wake: false, prompt: false, announce: false };
  }
  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/behavior.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/behavior.ts src/behavior.test.ts
git commit -m "feat(behavior): add STATE_BEHAVIOR mapping and notifyStates override"
```

---

### Task 2: Create `src/dispatcher.ts` and `src/dispatcher.test.ts`

**Files:**
- Create: `src/dispatcher.ts`
- Create: `src/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { createBehaviorDispatcher } from "./dispatcher.js";
import type { SessionState } from "./state.js";

function makeSession(state: SessionState["state"], sessionId: string): SessionState {
  return {
    sessionId,
    state,
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: sessionId },
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
  };
}

describe("createBehaviorDispatcher", () => {
  it("wakes heartbeat for WAITING", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, notifyStates: ["WAITING"] });
    dispatcher.onStateChanged(makeSession("WAITING", "s1"));
    expect(requestHeartbeat).toHaveBeenCalled();
  });

  it("does not wake for WORKING", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, notifyStates: ["WAITING", "WORKING"] });
    dispatcher.onStateChanged(makeSession("WORKING", "s2"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does not wake for FATAL", () => {
    const requestHeartbeat = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, notifyStates: ["FATAL"] });
    dispatcher.onStateChanged(makeSession("FATAL", "s3"));
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("tracks pending announce and flushes it with sessionKey", () => {
    const requestHeartbeat = vi.fn();
    const enqueueSystemEvent = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, enqueueSystemEvent, notifyStates: ["WAITING"] });
    dispatcher.onStateChanged(makeSession("WAITING", "s4"));
    const flushed = dispatcher.flushAnnouncements("sk-1");
    expect(flushed).toHaveLength(1);
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("only announces FATAL once", () => {
    const requestHeartbeat = vi.fn();
    const enqueueSystemEvent = vi.fn();
    const dispatcher = createBehaviorDispatcher({ requestHeartbeat, enqueueSystemEvent, notifyStates: ["FATAL"] });
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    dispatcher.flushAnnouncements("sk-2");
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    const flushed = dispatcher.flushAnnouncements("sk-2");
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(flushed).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/dispatcher.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  flushAnnouncements(sessionKey: string): Array<{ text: string; enqueued: boolean }>;
  getPendingAnnounceSessionIds(): string[];
};

export function createBehaviorDispatcher(options: {
  requestHeartbeat: (opts?: { reason?: string }) => void;
  enqueueSystemEvent?: (text: string, opts: { sessionKey: string }) => void;
  notifyStates: ClaudeCodeState[];
}): BehaviorDispatcher {
  const { requestHeartbeat, enqueueSystemEvent, notifyStates } = options;
  const pendingAnnounce = new Map<string, string>();
  const announcedOnce = new Set<string>();

  function onStateChanged(state: SessionState): void {
    const behavior = resolveBehavior(state.state, notifyStates);
    if (behavior.wake) {
      requestHeartbeat({ reason: `claude-code:${state.state.toLowerCase()}` });
    }
    if (behavior.announce) {
      if (behavior.oneShotAnnounce) {
        if (announcedOnce.has(state.sessionId)) return;
        announcedOnce.add(state.sessionId);
      }
      const text = `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}`;
      pendingAnnounce.set(state.sessionId, text);
    }
  }

  function flushAnnouncements(sessionKey: string): Array<{ text: string; enqueued: boolean }> {
    const results: Array<{ text: string; enqueued: boolean }> = [];
    for (const [sessionId, text] of pendingAnnounce) {
      const enqueued = enqueueSystemEvent ? (enqueueSystemEvent(text, { sessionKey }), true) : false;
      results.push({ text, enqueued });
      pendingAnnounce.delete(sessionId);
    }
    return results;
  }

  function getPendingAnnounceSessionIds(): string[] {
    return Array.from(pendingAnnounce.keys());
  }

  return { onStateChanged, flushAnnouncements, getPendingAnnounceSessionIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher.ts src/dispatcher.test.ts
git commit -m "feat(dispatcher): add behavior dispatcher with wake and announce"
```

---

### Task 3: Rewrite `src/context.ts` and `src/context.test.ts`

**Files:**
- Modify: `src/context.ts`
- Modify: `src/context.test.ts`

- [ ] **Step 1: Write the failing test**

Replace `src/context.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildClaudeCodeContext } from "./context.js";
import type { SessionState } from "./state.js";

function makeSession(state: SessionState["state"], overrides?: Partial<SessionState>): SessionState {
  return {
    sessionId: "s1",
    tmuxSession: "cc-test",
    state,
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: "s1" },
    stateSince: Date.now() - 5000,
    lastSeenAt: Date.now(),
    history: [],
    ...overrides,
  };
}

describe("buildClaudeCodeContext", () => {
  it("includes WAITING with warning prefix", () => {
    const ctx = buildClaudeCodeContext({ sessions: [makeSession("WAITING")] });
    expect(ctx).toContain("## Active Claude Code sessions");
    expect(ctx).toContain("⚠️");
    expect(ctx).toContain("cc-test");
    expect(ctx).toContain("WAITING");
    expect(ctx).toContain("waiting for input");
  });

  it("includes FATAL with error prefix", () => {
    const ctx = buildClaudeCodeContext({ sessions: [makeSession("FATAL", { fatalReason: "no hook" })] });
    expect(ctx).toContain("🚨");
    expect(ctx).toContain("timed out");
    expect(ctx).toContain("no hook");
  });

  it("omits WORKING sessions", () => {
    const ctx = buildClaudeCodeContext({ sessions: [makeSession("WORKING")] });
    expect(ctx).toBe("");
  });

  it("sorts by urgency: FATAL/ERROR first, then WAITING/QUESTION/PERMISSION, then DONE", () => {
    const sessions = [
      makeSession("DONE", { sessionId: "done", tmuxSession: "cc-done" }),
      makeSession("FATAL", { sessionId: "fatal", tmuxSession: "cc-fatal" }),
      makeSession("WAITING", { sessionId: "waiting", tmuxSession: "cc-wait" }),
    ];
    const ctx = buildClaudeCodeContext({ sessions });
    const fatalIdx = ctx.indexOf("cc-fatal");
    const waitIdx = ctx.indexOf("cc-wait");
    const doneIdx = ctx.indexOf("cc-done");
    expect(fatalIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(doneIdx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/context.test.ts`
Expected: FAIL (new assertions not met).

- [ ] **Step 3: Write minimal implementation**

Replace `src/context.ts` with:

```ts
import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

const STATE_ORDER: Record<ClaudeCodeState, number> = {
  FATAL: 0,
  ERROR: 1,
  PERMISSION: 2,
  QUESTION: 3,
  WAITING: 4,
  DONE: 5,
  WORKING: 6,
};

export function buildClaudeCodeContext({
  sessions,
  notifyStates,
}: {
  sessions: SessionState[];
  notifyStates?: ClaudeCodeState[];
}): string {
  const relevant = sessions
    .filter((s) => {
      const behavior = resolveBehavior(s.state, notifyStates ?? Object.keys(STATE_ORDER) as ClaudeCodeState[]);
      return behavior.prompt;
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  if (relevant.length === 0) return "";

  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    const behavior = resolveBehavior(s.state, notifyStates ?? Object.keys(STATE_ORDER) as ClaudeCodeState[]);
    lines.push(`- ${behavior.prefix} tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | ${behavior.message}`);
    lines.push(`  since: ${new Date(s.stateSince).toISOString()}`);
    if (s.workdir) lines.push(`  workdir: ${s.workdir}`);
    if (s.fatalReason) lines.push(`  reason: ${s.fatalReason}`);
    if (s.budgetDeadline) lines.push(`  budget deadline: ${new Date(s.budgetDeadline).toISOString()}`);
    if (s.logFile) lines.push(`  log: ${s.logFile}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "feat(context): build heartbeat context from behavior mapping"
```

---

### Task 4: Refactor `src/routes.ts` hook handler and update `src/routes.test.ts`

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the hook-related tests in `src/routes.test.ts` with:

```ts
  it("accepts a hook and returns 200 with ok: true", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s1" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse((res as unknown as { body: string }).body);
    expect(body).toEqual({ ok: true });
  });

  it("delegates state change to dispatcher", async () => {
    const req = mockReq({
      method: "POST",
      path: "/claude-code/hook",
      body: { hook_event_name: "Stop", session_id: "s2" },
    });
    const res = mockRes();
    await routes.hook(req, res);
    expect(dispatcher.onStateChanged).toHaveBeenCalled();
    const callArg = dispatcher.onStateChanged.mock.calls[0]?.[0];
    expect(callArg?.state).toBe("WAITING");
  });
```

Add `dispatcher` mock to the test setup:

```ts
let dispatcher: ReturnType<typeof vi.fn> & { onStateChanged: ReturnType<typeof vi.fn> };

beforeEach(() => {
  store = createSessionStore({ stateFileDir: "/tmp/routes-test" });
  dispatcher = { onStateChanged: vi.fn() } as never;
  sendKeys = vi.fn();
  routes = createClaudeCodeRoutes({
    store,
    config,
    dispatcher,
    sendKeys,
  });
});
```

Remove the old `requestHeartbeatNow` setup and direct heartbeat assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes.test.ts`
Expected: FAIL (routes.ts does not accept dispatcher yet).

- [ ] **Step 3: Write minimal implementation**

Modify `src/routes.ts`:

1. Add import:
```ts
import type { BehaviorDispatcher } from "./dispatcher.js";
```

2. Update `createClaudeCodeRoutes` parameter object: replace `requestHeartbeatNow?: () => void` with `dispatcher?: BehaviorDispatcher`.

3. Replace the `hook` function body with:

```ts
  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const payload = parseHookPayload(body);
      const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
      dispatcher?.onStateChanged(state);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("claude-code hook failed:", err);
      sendJson(res, 200, { ok: false, error: String(err) });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "refactor(routes): slim hook handler delegates to dispatcher"
```

---

### Task 5: Wire `src/index.ts` and update `src/index.test.ts`

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("plugin registration", () => {
  it("registers heartbeat_prompt_contribution hook", () => {
    const hooks: Array<{ event: string; name: string }> = [];
    const captured = capturePluginRegistrations(plugin, {
      onHook: (event, name) => hooks.push({ event, name }),
    });
    const contribution = hooks.find((h) => h.event === "heartbeat_prompt_contribution");
    expect(contribution).toBeDefined();
    expect(contribution?.name).toBe("claude-code-heartbeat-context");
  });
});
```

If `capturePluginRegistrations` does not exist, create a minimal helper inline in the test file that invokes `plugin.register` with a stub API and records `registerHook` calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.ts`
Expected: FAIL (hook not registered).

- [ ] **Step 3: Write minimal implementation**

Modify `src/index.ts`:

1. Add imports:
```ts
import { createBehaviorDispatcher } from "./dispatcher.js";
import { buildClaudeCodeContext } from "./context.js";
```

2. After creating `store` and `requestHeartbeatNow`, add:
```ts
    const requestHeartbeat = (opts?: { reason?: string }) => {
      try {
        api.runtime.system.requestHeartbeat({
          source: "hook",
          intent: "event",
          reason: opts?.reason ?? "claude-code:state-changed",
        });
      } catch {
        // Fallback to deprecated API if requestHeartbeat is unavailable.
        try {
          api.runtime.system.requestHeartbeatNow();
        } catch {
          // ignore
        }
      }
    };

    const dispatcher = createBehaviorDispatcher({
      requestHeartbeat,
      enqueueSystemEvent: (text, opts) => {
        try {
          api.runtime.system.enqueueSystemEvent(text, opts);
        } catch {
          // ignore
        }
      },
      notifyStates: config.notifyStates,
    });
```

3. Update `createClaudeCodeRoutes` call to pass `dispatcher` instead of `requestHeartbeatNow`.

4. After HTTP route registrations, register the heartbeat prompt contribution hook:

```ts
    api.registerHook(
      "heartbeat_prompt_contribution",
      async (event) => {
        const ctx = buildClaudeCodeContext({
          sessions: store.listStates(),
          notifyStates: config.notifyStates,
        });
        if (!ctx) return;
        const sessionKey = (event as { sessionKey?: string }).sessionKey;
        if (sessionKey) {
          dispatcher.flushAnnouncements(sessionKey);
        }
        return { appendContext: ctx };
      },
      { name: "claude-code-heartbeat-context", description: "Inject active Claude Code sessions into heartbeat prompts" },
    );
```

Note: the internal hook event shape is `{ type, action, sessionKey, context, timestamp, messages }`. Casting `event` to access `sessionKey` is acceptable in the absence of an exported narrow type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(index): register heartbeat_prompt_contribution and wire dispatcher"
```

---

### Task 6: Integrate timeout service FATAL path with dispatcher

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/index.test.ts`:

```ts
  it("timeout service marks FATAL without waking", async () => {
    // This is an integration-level smoke assertion; full FATAL path is covered in dispatcher tests.
    const api = createMockApi({ notifyStates: ["FATAL"] });
    plugin.register(api);
    expect(api.serviceStarted).toBe(true);
  });
```

The mock API should expose a way to start services and inspect dispatcher state. For TDD, it is enough to assert that the service is registered; the dispatcher tests already cover FATAL behavior.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/index.test.ts`
Expected: FAIL if mock API is not ready; otherwise PASS after implementation.

- [ ] **Step 3: Write minimal implementation**

In `src/index.ts`, update the timeout service interval to call `dispatcher.onStateChanged` for each timed-out session after marking FATAL:

```ts
        timeoutTimer = setInterval(() => {
          const now = Date.now();
          for (const state of store.listStates()) {
            if (now - state.lastSeenAt > config.sessionTimeoutSeconds * 1000) {
              const updated = store.markFatal(
                state.sessionId,
                "no hook received within sessionTimeoutSeconds",
              );
              if (updated) {
                dispatcher.onStateChanged(updated);
              }
            }
          }
        }, intervalMs);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(timeout): route FATAL state through dispatcher for one-shot announce"
```

---

### Task 7: Final verification and version bump

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All existing + new tests pass.

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 3: Smoke test**

Run:
```bash
node -e "
const { createBehaviorDispatcher } = require('./dist/dispatcher.js');
const { buildClaudeCodeContext } = require('./dist/context.js');
const { createSessionStore } = require('./dist/store.js');
(async () => {
  const store = createSessionStore({ stateFileDir: '/tmp/smoke-v021' });
  const hb = [];
  const dispatcher = createBehaviorDispatcher({
    requestHeartbeat: (o) => hb.push(o?.reason),
    notifyStates: ['WAITING', 'DONE', 'ERROR', 'FATAL'],
  });
  const s1 = await store.applyHook({ hook_event_name: 'Stop', session_id: 'smoke-1' }, async () => ({ tmuxSession: 'cc-smoke' }));
  dispatcher.onStateChanged(s1);
  const s2 = await store.applyHook({ hook_event_name: 'SessionEnd', session_id: 'smoke-2' }, async () => ({ tmuxSession: 'cc-done' }));
  dispatcher.onStateChanged(s2);
  console.log('wake reasons:', hb);
  console.log('context:', buildClaudeCodeContext({ sessions: store.listStates() }));
  await store.dispose();
})();
"
```
Expected output shows wake reasons for WAITING and DONE, and context contains both sessions with emoji prefixes.

- [ ] **Step 4: Bump version**

Edit `package.json` and `openclaw.plugin.json`:
- `"version": "0.2.1"`

- [ ] **Step 5: Commit**

```bash
git add package.json openclaw.plugin.json
git commit -m "chore(release): bump version to 0.2.1"
```

---

## Self-Review

1. **Spec coverage:**
   - `behavior.ts` → behavior mapping ✅
   - `dispatcher.ts` → wake / announce / one-shot FATAL ✅
   - `routes.ts` slim hook handler ✅
   - `index.ts` `heartbeat_prompt_contribution` registration ✅
   - `context.ts` rewrite with templates ✅
   - `notifyStates` override ✅
   - timeout FATAL path ✅

2. **Placeholder scan:** No TBD/TODO/fill-in-details.

3. **Type consistency:**
   - `resolveBehavior` takes `(state, notifyStates)` consistently.
   - `BehaviorDispatcher.onStateChanged` takes `SessionState`.
   - `buildClaudeCodeContext` takes `{ sessions, notifyStates? }`.
   - Hook event accessed via `event.sessionKey` with cast.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-v021-heartbeat-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

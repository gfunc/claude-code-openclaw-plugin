# Per-Caller Notification Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Claude Code hook notifications back to the agent session that spawned the task (instead of a hardcoded global session), and unify intermediate/terminal state delivery so the receiving LLM always generates a user-visible reply.

**Architecture:** Use OpenClaw's `OpenClawPluginToolFactory` to capture the caller's `sessionKey` + `deliveryContext` at tool-invocation time, persist them in `SessionState`, and pass them through to `enqueueSystemEvent`/`requestHeartbeatNow` on hook transitions. All notify states (WAITING/QUESTION/PERMISSION/ERROR/DONE/FATAL) emit `exec completed (...)` format so `heartbeat-runner` generates a prompt the LLM responds to. Webhook delivery removed.

**Tech Stack:** TypeScript, OpenClaw plugin SDK (`openclaw/plugin-sdk/plugin-entry`), Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-06-27-per-caller-notification-routing-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/config.ts` | modify | Rename `targetSessionKey` → `defaultNotifySessionKey`, remove `wecomWebhookUrl`, remove `notifyStates` |
| `src/state.ts` | modify | Add `notifySessionKey`, `notifyDeliveryContext` to `SessionState`; drop `requesterSessionKey` |
| `src/store.ts` | modify | Replace `setRequesterContext` with `setNotifyContext` |
| `src/task-registry.ts` | rewrite | `onStateTransition(state)` reads route from state; unify intermediate + terminal branches; pass `deliveryContext` |
| `src/spawn.ts` | modify | Accept `notifySessionKey`/`notifyDeliveryContext` in `SpawnDeps`, call `store.setNotifyContext` |
| `src/routes.ts` | modify | Hook handler stops calling `setRequesterContext`; spawn route accepts `notifySessionKey` body field |
| `src/index.ts` | modify | Register tools as factories, capture `ctx.sessionKey`/`ctx.deliveryContext`; drop webhook block |
| `src/context.ts` | modify | Remove `notifyStates` parameter (config field gone) |
| `openclaw.plugin.json` | modify | Update configSchema (drop old fields, rename), bump version to `0.8.0` |
| `README.md` | modify | Document new config keys, breaking changes, removal of webhook |
| `package.json` | modify | Bump version to `0.8.0` |
| Existing test files | modify | Update to new API; delete webhook/notifyStates tests |

---

## Type Definitions (used across multiple tasks)

These are the canonical shapes — every task that touches them must match.

```ts
// imported from openclaw plugin SDK
import type { DeliveryContext } from "openclaw/plugin-sdk/plugin-entry";

// SessionState additions (state.ts)
type SessionState = {
  // ... existing fields ...
  notifySessionKey?: string;
  notifyDeliveryContext?: DeliveryContext;
  // REMOVED: requesterSessionKey
};

// store API change (store.ts)
function setNotifyContext(
  sessionId: string,
  params: {
    runId: string;
    notifySessionKey: string;
    notifyDeliveryContext?: DeliveryContext;
  },
): void;

// task-registry API change (task-registry.ts)
type TaskRegistry = {
  createTask(params: { runId: string; task: string; label?: string }): void;
  onStateTransition(state: SessionState): void;  // full SessionState now
};

type TaskRegistryDeps = {
  enqueueSystemEvent: (text: string, opts: {
    sessionKey: string;
    contextKey: string;
    deliveryContext?: DeliveryContext;
  }) => boolean;
  requestHeartbeatNow: (opts: {
    source: string; intent: string; reason: string; sessionKey: string; agentId?: string;
  }) => void;
  defaultNotifySessionKey: string;
  log?: (text: string) => void;
};
```

---

## Task 1: Config rename, drop dead fields

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Update config.test.ts to expect new shape**

Read `src/config.test.ts` first. Replace any `targetSessionKey` assertion with `defaultNotifySessionKey`, delete `wecomWebhookUrl` assertions and `notifyStates` assertions. Then add:

```ts
it("renames targetSessionKey → defaultNotifySessionKey with main:main default", () => {
  const cfg = resolvePluginConfig({});
  expect(cfg.defaultNotifySessionKey).toBe("agent:main:main");
});

it("rejects unknown config field wecomWebhookUrl", () => {
  // wecomWebhookUrl is no longer in schema; passing it should be stripped or rejected.
  // We use z.object(...) without .passthrough() — Zod strips by default.
  // If the schema is strict, change to expect.toThrow.
  const cfg = resolvePluginConfig({ wecomWebhookUrl: "https://example.com" });
  expect((cfg as Record<string, unknown>).wecomWebhookUrl).toBeUndefined();
});

it("rejects unknown config field notifyStates", () => {
  const cfg = resolvePluginConfig({ notifyStates: ["WAITING"] });
  expect((cfg as Record<string, unknown>).notifyStates).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `defaultNotifySessionKey` doesn't exist on cfg, possibly TypeScript compile error too.

- [ ] **Step 3: Update src/config.ts**

Replace the `pluginConfigSchema` definition with:

```ts
export const pluginConfigSchema = z.object({
  routePrefix: z.string().default("/claude-code"),
  eventTypes: z.array(z.string()).default(["*"]),
  stateFileDir: z.string().default("~/.cache/claude-code-hooks"),
  sendKeysRateLimitPerMinute: z.number().int().positive().default(10),
  sessionTimeoutSeconds: z.number().int().positive().default(300),
  defaultNotifySessionKey: z.string().default("agent:main:main"),
  permissionMode: ClaudePermissionMode.default("bypassPermissions"),
  debugLog: z.boolean().default(false),
});
```

Keep the `ClaudeCodeState` and `ClaudePermissionMode` exports untouched. `expandTilde` and `resolvePluginConfig` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "config: rename targetSessionKey → defaultNotifySessionKey, drop dead fields"
```

---

## Task 2: SessionState shape change

**Files:**
- Modify: `src/state.ts`
- Modify: `src/state.test.ts`

- [ ] **Step 1: Inspect existing state.test.ts**

Run: `cat src/state.test.ts | grep -n requesterSessionKey`
Note any references. Plan to remove or rename them.

- [ ] **Step 2: Write failing test for new fields**

Append to `src/state.test.ts`:

```ts
import type { SessionState } from "./state.js";

describe("SessionState shape", () => {
  it("supports notifySessionKey and notifyDeliveryContext as optional fields", () => {
    const s: SessionState = {
      sessionId: "x",
      state: "WORKING",
      lastHookEvent: "SessionStart",
      lastHookPayload: { hook_event_name: "SessionStart", session_id: "x" },
      stateSince: 0,
      lastSeenAt: 0,
      history: [],
      notifySessionKey: "agent:wecom:user-1",
      notifyDeliveryContext: { channel: "wecom", to: "user-1" },
    };
    expect(s.notifySessionKey).toBe("agent:wecom:user-1");
    expect(s.notifyDeliveryContext?.channel).toBe("wecom");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/state.test.ts`
Expected: FAIL — TypeScript compile error: `Property 'notifySessionKey' does not exist on type 'SessionState'`.

- [ ] **Step 4: Update src/state.ts**

At the top, add the import:

```ts
import type { DeliveryContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ClaudeCodeState } from "./config.js";
```

Replace the `SessionState` type definition with:

```ts
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
  // notification routing — captured at spawn from tool factory ctx
  runId?: string;
  notifySessionKey?: string;
  notifyDeliveryContext?: DeliveryContext;
  history: Array<{
    ts: number;
    state: ClaudeCodeState;
    event: ClaudeCodeHookName;
    tool?: string;
  }>;
};
```

(Removed: `requesterSessionKey`.)

`deriveState`, `buildInitialState`, `applyHook` unchanged.

- [ ] **Step 5: Verify import path for DeliveryContext**

Run: `node -e "const t = require('openclaw/plugin-sdk/plugin-entry'); console.log(Object.keys(t).filter(k => k.includes('Delivery')))"`
Expected: should not error. If `DeliveryContext` is not exported as a runtime value, that's fine — we only use it as a type, so it lives in `.d.ts`. Confirm the type resolves by running the compile check:

Run: `npx tsc --noEmit`
Expected: PASS (no compile errors).

- [ ] **Step 6: Run state tests to verify they pass**

Run: `npx vitest run src/state.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/state.ts src/state.test.ts
git commit -m "state: add notifySessionKey + notifyDeliveryContext, drop requesterSessionKey"
```

---

## Task 3: Store setNotifyContext

**Files:**
- Modify: `src/store.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Inspect store.test.ts for old setRequesterContext usage**

Run: `grep -n setRequesterContext src/store.test.ts`
Note the test names. They become the basis for new tests.

- [ ] **Step 2: Write failing test for setNotifyContext**

In `src/store.test.ts`, replace existing `setRequesterContext` test(s) (if any) with:

```ts
describe("setNotifyContext", () => {
  it("stores notifySessionKey and notifyDeliveryContext on the session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });
    await store.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-x",
    } as ClaudeCodeHookPayload);

    store.setNotifyContext("sid-x", {
      runId: "sid-x",
      notifySessionKey: "agent:wecom:user-7",
      notifyDeliveryContext: { channel: "wecom", to: "user-7", accountId: "ww1" },
    });

    const s = store.getState("sid-x")!;
    expect(s.runId).toBe("sid-x");
    expect(s.notifySessionKey).toBe("agent:wecom:user-7");
    expect(s.notifyDeliveryContext).toEqual({
      channel: "wecom", to: "user-7", accountId: "ww1",
    });
  });

  it("is a no-op when sessionId is unknown", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const store = createSessionStore({ stateFileDir: dir });
    expect(() => store.setNotifyContext("nope", {
      runId: "nope",
      notifySessionKey: "agent:main:main",
    })).not.toThrow();
    expect(store.getState("nope")).toBeUndefined();
  });

  it("persists notifySessionKey across loadFromDisk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "store-"));
    const a = createSessionStore({ stateFileDir: dir, flushDebounceMs: 0 });
    await a.applyHook({
      hook_event_name: "SessionStart",
      session_id: "sid-roundtrip",
    } as ClaudeCodeHookPayload);
    a.setNotifyContext("sid-roundtrip", {
      runId: "sid-roundtrip",
      notifySessionKey: "agent:wecom:user-1",
      notifyDeliveryContext: { channel: "wecom", to: "user-1" },
    });
    await a.dispose();  // flushes

    const b = createSessionStore({ stateFileDir: dir });
    const count = await b.loadFromDisk();
    expect(count).toBeGreaterThanOrEqual(1);
    const s = b.getState("sid-roundtrip")!;
    expect(s.notifySessionKey).toBe("agent:wecom:user-1");
    expect(s.notifyDeliveryContext?.channel).toBe("wecom");
  });
});
```

(Make sure imports at the top of `store.test.ts` include `fs`, `path`, `os`, and `ClaudeCodeHookPayload` — match existing test style; if these already exist in the file, don't duplicate.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL — `setNotifyContext` doesn't exist on store; possibly TS compile error.

- [ ] **Step 4: Update src/store.ts**

Replace the `setRequesterContext` function definition (around line 134-145) with:

```ts
function setNotifyContext(
  sessionId: string,
  params: {
    runId: string;
    notifySessionKey: string;
    notifyDeliveryContext?: DeliveryContext;
  },
): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  state.runId = params.runId;
  state.notifySessionKey = params.notifySessionKey;
  state.notifyDeliveryContext = params.notifyDeliveryContext;
  scheduleFlush();
}
```

Add the `DeliveryContext` import at the top:

```ts
import type { DeliveryContext } from "openclaw/plugin-sdk/plugin-entry";
```

Update the returned object at the bottom: replace `setRequesterContext` with `setNotifyContext` in the export literal.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store.test.ts`
Expected: PASS (the three new tests). Existing tests should still pass.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "store: replace setRequesterContext with setNotifyContext"
```

---

## Task 4: task-registry — unified branch + delivery routing

**Files:**
- Rewrite: `src/task-registry.ts`
- Modify: `src/task-registry.test.ts`

- [ ] **Step 1: Write failing tests for new behavior**

Replace the contents of `src/task-registry.test.ts` with the file shown below. This covers: routing from state, deliveryContext pass-through, fallback to default, exec-completion format on every notify state, wake on every notify state, dedup, agentId derivation.

```ts
// @ts-nocheck — vitest mock.calls typing doesn't narrow after toHaveBeenCalled()
import { describe, expect, it, vi } from "vitest";
import { createTaskRegistry } from "./task-registry.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sid-1",
    tmuxSession: "cc-test",
    state: "WAITING",
    lastHookEvent: "Stop",
    lastHookPayload: { hook_event_name: "Stop", session_id: "sid-1" },
    stateSince: 0,
    lastSeenAt: 0,
    history: [],
    ...overrides,
  };
}

describe("createTaskRegistry", () => {
  const defaultNotifySessionKey = "agent:main:main";

  function setup() {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeatNow = vi.fn();
    const log = vi.fn();
    const reg = createTaskRegistry({
      enqueueSystemEvent, requestHeartbeatNow, defaultNotifySessionKey, log,
    });
    return { enqueueSystemEvent, requestHeartbeatNow, log, reg };
  }

  describe("routing", () => {
    it("uses state.notifySessionKey when set", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        notifySessionKey: "agent:wecom:user-1",
      }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: "agent:wecom:user-1" }),
      );
      expect(requestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "agent:wecom:user-1", agentId: "wecom" }),
      );
    });

    it("falls back to defaultNotifySessionKey when state.notifySessionKey is missing", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ sessionKey: defaultNotifySessionKey }),
      );
      expect(requestHeartbeatNow).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: defaultNotifySessionKey, agentId: "main" }),
      );
    });

    it("passes deliveryContext through to enqueueSystemEvent", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        notifySessionKey: "agent:wecom:user-1",
        notifyDeliveryContext: { channel: "wecom", to: "user-1", accountId: "ww1" },
      }));
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          deliveryContext: { channel: "wecom", to: "user-1", accountId: "ww1" },
        }),
      );
    });

    it("omits deliveryContext when undefined", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      const call = enqueueSystemEvent.mock.calls[0]!;
      expect(call[1].deliveryContext).toBeUndefined();
    });
  });

  describe("exec-completion format", () => {
    it.each([
      ["WAITING",    "completed", "code 0"],
      ["QUESTION",   "completed", "code 0"],
      ["PERMISSION", "completed", "code 0"],
      ["ERROR",      "completed", "code 0"],
      ["DONE",       "completed", "code 0"],
      ["FATAL",      "failed",    "code 1"],
    ])("emits 'exec %s (claude-code-<id>, %s)' for %s", (state, verb, exitCode) => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state }));
      const text = enqueueSystemEvent.mock.calls[0]![0] as string;
      expect(text).toMatch(new RegExp(`^exec ${verb} \\(claude-code-[a-zA-Z0-9_-]+, ${exitCode.replace(" ", " ")}\\) :: `));
    });

    it("wakes on every notify state", () => {
      for (const state of ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE", "FATAL"]) {
        const { requestHeartbeatNow, reg } = setup();
        reg.onStateTransition(makeState({ state, sessionId: `sid-${state}` }));
        expect(requestHeartbeatNow).toHaveBeenCalledTimes(1);
      }
    });

    it("includes last_assistant_message in result block when present", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({
        state: "DONE",
        lastHookPayload: {
          hook_event_name: "SessionEnd",
          session_id: "sid-1",
          last_assistant_message: "the result text",
        },
      }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("the result text");
    });

    it("omits result block when last_assistant_message is absent", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).not.toContain("\n> ");
    });

    it("uses tmuxSession as label when present", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "DONE", tmuxSession: "cc-my-task" }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("cc-my-task");
    });

    it("falls back to sessionId as label when tmuxSession is missing", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING", tmuxSession: undefined }));
      expect(enqueueSystemEvent.mock.calls[0]![0]).toContain("sid-1");
    });
  });

  describe("dedup", () => {
    it("does not re-fire for same session+state twice", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING" }));
      reg.onStateTransition(makeState({ state: "WAITING" }));
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    });

    it("still fires for different sessions in same state", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING", sessionId: "sid-a" }));
      reg.onStateTransition(makeState({ state: "WAITING", sessionId: "sid-b" }));
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    });

    it("still fires when same session moves to a different notify state", () => {
      const { enqueueSystemEvent, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING" }));
      reg.onStateTransition(makeState({ state: "DONE" }));
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe("no-ops", () => {
    it("does not fire on WORKING transitions", () => {
      const { enqueueSystemEvent, requestHeartbeatNow, reg } = setup();
      reg.onStateTransition(makeState({ state: "WORKING" }));
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeatNow).not.toHaveBeenCalled();
    });

    it("createTask is a no-op", () => {
      const { reg } = setup();
      expect(() => reg.createTask({ runId: "r1", task: "do stuff" })).not.toThrow();
    });
  });

  describe("logging", () => {
    it("logs on every notify transition", () => {
      const { log, reg } = setup();
      reg.onStateTransition(makeState({ state: "WAITING" }));
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("claude-code: notify state=WAITING"),
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/task-registry.test.ts`
Expected: FAIL — old `requesterSessionKey` parameter shape, no `deliveryContext`, intermediate states don't wake.

- [ ] **Step 3: Rewrite src/task-registry.ts**

Replace the entire file with:

```ts
// Notification bridge: hook state transitions → caller's session via system events.
//
// Routing: each SessionState carries notifySessionKey + notifyDeliveryContext
// captured from the tool-factory ctx at spawn time (see index.ts). On state
// transitions we enqueue an exec-completion event addressed at that session
// (with channel hint) and request a wake heartbeat.
//
// Why exec-completion format for ALL notify states (not just DONE/FATAL):
//   heartbeat-runner only generates a user-visible prompt when
//   isExecCompletionEvent(text)===true — otherwise resolveHeartbeatRunPrompt
//   returns null and the agent stays silent. By emitting the same format for
//   WAITING/PERMISSION/etc. with code 0, the receiving LLM is prompted to
//   "relay this background task update" and naturally responds.
//
// See: docs/openclaw-background-task-notification.md §3.1, §3.4.

import type { DeliveryContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionState } from "./state.js";

export type TaskRegistry = {
  createTask(params: { runId: string; task: string; label?: string }): void;
  onStateTransition(state: SessionState): void;
};

export type TaskRegistryDeps = {
  enqueueSystemEvent: (text: string, opts: {
    sessionKey: string;
    contextKey: string;
    deliveryContext?: DeliveryContext;
  }) => boolean;
  requestHeartbeatNow: (opts: {
    source: string;
    intent: string;
    reason: string;
    sessionKey: string;
    agentId?: string;
  }) => void;
  defaultNotifySessionKey: string;
  log?: (text: string) => void;
};

const NOTIFY_STATES = new Set(["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE", "FATAL"]);

type StateDescriptor = {
  verb: "completed" | "failed";
  exitCode: "code 0" | "code 1";
  emoji: string;
  mood: string;
};

function describe(state: string): StateDescriptor {
  switch (state) {
    case "DONE":       return { verb: "completed", exitCode: "code 0", emoji: "🚨", mood: "finished" };
    case "FATAL":      return { verb: "failed",    exitCode: "code 1", emoji: "🚨", mood: "timed out" };
    case "WAITING":    return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for input)" };
    case "QUESTION":   return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for an answer)" };
    case "PERMISSION": return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (waiting for permission)" };
    case "ERROR":      return { verb: "completed", exitCode: "code 0", emoji: "⚠️", mood: "needs attention (tool failed)" };
    default:           return { verb: "completed", exitCode: "code 0", emoji: "ℹ️", mood: state.toLowerCase() };
  }
}

export function createTaskRegistry(deps: TaskRegistryDeps): TaskRegistry {
  const { enqueueSystemEvent, requestHeartbeatNow, defaultNotifySessionKey, log } = deps;
  const seenStates = new Set<string>();

  return {
    createTask() {
      // No persistent task record — routing lives on SessionState, delivery
      // happens in onStateTransition.
    },

    onStateTransition(state) {
      if (!NOTIFY_STATES.has(state.state)) return;

      const key = `${state.sessionId}:${state.state}`;
      if (seenStates.has(key)) return;
      seenStates.add(key);

      const target = state.notifySessionKey ?? defaultNotifySessionKey;
      const agentId = target.split(":")[1] ?? "";
      const label = state.tmuxSession ?? state.sessionId;
      const contextKey = `task:claude-code:${state.sessionId}`;
      const reason = `claude-code:${state.sessionId}:${state.state}`;

      const { verb, exitCode, emoji, mood } = describe(state.state);
      const result = extractResultText(state.lastHookPayload as Record<string, unknown>);
      const resultSuffix = result ? `\n> ${result.slice(0, 7000)}` : "";
      const execId = state.sessionId.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64);
      const body = `${emoji} Claude Code session \`${label}\` **${mood}**.${resultSuffix}`;
      const text = `exec ${verb} (claude-code-${execId}, ${exitCode}) :: ${body}`;

      log?.(`claude-code: notify state=${state.state} sessionId=${state.sessionId} target=${target} contextKey=${contextKey}`);

      const enqOpts: { sessionKey: string; contextKey: string; deliveryContext?: DeliveryContext } = {
        sessionKey: target,
        contextKey,
      };
      if (state.notifyDeliveryContext) enqOpts.deliveryContext = state.notifyDeliveryContext;

      enqueueSystemEvent(text, enqOpts);
      requestHeartbeatNow({
        source: "hook",
        intent: "immediate",
        reason,
        sessionKey: target,
        agentId,
      });
    },
  };
}

function extractResultText(payload: Record<string, unknown>): string | undefined {
  const msg = payload.last_assistant_message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/task-registry.test.ts`
Expected: PASS for all tests.

- [ ] **Step 5: Commit**

```bash
git add src/task-registry.ts src/task-registry.test.ts
git commit -m "task-registry: route per-state.notifySessionKey, unify intermediate+terminal as exec-completion"
```

---

## Task 5: spawn — accept notifySessionKey + deliveryContext, call setNotifyContext

**Files:**
- Modify: `src/spawn.ts`
- Modify: `src/spawn.test.ts`

- [ ] **Step 1: Inspect existing spawn.test.ts**

Run: `grep -n "requesterSessionKey\|taskRegistry\|setNotifyContext" src/spawn.test.ts`
Note which tests reference the old shape so you can update them.

- [ ] **Step 2: Write failing test for setNotifyContext call**

Add to `src/spawn.test.ts` (inside the existing describe block, replace any `requesterSessionKey` tests):

```ts
it("calls store.setNotifyContext with notifySessionKey + deliveryContext when provided", async () => {
  const setNotifyContext = vi.fn();
  const fakeStore = { setNotifyContext } as unknown as Parameters<typeof spawnSession>[0]["store"];

  const result = await spawnSession({
    tmuxSession: "cc-test",
    task: "do stuff",
    workdir: "/tmp",
    exec: makeFakeExec(),                 // existing helper in this file
    tasksDir: await fs.mkdtemp(path.join(os.tmpdir(), "tasks-")),
    writeState: async () => {},
    startWatchdog: async () => {},
    uuid: () => "sid-fixed",
    sleepMs: 0,
    store: fakeStore,
    notifySessionKey: "agent:wecom:user-1",
    notifyDeliveryContext: { channel: "wecom", to: "user-1" },
    defaultNotifySessionKey: "agent:main:main",
    checkHooksConfigured: async () => true,  // stub to skip pre-flight; or whatever existing test uses
  });

  expect(result.success).toBe(true);
  expect(setNotifyContext).toHaveBeenCalledWith("sid-fixed", {
    runId: "sid-fixed",
    notifySessionKey: "agent:wecom:user-1",
    notifyDeliveryContext: { channel: "wecom", to: "user-1" },
  });
});

it("falls back to defaultNotifySessionKey when notifySessionKey is omitted", async () => {
  const setNotifyContext = vi.fn();
  const fakeStore = { setNotifyContext } as unknown as Parameters<typeof spawnSession>[0]["store"];

  await spawnSession({
    tmuxSession: "cc-test-2",
    task: "do stuff",
    workdir: "/tmp",
    exec: makeFakeExec(),
    tasksDir: await fs.mkdtemp(path.join(os.tmpdir(), "tasks-")),
    writeState: async () => {},
    startWatchdog: async () => {},
    uuid: () => "sid-fixed-2",
    sleepMs: 0,
    store: fakeStore,
    defaultNotifySessionKey: "agent:notifications:claude-code",
    checkHooksConfigured: async () => true,
  });

  expect(setNotifyContext).toHaveBeenCalledWith("sid-fixed-2", {
    runId: "sid-fixed-2",
    notifySessionKey: "agent:notifications:claude-code",
    notifyDeliveryContext: undefined,
  });
});
```

Note: the existing test file likely has `makeFakeExec` or similar helper — reuse it. If `checkHooksConfigured` is not currently a dependency injection point in `spawnSession`, see Step 3.

- [ ] **Step 3: Update src/spawn.ts**

Replace the `SpawnDeps` type and `spawnSession` signature.

```ts
import type { DeliveryContext } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionStore } from "./store.js";

export type SpawnDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
  uuid?: () => string;
  sleepMs?: number;
  store?: SessionStore;                     // ★ replaces taskRegistry
  notifySessionKey?: string;                // ★ from tool factory ctx.sessionKey
  notifyDeliveryContext?: DeliveryContext;  // ★ from tool factory ctx.deliveryContext
  defaultNotifySessionKey?: string;         // ★ fallback when notifySessionKey is absent
  checkHooksConfigured?: (workdir: string) => Promise<boolean>;  // ★ make pre-flight injectable for tests
};
```

In `spawnSession`, after a successful spawn, replace the old `taskRegistry.createTask(...)` block with:

```ts
if (store && (notifySessionKey || defaultNotifySessionKey)) {
  store.setNotifyContext(sessionId, {
    runId: sessionId,
    notifySessionKey: notifySessionKey ?? defaultNotifySessionKey!,
    notifyDeliveryContext,
  });
}
```

Wire `checkHooksConfigured` through: keep the existing module-level `async function checkHooksConfigured` as the default; in the function signature, accept `checkHooksConfigured = defaultCheckHooksConfigured` and call that.

```ts
// at top of spawnSession destructure:
checkHooksConfigured = checkHooksConfiguredDefault,
```

Rename the existing top-level `checkHooksConfigured` function to `checkHooksConfiguredDefault` to avoid the shadowing collision.

Update `createClaudeCodeSpawnTool` and `handleSpawnRoute` to forward the new fields:

```ts
export function createClaudeCodeSpawnTool(config?: {
  permissionMode?: ClaudePermissionMode;
  store?: SessionStore;
  notifySessionKey?: string;
  notifyDeliveryContext?: DeliveryContext;
  defaultNotifySessionKey?: string;
}): AnyAgentTool {
  return {
    // ... existing label/name/description ...
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Name for the tmux session" }),
      task: Type.String({ description: "Initial task to send to Claude Code" }),
      budgetMinutes: Type.Optional(Type.Number({ description: "Idle budget in minutes (default 30)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (default cwd)" })),
    }),
    async execute(_toolCallId, params) {
      const { tmuxSession, task, budgetMinutes, workdir } = params as {
        tmuxSession: string; task: string; budgetMinutes?: number; workdir?: string;
      };
      const result = await spawnSession({
        tmuxSession, task, budgetMinutes, workdir,
        permissionMode: config?.permissionMode,
        store: config?.store,
        notifySessionKey: config?.notifySessionKey,
        notifyDeliveryContext: config?.notifyDeliveryContext,
        defaultNotifySessionKey: config?.defaultNotifySessionKey,
      });
      return jsonResult(result);
    },
  };
}

export async function handleSpawnRoute(
  body: unknown,
  config?: {
    permissionMode?: ClaudePermissionMode;
    store?: SessionStore;
    defaultNotifySessionKey?: string;
  },
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const {
    tmuxSession, task, budgetMinutes, workdir,
    notifySessionKey, notifyDeliveryContext,
  } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string" || typeof task !== "string") {
    return { status: 400, body: { error: "tmuxSession and task are required" } };
  }
  const result = await spawnSession({
    tmuxSession,
    task,
    budgetMinutes: typeof budgetMinutes === "number" ? budgetMinutes : undefined,
    permissionMode: config?.permissionMode,
    workdir: typeof workdir === "string" ? workdir : undefined,
    store: config?.store,
    notifySessionKey: typeof notifySessionKey === "string" ? notifySessionKey : undefined,
    notifyDeliveryContext: (notifyDeliveryContext && typeof notifyDeliveryContext === "object")
      ? notifyDeliveryContext as DeliveryContext
      : undefined,
    defaultNotifySessionKey: config?.defaultNotifySessionKey,
  });
  return { status: result.success ? 200 : 500, body: result };
}
```

(Remove the `taskRegistry` and `requesterSessionKey` fields entirely from `SpawnDeps`, `createClaudeCodeSpawnTool`, and `handleSpawnRoute`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/spawn.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/spawn.ts src/spawn.test.ts
git commit -m "spawn: capture notify routing, replace taskRegistry.createTask with store.setNotifyContext"
```

---

## Task 6: routes — stop calling setRequesterContext, forward new spawn fields

**Files:**
- Modify: `src/routes.ts`
- Modify: `src/routes.test.ts`

- [ ] **Step 1: Update routes.test.ts**

Read the existing tests. Two changes:
1. Remove any assertion that the hook handler calls `setRequesterContext` — that path is gone.
2. Add a new test that the spawn route accepts `notifySessionKey` / `notifyDeliveryContext` body fields and forwards them.

In `src/routes.test.ts`, append:

```ts
it("hook handler no longer calls setRequesterContext", async () => {
  const setRequesterContext = vi.fn();
  const setNotifyContext = vi.fn();
  const store = makeFakeStore({ setRequesterContext, setNotifyContext });  // helper

  const routes = createClaudeCodeRoutes({
    store, config: makeConfig(),
    taskRegistry: { createTask: vi.fn(), onStateTransition: vi.fn() },
  });
  await invokeRoute(routes.hook, {
    hook_event_name: "SessionStart", session_id: "sid-x",
  });

  expect(setRequesterContext).not.toHaveBeenCalled();
  expect(setNotifyContext).not.toHaveBeenCalled();  // hooks don't set routing; spawn does
});
```

(`makeFakeStore`, `makeConfig`, `invokeRoute` are existing helpers in `routes.test.ts` — match its style. If they don't exist, infer their construction from the surrounding tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/routes.test.ts`
Expected: FAIL — routes.ts still calls `setRequesterContext` in the hook handler.

- [ ] **Step 3: Update src/routes.ts**

In the `hook` function (around line 73-80), **remove**:

```ts
// On first hook for a session, set requester context if not already set.
if (!prevState && state.runId === undefined) {
  store.setRequesterContext(
    payload.session_id,
    payload.session_id,
    config.targetSessionKey,
  );
}
```

Notification routing is now set by `spawn.ts` calling `store.setNotifyContext`. The hook handler should not touch routing — it only feeds state.

Also: any other reference to `config.targetSessionKey` in routes.ts needs to switch to `config.defaultNotifySessionKey`. After this task, run `grep -n targetSessionKey src/routes.ts` and confirm zero hits.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "routes: stop setting notify routing from hooks (now set in spawn)"
```

---

## Task 7: context.ts — drop notifyStates param

**Files:**
- Modify: `src/context.ts`
- Modify: `src/context.test.ts`

- [ ] **Step 1: Update context.test.ts**

Open `src/context.test.ts`. Find any test that passes `notifyStates` as an argument to `buildClaudeCodeContext`. Remove that parameter from all call sites. Update assertions if they depended on `notifyStates` filtering.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/context.test.ts`
Expected: PASS or FAIL — likely PASS because removing a parameter doesn't break TS (it's optional). Move to Step 3 regardless.

- [ ] **Step 3: Update src/context.ts**

Replace the file with:

```ts
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

const STATE_LABELS: Record<
  ClaudeCodeState,
  { prompt: boolean; prefix: string; message: string }
> = {
  WORKING: { prompt: false, prefix: "", message: "" },
  WAITING: { prompt: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { prompt: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { prompt: true, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { prompt: true, prefix: "🚨", message: "failed" },
  DONE: { prompt: true, prefix: "ℹ️", message: "finished" },
  FATAL: { prompt: true, prefix: "🚨", message: "timed out" },
};

const STATE_ORDER: Record<ClaudeCodeState, number> = {
  FATAL: 0, ERROR: 1, PERMISSION: 2, QUESTION: 3, WAITING: 4, DONE: 5, WORKING: 6,
};

export function buildClaudeCodeContext({
  sessions,
}: {
  sessions: SessionState[];
}): string {
  const relevant = sessions
    .filter((s) => STATE_LABELS[s.state].prompt)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  if (relevant.length === 0) return "";

  const lines = ["## Active Claude Code sessions"];
  for (const s of relevant) {
    const display = STATE_LABELS[s.state];
    lines.push(
      `- ${display.prefix} tmux: ${s.tmuxSession ?? "unknown"} | state: ${s.state} | ${display.message}`,
    );
    lines.push(`  since: ${new Date(s.stateSince).toISOString()}`);
    if (s.workdir) lines.push(`  workdir: ${s.workdir}`);
    if (s.fatalReason) lines.push(`  reason: ${s.fatalReason}`);
    if (s.budgetDeadline)
      lines.push(`  budget deadline: ${new Date(s.budgetDeadline).toISOString()}`);
    if (s.logFile) lines.push(`  log: ${s.logFile}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context.ts src/context.test.ts
git commit -m "context: drop notifyStates param (config field removed)"
```

---

## Task 8: index.ts — register tools as factories, drop webhook

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index.test.ts`

- [ ] **Step 1: Inspect existing index.test.ts**

Run: `cat src/index.test.ts`
Identify how registration is currently tested. Plan replacement tests that assert:
1. `registerTool` is called with a function (factory), not an object.
2. The factory, when invoked with `{sessionKey, deliveryContext}`, produces a tool whose `execute` plumbs those values through.

- [ ] **Step 2: Add failing factory tests**

Append (or replace existing registration tests) in `src/index.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

function makeFakeApi() {
  const tools: Array<unknown> = [];
  const routes: Array<unknown> = [];
  const services: Array<unknown> = [];
  const runtime = {
    system: {
      enqueueSystemEvent: vi.fn(() => true),
      requestHeartbeatNow: vi.fn(),
    },
  };
  return {
    api: {
      pluginConfig: {},
      runtime,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: (toolOrFactory: unknown) => { tools.push(toolOrFactory); },
      registerHttpRoute: (params: unknown) => { routes.push(params); },
      registerService: (svc: unknown) => { services.push(svc); },
    },
    tools, routes, services, runtime,
  };
}

describe("plugin registration", () => {
  it("registers spawn tool as a factory", () => {
    const { api, tools } = makeFakeApi();
    plugin.register(api as never);

    const spawnFactory = tools.find((t) => typeof t === "function");
    expect(spawnFactory).toBeDefined();
    expect(typeof spawnFactory).toBe("function");
  });

  it("spawn factory captures ctx.sessionKey + ctx.deliveryContext", () => {
    const { api, tools } = makeFakeApi();
    plugin.register(api as never);

    // Find the spawn factory by invoking each and inspecting tool.name
    const factories = tools.filter((t): t is Function => typeof t === "function");
    const spawnTool = factories
      .map((f) => f({
        sessionKey: "agent:wecom:user-1",
        deliveryContext: { channel: "wecom", to: "user-1" },
      }))
      .find((t) => t && (t as { name?: string }).name === "claude_code_spawn") as { name: string } | undefined;

    expect(spawnTool).toBeDefined();
    // The tool object itself doesn't expose the captured ctx; we verify via the
    // mock runtime (enqueueSystemEvent route) in integration.test.ts.
  });
});
```

The deep assertion (that `ctx.sessionKey` ends up in `setNotifyContext`) lives in the integration test (Task 11).

- [ ] **Step 3: Update src/index.ts**

Replace the relevant section. Full new wiring:

```ts
// pluginConfigJsonSchema — remove wecomWebhookUrl + notifyStates, rename targetSessionKey
const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    routePrefix: { type: "string", default: "/claude-code" },
    eventTypes: {
      type: "array",
      items: { type: "string" },
      default: ["*"],
    },
    stateFileDir: { type: "string", default: "~/.cache/claude-code-hooks" },
    sendKeysRateLimitPerMinute: { type: "number", default: 10 },
    sessionTimeoutSeconds: { type: "number", default: 300 },
    defaultNotifySessionKey: { type: "string", default: "agent:main:main" },
    permissionMode: {
      type: "string",
      enum: ["default", "acceptEdits", "plan", "bypassPermissions"],
      default: "bypassPermissions",
    },
    debugLog: { type: "boolean", default: false },
  },
  required: [],
} as const;
```

Replace the `register` body's `taskReg` construction:

```ts
const taskReg = createTaskRegistry({
  enqueueSystemEvent: (text, opts) => {
    try {
      const ok = api.runtime.system.enqueueSystemEvent(text, opts);
      if (!ok) {
        api.logger?.warn(
          `claude-code: enqueueSystemEvent returned false contextKey=${opts.contextKey} sessionKey=${opts.sessionKey}`,
        );
      }
      return ok;
    } catch (err) {
      api.logger?.warn(`claude-code: enqueueSystemEvent threw: ${String(err)}`);
      return false;
    }
  },
  requestHeartbeatNow: (opts) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api.runtime.system.requestHeartbeatNow(opts as any);
    } catch (err) {
      api.logger?.warn(`claude-code: requestHeartbeatNow failed: ${String(err)}`);
    }
  },
  log: (text) => api.logger?.info?.(text),
  defaultNotifySessionKey: config.defaultNotifySessionKey,
});
```

(No more `onTerminalState`; webhook code removed entirely.)

Replace the `registerTool(...)` block with factories:

```ts
api.registerTool((ctx) =>
  createClaudeCodeSpawnTool({
    permissionMode: config.permissionMode,
    store,
    notifySessionKey: ctx.sessionKey,
    notifyDeliveryContext: ctx.deliveryContext,
    defaultNotifySessionKey: config.defaultNotifySessionKey,
  }),
);
api.registerTool(() => createClaudeCodeStatusTool(store));
api.registerTool(() => createClaudeCodeStopTool());
api.registerTool(() => createClaudeCodeRestoreTool({ permissionMode: config.permissionMode }));
api.registerTool(() => createClaudeCodeSendTool());
api.registerTool(() => createClaudeCodeReadTool());
api.registerTool(() => createClaudeCodeSetupHooksTool());
```

Update the `createClaudeCodeRoutes` call so the spawn HTTP route also gets `store` + `defaultNotifySessionKey` (forwarded by `routes.ts` into `handleSpawnRoute`):

```ts
const routes = createClaudeCodeRoutes({
  store,
  config,
  taskRegistry: taskReg,
  log: (text) => api.logger?.info?.(text),
  discoverSession: async (sessionId) => discoverSession({ sessionId }),
  sendKeys: async ({ tmuxSession, text, submit, keys }) => {
    const exists = await tmuxSessionExists(tmuxSession);
    if (!exists) throw new Error(`tmux session ${tmuxSession} not found`);
    if (text) await sendKeysToTmuxSession({ tmuxSession, text, submit });
    if (keys && keys.length) await sendKeysSequence({ tmuxSession, keys });
  },
});
```

(If `routes.ts` doesn't already accept `store` + config, it does — `store` was already a param. The spawn route inside `routes.ts` needs to construct the `handleSpawnRoute` config — verify Task 6's changes are compatible.)

Remove the entire `requesterSessionKey: config.targetSessionKey` argument from the prior `createTaskRegistry` call — gone now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "index: register tools as factories, drop webhook block"
```

---

## Task 9: integration.test.ts — end-to-end routing

**Files:**
- Modify: `src/integration.test.ts`

- [ ] **Step 1: Add end-to-end routing test**

Append to `src/integration.test.ts`:

```ts
it("routes WeCom-spawned task notifications back to the WeCom session", async () => {
  // Setup: full plugin wired with mock runtime
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeatNow = vi.fn();
  const api = makeIntegrationApi({ enqueueSystemEvent, requestHeartbeatNow });
  plugin.register(api);

  // Find the spawn factory
  const spawnFactory = api.tools.find((t): t is Function => typeof t === "function" && !!t({}).then === undefined)!;
  // Invoke factory as WeCom agent would
  const spawnTool = (spawnFactory as (ctx: unknown) => { name: string; execute: Function })({
    sessionKey: "agent:wecom:user-99",
    deliveryContext: { channel: "wecom", to: "user-99", accountId: "ww-7" },
  });
  expect(spawnTool.name).toBe("claude_code_spawn");

  // Call spawn (stub out tmux/exec — reuse existing integration test helpers)
  await spawnTool.execute("call-1", {
    tmuxSession: "cc-integration",
    task: "do the thing",
  });

  // Simulate Claude Code hook lifecycle: SessionStart → Stop → SessionEnd
  await invokeHookRoute(api, { hook_event_name: "SessionStart", session_id: "<sessionId>" });
  await invokeHookRoute(api, { hook_event_name: "SessionEnd", session_id: "<sessionId>", last_assistant_message: "done" });

  // Assert notification routed to WeCom session with delivery context
  const call = enqueueSystemEvent.mock.calls.find((c) => c[0].startsWith("exec completed"));
  expect(call).toBeDefined();
  expect(call![1].sessionKey).toBe("agent:wecom:user-99");
  expect(call![1].deliveryContext).toEqual({
    channel: "wecom", to: "user-99", accountId: "ww-7",
  });
  expect(call![1].contextKey).toMatch(/^task:claude-code:/);

  expect(requestHeartbeatNow).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "agent:wecom:user-99",
      agentId: "wecom",
      source: "hook",
    }),
  );
});

it("routes main-agent-spawned task notifications to defaultNotifySessionKey", async () => {
  const enqueueSystemEvent = vi.fn(() => true);
  const api = makeIntegrationApi({ enqueueSystemEvent });
  plugin.register(api);

  const spawnFactory = api.tools.find((t): t is Function => typeof t === "function" && !!t({}).then === undefined)!;
  const spawnTool = (spawnFactory as (ctx: unknown) => { name: string; execute: Function })({
    // ctx.sessionKey omitted — simulates a non-tool-call code path or a "cold" caller
  });

  await spawnTool.execute("call-2", {
    tmuxSession: "cc-default",
    task: "main agent task",
  });

  await invokeHookRoute(api, { hook_event_name: "SessionEnd", session_id: "<sessionId>" });

  const call = enqueueSystemEvent.mock.calls.find((c) => c[0].startsWith("exec completed"));
  expect(call).toBeDefined();
  expect(call![1].sessionKey).toBe("agent:main:main");  // default
  expect(call![1].deliveryContext).toBeUndefined();
});
```

`makeIntegrationApi`, `invokeHookRoute` are helpers — if they don't exist in `integration.test.ts`, look at the existing tests in the same file to see how the harness is constructed and mirror that style. Capture sessionId from the spawn result; the `<sessionId>` placeholder above is illustrative — use the actual returned `sessionId`.

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run src/integration.test.ts`
Expected: PASS for both new tests.

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "integration: e2e test per-caller notification routing"
```

---

## Task 10: Manifest + version + README

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Update openclaw.plugin.json**

Replace the `version` and the `configSchema.properties` block:

```json
{
  "id": "claude-code-openclaw-plugin",
  "name": "Claude Code harness",
  "description": "Add Claude Code harness tools to OpenClaw.",
  "version": "0.8.0",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "routePrefix": { "type": "string", "default": "/claude-code" },
      "eventTypes": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["*"]
      },
      "stateFileDir": { "type": "string", "default": "~/.cache/claude-code-hooks" },
      "sendKeysRateLimitPerMinute": { "type": "number", "default": 10 },
      "sessionTimeoutSeconds": { "type": "number", "default": 300 },
      "defaultNotifySessionKey": { "type": "string", "default": "agent:main:main" },
      "permissionMode": {
        "type": "string",
        "enum": ["default", "acceptEdits", "plan", "bypassPermissions"],
        "default": "bypassPermissions"
      },
      "debugLog": { "type": "boolean", "default": false }
    },
    "required": []
  },
  "activation": { "onStartup": true },
  "contracts": {
    "tools": [
      "claude_code_status",
      "claude_code_spawn",
      "claude_code_stop",
      "claude_code_restore",
      "claude_code_send",
      "claude_code_read",
      "claude_code_setup_hooks"
    ]
  },
  "skills": ["./skills"]
}
```

- [ ] **Step 2: Update package.json**

Run: `sed -i 's/"version": "0\.7\.1"/"version": "0.8.0"/' package.json`

Verify with: `grep '"version"' package.json`
Expected: `"version": "0.8.0",`

- [ ] **Step 3: Update README.md**

Rewrite the "Configuration" table and "Example config" section. Add a "Breaking changes in 0.8.0" section near the top of the README.

```markdown
## Breaking changes in 0.8.0

- `targetSessionKey` renamed to `defaultNotifySessionKey`. Update your config.
- `wecomWebhookUrl` removed. Notifications now route to the caller's agent session via OpenClaw's system-event channel; the LLM there composes the user-facing reply.
- `notifyStates` removed. Was never read by code.
- `SessionState.requesterSessionKey` → `notifySessionKey` (+ new `notifyDeliveryContext`). On-disk state files from 0.7.x are forward-compatible: the old field is ignored, missing new fields fall back to `defaultNotifySessionKey`.

## How notifications work

Each tool invocation captures the caller's `sessionKey` and `deliveryContext` from OpenClaw's plugin tool context. Spawn stores them on the Claude Code session. When the session hits a notify state (WAITING / QUESTION / PERMISSION / ERROR / DONE / FATAL), the plugin:

1. Enqueues an `exec completed (claude-code-<id>, code 0) :: ...` system event addressed to the caller's `sessionKey`, with `deliveryContext` attached so OpenClaw routes any reply back through the original channel.
2. Calls `requestHeartbeatNow({source:"hook"})` to wake the caller's session.

The receiving agent sees the event as a background-task-completion prompt, generates a user-visible reply, and OpenClaw delivers it back to the caller (WeCom, Slack, CLI, whatever).

**Caveat: `agent:main:main` blocking.** OpenClaw serializes heartbeat runs against a global `main` command lane (`getSize("main") > 0` blocks any wake). If the caller is `agent:main:main` and the user is currently chatting there, notifications queue until the user's next turn. For reliable push, point `defaultNotifySessionKey` at a dedicated session like `agent:notifications:claude-code`.
```

Update the Configuration table:

```markdown
## Configuration

| Field | Default | Purpose |
|-------|---------|---------|
| `defaultNotifySessionKey` | `agent:main:main` | Fallback target session when a tool caller's `sessionKey` is unavailable (e.g. HTTP spawn route, or invocations without an active session context) |
| `permissionMode` | `bypassPermissions` | Claude Code `--permission-mode` for spawn/restore |
| `routePrefix` | `/claude-code` | HTTP route prefix |
| `sessionTimeoutSeconds` | `300` | Idle threshold before FATAL |
| `stateFileDir` | `~/.cache/claude-code-hooks` | Per-session state and debug logs |
| `sendKeysRateLimitPerMinute` | `10` | Rate limit for `/send` route |
| `debugLog` | `false` | Append per-session hook log to `<stateFileDir>/<sessionId>.log` |
```

Update the Example config:

```json
{
  "plugins": {
    "entries": {
      "claude-code-openclaw-plugin": {
        "enabled": true,
        "config": {
          "defaultNotifySessionKey": "agent:notifications:claude-code",
          "permissionMode": "bypassPermissions"
        }
      }
    },
    "load": {
      "paths": ["/path/to/claude-code-openclaw-plugin"]
    }
  }
}
```

Update the State machine table — all notify states now `enqueue + wake`:

```markdown
## State machine

| State | Triggered by | Action |
|-------|-------------|-----------|
| `WORKING` | SessionStart, UserPromptSubmit, PostToolUse | none |
| `WAITING` | Stop | exec-completion event + wake |
| `QUESTION` | Elicitation | exec-completion event + wake |
| `PERMISSION` | PermissionRequest | exec-completion event + wake |
| `ERROR` | PostToolUseFailure | exec-completion event + wake |
| `DONE` | SessionEnd | exec-completion event + wake |
| `FATAL` | Idle timeout (`sessionTimeoutSeconds`) | exec-completion event + wake |
```

- [ ] **Step 4: Verify build + tests pass**

Run: `npm run build && npx vitest run`
Expected: build succeeds (tsc passes), all tests pass.

- [ ] **Step 5: Commit**

```bash
git add openclaw.plugin.json package.json README.md
git commit -m "release: 0.8.0 — per-caller notification routing"
```

---

## Task 11: Full sweep — kill remaining references

**Files:**
- All `src/**`

- [ ] **Step 1: Sweep for stale identifiers**

Run: `grep -rn "requesterSessionKey\|targetSessionKey\|wecomWebhookUrl\|notifyStates\|setRequesterContext\|onTerminalState" src/`

Expected: zero hits. If any remain, open the file and fix — likely a comment, a stray test, or an import. Each stale reference is a small commit.

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS — all tests across all files.

- [ ] **Step 3: Run TypeScript build**

Run: `npm run build`
Expected: clean compile, no errors.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "cleanup: remove final stale references to old notification API" || echo "nothing to commit"
```

---

## Verification (final)

After all tasks complete:

- [ ] `grep -rn "requesterSessionKey\|targetSessionKey\|wecomWebhookUrl\|notifyStates" src/ openclaw.plugin.json README.md` → zero hits
- [ ] `npx vitest run` → all green
- [ ] `npm run build` → clean
- [ ] `git log --oneline master..HEAD` → ~11 commits, each scoped to one file group with clear conventional-commit message

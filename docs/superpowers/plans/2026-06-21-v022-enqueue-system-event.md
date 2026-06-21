# v0.2.2 enqueueSystemEvent Heartbeat Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace heartbeat-wake notification with direct `enqueueSystemEvent` calls so Claude Code state changes reach OpenClaw's session queue immediately.

**Architecture:** Keep the hook endpoint dumb and behavior mapping centralized. The dispatcher now calls `enqueueSystemEvent` directly instead of waking the heartbeat runner; `heartbeat_prompt_contribution` remains as a passive context injector. Add `targetSessionKey` config so users can control which session receives the system events.

**Tech Stack:** TypeScript, Vitest, Zod, OpenClaw plugin SDK.

---

### Task 1: Add `targetSessionKey` config option

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Add failing tests for `targetSessionKey` default and override**

```ts
import { describe, expect, it } from "vitest";
import { resolvePluginConfig } from "./config.js";

describe("resolvePluginConfig targetSessionKey", () => {
  it("defaults to agent:main:main", () => {
    const config = resolvePluginConfig({});
    expect(config.targetSessionKey).toBe("agent:main:main");
  });

  it("uses provided value", () => {
    const config = resolvePluginConfig({ targetSessionKey: "agent:other" });
    expect(config.targetSessionKey).toBe("agent:other");
  });
});
```

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `targetSessionKey` not on config type / output.

- [ ] **Step 2: Add `targetSessionKey` to schema and type**

Modify `src/config.ts`:

```ts
export const pluginConfigSchema = z.object({
  routePrefix: z.string().default("/claude-code"),
  eventTypes: z.array(z.string()).default(["*"]),
  stateFileDir: z.string().default("~/.cache/claude-code-hooks"),
  notifyStates: z.array(ClaudeCodeState).default([
    "WAITING",
    "QUESTION",
    "PERMISSION",
    "ERROR",
    "DONE",
  ]),
  sendKeysRateLimitPerMinute: z.number().int().positive().default(10),
  sessionTimeoutSeconds: z.number().int().positive().default(300),
  targetSessionKey: z.string().default("agent:main:main"),
});
```

- [ ] **Step 3: Add `targetSessionKey` to JSON plugin config schema in `src/index.ts`**

Add inside `pluginConfigJsonSchema.properties`:

```ts
targetSessionKey: { type: "string", default: "agent:main:main" },
```

Run: `npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/config.test.ts src/index.ts
git commit -m "feat(config): add targetSessionKey option for system event delivery"
```

---

### Task 2: Remove `wake` from behavior mapping

**Files:**
- Modify: `src/behavior.ts`
- Test: `src/behavior.test.ts`

- [ ] **Step 1: Update failing behavior tests (no `wake` field)**

Modify `src/behavior.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveBehavior, STATE_BEHAVIOR } from "./behavior.js";

describe("STATE_BEHAVIOR", () => {
  it("WAITING announces with warning prefix", () => {
    const b = STATE_BEHAVIOR.WAITING;
    expect(b.announce).toBe(true);
    expect(b.prompt).toBe(true);
    expect(b.prefix).toBe("⚠️");
    expect(b.message).toContain("waiting");
  });

  it("WORKING does nothing", () => {
    const b = STATE_BEHAVIOR.WORKING;
    expect(b.announce).toBe(false);
    expect(b.prompt).toBe(false);
  });

  it("FATAL is one-shot announce", () => {
    const b = STATE_BEHAVIOR.FATAL;
    expect(b.announce).toBe(true);
    expect(b.oneShotAnnounce).toBe(true);
  });
});

describe("resolveBehavior", () => {
  it("returns table defaults when state is in notifyStates", () => {
    const b = resolveBehavior("WAITING", ["WAITING", "ERROR"]);
    expect(b.announce).toBe(true);
  });

  it("disables announce when state is not in notifyStates", () => {
    const b = resolveBehavior("DONE", ["WAITING"]);
    expect(b.announce).toBe(false);
  });
});
```

Run: `npx vitest run src/behavior.test.ts`
Expected: FAIL — `wake` references / extra fields.

- [ ] **Step 2: Update `ClaudeCodeBehavior` and `STATE_BEHAVIOR`**

Modify `src/behavior.ts`:

```ts
import type { ClaudeCodeState } from "./config.js";

export type ClaudeCodeBehavior = {
  state: ClaudeCodeState;
  prompt: boolean;
  announce: boolean;
  prefix: string;
  message: string;
  oneShotAnnounce?: boolean;
};

export const STATE_BEHAVIOR: Record<ClaudeCodeState, ClaudeCodeBehavior> = {
  WORKING: { state: "WORKING", prompt: false, announce: false, prefix: "", message: "" },
  WAITING: { state: "WAITING", prompt: true, announce: true, prefix: "⚠️", message: "waiting for input" },
  QUESTION: { state: "QUESTION", prompt: true, announce: true, prefix: "⚠️", message: "waiting for an answer" },
  PERMISSION: { state: "PERMISSION", prompt: true, announce: false, prefix: "⚠️", message: "waiting for permission" },
  ERROR: { state: "ERROR", prompt: true, announce: true, prefix: "🚨", message: "failed" },
  DONE: { state: "DONE", prompt: true, announce: true, prefix: "ℹ️", message: "finished" },
  FATAL: { state: "FATAL", prompt: true, announce: true, prefix: "🚨", message: "timed out", oneShotAnnounce: true },
};

export function resolveBehavior(
  state: ClaudeCodeState,
  notifyStates: ClaudeCodeState[],
): ClaudeCodeBehavior {
  const base = STATE_BEHAVIOR[state];
  if (!notifyStates.includes(state)) {
    return { ...base, announce: false };
  }
  return base;
}
```

Run: `npx vitest run src/behavior.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/behavior.ts src/behavior.test.ts
git commit -m "refactor(behavior): drop wake field, keep announce/prompt mapping"
```

---

### Task 3: Rewrite dispatcher to call `enqueueSystemEvent` directly

**Files:**
- Modify: `src/dispatcher.ts`
- Test: `src/dispatcher.test.ts`

- [ ] **Step 1: Rewrite dispatcher tests for direct enqueue**

Modify `src/dispatcher.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBehaviorDispatcher } from "./dispatcher.js";
import type { SessionState } from "./state.js";

function makeSession(state: SessionState["state"], sessionId: string): SessionState {
  return {
    sessionId,
    tmuxSession: "cc-test",
    state,
    lastHookEvent: "SessionStart",
    lastHookPayload: { hook_event_name: "SessionStart", session_id: sessionId },
    stateSince: Date.now(),
    lastSeenAt: Date.now(),
    history: [],
  };
}

describe("createBehaviorDispatcher", () => {
  it("enqueues system event for WAITING", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("WAITING", "s1"));
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("waiting for input"),
      { sessionKey: "agent:main:main", contextKey: "s1" },
    );
  });

  it("does not enqueue for WORKING", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING", "WORKING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("WORKING", "s2"));
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("only announces FATAL once", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["FATAL"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    dispatcher.onStateChanged(makeSession("FATAL", "s5"));
    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("honors notifyStates override", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent,
      notifyStates: ["WAITING"],
      sessionKey: "agent:main:main",
    });
    dispatcher.onStateChanged(makeSession("DONE", "s6"));
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/dispatcher.test.ts`
Expected: FAIL — dispatcher signature mismatch.

- [ ] **Step 2: Implement direct-enqueue dispatcher**

Modify `src/dispatcher.ts`:

```ts
import { resolveBehavior } from "./behavior.js";
import type { ClaudeCodeState } from "./config.js";
import type { SessionState } from "./state.js";

export type BehaviorDispatcher = {
  onStateChanged(state: SessionState): void;
  getPendingAnnounceSessionIds(): string[];
};

export function createBehaviorDispatcher(options: {
  enqueueSystemEvent: (text: string, opts: { sessionKey: string; contextKey: string }) => boolean;
  notifyStates: ClaudeCodeState[];
  sessionKey: string;
}): BehaviorDispatcher {
  const { enqueueSystemEvent, notifyStates, sessionKey } = options;
  const announcedOnce = new Set<string>();

  function onStateChanged(state: SessionState): void {
    const behavior = resolveBehavior(state.state, notifyStates);
    if (!behavior.announce) return;
    if (behavior.oneShotAnnounce && announcedOnce.has(state.sessionId)) return;
    if (behavior.oneShotAnnounce) announcedOnce.add(state.sessionId);

    const text = `${behavior.prefix} Claude Code session ${state.tmuxSession ?? state.sessionId} is ${behavior.message}`;
    try {
      enqueueSystemEvent(text, { sessionKey, contextKey: state.sessionId });
    } catch (err) {
      // Best-effort: don't let notification failures break hook processing.
      // eslint-disable-next-line no-console
      console.error("claude-code: enqueueSystemEvent failed:", err);
    }
  }

  function getPendingAnnounceSessionIds(): string[] {
    return [];
  }

  return { onStateChanged, getPendingAnnounceSessionIds };
}
```

Run: `npx vitest run src/dispatcher.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/dispatcher.ts src/dispatcher.test.ts
git commit -m "feat(dispatcher): enqueue system events directly instead of waking heartbeat"
```

---

### Task 4: Re-wire plugin entry (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts`

- [ ] **Step 1: Update index tests to assert enqueueSystemEvent is called**

Modify `src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import entry from "./index.js";

type HookEntry = {
  events: string | string[];
  name: string;
  description?: string;
  handler: (event: unknown) => Promise<unknown> | unknown;
};

function createMockApi(pluginConfig?: Record<string, unknown>) {
  const hooks: HookEntry[] = [];
  const httpRoutes: Array<{ path: string; handler: unknown }> = [];
  const tools: Array<{ name: string }> = [];
  const services: Array<{ id: string; start: () => Promise<void> }> = [];
  const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];

  const api = {
    pluginConfig,
    runtime: {
      system: {
        enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
          systemEvents.push({ text, opts });
          return true;
        },
      },
    },
    registerHttpRoute: (params: { path: string; handler: unknown }) => {
      httpRoutes.push(params);
    },
    registerTool: (tool: { name: string }) => {
      tools.push(tool);
    },
    registerHook: (
      events: string | string[],
      handler: (event: unknown) => Promise<unknown> | unknown,
      opts?: { name?: string; description?: string },
    ) => {
      hooks.push({
        events,
        name: opts?.name ?? "unnamed",
        description: opts?.description,
        handler,
      });
    },
    registerService: (service: { id: string; start: () => Promise<void> }) => {
      services.push(service);
    },
  };

  return { api, hooks, httpRoutes, tools, services, systemEvents };
}

describe("claude-code-openclaw-plugin", () => {
  it("exports a defined plugin entry", () => {
    expect(entry.id).toBe("claude-code-openclaw-plugin");
    expect(entry.register).toBeTypeOf("function");
  });

  it("registers heartbeat_prompt_contribution hook", () => {
    const { api, hooks } = createMockApi();
    entry.register!(api as never);
    const contribution = hooks.find((h) =>
      Array.isArray(h.events)
        ? h.events.includes("heartbeat_prompt_contribution")
        : h.events === "heartbeat_prompt_contribution",
    );
    expect(contribution).toBeDefined();
    expect(contribution?.name).toBe("claude-code-heartbeat-context");
  });

  it("heartbeat_prompt_contribution handler returns appendContext", async () => {
    const { api, hooks } = createMockApi();
    entry.register!(api as never);
    const contribution = hooks.find((h) =>
      Array.isArray(h.events)
        ? h.events.includes("heartbeat_prompt_contribution")
        : h.events === "heartbeat_prompt_contribution",
    );
    expect(contribution).toBeDefined();
    const result = await contribution!.handler({ sessionKey: "test-session" });
    expect(result).toEqual({ appendContext: "" });
  });
});
```

Run: `npx vitest run src/index.test.ts`
Expected: FAIL — index.ts still uses old dispatcher / requestHeartbeat.

- [ ] **Step 2: Re-wire plugin entry**

Modify `src/index.ts`:

```ts
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePluginConfig } from "./config.js";
import { discoverSession } from "./discovery.js";
import { createClaudeCodeRoutes } from "./routes.js";
import { createSessionStore } from "./store.js";
import { sendKeysToTmuxSession, tmuxSessionExists } from "./tmux.js";
import { createClaudeCodeStatusTool } from "./tools.js";

import { createClaudeCodeSpawnTool } from "./spawn.js";
import { createClaudeCodeStopTool } from "./stop.js";
import { createClaudeCodeRestoreTool } from "./restore.js";
import { createClaudeCodeSetupHooksTool } from "./setup-hooks.js";
import { createBehaviorDispatcher } from "./dispatcher.js";
import { buildClaudeCodeContext } from "./context.js";

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
    notifyStates: {
      type: "array",
      items: { type: "string" },
      default: ["WAITING", "QUESTION", "PERMISSION", "ERROR", "DONE"],
    },
    sendKeysRateLimitPerMinute: { type: "number", default: 10 },
    sessionTimeoutSeconds: { type: "number", default: 300 },
    targetSessionKey: { type: "string", default: "agent:main:main" },
  },
  required: [],
} as const;

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "claude-code-openclaw-plugin",
  name: "Claude Code harness",
  description: "Add Claude Code harness tools to OpenClaw.",
  configSchema: buildJsonPluginConfigSchema(pluginConfigJsonSchema),
  register(api: OpenClawPluginApi) {
    const rawConfig = api.pluginConfig ?? {};
    const config = resolvePluginConfig(rawConfig);
    const store = createSessionStore({ stateFileDir: config.stateFileDir });

    const dispatcher = createBehaviorDispatcher({
      enqueueSystemEvent: (text, opts) => {
        try {
          return api.runtime.system.enqueueSystemEvent(text, opts);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("claude-code: enqueueSystemEvent failed:", err);
          return false;
        }
      },
      notifyStates: config.notifyStates,
      sessionKey: config.targetSessionKey,
    });

    const routes = createClaudeCodeRoutes({
      store,
      config,
      dispatcher,
      discoverSession: async (sessionId) => discoverSession({ sessionId }),
      sendKeys: async ({ tmuxSession, text, submit }) => {
        const exists = await tmuxSessionExists(tmuxSession);
        if (!exists) throw new Error(`tmux session ${tmuxSession} not found`);
        await sendKeysToTmuxSession({ tmuxSession, text, submit });
      },
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/hook`,
      auth: "plugin",
      match: "exact",
      handler: routes.hook,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/spawn`,
      auth: "plugin",
      match: "exact",
      handler: routes.spawn,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/setup-hooks`,
      auth: "plugin",
      match: "exact",
      handler: routes.setupHooks,
    });

    api.registerHttpRoute({
      path: `${config.routePrefix}/`,
      auth: "plugin",
      match: "prefix",
      handler: routes.dispatch,
    });

    api.registerHook(
      "heartbeat_prompt_contribution",
      (async () => {
        const ctx = buildClaudeCodeContext({
          sessions: store.listStates(),
          notifyStates: config.notifyStates,
        });
        if (!ctx) return;
        return { appendContext: ctx };
      }) as Parameters<OpenClawPluginApi["registerHook"]>[1],
      {
        name: "claude-code-heartbeat-context",
        description: "Inject active Claude Code sessions into heartbeat prompts",
      },
    );

    api.registerTool(createClaudeCodeStatusTool(store));
    api.registerTool(createClaudeCodeSpawnTool());
    api.registerTool(createClaudeCodeStopTool());
    api.registerTool(createClaudeCodeRestoreTool());
    api.registerTool(createClaudeCodeSetupHooksTool());

    let timeoutTimer: NodeJS.Timeout | undefined;
    api.registerService({
      id: "claude-code-session-timeout",
      start: async () => {
        await store.loadFromDisk();
        const intervalMs = Math.min(config.sessionTimeoutSeconds * 1000, 60_000);
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
        timeoutTimer.unref();
      },
      stop: () => {
        if (timeoutTimer) clearInterval(timeoutTimer);
        void store.dispose();
      },
    });
  },
});

export default plugin;
```

Run: `npx vitest run src/index.test.ts`
Expected: PASS.

- [ ] **Step 3: Run full test suite and build**

Run: `npm run build && npm test`
Expected: build passes; 77 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(index): use enqueueSystemEvent for notifications and simplify heartbeat hook"
```

---

### Task 5: Add integration test for hook → enqueueSystemEvent

**Files:**
- Create: `src/integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `src/integration.test.ts`:

```ts
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import entry from "./index.js";

function mockReq(body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = "/claude-code/hook";
  req.headers = { "content-type": "application/json" };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
  return req;
}

function mockRes(): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse;
  res.statusCode = 200;
  res.writeHead = ((_code: number) => res) as ServerResponse["writeHead"];
  res.end = ((body?: string) => {
    (res as unknown as { body: string }).body = body ?? "";
    return res;
  }) as ServerResponse["end"];
  return res;
}

describe("hook event enqueues system event", () => {
  const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
  const api = {
    pluginConfig: {
      targetSessionKey: "agent:main:main",
      notifyStates: ["WAITING"],
      stateFileDir: "~/.cache/claude-code-integration-test",
    },
    runtime: {
      system: {
        enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
          systemEvents.push({ text, opts });
          return true;
        },
      },
    },
    registerHttpRoute: () => {},
    registerTool: () => {},
    registerHook: () => {},
    registerService: () => {},
  };

  beforeEach(() => {
    systemEvents.length = 0;
  });

  it("WAITING hook enqueues a system event", async () => {
    entry.register!(api as never);
    // Service start loads store from disk; wait for it.
    const services = [] as Array<{ id: string; start: () => Promise<void> }>;
    // We need the actual routes, so capture via a custom api in a real test. This stub is illustrative.
    // For a complete test, spy on registerHttpRoute to obtain the hook handler and invoke it.
  });
});
```

The integration test above is illustrative. To make it real, capture the hook route handler:

```ts
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import entry from "./index.js";

function mockReq(body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = "/claude-code/hook";
  req.headers = { "content-type": "application/json" };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
  return req;
}

function mockRes(): ServerResponse {
  const res = new EventEmitter() as unknown as ServerResponse;
  res.statusCode = 200;
  res.writeHead = ((_code: number) => res) as ServerResponse["writeHead"];
  res.end = ((body?: string) => {
    (res as unknown as { body: string }).body = body ?? "";
    return res;
  }) as ServerResponse["end"];
  return res;
}

describe("hook event enqueues system event", () => {
  it("WAITING hook triggers enqueueSystemEvent", async () => {
    const systemEvents: Array<{ text: string; opts: Record<string, unknown> }> = [];
    const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = [];

    const api = {
      pluginConfig: {
        targetSessionKey: "agent:main:main",
        notifyStates: ["WAITING"],
        stateFileDir: "~/.cache/claude-code-integration-test",
      },
      runtime: {
        system: {
          enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => {
            systemEvents.push({ text, opts });
            return true;
          },
        },
      },
      registerHttpRoute: (params: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => {
        routes.push(params);
      },
      registerTool: () => {},
      registerHook: () => {},
      registerService: () => {},
    };

    entry.register!(api as never);
    const hookRoute = routes.find((r) => r.path === "/claude-code/hook");
    expect(hookRoute).toBeDefined();

    const req = mockReq({ hook_event_name: "Stop", session_id: "integration-s1" });
    const res = mockRes();
    await hookRoute!.handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(systemEvents).toHaveLength(1);
    expect(systemEvents[0].text).toContain("waiting for input");
    expect(systemEvents[0].opts).toMatchObject({
      sessionKey: "agent:main:main",
      contextKey: "integration-s1",
    });
  });
});
```

Run: `npx vitest run src/integration.test.ts`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add src/integration.test.ts
git commit -m "test(integration): verify WAITING hook enqueues system event"
```

---

### Task 6: Smoke test

**Files:**
- None (manual / CLI)

- [ ] **Step 1: Build and start the plugin**

Run: `npm run build`
Expected: success.

- [ ] **Step 2: Start OpenClaw gateway with the plugin loaded**

Use the project's normal dev command or `openclaw` CLI to start gateway. Ensure `targetSessionKey` matches the active session (default `agent:main:main`).

- [ ] **Step 3: Send a WAITING hook event**

```bash
curl -X POST http://127.0.0.1:18789/claude-code/hook \
  -H "Content-Type: application/json" \
  -d '{"hook_event_name":"Stop","session_id":"smoke-s1"}'
```

Expected: `{"ok":true}`.

- [ ] **Step 4: Inspect OpenClaw session queue**

Use `openclaw` CLI or RPC to list queued system events for session `agent:main:main`. Verify a system event with text containing `waiting for input` and contextKey `smoke-s1` is present.

If the smoke test passes, proceed. If not, debug and fix.

- [ ] **Step 5: Commit smoke-test notes (optional)**

If smoke-test commands are worth preserving, append them to `docs/superpowers/specs/2026-06-21-v022-enqueue-system-event-design.md`.

---

### Task 7: Version bump to v0.2.2

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`

- [ ] **Step 1: Bump version strings**

Change `version` from `"0.2.1"` to `"0.2.2"` in both files.

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add package.json openclaw.plugin.json
git commit -m "chore(release): bump version to 0.2.2"
```

---

## Spec Coverage Check

- Drop `wake` field → Task 2.
- Dispatcher calls `enqueueSystemEvent` immediately → Task 3.
- `targetSessionKey` config → Task 1.
- `index.ts` rewired → Task 4.
- `heartbeat_prompt_contribution` kept but simplified → Task 4.
- Hook endpoint unchanged → no task needed.
- Tests updated / new integration test → Tasks 2, 3, 4, 5.
- Smoke test → Task 6.
- Version bump → Task 7.

## Placeholder Scan

No TBD/TODO/similar placeholders.

## Type Consistency

- `ClaudeCodeBehavior` loses `wake`; `resolveBehavior` returns `announce` false override.
- `createBehaviorDispatcher` options: `enqueueSystemEvent`, `notifyStates`, `sessionKey`.
- `PluginConfig` gains `targetSessionKey`.
- JSON schema in `src/index.ts` gains `targetSessionKey`.

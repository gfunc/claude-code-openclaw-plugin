# v0.2.0 Tool + Route Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `claude-task`, `claude-task-stop`, `claude-task-restore`, and `setup-claude-hooks` bash logic into the OpenClaw plugin as four tools + HTTP routes, while preserving existing CLI compatibility through HTTP-first bash wrappers with fallback to local bash logic.

**Architecture:** Four focused TypeScript modules (`spawn.ts`, `stop.ts`, `restore.ts`, `setup-hooks.ts`) each export a tool factory and a route handler. The plugin entry point registers all tools/routes. Bash scripts in `bin/` become thin curl wrappers that fall back to the original bash implementation when the plugin is unavailable.

**Tech Stack:** TypeScript, `@sinclair/typebox`, Vitest, `openclaw/plugin-sdk`, `tmux`, bash.

---

## File Structure

### New files
- `src/setup-hooks.ts` — `claude_code_setup_hooks` tool + route handler
- `src/setup-hooks.test.ts` — Vitest tests for setup-hooks
- `src/stop.ts` — `claude_code_stop` tool + route handler
- `src/stop.test.ts` — Vitest tests for stop
- `src/spawn.ts` — `claude_code_spawn` tool + route handler
- `src/spawn.test.ts` — Vitest tests for spawn
- `src/restore.ts` — `claude_code_restore` tool + route handler
- `src/restore.test.ts` — Vitest tests for restore

### Modified files
- `src/index.ts` — register new tools and routes
- `src/routes.ts` — add spawn/stop/restore/setup-hooks route handlers
- `openclaw.plugin.json` — declare new tools, bump version
- `package.json` — bump version
- `bin/claude-task` — rewrite as HTTP-first curl wrapper with bash fallback
- `bin/claude-task-stop` — rewrite as HTTP-first curl wrapper with bash fallback
- `bin/claude-task-restore` — rewrite as HTTP-first curl wrapper with bash fallback
- `bin/setup-claude-hooks` — rewrite as HTTP-first curl wrapper with bash fallback

### Symlink target (manual step, not committed)
- `~/.local/bin/claude-task` → `~/Projects/claude-code-openclaw-plugin/bin/claude-task`
- `~/.local/bin/claude-task-stop` → `~/Projects/claude-code-openclaw-plugin/bin/claude-task-stop`
- `~/.local/bin/claude-task-restore` → `~/Projects/claude-code-openclaw-plugin/bin/claude-task-restore`
- `~/.local/bin/setup-claude-hooks` → `~/Projects/claude-code-openclaw-plugin/bin/setup-claude-hooks`

---

## Shared Types and Helpers

The new modules will import from existing files:

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { PluginConfig } from "./config.js";
import type { SessionStore } from "./store.js";
```

All tools return `jsonResult({ success: boolean, ... })`. HTTP route handlers parse JSON bodies and path segments, call the same core functions, and return JSON with `sendJson(res, status, body)`.

---

## Task 1: `claude_code_setup_hooks` Tool

**Files:**
- Create: `src/setup-hooks.ts`
- Create: `src/setup-hooks.test.ts`

### Step 1: Write the failing test

```ts
// src/setup-hooks.test.ts
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeSetupHooksTool, handleSetupHooksRoute } from "./setup-hooks.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("claude_code_setup_hooks tool", () => {
  it("writes settings.local.json from template", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "setup-hooks-"));
    const templateDir = await fs.mkdtemp(path.join(os.tmpdir(), "setup-hooks-template-"));
    const template = path.join(templateDir, "settings.json");
    await fs.writeFile(template, JSON.stringify({ hooks: { url: "http://127.0.0.1:18789/claude-code/hook" } }), "utf8");

    const tool = createClaudeCodeSetupHooksTool({ templatePath: template });
    const result = await tool.execute("tc-1", { repoPath: repo });
    const details = result.details as { success: boolean; target: string };

    expect(details.success).toBe(true);
    expect(details.target).toBe(path.join(repo, ".claude", "settings.local.json"));
    const written = await fs.readFile(details.target, "utf8");
    expect(written).toContain("http://127.0.0.1:18789/claude-code/hook");
  });
});
```

Run: `npx vitest run src/setup-hooks.test.ts`
Expected: FAIL — `createClaudeCodeSetupHooksTool` not defined.

### Step 2: Implement `src/setup-hooks.ts`

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import fs from "node:fs/promises";
import path from "node:path";

export type SetupHooksConfig = {
  templatePath?: string;
};

const DEFAULT_TEMPLATE = path.join(
  process.env.HOME ?? "/",
  "Projects",
  "claude-code-openclaw-plugin",
  ".claude",
  "settings.json",
);

const HOOK_URL = "http://127.0.0.1:18789/claude-code/hook";

export async function setupHooks({
  repoPath,
  shared,
  force,
  templatePath,
}: {
  repoPath: string;
  shared?: boolean;
  force?: boolean;
  templatePath?: string;
}): Promise<{ success: boolean; target?: string; alreadyConfigured?: boolean; error?: string }> {
  const template = templatePath ?? DEFAULT_TEMPLATE;
  const absRepo = path.resolve(repoPath);
  try {
    await fs.access(absRepo);
  } catch {
    return { success: false, error: `not a directory: ${absRepo}` };
  }

  for (const f of [
    path.join(absRepo, ".claude", "settings.json"),
    path.join(absRepo, ".claude", "settings.local.json"),
  ]) {
    try {
      const content = await fs.readFile(f, "utf8");
      if (content.includes(HOOK_URL)) {
        return { success: true, target: f, alreadyConfigured: true };
      }
    } catch {
      // file does not exist
    }
  }

  const target = shared
    ? path.join(absRepo, ".claude", "settings.json")
    : path.join(absRepo, ".claude", "settings.local.json");

  if (!force) {
    try {
      await fs.access(target);
      return {
        success: false,
        error: `${target} exists but does not contain hook URL; use --force to overwrite`,
      };
    } catch {
      // target does not exist
    }
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(template, target);
  return { success: true, target };
}

export function createClaudeCodeSetupHooksTool(config?: SetupHooksConfig): AnyAgentTool {
  return {
    label: "Claude Code Setup Hooks",
    name: "claude_code_setup_hooks",
    description:
      "Install Claude Code hook settings in a target repository so the OpenClaw plugin can track sessions. Writes .claude/settings.local.json by default; use shared=true for .claude/settings.json.",
    parameters: Type.Object({
      repoPath: Type.String({ description: "Path to the target repository" }),
      shared: Type.Optional(Type.Boolean({ description: "Write to .claude/settings.json instead of .local.json" })),
      force: Type.Optional(Type.Boolean({ description: "Overwrite existing settings file" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { repoPath, shared, force } = params as { repoPath: string; shared?: boolean; force?: boolean };
      const result = await setupHooks({ repoPath, shared, force, templatePath: config?.templatePath });
      return jsonResult(result);
    },
  };
}

export async function handleSetupHooksRoute(
  body: unknown,
  config?: SetupHooksConfig,
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { repoPath, shared, force } = body as Record<string, unknown>;
  if (typeof repoPath !== "string") {
    return { status: 400, body: { error: "repoPath is required" } };
  }
  const result = await setupHooks({
    repoPath,
    shared: Boolean(shared),
    force: Boolean(force),
    templatePath: config?.templatePath,
  });
  return { status: result.success ? 200 : 409, body: result };
}
```

Run: `npx vitest run src/setup-hooks.test.ts`
Expected: PASS.

### Step 3: Commit

```bash
git add src/setup-hooks.ts src/setup-hooks.test.ts
git commit -m "feat(setup-hooks): add claude_code_setup_hooks tool and route handler"
```

---

## Task 2: `claude_code_stop` Tool

**Files:**
- Create: `src/stop.ts`
- Create: `src/stop.test.ts`

### Step 1: Write the failing test

```ts
// src/stop.test.ts
import { describe, expect, it, vi } from "vitest";
import { stopSession, createClaudeCodeStopTool, handleStopRoute } from "./stop.js";

describe("claude_code_stop tool", () => {
  it("stops a discovered session", async () => {
    const exec = vi.fn();
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // has-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // kill-session

    const result = await stopSession({
      sessionName: "cc-test",
      exec,
      tasksDir: "/tmp/stop-test",
      writeState: async () => {},
      killWatchdog: async () => {},
    });

    expect(result.success).toBe(true);
    expect(exec).toHaveBeenCalledWith(["tmux", "has-session", "-t", "cc-test"], { timeoutMs: 2000 });
    expect(exec).toHaveBeenCalledWith(["tmux", "kill-session", "-t", "cc-test"], { timeoutMs: 5000 });
  });

  it("returns not found when session does not exist", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const result = await stopSession({
      sessionName: "cc-missing",
      exec,
      tasksDir: "/tmp/stop-test",
      writeState: async () => {},
      killWatchdog: async () => {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not alive");
  });
});
```

Run: `npx vitest run src/stop.test.ts`
Expected: FAIL — `stopSession` not defined.

### Step 2: Implement `src/stop.ts`

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type StopDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  killWatchdog?: (statePath: string) => Promise<void>;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

export async function stopSession({
  sessionName,
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  killWatchdog = defaultKillWatchdog,
}: {
  sessionName: string;
} & StopDeps): Promise<{ success: boolean; sessionName: string; stopped?: boolean; error?: string }> {
  const statePath = path.join(tasksDir, `${sessionName}.state`);
  await killWatchdog(statePath);

  const hasSession = await exec(["tmux", "has-session", "-t", sessionName], { timeoutMs: 2000 });
  if (hasSession.code !== 0) {
    return { success: false, sessionName, error: `session not alive: ${sessionName}` };
  }

  await exec(["tmux", "kill-session", "-t", sessionName], { timeoutMs: 5000 });
  await writeState(statePath, `STOPPED ${Date.now() / 1000 | 0}\n`);
  return { success: true, sessionName, stopped: true };
}

async function defaultWriteState(statePath: string, line: string): Promise<void> {
  await fs.appendFile(statePath, line, "utf8").catch(() => {});
}

async function defaultKillWatchdog(statePath: string): Promise<void> {
  const watchdogPath = `${statePath}.watchdog`;
  try {
    const pid = await fs.readFile(watchdogPath, "utf8");
    if (pid.trim()) {
      try {
        process.kill(Number(pid.trim()), "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // no watchdog file
  }
  await fs.unlink(watchdogPath).catch(() => {});
}

export function createClaudeCodeStopTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Stop",
    name: "claude_code_stop",
    description: "Stop a running Claude Code tmux session by its tmux session name.",
    parameters: Type.Object({
      sessionName: Type.String({ description: "Tmux session name to stop" }),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { sessionName } = params as { sessionName: string };
      const result = await stopSession({ sessionName });
      return jsonResult(result);
    },
  };
}

export async function handleStopRoute(
  body: unknown,
  _config?: unknown,
): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { sessionName } = body as Record<string, unknown>;
  if (typeof sessionName !== "string") {
    return { status: 400, body: { error: "sessionName is required" } };
  }
  const result = await stopSession({ sessionName });
  return { status: result.success ? 200 : 404, body: result };
}
```

Run: `npx vitest run src/stop.test.ts`
Expected: PASS.

### Step 3: Commit

```bash
git add src/stop.ts src/stop.test.ts
git commit -m "feat(stop): add claude_code_stop tool and route handler"
```

---

## Task 3: `claude_code_spawn` Tool

**Files:**
- Create: `src/spawn.ts`
- Create: `src/spawn.test.ts`

### Step 1: Write the failing test

```ts
// src/spawn.test.ts
import { describe, expect, it, vi } from "vitest";
import { spawnSession, createClaudeCodeSpawnTool } from "./spawn.js";

describe("claude_code_spawn tool", () => {
  it("spawns a session with expected tmux commands", async () => {
    const exec = vi.fn();
    // kill-session (cleanup)
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    // new-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    // pipe-pane
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    // capture-pane
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    // load-buffer
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    // paste-buffer
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    const writeState = vi.fn().mockResolvedValue(undefined);
    const startWatchdog = vi.fn().mockResolvedValue(undefined);

    const result = await spawnSession({
      tmuxSession: "cc-test",
      task: "echo hello",
      budgetMinutes: 5,
      workdir: "/tmp",
      exec,
      writeState,
      startWatchdog,
      uuid: () => "test-uuid",
      sleepMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("test-uuid");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["tmux", "new-session", "-d", "-s", "cc-test"]),
      { timeoutMs: 10000 },
    );
    expect(writeState).toHaveBeenCalled();
    expect(startWatchdog).toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/spawn.test.ts`
Expected: FAIL — `spawnSession` not defined.

### Step 2: Implement `src/spawn.ts`

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type SpawnDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
  uuid?: () => string;
  sleepMs?: number;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

function defaultUuid(): string {
  return crypto.randomUUID();
}

async function defaultWriteState(statePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, line, "utf8");
}

async function defaultStartWatchdog(
  statePath: string,
  sessionId: string,
  tmuxSession: string,
  budgetMinutes: number,
): Promise<void> {
  const watchdogPath = `${statePath}.watchdog`;
  const script = `
HOOK_STATE="$HOME/.cache/claude-code-hooks/${sessionId}.json"
GRACE_MIN=$(( ${budgetMinutes} + 5 ))
while true; do
  sleep 30
  if [ -f "\$HOOK_STATE" ]; then
    LAST_TOUCH=$(stat -c %Y "\$HOOK_STATE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    IDLE_MIN=$(( (NOW - LAST_TOUCH) / 60 ))
    if [ "\$IDLE_MIN" -ge "${budgetMinutes}" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_IDLE $(date +%s) session_id=${sessionId} idle_min=\$IDLE_MIN budget_min=${budgetMinutes}" >> "${statePath}"
      fi
      break
    fi
  else
    NOW=$(date +%s)
    START_S=$(stat -c %Y "${statePath}" 2>/dev/null || echo \$NOW)
    ELAPSED_MIN=$(( (NOW - START_S) / 60 ))
    if [ "\$ELAPSED_MIN" -ge "\$GRACE_MIN" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) session_id=${sessionId} elapsed_min=\$ELAPSED_MIN" >> "${statePath}"
      fi
      break
    fi
  fi
done
`.trim();
  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  if (child.pid) {
    await fs.writeFile(watchdogPath, String(child.pid), "utf8").catch(() => {});
  }
}

export async function spawnSession({
  tmuxSession,
  task,
  budgetMinutes = 30,
  workdir = process.cwd(),
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  startWatchdog = defaultStartWatchdog,
  uuid = defaultUuid,
  sleepMs = 5000,
}: {
  tmuxSession: string;
  task: string;
  budgetMinutes?: number;
  workdir?: string;
} & SpawnDeps): Promise<{
  success: boolean;
  tmuxSession: string;
  sessionId: string;
  budgetMinutes: number;
  workdir: string;
  logFile: string;
  stateFile: string;
  error?: string;
}> {
  const sessionId = uuid();
  const logFile = path.join(tasksDir, `${tmuxSession}.log`);
  const stateFile = path.join(tasksDir, `${tmuxSession}.state`);

  try {
    // Cleanup old session
    await exec(["tmux", "kill-session", "-t", tmuxSession], { timeoutMs: 5000 }).catch(() => {});
    await fs.rm(logFile, { force: true });
    await fs.rm(stateFile, { force: true });
    await fs.rm(`${stateFile}.watchdog`, { force: true });

    // Spawn interactive Claude Code session
    await exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        workdir,
        `claude --session-id '${sessionId}' --permission-mode bypassPermissions`,
      ],
      { timeoutMs: 10000 },
    );

    // Start logging
    await exec(["tmux", "pipe-pane", "-t", tmuxSession, "-o", `cat >> '${logFile}'`], { timeoutMs: 5000 });

    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }

    // Detect and auto-accept trust dialog
    const capture = await exec(["tmux", "capture-pane", "-t", tmuxSession, "-p"], { timeoutMs: 5000 });
    const stdout = capture.stdout ?? "";
    const trustThreeOption =
      /1\. Continue/i.test(stdout) &&
      /2\. Fix with Claude/i.test(stdout) &&
      /3\. Exit and fix manually/i.test(stdout) &&
      /Enter to confirm/i.test(stdout);
    const trustTwoOption =
      /Yes, I trust this folder/i.test(stdout) && /No, exit/i.test(stdout);
    if (trustThreeOption || trustTwoOption) {
      await exec(["tmux", "send-keys", "-t", tmuxSession, "1"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 1000));
      await exec(["tmux", "send-keys", "-t", tmuxSession, "Enter"], { timeoutMs: 5000 });
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Send task via paste-buffer (avoid stdin to keep ExecFn compatible)
    const bufPath = path.join(tasksDir, `${tmuxSession}.taskbuf`);
    await fs.writeFile(bufPath, task, "utf8");
    await exec(["tmux", "load-buffer", "-b", "taskbuf", bufPath], { timeoutMs: 5000 });
    await exec(["tmux", "paste-buffer", "-b", "taskbuf", "-t", tmuxSession], { timeoutMs: 5000 });
    await exec(["tmux", "send-keys", "-t", tmuxSession, "Enter"], { timeoutMs: 5000 });
    await fs.rm(bufPath, { force: true });

    // Persist state
    const stateLine = `RUNNING ${Date.now() / 1000 | 0} budget=${budgetMinutes}min workdir=${workdir} session_id=${sessionId}\n`;
    await writeState(stateFile, stateLine);

    // Start idle watchdog
    await startWatchdog(stateFile, sessionId, tmuxSession, budgetMinutes);

    return {
      success: true,
      tmuxSession,
      sessionId,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
    };
  } catch (err) {
    return {
      success: false,
      tmuxSession,
      sessionId,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
      error: String(err),
    };
  }
}

export function createClaudeCodeSpawnTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Spawn",
    name: "claude_code_spawn",
    description:
      "Spawn an interactive Claude Code session in a detached tmux session. Returns immediately.",
    parameters: Type.Object({
      tmuxSession: Type.String({ description: "Name for the tmux session" }),
      task: Type.String({ description: "Initial task to send to Claude Code" }),
      budgetMinutes: Type.Optional(Type.Number({ description: "Idle budget in minutes (default 30)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (default cwd)" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { tmuxSession, task, budgetMinutes, workdir } = params as {
        tmuxSession: string;
        task: string;
        budgetMinutes?: number;
        workdir?: string;
      };
      const result = await spawnSession({ tmuxSession, task, budgetMinutes, workdir });
      return jsonResult(result);
    },
  };
}

export async function handleSpawnRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { tmuxSession, task, budgetMinutes, workdir } = body as Record<string, unknown>;
  if (typeof tmuxSession !== "string" || typeof task !== "string") {
    return { status: 400, body: { error: "tmuxSession and task are required" } };
  }
  const result = await spawnSession({
    tmuxSession,
    task,
    budgetMinutes: typeof budgetMinutes === "number" ? budgetMinutes : undefined,
    workdir: typeof workdir === "string" ? workdir : undefined,
  });
  return { status: result.success ? 200 : 500, body: result };
}
```

Run: `npx vitest run src/spawn.test.ts`
Expected: PASS.

### Step 3: Commit

```bash
git add src/spawn.ts src/spawn.test.ts
git commit -m "feat(spawn): add claude_code_spawn tool and route handler"
```

---

## Task 4: `claude_code_restore` Tool

**Files:**
- Create: `src/restore.ts`
- Create: `src/restore.test.ts`

### Step 1: Write the failing test

```ts
// src/restore.test.ts
import { describe, expect, it, vi } from "vitest";
import { restoreSession, createClaudeCodeRestoreTool } from "./restore.js";

describe("claude_code_restore tool", () => {
  it("resumes a session with expected tmux commands", async () => {
    const exec = vi.fn();
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // kill-session
    exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // new-session

    const writeState = vi.fn().mockResolvedValue(undefined);
    const startWatchdog = vi.fn().mockResolvedValue(undefined);

    const result = await restoreSession({
      sessionId: "sid-123",
      tmuxSession: "cc-resume",
      workdir: "/tmp",
      budgetMinutes: 10,
      exec,
      writeState,
      startWatchdog,
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("sid-123");
    expect(exec).toHaveBeenCalledWith(
      expect.arrayContaining(["tmux", "new-session", "-d", "-s", "cc-resume"]),
      { timeoutMs: 10000 },
    );
    expect(writeState).toHaveBeenCalled();
    expect(startWatchdog).toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/restore.test.ts`
Expected: FAIL — `restoreSession` not defined.

### Step 2: Implement `src/restore.ts`

```ts
import { Type } from "typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ExecFn } from "./tmux.js";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type RestoreDeps = {
  exec?: ExecFn;
  tasksDir?: string;
  writeState?: (statePath: string, line: string) => Promise<void>;
  startWatchdog?: (statePath: string, sessionId: string, tmuxSession: string, budgetMinutes: number) => Promise<void>;
};

const DEFAULT_TASKS_DIR = path.join(os.homedir(), ".cache", "claude-tasks");

async function defaultWriteState(statePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, line, "utf8");
}

async function defaultStartWatchdog(
  statePath: string,
  sessionId: string,
  tmuxSession: string,
  budgetMinutes: number,
): Promise<void> {
  const watchdogPath = `${statePath}.watchdog`;
  const script = `
HOOK_STATE="$HOME/.cache/claude-code-hooks/${sessionId}.json"
GRACE_MIN=$(( ${budgetMinutes} + 5 ))
while true; do
  sleep 30
  if [ -f "\$HOOK_STATE" ]; then
    LAST_TOUCH=$(stat -c %Y "\$HOOK_STATE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    IDLE_MIN=$(( (NOW - LAST_TOUCH) / 60 ))
    if [ "\$IDLE_MIN" -ge "${budgetMinutes}" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_IDLE $(date +%s) resumed_from=${sessionId} idle_min=\$IDLE_MIN" >> "${statePath}"
      fi
      break
    fi
  else
    NOW=$(date +%s)
    START_S=$(stat -c %Y "${statePath}" 2>/dev/null || echo \$NOW)
    ELAPSED_MIN=$(( (NOW - START_S) / 60 ))
    if [ "\$ELAPSED_MIN" -ge "\$GRACE_MIN" ]; then
      if tmux has-session -t "${tmuxSession}" 2>/dev/null; then
        tmux kill-session -t "${tmuxSession}" 2>/dev/null
        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) resumed_from=${sessionId} elapsed_min=\$ELAPSED_MIN" >> "${statePath}"
      fi
      break
    fi
  fi
done
`.trim();
  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  if (child.pid) {
    await fs.writeFile(watchdogPath, String(child.pid), "utf8").catch(() => {});
  }
}

export async function restoreSession({
  sessionId,
  tmuxSession = "cc-resume",
  workdir = process.cwd(),
  budgetMinutes = 30,
  exec = runCommandWithTimeout,
  tasksDir = DEFAULT_TASKS_DIR,
  writeState = defaultWriteState,
  startWatchdog = defaultStartWatchdog,
}: {
  sessionId: string;
  tmuxSession?: string;
  workdir?: string;
  budgetMinutes?: number;
} & RestoreDeps): Promise<{
  success: boolean;
  sessionId: string;
  tmuxSession: string;
  budgetMinutes: number;
  workdir: string;
  logFile: string;
  stateFile: string;
  error?: string;
}> {
  const logFile = path.join(tasksDir, `${tmuxSession}.log`);
  const stateFile = path.join(tasksDir, `${tmuxSession}.state`);

  try {
    await exec(["tmux", "kill-session", "-t", tmuxSession], { timeoutMs: 5000 }).catch(() => {});
    await fs.rm(logFile, { force: true });
    await fs.rm(stateFile, { force: true });
    await fs.rm(`${stateFile}.watchdog`, { force: true });

    await exec(
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        tmuxSession,
        "-c",
        workdir,
        `claude --resume '${sessionId}' --permission-mode bypassPermissions 2>&1 | tee '${logFile}'`,
      ],
      { timeoutMs: 10000 },
    );

    const stateLine = `RUNNING ${Date.now() / 1000 | 0} budget=${budgetMinutes}min workdir=${workdir} resumed_from=${sessionId}\n`;
    await writeState(stateFile, stateLine);
    await startWatchdog(stateFile, sessionId, tmuxSession, budgetMinutes);

    return {
      success: true,
      sessionId,
      tmuxSession,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
    };
  } catch (err) {
    return {
      success: false,
      sessionId,
      tmuxSession,
      budgetMinutes,
      workdir,
      logFile,
      stateFile,
      error: String(err),
    };
  }
}

export function createClaudeCodeRestoreTool(_config?: unknown): AnyAgentTool {
  return {
    label: "Claude Code Restore",
    name: "claude_code_restore",
    description: "Resume a previous Claude Code session id in a new tmux session.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Claude Code session id to resume" }),
      tmuxSession: Type.Optional(Type.String({ description: "Name for the new tmux session (default cc-resume)" })),
      workdir: Type.Optional(Type.String({ description: "Working directory (default cwd)" })),
      budgetMinutes: Type.Optional(Type.Number({ description: "Idle budget in minutes (default 30)" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const { sessionId, tmuxSession, workdir, budgetMinutes } = params as {
        sessionId: string;
        tmuxSession?: string;
        workdir?: string;
        budgetMinutes?: number;
      };
      const result = await restoreSession({ sessionId, tmuxSession, workdir, budgetMinutes });
      return jsonResult(result);
    },
  };
}

export async function handleRestoreRoute(body: unknown): Promise<{ status: number; body: unknown }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: "invalid body" } };
  }
  const { sessionId, tmuxSession, workdir, budgetMinutes } = body as Record<string, unknown>;
  if (typeof sessionId !== "string") {
    return { status: 400, body: { error: "sessionId is required" } };
  }
  const result = await restoreSession({
    sessionId,
    tmuxSession: typeof tmuxSession === "string" ? tmuxSession : undefined,
    workdir: typeof workdir === "string" ? workdir : undefined,
    budgetMinutes: typeof budgetMinutes === "number" ? budgetMinutes : undefined,
  });
  return { status: result.success ? 200 : 500, body: result };
}
```

Run: `npx vitest run src/restore.test.ts`
Expected: PASS.

### Step 3: Commit

```bash
git add src/restore.ts src/restore.test.ts
git commit -m "feat(restore): add claude_code_restore tool and route handler"
```

---

## Task 5: Integrate Routes into `src/routes.ts`

**Files:**
- Modify: `src/routes.ts`

### Step 1: Update route creation function signature

Add handler imports and new dependencies to `createClaudeCodeRoutes`:

```ts
import { handleSpawnRoute } from "./spawn.js";
import { handleStopRoute } from "./stop.js";
import { handleRestoreRoute } from "./restore.js";
import { handleSetupHooksRoute } from "./setup-hooks.js";
```

### Step 2: Refactor `send` and add `dispatch`

Refactor the existing `send` function to accept an optional `tmuxSession`:

```ts
async function send(
  req: IncomingMessage,
  res: ServerResponse,
  explicitTmuxSession?: string,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith(config.routePrefix)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const suffix = pathname.slice(config.routePrefix.length);
  const tmuxSession = explicitTmuxSession ?? suffix.match(/^\/([^/]+)\/send$/)?.[1];
  if (!tmuxSession) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const tracked = store.listStates().find((s) => s.tmuxSession === tmuxSession);
  if (!tracked) {
    sendJson(res, 404, { error: "session not tracked" });
    return;
  }
  const now = Date.now();
  const minIntervalMs = 60_000 / config.sendKeysRateLimitPerMinute;
  const lastSent = lastSendAt.get(tmuxSession) ?? 0;
  if (now - lastSent < minIntervalMs) {
    sendJson(res, 429, { error: "rate limited" });
    return;
  }
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, { error: "invalid body" });
      return;
    }
    const text = String(body.text ?? "");
    const submit = Boolean(body.submit);
    await sendKeys?.({ tmuxSession, text, submit });
    lastSendAt.set(tmuxSession, Date.now());
    sendJson(res, 200, { sent: true, sessionId: tracked.sessionId });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}
```

Add the new route handlers:

```ts
async function spawn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const { status, body: resp } = await handleSpawnRoute(body);
    sendJson(res, status, resp);
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}

async function setupHooks(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const { status, body: resp } = await handleSetupHooksRoute(body);
    sendJson(res, status, resp);
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const pathname = url.pathname;
  if (!pathname.startsWith(config.routePrefix)) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const suffix = pathname.slice(config.routePrefix.length);

  // Existing send route: /claude-code/<tmux>/send
  const sendMatch = suffix.match(/^\/([^/]+)\/send$/);
  if (sendMatch) {
    await send(req, res, sendMatch[1]);
    return;
  }

  // New routes: /claude-code/<session>/stop and /claude-code/<session>/restore
  // Also accept /claude-code/stop and /claude-code/restore with params in body.
  const dynamicMatch = suffix.match(/^\/([^/]+)\/(stop|restore)$/);
  const exactActionMatch = suffix.match(/^\/(stop|restore)$/);
  const actionFromPath = (dynamicMatch?.[2] ?? exactActionMatch?.[1]) as "stop" | "restore" | undefined;
  const nameFromPath = dynamicMatch?.[1];

  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    const payload = typeof body === "object" && body !== null && !Array.isArray(body) ? body : {};

    if (actionFromPath === "stop") {
      const sessionName = nameFromPath ?? (payload as Record<string, unknown>).sessionName;
      if (typeof sessionName !== "string") {
        sendJson(res, 400, { error: "sessionName is required" });
        return;
      }
      const result = await stopSession({ sessionName });
      sendJson(res, result.success ? 200 : 404, result);
      return;
    }

    if (actionFromPath === "restore") {
      const sessionId = nameFromPath ?? (payload as Record<string, unknown>).sessionId;
      if (typeof sessionId !== "string") {
        sendJson(res, 400, { error: "sessionId is required" });
        return;
      }
      const tmuxSession = typeof (payload as Record<string, unknown>).tmuxSession === "string"
        ? (payload as Record<string, unknown>).tmuxSession as string
        : undefined;
      const workdir = typeof (payload as Record<string, unknown>).workdir === "string"
        ? (payload as Record<string, unknown>).workdir as string
        : undefined;
      const budgetMinutes = typeof (payload as Record<string, unknown>).budgetMinutes === "number"
        ? (payload as Record<string, unknown>).budgetMinutes as number
        : undefined;
      const result = await restoreSession({ sessionId, tmuxSession, workdir, budgetMinutes });
      sendJson(res, result.success ? 200 : 500, result);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err) });
  }
}
```

### Step 3: Export handlers

Update the return object:

```ts
return { hook, send, spawn, setupHooks, dispatch };
```

Run: `npx vitest run src/routes.test.ts`
Expected: PASS (existing tests still pass).

### Step 4: Commit

```bash
git add src/routes.ts
git commit -m "feat(routes): add spawn, setup-hooks, stop, and restore route handlers"
```

---

## Task 6: Register Tools and Routes in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

### Step 1: Import new tool factories

```ts
import { createClaudeCodeSpawnTool } from "./spawn.js";
import { createClaudeCodeStopTool } from "./stop.js";
import { createClaudeCodeRestoreTool } from "./restore.js";
import { createClaudeCodeSetupHooksTool } from "./setup-hooks.js";
```

### Step 2: Register routes

After the existing `/claude-code/hook` route and before `api.registerTool`, add:

```ts
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
```

Update the prefix route registration to use the new dispatcher:

```ts
api.registerHttpRoute({
  path: `${config.routePrefix}/`,
  auth: "plugin",
  match: "prefix",
  handler: routes.dispatch, // handles <tmux>/send, <session>/stop, <session>/restore
});
```

**Auth note:** Routes use `auth: "plugin"` to match the existing `/claude-code/hook` and `/claude-code/<tmux>/send` routes. Local curl calls from bash wrappers will receive a 401/403 or connection failure and fall back to the local bash implementation. This is intentional per the Option A fallback strategy.

### Step 3: Register tools

Keep the existing status tool registration and add the new tools:

```ts
api.registerTool(createClaudeCodeStatusTool(store));
api.registerTool(createClaudeCodeSpawnTool());
api.registerTool(createClaudeCodeStopTool());
api.registerTool(createClaudeCodeRestoreTool());
api.registerTool(createClaudeCodeSetupHooksTool());
```

Run: `npm run build`
Expected: PASS (no TypeScript errors).

Run: `npx vitest run src/index.test.ts src/routes.test.ts`
Expected: PASS.

### Step 4: Commit

```bash
git add src/index.ts src/routes.ts
git commit -m "feat(index): register spawn/stop/restore/setup-hooks tools and routes"
```

---

## Task 7: Bump Manifest and Package Versions

**Files:**
- Modify: `openclaw.plugin.json`
- Modify: `package.json`

### Step 1: Update `openclaw.plugin.json`

```json
{
  "version": "0.2.0",
  "contracts": {
    "tools": [
      "claude_code_status",
      "claude_code_spawn",
      "claude_code_stop",
      "claude_code_restore",
      "claude_code_setup_hooks"
    ]
  }
}
```

### Step 2: Update `package.json`

```json
{
  "version": "0.2.0"
}
```

### Step 3: Commit

```bash
git add openclaw.plugin.json package.json
git commit -m "chore(manifest): bump version to 0.2.0 and declare new tools"
```

---

## Task 8: Rewrite Bash Wrappers in `bin/`

**Files:**
- Modify: `bin/claude-task`
- Modify: `bin/claude-task-stop`
- Modify: `bin/claude-task-restore`
- Modify: `bin/setup-claude-hooks`

Strategy for each script:
1. Parse CLI args exactly as before.
2. Build JSON payload.
3. `curl -fsS` to the plugin endpoint.
4. On success, print the plugin's output and exit 0.
5. On any failure (network, non-2xx), run the existing bash implementation as fallback.

### `bin/claude-task`

```bash
#!/usr/bin/env bash
# claude-task - Spawn an INTERACTIVE Claude Code session in tmux.
# HTTP-first wrapper: tries the OpenClaw plugin, falls back to local bash.

set -euo pipefail

GATEWAY="http://127.0.0.1:18789"

fallback() {
    # --- LOCAL BASH IMPLEMENTATION START ---
    if [ $# -lt 2 ]; then
        cat <<EOF
Usage: claude-task <session> <task> [budget-min=30] [workdir=\$PWD]

Spawns an INTERACTIVE Claude Code session in tmux:
  - default budget 30min (watchdog auto-kills)
  - explicit session id (saved to state file, resumable)
  - bypassPermissions by default
  - spawns detached — does NOT block the calling channel

Manage via:
  claude-task-status <session>    # status + session id
  claude-task-stop <session>      # kill early
  claude-task-restore <sid> [session] [workdir]   # resume in new tmux
  tmux attach -t <session>         # interactive
EOF
        exit 1
    fi

    SESSION="$1"
    TASK="$2"
    BUDGET="${3:-30}"
    DIR="${4:-$PWD}"

    TASK_DIR="$HOME/.cache/claude-tasks"
    LOG="$TASK_DIR/$SESSION.log"
    STATE="$TASK_DIR/$SESSION.state"
    mkdir -p "$TASK_DIR"

    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -f "$LOG" "$STATE" "${STATE}.watchdog"

    SID=$(cat /proc/sys/kernel/random/uuid)

    tmux new-session -d -s "$SESSION" -c "$DIR" \
        "claude --session-id '$SID' --permission-mode bypassPermissions"

    tmux pipe-pane -t "$SESSION" -o "cat >> '$LOG'"

    sleep 5

    CAPTURE=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)
    TRUST_MATCHED=""
    if echo "$CAPTURE" | grep -qiE "1\. Continue" \
        && echo "$CAPTURE" | grep -qiE "2\. Fix with Claude" \
        && echo "$CAPTURE" | grep -qiE "3\. Exit and fix manually" \
        && echo "$CAPTURE" | grep -qiE "Enter to confirm"; then
        TRUST_MATCHED="2.x-three-option"
    elif echo "$CAPTURE" | grep -qiE "Yes, I trust this folder" \
        && echo "$CAPTURE" | grep -qiE "No, exit"; then
        TRUST_MATCHED="2.x-two-option"
    fi
    if [ -n "$TRUST_MATCHED" ]; then
        tmux send-keys -t "$SESSION" "1"
        sleep 1
        tmux send-keys -t "$SESSION" Enter
        sleep 2
    fi

    printf '%s' "$TASK" | tmux load-buffer -
    tmux paste-buffer -t "$SESSION"
    tmux send-keys -t "$SESSION" Enter

    echo "RUNNING $(date +%s) budget=${BUDGET}min workdir=$DIR session_id=$SID" > "$STATE"

    (
        HOOK_STATE="$HOME/.cache/claude-code-hooks/${SID}.json"
        GRACE_MIN=$((BUDGET + 5))
        while true; do
            sleep 30
            if [ -f "$HOOK_STATE" ]; then
                LAST_TOUCH=$(stat -c %Y "$HOOK_STATE" 2>/dev/null || echo 0)
                NOW=$(date +%s)
                IDLE_MIN=$(( (NOW - LAST_TOUCH) / 60 ))
                if [ "$IDLE_MIN" -ge "$BUDGET" ]; then
                    if tmux has-session -t "$SESSION" 2>/dev/null; then
                        tmux kill-session -t "$SESSION" 2>/dev/null
                        echo "BUDGET_EXCEEDED_IDLE $(date +%s) session_id=$SID idle_min=$IDLE_MIN budget_min=$BUDGET" >> "$STATE"
                    fi
                    break
                fi
            else
                NOW=$(date +%s)
                START_S=$(stat -c %Y "$STATE" 2>/dev/null || echo $NOW)
                ELAPSED_MIN=$(( (NOW - START_S) / 60 ))
                if [ "$ELAPSED_MIN" -ge "$GRACE_MIN" ]; then
                    if tmux has-session -t "$SESSION" 2>/dev/null; then
                        tmux kill-session -t "$SESSION" 2>/dev/null
                        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) session_id=$SID elapsed_min=$ELAPSED_MIN" >> "$STATE"
                    fi
                    break
                fi
            fi
        done
    ) &
    WATCHDOG_PID=$!
    disown "$WATCHDOG_PID" 2>/dev/null || true
    echo "$WATCHDOG_PID" > "${STATE}.watchdog"

    cat <<EOF
✓ spawned: $SESSION
  budget:     ${BUDGET}min
  workdir:    $DIR
  session id: $SID
  log:        $LOG
  state:      $STATE
  attach:     tmux attach -t $SESSION
  resume:     claude-task-restore $SID
  status:     claude-task-status $SESSION
  stop:       claude-task-stop $SESSION
EOF
    # --- LOCAL BASH IMPLEMENTATION END ---
}

if [ $# -lt 2 ]; then
    fallback "$@"
    exit $?
fi

SESSION="$1"
TASK="$2"
BUDGET="${3:-30}"
DIR="${4:-$PWD}"

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"tmuxSession":sys.argv[1],"task":sys.argv[2],"budgetMinutes":int(sys.argv[3]),"workdir":sys.argv[4]}))' "$SESSION" "$TASK" "$BUDGET" "$DIR")

if curl -fsS -X POST "${GATEWAY}/claude-code/spawn" \
    -H "content-type: application/json" \
    -d "$PAYLOAD"; then
    exit 0
fi

fallback "$@"
```

### `bin/claude-task-stop`

```bash
#!/usr/bin/env bash
# claude-task-stop - Kill a claude-task session early.
# HTTP-first wrapper: tries the OpenClaw plugin, falls back to local bash.

set -euo pipefail

GATEWAY="http://127.0.0.1:18789"

fallback() {
    # --- LOCAL BASH IMPLEMENTATION START ---
    if [ $# -lt 1 ]; then
        echo "Usage: claude-task-stop <session>"
        exit 1
    fi

    SESSION="$1"
    STATE="$HOME/.cache/claude-tasks/$SESSION.state"
    WATCHDOG="$STATE.watchdog"

    if [ -f "$WATCHDOG" ]; then
        WPID=$(cat "$WATCHDOG" 2>/dev/null || true)
        if [ -n "$WPID" ]; then
            kill "$WPID" 2>/dev/null || true
        fi
        rm -f "$WATCHDOG"
    fi

    if tmux has-session -t "$SESSION" 2>/dev/null; then
        tmux kill-session -t "$SESSION"
        echo "STOPPED $(date +%s)" >> "$STATE" 2>/dev/null || true
        echo "✓ killed session: $SESSION"
    else
        echo "session not alive: $SESSION"
    fi
    # --- LOCAL BASH IMPLEMENTATION END ---
}

if [ $# -lt 1 ]; then
    fallback "$@"
    exit $?
fi

SESSION="$1"

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"sessionName":sys.argv[1]}))' "$SESSION")

if curl -fsS -X POST "${GATEWAY}/claude-code/${SESSION}/stop" \
    -H "content-type: application/json" \
    -d "$PAYLOAD"; then
    exit 0
fi

fallback "$@"
```

### `bin/claude-task-restore`

```bash
#!/usr/bin/env bash
# claude-task-restore - Spawn a NEW tmux session that --resume's a previous session id.
# HTTP-first wrapper: tries the OpenClaw plugin, falls back to local bash.

set -euo pipefail

GATEWAY="http://127.0.0.1:18789"

fallback() {
    # --- LOCAL BASH IMPLEMENTATION START ---
    if [ $# -lt 1 ]; then
        cat <<EOF
Usage: claude-task-restore <session-id> [tmux-session-name] [workdir=\$PWD] [budget-min=30]

Resumes a previous Claude Code session by id, in a new tmux session.
EOF
        exit 1
    fi

    SID="$1"
    TMUX_SESSION="${2:-cc-resume}"
    DIR="${3:-$PWD}"
    BUDGET="${4:-30}"

    TASK_DIR="$HOME/.cache/claude-tasks"
    LOG="$TASK_DIR/$TMUX_SESSION.log"
    STATE="$TASK_DIR/$TMUX_SESSION.state"
    mkdir -p "$TASK_DIR"

    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    rm -f "$LOG" "$STATE" "${STATE}.watchdog"

    tmux new-session -d -s "$TMUX_SESSION" -c "$DIR" \
        "claude --resume '$SID' --permission-mode bypassPermissions 2>&1 | tee '$LOG'"

    echo "RUNNING $(date +%s) budget=${BUDGET}min workdir=$DIR resumed_from=$SID" > "$STATE"

    (
        HOOK_STATE="$HOME/.cache/claude-code-hooks/${SID}.json"
        GRACE_MIN=$((BUDGET + 5))
        while true; do
            sleep 30
            if [ -f "$HOOK_STATE" ]; then
                LAST_TOUCH=$(stat -c %Y "$HOOK_STATE" 2>/dev/null || echo 0)
                NOW=$(date +%s)
                IDLE_MIN=$(( (NOW - LAST_TOUCH) / 60 ))
                if [ "$IDLE_MIN" -ge "$BUDGET" ]; then
                    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
                        tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
                        echo "BUDGET_EXCEEDED_IDLE $(date +%s) resumed_from=$SID idle_min=$IDLE_MIN" >> "$STATE"
                    fi
                    break
                fi
            else
                NOW=$(date +%s)
                START_S=$(stat -c %Y "$STATE" 2>/dev/null || echo $NOW)
                ELAPSED_MIN=$(( (NOW - START_S) / 60 ))
                if [ "$ELAPSED_MIN" -ge "$GRACE_MIN" ]; then
                    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
                        tmux kill-session -t "$TMUX_SESSION" 2>/dev/null
                        echo "BUDGET_EXCEEDED_NO_HOOKS $(date +%s) resumed_from=$SID elapsed_min=$ELAPSED_MIN" >> "$STATE"
                    fi
                    break
                fi
            fi
        done
    ) &
    WATCHDOG_PID=$!
    disown "$WATCHDOG_PID" 2>/dev/null || true
    echo "$WATCHDOG_PID" > "${STATE}.watchdog"

    cat <<EOF
✓ resumed: $TMUX_SESSION
  resumed from: $SID
  budget:       ${BUDGET}min
  workdir:      $DIR
  attach:       tmux attach -t $TMUX_SESSION
  status:       claude-task-status $TMUX_SESSION
  stop:         claude-task-stop $TMUX_SESSION
EOF
    # --- LOCAL BASH IMPLEMENTATION END ---
}

if [ $# -lt 1 ]; then
    fallback "$@"
    exit $?
fi

SID="$1"
TMUX_SESSION="${2:-cc-resume}"
DIR="${3:-$PWD}"
BUDGET="${4:-30}"

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"sessionId":sys.argv[1],"tmuxSession":sys.argv[2],"workdir":sys.argv[3],"budgetMinutes":int(sys.argv[4])}))' "$SID" "$TMUX_SESSION" "$DIR" "$BUDGET")

if curl -fsS -X POST "${GATEWAY}/claude-code/${SID}/restore" \
    -H "content-type: application/json" \
    -d "$PAYLOAD"; then
    exit 0
fi

fallback "$@"
```

### `bin/setup-claude-hooks`

```bash
#!/usr/bin/env bash
# setup-claude-hooks — Enable Claude Code hook config for a target repo.
# HTTP-first wrapper: tries the OpenClaw plugin, falls back to local bash.

set -euo pipefail

GATEWAY="http://127.0.0.1:18789"

fallback() {
    # --- LOCAL BASH IMPLEMENTATION START ---
    TEMPLATE="$HOME/Projects/claude-code-openclaw-plugin/.claude/settings.json"
    HOOK_URL="http://127.0.0.1:18789/claude-code/hook"

    if [ ! -f "$TEMPLATE" ]; then
        echo "✗ canonical template not found: $TEMPLATE"
        exit 1
    fi

    if [ $# -lt 1 ]; then
        cat <<EOF
Usage: setup-claude-hooks <repo-path> [--force] [--shared]

Writes Claude Code hook config to <repo>/.claude/settings.local.json (default;
env-specific, auto-gitignored) so the OpenClaw claude-code plugin can track
Claude Code sessions in that repo.

Options:
  --force   Overwrite existing settings file if present.
  --shared  Write to .claude/settings.json (committed) instead of .local.json.
EOF
        exit 1
    fi

    REPO_RAW="$1"
    shift

    FORCE=0
    SHARED=0
    for arg in "$@"; do
        case "$arg" in
            --force) FORCE=1 ;;
            --shared) SHARED=1 ;;
            *) echo "✗ unknown flag: $arg"; exit 1 ;;
        esac
    done

    if [ ! -d "$REPO_RAW" ]; then
        echo "✗ not a directory: $REPO_RAW"
        exit 1
    fi
    REPO=$(cd "$REPO_RAW" && pwd)

    if [ "$SHARED" = "1" ]; then
        TARGET="$REPO/.claude/settings.json"
        TARGET_KIND="shared (.claude/settings.json — committed)"
    else
        TARGET="$REPO/.claude/settings.local.json"
        TARGET_KIND="local (.claude/settings.local.json — auto-gitignored)"
    fi

    for f in "$REPO/.claude/settings.json" "$REPO/.claude/settings.local.json"; do
        if [ -f "$f" ] && grep -qF "$HOOK_URL" "$f"; then
            echo "✓ hooks already configured in $f"
            exit 0
        fi
    done

    if [ -f "$TARGET" ] && [ "$FORCE" != "1" ]; then
        echo "✗ $TARGET exists but does not contain $HOOK_URL"
        echo "  refusing to overwrite without --force"
        exit 1
    fi

    mkdir -p "$(dirname "$TARGET")"
    cp "$TEMPLATE" "$TARGET"

    echo "✓ hooks configured: $TARGET"
    echo "  kind: $TARGET_KIND"
    # --- LOCAL BASH IMPLEMENTATION END ---
}

if [ $# -lt 1 ]; then
    fallback "$@"
    exit $?
fi

REPO_RAW="$1"
shift

FORCE=0
SHARED=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --shared) SHARED=1 ;;
        *) ;;
    esac
done

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"repoPath":sys.argv[1],"shared":bool(int(sys.argv[2])),"force":bool(int(sys.argv[3]))}))' "$REPO_RAW" "$SHARED" "$FORCE")

if curl -fsS -X POST "${GATEWAY}/claude-code/setup-hooks" \
    -H "content-type: application/json" \
    -d "$PAYLOAD"; then
    exit 0
fi

fallback "$@"
```

### Step 2: Commit

```bash
chmod +x bin/claude-task bin/claude-task-stop bin/claude-task-restore bin/setup-claude-hooks
git add bin/
git commit -m "feat(bin): add HTTP-first bash wrappers with fallback to original logic"
```

---

## Task 9: Replace `~/.local/bin/` Scripts with Symlinks

**Manual step (run after build/test pass):**

```bash
ln -sf ~/Projects/claude-code-openclaw-plugin/bin/claude-task ~/.local/bin/claude-task
ln -sf ~/Projects/claude-code-openclaw-plugin/bin/claude-task-stop ~/.local/bin/claude-task-stop
ln -sf ~/Projects/claude-code-openclaw-plugin/bin/claude-task-restore ~/.local/bin/claude-task-restore
ln -sf ~/Projects/claude-code-openclaw-plugin/bin/setup-claude-hooks ~/.local/bin/setup-claude-hooks
```

Verify:

```bash
ls -la ~/.local/bin/claude-task ~/.local/bin/claude-task-stop ~/.local/bin/claude-task-restore ~/.local/bin/setup-claude-hooks
```

Expected: All four entries are symlinks pointing to `~/Projects/claude-code-openclaw-plugin/bin/*`.

---

## Task 10: Build, Test, and Smoke Test

### Step 1: Build

```bash
npm run build
```

Expected: No TypeScript errors.

### Step 2: Run tests

```bash
npm test
```

Expected: All existing + new tests pass.

### Step 3: Smoke test bash compatibility

```bash
~/.local/bin/claude-task cc-v020-test "echo 'v0.2.0 OK'" 5 .
sleep 3
~/.local/bin/claude-task-status cc-v020-test
~/.local/bin/claude-task-stop cc-v020-test
~/.local/bin/setup-claude-hooks /tmp/_v020_test_dir
```

Expected:
- `claude-task` spawns tmux session `cc-v020-test`.
- `claude-task-status` reports session alive and session id.
- `claude-task-stop` kills the session.
- `setup-claude-hooks` writes `/tmp/_v020_test_dir/.claude/settings.local.json` (or reports already configured).

### Step 4: Final commit

Squash the feature commits into one:

```bash
git reset --soft HEAD~N  # N = number of feature commits
# OR keep individual commits and add a final empty marker commit
```

Per acceptance criteria, a single commit is preferred:

```bash
git add -A
git commit -m "feat: add spawn/stop/restore/setup-hooks tools and HTTP routes (v0.2.0)

Move claude-task/claude-task-stop/claude-task-restore/setup-claude-hooks
logic into the plugin as OpenClaw tools and HTTP routes. Bash wrappers in
bin/ now call the plugin first and fall back to the original bash
implementation if the gateway is unreachable. This preserves George's
existing CLI while enabling tool-based orchestration.

- Add claude_code_spawn/stop/restore/setup_hooks tools
- Add POST /claude-code/spawn, /setup-hooks, /<session>/stop, /<sid>/restore
- Fallback body-param routes for environments without dynamic path segments
- Bump version 0.1.0 -> 0.2.0
- Replace ~/.local/bin scripts with symlinks to repo bin/"
```

---

## Self-Review Checklist

- [ ] Spec coverage: every requirement in the design doc maps to a task.
- [ ] Placeholder scan: no "TBD", "TODO", or "implement later".
- [ ] Type consistency: `SpawnDeps`, `StopDeps`, `RestoreDeps`, and handler signatures match between tool and route usage.
- [ ] Existing functionality preserved: `routes.dispatch` still handles `/claude-code/<tmux>/send`.
- [ ] Bash fallback logic includes the idle-watchdog fix from `~/.local/bin`.
- [ ] Version bump applied to both `package.json` and `openclaw.plugin.json`.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-06-21-v020-refactor-plan.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?

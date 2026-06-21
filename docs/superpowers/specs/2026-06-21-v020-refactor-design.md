# v0.2.0 Tool + Route Refactor Design

## Goal

Move the bash logic from `~/.local/bin/claude-task`, `claude-task-stop`, `claude-task-restore`, and `setup-claude-hooks` into the `claude-code-openclaw-plugin` as proper OpenClaw tools and HTTP routes, while keeping the existing CLI fully compatible.

## Decisions

- **Bash wrapper fallback strategy:** Option A — bash scripts call the new HTTP routes first, and fall back to the original bash implementation on any failure.
- **Tool names:** `claude_code_spawn`, `claude_code_stop`, `claude_code_restore`, `claude_code_setup_hooks`.
- **HTTP routes:**
  - `POST /claude-code/spawn`
  - `POST /claude-code/setup-hooks`
  - `POST /claude-code/<sessionName>/stop`
  - `POST /claude-code/<sessionId>/restore`
  - Fallback body-param routes if dynamic segments are unsupported: `POST /claude-code/stop` and `POST /claude-code/restore`.
- **Setup-hooks write target:** `.claude/settings.local.json` by default; `.claude/settings.json` with `--shared`.
- **Version bump:** `0.1.0` → `0.2.0`.
- **No push.**

## Architecture

Four new plugin modules, each co-located with its test:

| File | Tool | Route responsibility |
|---|---|---|
| `src/spawn.ts` | `claude_code_spawn` | Spawn a new Claude Code tmux session |
| `src/stop.ts` | `claude_code_stop` | Stop a running session |
| `src/restore.ts` | `claude_code_restore` | Resume a previous session id in a new tmux session |
| `src/setup-hooks.ts` | `claude_code_setup_hooks` | Install hook settings in a target repo |

Each module exposes:
- A tool factory function that takes shared helpers (`store`, `config`, etc.) and returns an `AnyAgentTool`.
- A route handler function that delegates to the same core logic.

The plugin entry point (`src/index.ts`) registers all tools and routes. Existing helpers (`tmux.ts`, `store.ts`, `discovery.ts`, `config.ts`) are reused without modification.

## Bash Wrapper Changes

Each script in `~/.local/bin/` becomes an HTTP-first curl wrapper (~30 lines). It attempts the plugin endpoint first; on network error or non-2xx response it runs the existing bash logic unchanged. This preserves:
- CLI argument compatibility
- Trust-dialog detection
- Logging and watchdog behavior
- Fallback behavior when the plugin/gateway is not running

## Route Registration

```ts
api.registerHttpRoute({ path: `${config.routePrefix}/spawn`,     auth: "plugin", match: "exact", handler: spawnRoute });
api.registerHttpRoute({ path: `${config.routePrefix}/setup-hooks`, auth: "plugin", match: "exact", handler: setupHooksRoute });
api.registerHttpRoute({ path: `${config.routePrefix}/`,            auth: "plugin", match: "prefix", handler: stopRestoreRoute });
```

The `<sessionName>/stop` and `<sessionId>/restore` patterns are handled by a single prefix route that parses the remaining path segments, falling back to reading `sessionName`/`sessionId` from the request body if the path does not contain a dynamic segment.

## Error Handling

- Tools return structured JSON results with `success: false` and an `error` message on failure.
- HTTP routes return 4xx/5xx with a JSON error body.
- Bash wrappers treat any HTTP failure as a signal to fall back to local bash logic.

## Testing

Add one Vitest file per tool, co-located in `src/`:

- `src/spawn.test.ts` — smoke-level test validating parameter parsing and tmux call delegation with a mocked `exec`.
- `src/stop.test.ts` — validates session discovery and stop/kill behavior.
- `src/restore.test.ts` — validates resume flow.
- `src/setup-hooks.test.ts` — validates idempotent settings file writing.

Route-level behavior is covered with the existing mock `IncomingMessage`/`ServerResponse` pattern.

## Manifest + Version

- `openclaw.plugin.json`: append the four new tool names to `contracts.tools`.
- `package.json` and `openclaw.plugin.json`: bump `version` from `0.1.0` to `0.2.0`.

## Out of Scope

- No changes to existing hook handler, session store, timeout service, or `claude_code_status`.
- No changes to trust-dialog detection in `claude-task`.
- No writes to `/home/georgefu/.claude` global files.
- No push.
- No version bump beyond `0.2.0`.

## Acceptance Criteria

1. `npm run build` passes.
2. `npm test` passes (existing + new tests).
3. Bash compatibility smoke test passes:
   ```bash
   ~/.local/bin/claude-task cc-v020-test "echo 'v0.2.0 OK'" 5 .
   sleep 3
   ~/.local/bin/claude-task-status cc-v020-test
   ~/.local/bin/claude-task-stop cc-v020-test
   ~/.local/bin/setup-claude-hooks /tmp/_v020_test_dir
   ```
4. Gateway restart deferred to George.
5. Report includes changed files, line counts, test output, smoke test result, commit hash, and fallback strategy summary.

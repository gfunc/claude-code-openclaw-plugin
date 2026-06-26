// Append-only per-session debug log of received hook events.
// One line per hook: `<iso> <event> <prev_state> -> <new_state> [tool]`.
// Disabled by default; enable via plugin config `debugLog: true`.
//
// ponytail: fs.appendFile per hook, no buffering. ~10ms/hook is fine for the
// volumes we see (1700 events in the busiest session's lifetime).
// Files grow unbounded — rotate when size matters.

import fs from "node:fs/promises";
import path from "node:path";

export type SessionEventLogger = {
  log(sessionId: string, line: string): void;
};

export function createSessionEventLogger(opts: {
  dir: string;
  enabled: boolean;
}): SessionEventLogger {
  if (!opts.enabled) {
    return { log: () => {} };
  }

  let dirReady: Promise<void> | undefined;
  function ensureDir(): Promise<void> {
    if (!dirReady) dirReady = fs.mkdir(opts.dir, { recursive: true }).then(() => {});
    return dirReady;
  }

  return {
    log(sessionId, line) {
      const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const file = path.join(opts.dir, `${safeId}.log`);
      // fire-and-forget; logging must not block or fail hook processing.
      void ensureDir()
        .then(() => fs.appendFile(file, line + "\n", "utf8"))
        // eslint-disable-next-line no-console
        .catch((err) => console.error("claude-code: debug-log write failed:", err));
    },
  };
}

export function formatHookLogLine(params: {
  ts: number;
  event: string;
  prevState: string | undefined;
  newState: string;
  tool?: string;
}): string {
  const t = new Date(params.ts).toISOString();
  const transition = params.prevState && params.prevState !== params.newState
    ? `${params.prevState} -> ${params.newState}`
    : params.newState;
  const tool = params.tool ? ` tool=${params.tool}` : "";
  return `${t} ${params.event} ${transition}${tool}`;
}

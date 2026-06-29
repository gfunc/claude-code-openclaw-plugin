import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import { parseHookPayload } from "./hook.js";
import type { SessionStore } from "./store.js";
import { handleSetupHooksRoute } from "./setup-hooks.js";
import type { SessionState } from "./state.js";

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createClaudeCodeRoutes({
  store,
  config,
  discoverSession,
  log,
  onHookTransition,
}: {
  store: SessionStore;
  config: PluginConfig;
  discoverSession?: (sessionId: string) => Promise<DiscoveredSession | undefined>;
  log?: (text: string) => void;
  onHookTransition?: (state: SessionState) => void;
}) {
  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const payload = parseHookPayload(body);
      const prevState = store.getState(payload.session_id);
      log?.(`claude-code: hook received event=${payload.hook_event_name} sessionId=${payload.session_id}` +
        (prevState ? ` prevState=${prevState.state}` : " (new)"));
      const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
      if (prevState?.state !== state.state) {
        log?.(`claude-code: state transition ${prevState?.state ?? "none"} -> ${state.state} sessionId=${state.sessionId}`);
      }
      onHookTransition?.(state);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      // Claude Code must not be blocked by hook failures; always return 200
      console.error("claude-code hook failed:", err);
      sendJson(res, 200, { ok: false, error: String(err) });
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

  return { hook, setupHooks };
}

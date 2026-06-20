import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import { parseHookPayload } from "./hook.js";
import type { SessionStore } from "./store.js";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export type SendKeysFn = (params: {
  tmuxSession: string;
  text: string;
  submit: boolean;
}) => Promise<void>;

export function createClaudeCodeRoutes({
  store,
  config,
  requestHeartbeatNow,
  sendKeys,
  discoverSession,
}: {
  store: SessionStore;
  config: PluginConfig;
  requestHeartbeatNow?: () => void;
  sendKeys?: SendKeysFn;
  discoverSession?: (sessionId: string) => Promise<DiscoveredSession | undefined>;
}) {
  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const payload = parseHookPayload(body);
      const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
      if (config.notifyStates.includes(state.state)) {
        requestHeartbeatNow?.();
      }
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: String(err) });
    }
  }

  async function send(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const suffix = req.url?.slice(config.routePrefix.length) ?? "";
    const match = suffix.match(/^\/([^/]+)\/send$/);
    const tmuxSession = match?.[1];
    if (!tmuxSession) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const tracked = store.listStates().find((s) => s.tmuxSession === tmuxSession);
    if (!tracked) {
      sendJson(res, 404, { error: "session not tracked" });
      return;
    }
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const text = String(body.text ?? "");
      const submit = Boolean(body.submit);
      await sendKeys?.({ tmuxSession, text, submit });
      sendJson(res, 200, { sent: true, sessionId: tracked.sessionId });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  }

  return { hook, send };
}

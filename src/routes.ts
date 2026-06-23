import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginConfig } from "./config.js";
import type { DiscoveredSession } from "./discovery.js";
import { parseHookPayload } from "./hook.js";
import type { SessionStore } from "./store.js";
import { handleSpawnRoute } from "./spawn.js";
import { stopSession } from "./stop.js";
import { restoreSession } from "./restore.js";
import { handleSetupHooksRoute } from "./setup-hooks.js";
import type { BehaviorDispatcher } from "./dispatcher.js";

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

export type SendKeysFn = (params: {
  tmuxSession: string;
  text: string;
  submit: boolean;
}) => Promise<void>;

export function createClaudeCodeRoutes({
  store,
  config,
  dispatcher,
  sendKeys,
  discoverSession,
}: {
  store: SessionStore;
  config: PluginConfig;
  dispatcher?: BehaviorDispatcher;
  sendKeys?: SendKeysFn;
  discoverSession?: (sessionId: string) => Promise<DiscoveredSession | undefined>;
}) {
  const lastSendAt = new Map<string, number>();

  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const payload = parseHookPayload(body);
      const state = await store.applyHook(payload, async () => discoverSession?.(payload.session_id));
      dispatcher?.onStateChanged(state);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      // Claude Code must not be blocked by hook failures; always return 200
      // eslint-disable-next-line no-console
      console.error("claude-code hook failed:", err);
      sendJson(res, 200, { ok: false, error: String(err) });
    }
  }

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

  async function spawn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const { status, body: resp } = await handleSpawnRoute(body, {
        permissionMode: config.permissionMode,
      });
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

    const sendMatch = suffix.match(/^\/([^/]+)\/send$/);
    if (sendMatch) {
      await send(req, res, sendMatch[1]);
      return;
    }

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
        const result = await restoreSession({
          sessionId,
          tmuxSession,
          workdir,
          budgetMinutes,
          permissionMode: config.permissionMode,
        });
        sendJson(res, result.success ? 200 : 500, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: String(err) });
    }
  }

  return { hook, send, spawn, setupHooks, dispatch };
}

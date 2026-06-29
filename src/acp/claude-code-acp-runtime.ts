import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
} from "openclaw/plugin-sdk/acp-runtime";
import type { AcpSessionManager } from "./session-manager.js";
import type { AcpTmuxRuntime } from "./tmux-runtime.js";
import type { AcpEventStreamer } from "./event-streamer.js";
import type { SessionStore } from "../store.js";

import type { ExecFn } from "../tmux.js";

export type ClaudeCodeAcpRuntimeParams = {
  sessionManager: AcpSessionManager;
  tmuxRuntime: AcpTmuxRuntime;
  eventStreamer: AcpEventStreamer;
  store: SessionStore;
  exec: ExecFn;
  log: (text: string) => void;
};

export function createClaudeCodeAcpRuntime(
  params: ClaudeCodeAcpRuntimeParams,
): AcpRuntime {
  return {
    async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
      const handle = await params.sessionManager.ensureSession(input);
      if (handle.backendSessionId) {
        params.store.setSessionKey(handle.backendSessionId, handle.sessionKey);
      }
      return handle;
    },

    startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) {
        throw new Error("Session not found");
      }

      const tmuxSession = handle.runtimeSessionName;

      // Send the prompt text to the running Claude Code session.
      params.tmuxRuntime
        .send(tmuxSession, input.text)
        .catch((err) => params.log(`acp: send failed: ${String(err)}`));

      const { events, result, cancel } = params.eventStreamer.startTurn({
        sessionKey: input.handle.sessionKey,
        requestId: input.requestId,
        tmuxSession,
        signal: input.signal,
        timeoutMs: 30 * 60 * 1000,
        readOutput: () => params.tmuxRuntime.read(tmuxSession),
      });

      return {
        requestId: input.requestId,
        events,
        result,
        cancel: async (_reason) => {
          cancel();
          try {
            await params.tmuxRuntime.ctrlC(tmuxSession);
          } catch (err) {
            params.log(`acp: ctrl-c failed: ${String(err)}`);
          }
        },
        closeStream: async (_reason) => {
          cancel();
        },
      };
    },

    runTurn(input: AcpRuntimeTurnInput): AsyncIterable<import("openclaw/plugin-sdk/acp-runtime").AcpRuntimeEvent> {
      return this.startTurn!(input).events;
    },

    async close(input): Promise<void> {
      await params.sessionManager.close(
        input.handle.sessionKey,
        input.discardPersistentState,
      );
    },

    async cancel(input): Promise<void> {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) return;
      params.eventStreamer.cancelTurn(input.handle.sessionKey);
      await params.tmuxRuntime.ctrlC(handle.runtimeSessionName);
    },

    async getStatus(input): Promise<AcpRuntimeStatus> {
      const handle = params.sessionManager.getHandle(input.handle.sessionKey);
      if (!handle) return { summary: "session not found" };
      const alive = await params.tmuxRuntime.exists(handle.runtimeSessionName);
      return {
        summary: alive ? "running" : "dead",
        backendSessionId: handle.backendSessionId,
      };
    },

    getCapabilities(): AcpRuntimeCapabilities {
      return { controls: [] };
    },

    async doctor(): Promise<AcpRuntimeDoctorReport> {
      const details: string[] = [];
      try {
        const result = await params.exec(["claude", "--version"], {
          timeoutMs: 5000,
        });
        if (result.code !== 0) {
          return {
            ok: false,
            message: "claude CLI is not available",
            installCommand: "npm install -g @anthropic-ai/claude-code",
          };
        }
        details.push(`claude version: ${result.stdout.trim()}`);
      } catch {
        return {
          ok: false,
          message: "claude CLI is not on PATH",
          installCommand: "npm install -g @anthropic-ai/claude-code",
        };
      }
      try {
        const result = await params.exec(["tmux", "-V"], {
          timeoutMs: 5000,
        });
        if (result.code !== 0) {
          return {
            ok: false,
            message: "tmux is not available",
            installCommand: "apt-get install tmux",
          };
        }
        details.push(`tmux version: ${result.stdout.trim()}`);
      } catch {
        return {
          ok: false,
          message: "tmux is not on PATH",
          installCommand: "apt-get install tmux",
        };
      }
      return {
        ok: true,
        message: "claude-code backend ready",
        details,
      };
    },
  };
}

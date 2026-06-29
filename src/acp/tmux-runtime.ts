import type { ExecFn } from "../tmux.js";
import {
  capturePane,
  sendKeysSequence,
  sendKeysToTmuxSession,
  tmuxSessionExists,
} from "../tmux.js";

export type AcpTmuxRuntime = {
  send(tmuxSession: string, text: string, submit?: boolean): Promise<void>;
  sendKeys(tmuxSession: string, keys: string[]): Promise<void>;
  read(tmuxSession: string, lines?: number): Promise<string>;
  exists(tmuxSession: string): Promise<boolean>;
  kill(tmuxSession: string): Promise<void>;
  ctrlC(tmuxSession: string): Promise<void>;
};

export function createAcpTmuxRuntime(exec: ExecFn): AcpTmuxRuntime {
  return {
    send: (session, text, submit = true) =>
      sendKeysToTmuxSession({ tmuxSession: session, text, submit, exec }),
    sendKeys: (session, keys) => sendKeysSequence({ tmuxSession: session, keys, exec }),
    read: (session, lines) => capturePane({ tmuxSession: session, lines, exec }),
    exists: (session) => tmuxSessionExists(session, exec),
    kill: async (session) => {
      await exec(["tmux", "kill-session", "-t", session], { timeoutMs: 5000 });
    },
    ctrlC: async (session) => {
      await exec(["tmux", "send-keys", "-t", session, "C-c"], { timeoutMs: 5000 });
    },
  };
}

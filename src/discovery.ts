import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DiscoveredSession = {
  tmuxSession: string;
  logFile: string;
  workdir?: string;
  budgetMinutes?: number;
};

export async function discoverSession({
  sessionId,
  tasksDir = path.join(os.homedir(), ".cache", "claude-tasks"),
}: {
  sessionId: string;
  tasksDir?: string;
}): Promise<DiscoveredSession | undefined> {
  const entries = await fs.readdir(tasksDir).catch(() => []);
  for (const entry of entries) {
    if (!entry.endsWith(".state")) continue;
    const tmuxSession = entry.slice(0, -".state".length);
    const statePath = path.join(tasksDir, entry);
    const content = await fs.readFile(statePath, "utf8").catch(() => "");
    const match = content.match(/session_id=([^ \t\r\n]+)/);
    if (match?.[1] === sessionId) {
      const workdirMatch = content.match(/workdir=([^ \t\r\n]+)/);
      const budgetMatch = content.match(/budget=(\d+)min/);
      return {
        tmuxSession,
        logFile: path.join(tasksDir, `${tmuxSession}.log`),
        workdir: workdirMatch?.[1],
        budgetMinutes: budgetMatch ? parseInt(budgetMatch[1], 10) : undefined,
      };
    }
  }
  return undefined;
}

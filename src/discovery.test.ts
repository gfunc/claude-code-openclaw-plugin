import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSession } from "./discovery.js";

describe("discoverSession", () => {
  const baseDir = path.join(os.tmpdir(), "claude-hooks-discovery-test");

  beforeEach(async () => {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "cc-bugfix.state"),
      "RUNNING 1750435200 budget=30min workdir=/home/georgefu/Projects/uco session_id=s1\n",
    );
    await fs.writeFile(path.join(baseDir, "cc-bugfix.log"), "log line\n");
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("finds tmux session and log file by session id", async () => {
    const found = await discoverSession({ sessionId: "s1", tasksDir: baseDir });
    expect(found?.tmuxSession).toBe("cc-bugfix");
    expect(found?.logFile).toBe(path.join(baseDir, "cc-bugfix.log"));
    expect(found?.workdir).toBe("/home/georgefu/Projects/uco");
    expect(found?.budgetMinutes).toBe(30);
  });

  it("returns undefined when not found", async () => {
    const found = await discoverSession({ sessionId: "missing", tasksDir: baseDir });
    expect(found).toBeUndefined();
  });
});

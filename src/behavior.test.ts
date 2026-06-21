import { describe, expect, it } from "vitest";
import { resolveBehavior, STATE_BEHAVIOR } from "./behavior.js";

describe("STATE_BEHAVIOR", () => {
  it("WAITING wakes, prompts, and announces", () => {
    const b = STATE_BEHAVIOR.WAITING;
    expect(b.wake).toBe(true);
    expect(b.prompt).toBe(true);
    expect(b.announce).toBe(true);
    expect(b.prefix).toBe("⚠️");
    expect(b.message).toContain("waiting");
  });

  it("WORKING does nothing", () => {
    const b = STATE_BEHAVIOR.WORKING;
    expect(b.wake).toBe(false);
    expect(b.prompt).toBe(false);
    expect(b.announce).toBe(false);
  });

  it("FATAL does not wake and is one-shot", () => {
    const b = STATE_BEHAVIOR.FATAL;
    expect(b.wake).toBe(false);
    expect(b.announce).toBe(true);
    expect(b.oneShotAnnounce).toBe(true);
  });
});

describe("resolveBehavior", () => {
  it("returns table defaults when state is in notifyStates", () => {
    const b = resolveBehavior("WAITING", ["WAITING", "ERROR"]);
    expect(b.wake).toBe(true);
  });

  it("disables all flags when state is not in notifyStates", () => {
    const b = resolveBehavior("DONE", ["WAITING"]);
    expect(b.wake).toBe(false);
    expect(b.prompt).toBe(false);
    expect(b.announce).toBe(false);
  });
});

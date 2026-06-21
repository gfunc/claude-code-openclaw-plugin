# Fix Claude Code 2.x Integration Bugs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two independent integration issues discovered when testing `claude-code-openclaw-plugin` against Claude Code 2.x: wildcard hook matcher being ignored, and the workspace-trust auto-accept regex not matching the 2.x dialog.

**Architecture:** Expand `.claude/settings.json` hook configuration from a single `"*"` matcher into one entry per explicitly-supported event. Update `~/.local/bin/claude-task` trust-dialog detection to recognize the Claude Code 2.x three-option dialog without false positives.

**Tech Stack:** JSON, Bash, tmux, git.

---

## Task 1: Expand hook event matchers in `.claude/settings.json`

**Files:**
- Modify: `.claude/settings.json`

- [ ] **Step 1: Replace wildcard with explicit per-event entries**

Change the file from:

```json
{
  "hooks": {
    "*": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:18789/claude-code/hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

to:

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "SessionEnd": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "Stop": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "PreToolUse": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "PostToolUse": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "PostToolUseFailure": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "PermissionRequest": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "FileChanged": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}],
    "CwdChanged": [{"matcher": "*", "hooks": [{"type": "http", "url": "http://127.0.0.1:18789/claude-code/hook", "timeout": 30}]}]
  }
}
```

- [ ] **Step 2: Validate JSON syntax**

Run: `python3 -m json.tool .claude/settings.json > /dev/null`
Expected: no output (valid JSON).

- [ ] **Step 3: Commit**

Run:
```bash
git add .claude/settings.json
git commit -m "fix(hooks): expand wildcard matcher to explicit Claude Code 2.x events

Claude Code 2.x ignores the '*' hook event matcher and logs
'Unknown hook event \"*\" was ignored', so no hooks reached the plugin.
List each event the plugin explicitly listens to in src/hook.ts,
keeping the same HTTP endpoint and timeout."
```

---

## Task 2: Update trust dialog regex in `~/.local/bin/claude-task`

**Files:**
- Modify: `~/.local/bin/claude-task:89-95`

- [ ] **Step 1: Replace the trust-dialog detection block**

Change:

```bash
# Detect & auto-accept the workspace trust dialog (first launch in a new dir).
# Idempotent: if trust was already accepted in this dir, the prompt won't appear
# and we just skip this block.
CAPTURE=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)
if echo "$CAPTURE" | grep -qiE "trust this folder|1\. yes.*trust|2\. no.*exit"; then
    tmux send-keys -t "$SESSION" "1"
    sleep 1
    tmux send-keys -t "$SESSION" Enter
    sleep 2
fi
```

to:

```bash
# Detect & auto-accept the workspace trust dialog (first launch in a new dir).
# Claude Code 2.x shows a three-option dialog:
#   1. Continue
#   2. Fix with Claude
#   3. Exit and fix manually
#   Enter to confirm · Esc to cancel
# We match all three options plus the confirmation hint to avoid false positives.
# Idempotent: if trust was already accepted in this dir, the prompt won't appear
# and we just skip this block.
CAPTURE=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || true)
if echo "$CAPTURE" | grep -qiE "1\. Continue" \
    && echo "$CAPTURE" | grep -qiE "2\. Fix with Claude" \
    && echo "$CAPTURE" | grep -qiE "3\. Exit and fix manually" \
    && echo "$CAPTURE" | grep -qiE "Enter to confirm"; then
    tmux send-keys -t "$SESSION" "1"
    sleep 1
    tmux send-keys -t "$SESSION" Enter
    sleep 2
fi
```

- [ ] **Step 2: Shell-check the script**

Run: `bash -n ~/.local/bin/claude-task`
Expected: no output.

- [ ] **Step 3: Commit**

Run:
```bash
git add ~/.local/bin/claude-task
git commit -m "fix(claude-task): match Claude Code 2.x workspace trust dialog

The 2.x trust dialog changed to a three-option prompt
(Continue / Fix with Claude / Exit and fix manually). Update the
detection regex to match all three options plus the confirmation
hint, preventing false positives and supporting auto-accept."
```

---

## Task 3: Verify both fixes with acceptance tests

**Files:**
- None (runtime verification)

- [ ] **Step 1: Verify Bug 1 — hook events reach the plugin**

Run from `~/Projects/claude-code-openclaw-plugin` (trust already established):
```bash
claude-task cc-hook-test "reply with exactly: HOOK_OK" 5 .
sleep 8
ls -la ~/.cache/claude-code-hooks/
cat ~/.cache/claude-code-hooks/$(ls -t ~/.cache/claude-code-hooks/ | head -n1) | python3 -m json.tool
claude-task-stop cc-hook-test
```
Expected: a `{session_id}.json` file exists and its `history` contains at least two events (e.g. `PreToolUse` / `Bash`, `UserPromptSubmit`).

- [ ] **Step 2: Verify Bug 2 — trust dialog auto-accept in a fresh directory**

Run:
```bash
TESTDIR=$(mktemp -d)
claude-task cc-trust-test "reply with exactly: TRUST_OK" 5 "$TESTDIR"
sleep 8
tmux capture-pane -t cc-trust-test -p | tail -30
claude-task-stop cc-trust-test
rm -rf "$TESTDIR"
```
Expected: the captured pane shows Claude Code is processing `TRUST_OK`, not stuck on the trust dialog.

- [ ] **Step 3: Report results**

Report to the user:
- files changed and line ranges
- acceptance test results
- the two commit hashes (do not push)

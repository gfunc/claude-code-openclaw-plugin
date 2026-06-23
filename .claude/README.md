# `.claude/` — demo only

This folder is a **reference** of what `claude_code_setup_hooks` writes into a
target repo. It is **not** active configuration for this repo.

- `settings.example.json` — sample hook config. Claude Code does **not** load
  `*.example.json`, so running Claude Code inside this repo will not try to
  POST hook events to `http://127.0.0.1:18789/claude-code/hook` and you will
  not see hook errors when the OpenClaw gateway is not running.

If you want to actually install hooks here, copy:

```bash
cp .claude/settings.example.json .claude/settings.local.json
```

…or run the plugin tool against this repo:

```text
claude_code_setup_hooks({ repoPath: "/Users/georgefu/Projects/claude-code-openclaw-plugin" })
```

Both write `.claude/settings.local.json`, which **is** loaded by Claude Code.

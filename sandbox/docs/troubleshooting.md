# sandbox-dev: troubleshooting and forking

[Back to the sandbox guide](../README.md)

## Troubleshooting

### "Sandbox already exists"

The script skips creation if the named sandbox exists. To start fresh:

```bash
docker sandbox rm dev
./sandbox-setup.sh
```

Auth survives this because it's stored in `$SANDBOX_DIR/.auth/` on the host.

### Claude or Codex login doesn't persist

Confirm the symlinks were created:

```bash
docker sandbox exec dev ls -la /home/agent/.claude /home/agent/.codex
```

Both should show `-> /…/sandbox/.auth/…`.

### Codex review keeps failing the diff

Check the verdict JSON. The most common cause is Codex demanding generic best-practice changes that your `CLAUDE.md` explicitly forbids — which Claude is supposed to override. If you see this consistently, your `CLAUDE.md` may need to make the rule more explicit so it survives the 8KB injection budget in `openai-review`.

### Want a clean slate

```bash
docker sandbox rm dev
rm -rf ~/personal/sandbox
./sandbox-setup.sh
```

### `superpowers` plugin install failed

The setup script tries to install `superpowers@claude-plugins-official`. If you haven't logged into Claude yet, this fails with "plugin not found in marketplace". Login first, then re-run setup.

## Forking this for a different project

1. Change the defaults in `sandbox-setup.sh` (`SANDBOX_DIR`, `ETHOS_URL`, `ETHOS_BRANCH`)
2. Update the variable names if you don't want them called `ETHOS_*`
3. Update `sandbox-agent-claude.md` for your project's commands (replace `pnpm dev/check/lint`)
4. Keep `.agents/skills/openai-reviewer/` as-is — it reads your project's `CLAUDE.md` automatically
5. If your project has `node_modules` worth caching, consider mounting a host npm/pnpm store into the sandbox

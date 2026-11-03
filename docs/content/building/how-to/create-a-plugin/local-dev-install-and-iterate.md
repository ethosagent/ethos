---
title: "Create a plugin: install locally and iterate"
description: "Install the my-notes plugin by symlink, test its commands and tool, and iterate without a build step."
kind: how-to
audience: developer
time: "5 min"
updated: 2026-11-03
---

## Task

Install the local `my-notes` plugin, test it and iterate.

## Result

The agent calls `search_notes`, `/notes` works, and edits take effect on restart.

## Prereqs

- Complete [part 4](./local-dev-entry-point.md): `src/index.ts` exists.

## Steps

### Install locally

Install the plugin by pointing `ethos` at the directory:

```bash
ethos plugin install --path ~/.ethos/plugins/my-notes
```

This creates a symlink so the host loads your source directly. Changes take effect on restart — no `npm publish` needed.

### Test the plugin

Restart ethos to pick up the new plugin: stop the running `ethos` process (Ctrl+C) and start it again with `ethos`, or stop and re-run `ethos gateway start` if the gateway is running.

Verify registration:

```bash
ethos plugin list          # should show my-notes with 1 tool
ethos doctor               # runs every plugin health check, including notes-db
```

Try the slash commands:

```bash
/notes add "Set up CI for the billing service"
/notes add "Review the auth token rotation PR"
/notes list
```

Start a conversation and confirm the agent can use `search_notes`:

```
You: What notes do I have about CI?
```

The agent calls `search_notes` with `{ "query": "CI" }` and returns matching notes.

### Iterate

Edit `src/index.ts`, restart ethos, test. Plugins reload on restart.

No build step is needed during development if your `package.json` points `main` at `./src/index.ts` — `tsx` handles TypeScript directly. For production builds, add a build script using `tsup`:

```json
{
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts"
  }
}
```

Then update `main` to `./dist/index.js` before publishing.

## Verify

Run `ethos plugin list`. Expect `my-notes` in the output.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Plugin missing after install | `ethos` not restarted. | Restart the running `ethos` process. |

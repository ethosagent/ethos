---
title: "Run a new personality's birth ritual"
description: "Let a new personality confirm its name and propose a one-line vibe, an emoji and an avatar in its first chat, then apply or skip the identity request."
kind: how-to
audience: user
slug: run-a-birth-ritual
time: "5 min"
updated: 2026-09-29
---

## Task

Give a personality you just created its name, a one-line vibe and an emoji in its first conversation, and approve the result.

## Result

- The personality answers your first message, then asks you to confirm its name and proposes a vibe and an emoji you can veto.
- It files what you agreed as an identity request. Its `config.yaml` changes only when you run `ethos personality amendments apply <id>`.
- After you apply or skip, the ritual never runs again.

## Prereqs

- A terminal on the machine that holds `~/.ethos/`.
- A [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) created by `ethos personality create` or the web create form. Those paths make it **born**: they write a birth marker at `~/.ethos/learning/birth/<personality-id>.json` and add `propose_self_amendment` to its declared toolset. A directory you made by hand, a recipe install and a built-in are not born.

## Steps

### 1. Create the personality

```bash
ethos personality create owl --blank
```

```
Created personality "owl"  ~/.ethos/personalities/owl
```

`--from <id>` (a copy of another personality) and the AI-assisted `ethos personality create` are born too. The AI-assisted path marks the personality after the architect chat ends.

### 2. Talk to it privately

Open `ethos chat`, or a web chat you are logged in to, and switch to it:

```text
/personality owl
What's a good way to structure a weekly review?
```

The personality answers the question in full first. At the end of that reply, or the next one, it starts the ritual, one question per reply:

| Step | What it asks |
|---|---|
| Name | To keep or change the name you gave it at create time. It never picks a name of its own. |
| Vibe | A one-line description of how it comes across, e.g. "Calm, curious, a little dry." |
| Emoji | Exactly one emoji, e.g. 🦉. It becomes [`display.emoji`](../reference/personality-yaml.md#display). |
| Avatar | Keep the current avatar (the default), or upload a new image yourself after you apply. |

Veto or change anything. It reads the result back and asks "Shall I file this for you to approve?" before it files.

The ritual runs only where the request can be filed: a private `ethos chat` or logged-in web chat that you started. Telegram, Slack, Discord, WhatsApp, email, a shared room, a cron job or a watcher wake never see it. A session that has read a web page or an attachment stops offering it; start a fresh session.

### 3. Review the identity request

When it files, the chat shows the id:

```
Filed amendment a-mul1x2k3-owl9ab. It is pending your owner's review; nothing changes until they apply it.
```

```bash
ethos personality amendments list
```

```
ID                 PERSONALITY  CHANGE                                                    STATUS   FILED
a-mul1x2k3-owl9ab  owl          name → "Owl", vibe → "Calm, curious, a little dry.", …    pending  2026-09-29T09:12
```

```bash
ethos personality amendments show a-mul1x2k3-owl9ab
```

The review prints `Permission diff  none — an identity change grants nothing`, then the exact `config.yaml` lines it will change. An identity request only ever sets `name`, `description` and `display.emoji`. It never touches `display.avatar_url` or any other line. The web **Learning** page shows the same request, read-only.

### 4. Apply it

```bash
ethos personality amendments apply a-mul1x2k3-owl9ab
```

```
Type the personality id (owl) to apply: owl
✓ Applied a-mul1x2k3-owl9ab to owl's config.yaml. Other processes pick it up on their next turn.
```

Applying ends the ritual. If you chose to upload an avatar, the command adds a reminder: upload it from the web **Personalities** page. Until then the personality shows its generated mark.

Decline and rollback work as for any request; see [Review a personality's change request](review-personality-change-requests.md).

### 5. Or skip it

If you do not want the ritual, end it without changing anything:

```bash
ethos personality birth skip owl
```

```
Skipped the birth ritual for owl. It will not ask again.
```

## Verify

```bash
ethos personality show owl
```

The character sheet carries a `## Display` section:

```
## Display
- Emoji: 🦉
- Avatar: (generated mark)
```

The `ethos chat` header now shows `🦉 owl`. Send another message: the personality answers without starting the ritual.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| The personality never starts the ritual | It is not born (made by hand, a recipe, a built-in), its toolset is empty, you are on a channel or in a shared room, or the session read untrusted content. | Chat privately in `ethos chat` or the web app, in a fresh session. A personality that was never born has no ritual; edit `config.yaml` or the web Personalities page instead. |
| It asks again on every turn | No request has been filed yet. The ritual stops asking once a request is pending, and ends when it is applied. | Answer its questions, or run `ethos personality birth skip <personality-id>`. |
| `set_display_avatar` is refused: `this personality already has an avatar` | It asked to switch back to the generated mark while an avatar is set. | Keep the avatar (leave the avatar step out), or remove it yourself from the web Personalities page. |
| `set_display_emoji must be a single emoji` | It proposed more than one emoji, or text. | Ask it for exactly one emoji, and to file again. |
| `set_name …` or `set_description … must be one line with no quotes, backslashes, control or invisible characters` | The name or vibe has quotes, a line break, or is too long. | Ask for a plain one-line value, and to file again. |
| `<personality-id> has no birth ritual waiting; nothing to skip.` | It was never born, or the ritual already ended. | Nothing to do. |

A personality holding a shell tool under local execution can edit its own files, the birth marker included. The review warns about this; see [Review a personality's change request](review-personality-change-requests.md#4-read-the-review).

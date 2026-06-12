---
title: "Use inline context references"
description: "Attach files and URLs to any message with @-references, auto-inlined as context before the LLM sees your prompt."
kind: how-to
audience: user
slug: use-inline-context-refs
time: "5 min"
updated: 2026-06-09
---

## Task

Attach file contents and web pages to a chat message so the LLM reads them alongside your prompt.

## Result

Referenced files and URLs are fetched, inlined as fenced code blocks, and prepended to your message before the LLM sees it. The model answers with full context — no manual copy-paste.

## Prereqs

- `ethos` installed and a provider configured ([Configure an LLM provider](configure-providers.md)).
- An active chat [session](../../getting-started/glossary.md#session) (`ethos chat`).
- For URL references: a network connection from the machine running `ethos`.

## Steps

### 1. Reference a local file

Type `@` followed by a file path in your message. The path is relative to the working directory.

```text
@src/agent-loop.ts What does the run() method return?
```

On submit, `ethos` reads `src/agent-loop.ts` and inlines its contents before your prompt. The LLM receives:

```text
<context path="src/agent-loop.ts">
export class AgentLoop {
  async *run(input: string): AsyncGenerator<AgentEvent> {
    // ... full file contents ...
  }
}
</context>

What does the run() method return?
```

### 2. Reference a URL

Prefix a URL with `@` to fetch and inline its contents.

```text
@https://jsonplaceholder.typicode.com/posts/1 Summarize this API response.
```

The fetched body is inlined the same way:

```text
<context url="https://jsonplaceholder.typicode.com/posts/1">
{
  "userId": 1,
  "id": 1,
  "title": "sunt aut facere repellat providentem ...",
  "body": "quia et suscipit ..."
}
</context>

Summarize this API response.
```

### 3. Use tab completion in the CLI

Type `@` then a partial path, then press Tab. The CLI autocompletes against the filesystem.

```text
@src/     # press Tab
```

The shell lists matching files and directories:

```text
src/agent-loop.ts
src/commands/
src/config.ts
src/index.ts
src/wiring.ts
```

Select a file and continue typing your prompt.

### 4. Use the file picker in the web composer

In the web dashboard, type `@` in the message input. A popover appears listing files in the project root. Type to filter, then click or arrow-key to select.

The selected file path is inserted at the cursor. Submit the message and the file is inlined as in the CLI flow.

### 5. Reference multiple files in one message

Add as many `@`-references as you need. Each is resolved and inlined independently.

```text
@src/agent-loop.ts @src/tool-registry.ts How does the agent loop call tools?
```

The LLM receives both files as separate context blocks before your question:

```text
<context path="src/agent-loop.ts">
// ... agent-loop.ts contents ...
</context>

<context path="src/tool-registry.ts">
// ... tool-registry.ts contents ...
</context>

How does the agent loop call tools?
```

### 6. Mix file and URL references

File and URL references compose freely in a single message.

```text
@src/config.ts @https://docs.example.com/api/config Does our config match the spec?
```

Both sources are inlined before the prompt reaches the model.

### 7. Handle large files

Files over 8 000 characters are truncated. The inlined block ends with a truncation marker:

```text
<context path="dist/bundle.js">
// ... first ~8000 characters ...
[truncated — 142,388 chars total]
</context>
```

To get the full content of a large file, reference a specific slice instead. Break your question into smaller, targeted references rather than pointing at a monolithic file.

## Verify

1. Start a chat session:

```bash
ethos chat
```

2. Send a message with an `@`-reference:

```text
@package.json What version of TypeScript does this project use?
```

3. Confirm the agent's response references details from `package.json` (e.g. the TypeScript version under `devDependencies`). If the agent answers correctly with specifics from the file, inline context is working.

## Troubleshoot

**File not found after `@` reference.** — The path is relative to the working directory where `ethos chat` was started. Verify the path exists: `ls src/agent-loop.ts`. Launch `ethos chat` from the project root so relative paths resolve correctly.

**URL reference returns empty content.** — The fetch failed silently (network error, 404, or non-text content type). Open the URL in a browser to confirm it returns text. HTTPS URLs with self-signed certificates are not supported without additional configuration.

**Tab completion not working.** — Tab completion requires a readline-compatible terminal. It does not work in piped input or non-interactive shells. Verify your terminal supports readline (most modern terminals do).

**File content appears truncated.** — Files over 8 000 characters are truncated by design. Reference smaller, more targeted files, or split your question across multiple messages that each reference a different section of the codebase.

**Web composer file picker does not appear.** — The popover triggers on the `@` character in the web message input. Ensure you are running `ethos serve --web` and using the web dashboard at `http://localhost:3000`. The file picker is not available in the CLI.

**Multiple `@` references but only one file inlined.** — Each reference must be separated by whitespace. `@src/a.ts@src/b.ts` is parsed as a single (invalid) path. Add a space: `@src/a.ts @src/b.ts`.

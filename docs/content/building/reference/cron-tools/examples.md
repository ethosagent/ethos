---
title: "Cron tools: examples"
description: "Worked examples of the cron tool actions."
kind: reference
audience: developer
updated: 2026-11-03
---

## Synopsis {#synopsis}

Worked examples of the cron tool actions. Part of the [Cron tools reference](../cron-tools.md).

## Examples {#examples}

### Morning briefing {#example-morning-briefing}

```text
cron({
  action: "create",
  name: "Morning briefing",
  schedule: "0 8 * * 1-5",
  prompt: "Summarise overnight Slack alerts, the deploy log, and pending PRs."
})
```

### List all jobs {#example-list}

```text
cron({ action: "list" })
```

### Get job detail with run history {#example-get}

```text
cron({ action: "get", id: "morning-briefing" })
```

### Read a specific run's output {#example-read-run}

```text
cron({ action: "read_run", id: "morning-briefing", at: "2026-05-21T08:00:00.000Z" })
```

### Pause and resume {#example-pause-resume}

```text
cron({ action: "pause", id: "morning-briefing" })
cron({ action: "resume", id: "morning-briefing" })
```

### Run immediately {#example-run}

```text
cron({ action: "run", id: "morning-briefing" })
```

### Remove {#example-remove}

```text
cron({ action: "remove", id: "morning-briefing" })
```

## See also {#see-also}

- [Cron tools reference](../cron-tools.md): the index of every section and its page.

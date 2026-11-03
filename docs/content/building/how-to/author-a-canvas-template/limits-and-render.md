---
title: "Author a Canvas template: sizing, libraries, CSP and caps"
description: "Size the Canvas frame, request a library, stay inside the CSP, respect the caps and render the template."
kind: how-to
audience: developer
time: "10 min"
updated: 2026-11-03
---

## Task

Finish the Canvas template: frame sizing, the library allowlist, CSP limits and caps, then render it.

## Result

A template that renders in the web chat within the frame limits.

## Prereqs

- Complete [part 1](../author-a-canvas-template.md): the template file reads `window.ethosData` and uses theme variables.

## Steps

### 5. Let the host size the frame

Height is automatic. The host injects a `ResizeObserver` on `document.body` that reports `document.documentElement.scrollHeight` back over `postMessage`. Give your content a real height and do nothing else — no height protocol to implement, no manual resize call.

Charts are the one case that needs a number, because a chart canvas has no intrinsic height. Derive it from the data:

```js
root.style.height = sectors.length * 34 + 108 + 'px';
```

### 6. Request a library, if you need one

`libraries` is a versioned allowlist bundled locally by the web app. Spec 1 ships one entry:

| Name | Global | Registered surface |
|---|---|---|
| `echarts@1` | `echarts` | Series: bar, line, pie, scatter, heatmap. Components: dataset, grid, legend, title, tooltip, visualMap. |

Pass it on the call — `render_ui({ template: "sector-flow", libraries: ["echarts@1"], data })` — and the source is prepended inline before your markup. Unknown names are rejected at the tool. There is no CDN, by design.

Many templates need no library at all. The swing-trader `market-brief.html` is plain DOM: `document.createElement` plus `textContent`, no dependency.

### 7. Stay inside the CSP

The frame runs with `sandbox="allow-scripts"` and no `allow-same-origin` — an opaque origin, no cookies, no storage, no reach into the page around it. On top of that:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;
```

| Forbidden | Why |
|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` | `default-src 'none'` — a template cannot phone home. Everything it shows must arrive in `data`. |
| Remote scripts, stylesheets, fonts, images | Same fallback. Fonts are deliberately absent: the frame renders in the stack `--ethos-font` names. Images must be `data:` URIs. |
| `eval`, `new Function` | `script-src` carries no `'unsafe-eval'`. |
| Nonces and hashes | Deliberately not shipped — adding one would disable `'unsafe-inline'` and break every template. |

Inline `<style>`, `style=` attributes, and inline `<script>` all work. That is the whole surface.

### 8. Respect the caps

| Cap | Limit |
|---|---|
| `html` (inline or resolved template) | 65 536 chars |
| `data`, serialized | 32 768 chars |
| `libraries` | 4 entries |
| `title` | 120 chars |

Inline `html` is for one-off shapes the model composes on the spot. A template is the durable form: it is reviewed, it is versioned with the personality, and it costs no prompt tokens per turn.

## Verify

Call the tool from a chat turn on the web surface:

```
render_ui({ template: "sector-flow", libraries: ["echarts@1"], data: { "unit": "Cr", "buckets": ["Mon","Tue"], "sectors": ["Banks","IT"], "cells": [{"sector":"Banks","bucket":"Mon","value":412}] } })
```

```
rendered canvas
```

The frame appears in the turn, themed to your skin, sized to its content. Switch the app between dark and light: every color follows, and nothing in the frame is a fixed hex.

## Troubleshoot

**`Cards render on the web surface; answer in prose here.`**

The turn ran on a channel or the CLI. Both `ui` tools refuse off-surface, and the composition rules are not injected there either.

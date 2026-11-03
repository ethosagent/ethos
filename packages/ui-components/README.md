# @ethosagent/ui-components

## Purpose

React components for rendering agent output: markdown, sanitised HTML, a content router, and the plugin settings panel. It owns the fenced-code-block interception point and fallback chrome; host surfaces supply a resolver that decides how a given fence is rendered. React is a peer dependency.

## Public surface

| Export | Kind | One line |
|---|---|---|
| `ContentRenderer` | component | Renders message content. |
| `ContentRendererProps` | type | Props of `ContentRenderer`. |
| `MarkdownRenderer` | component | Renders markdown via react-markdown and remark-gfm. |
| `MarkdownRendererProps` | type | Props of `MarkdownRenderer`. |
| `HtmlRenderer` | component | Renders HTML after `DOMPurify.sanitize`. |
| `PluginSettingsPanel` | component | Settings panel for plugins. |
| `FenceRendererResolver` | type | Host-supplied resolver for fenced blocks. |
| `FenceRenderRequest` | type | One fenced block offered to the resolver. |
| `FenceRenderResult` | type | Resolver answer. |

## Seam

Archcheck layer `support`. UI decisions follow `.claude/rules/ui-design.md` and DESIGN.md. HTML is sanitised in `src/html-renderer.tsx` by `DOMPurify.sanitize`; no test pins this (limitation).

## Testing

```
pnpm vitest run packages/ui-components
```

This package has no test files.

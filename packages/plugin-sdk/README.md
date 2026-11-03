# @ethosagent/plugin-sdk

## Purpose

Toolkit for people who write Ethos plugins: the `EthosPlugin` and `EthosPluginApi` shapes, helpers for defining tools, plugin credential and OAuth plumbing, and test doubles for a plugin's tools. It wraps `@ethosagent/core` and `@ethosagent/types` and imports no concrete implementation.

## Public surface

Subpaths: `@ethosagent/plugin-sdk` (main), `@ethosagent/plugin-sdk/tool-helpers`, `@ethosagent/plugin-sdk/testing`.

| Export | Kind | One line |
|---|---|---|
| `EthosPlugin` | interface | Shape a plugin implements. |
| `EthosPluginApi` | interface | Registration API handed to a plugin. |
| `PluginApiImpl` | class | Implementation of `EthosPluginApi` over the registries. |
| `PluginRegistries` | interface | Registries a `PluginApiImpl` registers into. |
| `PluginEventBus` | class | Event bus shared between plugins. |
| `PluginRouteEntry` | interface | A plugin-registered HTTP route. |
| `PluginHttpRequest` | interface | Request passed to a plugin route handler. |
| `PluginHttpResponse` | interface | Response returned by a plugin route handler. |
| `intersectToolGrants` | function | Intersects a command's tool list with the personality toolset. |
| `ContextStore` | class | Re-exported from `context-registry`. |
| `DiagnosticStore` | class | Stores plugin diagnostics. |
| `LocalOAuthServer` | class | Local callback server for OAuth flows. |
| `OAuthCoordinatorImpl` | class | Implementation of `OAuthCoordinator`. |
| `pluginCredentialRef` | function | Builds a plugin credential reference. |
| `pluginCredentialPrefix` | function | Builds a plugin credential name prefix. |
| `migrateLegacyPluginCredentials` | function | Migrates legacy plugin credentials. |
| `defineTool` | function | Builds a `Tool` from a `ToolDefinition` (`tool-helpers`). |
| `ok` | function | Successful `ToolResult` (`tool-helpers`). |
| `err` | function | Failed `ToolResult` with an error code (`tool-helpers`). |
| `needsApproval` | function | Marks a tool definition as requiring approval (`tool-helpers`). |
| `withCache` | function | Adds caching to a tool definition (`tool-helpers`). |
| `withReturnDirect` | function | Marks a tool result to be returned directly (`tool-helpers`). |
| `mockLLM` | function | Scripted `LLMProvider` for tests (`testing`). |
| `mockTool` | function | Fixed-result `Tool` for tests (`testing`). |
| `createTestRuntime` | function | Test harness for plugin tools (`testing`). |

Plus many type re-exports from `@ethosagent/types`, see `src/index.ts`.

## Seam

Archcheck layer `core-adapters`: plugin-sdk wraps core for plugin authors and reaches nothing concrete (archcheck rule `core-adapters-wrap-core` in `architecture.config.ts`). The plugin contract itself lives in `@ethosagent/types` (`plugin.ts`).

## Testing

```
pnpm vitest run packages/plugin-sdk
```

- `src/__tests__/intersect-tool-grants.test.ts`: pins `intersectToolGrants` (undefined handling and intersection).
- `src/__tests__/cli-subcommand.test.ts`: CLI subcommand registration through the plugin API.
- `src/__tests__/plugin-sdk.test.ts`: plugin API registration behaviour.

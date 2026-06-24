# create-ethos-llm-provider

Starter template for building a custom Ethos LLM provider.

## Quick start

1. Copy this template to `extensions/llm-<your-provider>/`
2. Rename `MyProvider` to `YourProvider` in `src/index.ts`
3. Update `package.json`: change the package name to `@ethosagent/llm-<your-provider>`
4. Add path alias to root `tsconfig.json`:
   ```json
   "@ethosagent/llm-<your-provider>": ["./extensions/llm-<your-provider>/src"]
   ```
5. Implement the streaming logic in `complete()`
6. Run `pnpm test:conformance` to validate your implementation

## Two tiers of provider authoring

### Tier 1: Config-only (zero code)

If your provider speaks the OpenAI Chat Completions wire format, you don't need
code at all. Add a manifest to `packages/wiring/src/provider-manifests.ts`:

```typescript
{
  id: 'my-provider',
  name: 'My Provider',
  transport: 'openai-chat-completions',
  baseUrl: 'https://api.my-provider.com/v1',
  auth: { location: 'header', name: 'Authorization', scheme: 'bearer', secretRef: 'providers/my-provider/apiKey' },
  capabilities: { streaming: true, toolCalling: true, contractVersion: 1 },
}
```

### Tier 2: Custom provider (this template)

For providers with a non-standard wire format (Bedrock, Vertex, Cohere, etc.),
implement `LLMProvider` from `@ethosagent/types` and map your transport's
streaming events to the `CompletionChunk` union.

## Key rules

- **Extensionless imports**: `import './foo'` not `import './foo.ts'`
- **No console.\***: use the Logger from `LLMProviderFactoryContext`
- **Secrets via SecretsResolver**: never read API keys from config files
- **Reuse transports**: check ARCHITECTURE.md transport table before writing a streaming loop
- **Declare capabilities**: the `capabilities` getter must honestly reflect what your provider supports

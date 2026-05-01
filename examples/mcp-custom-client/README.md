# Ethos MCP — Custom Client

This example shows how to call the Ethos MCP server programmatically from a Node.js script.

## Setup

```bash
npm install @modelcontextprotocol/sdk
```

Ensure `ethos` is on your PATH and configured (`~/.ethos/config.yaml` exists).

## Run

```bash
node client.js
```

The script:
1. Spawns `ethos mcp serve` as a subprocess over stdio
2. Lists available tools
3. Lists all personalities
4. Asks the first personality a question and prints the response

## Key patterns

**Connecting:**
```js
const transport = new StdioClientTransport({ command: 'ethos', args: ['mcp', 'serve'] });
await client.connect(transport);
```

**Calling a tool:**
```js
const result = await client.callTool({
  name: 'ask_personality',
  arguments: { personality_id: 'researcher', prompt: 'What is AI alignment?' },
});
console.log(result.content[0].text);
```

**Reading a resource:**
```js
const { contents } = await client.readResource({ uri: 'ethos://memory/MEMORY.md' });
console.log(contents[0].text);
```

// Example: call the Ethos MCP server from a custom Node.js client.
// Run: node client.js
//
// Prerequisites:
//   npm install @modelcontextprotocol/sdk
//   ethos must be on PATH

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'ethos',
  args: ['mcp', 'serve'],
});

const client = new Client({ name: 'ethos-example', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

// List available tools
const { tools } = await client.listTools();
console.log(
  'Tools:',
  tools.map((t) => t.name),
);

// List personalities
const listResult = await client.callTool({ name: 'list_personalities', arguments: {} });
const personalities = JSON.parse(listResult.content[0].text);
console.log(
  '\nPersonalities:',
  personalities.map((p) => p.id),
);

// Ask a personality a question
const firstId = personalities[0]?.id ?? 'researcher';
console.log(`\nAsking ${firstId}...`);
const response = await client.callTool({
  name: 'ask_personality',
  arguments: {
    personality_id: firstId,
    prompt: 'In one sentence, what is your primary purpose?',
  },
});
console.log('Response:', response.content[0].text);

await client.close();

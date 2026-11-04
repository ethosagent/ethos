const received = [];

export function activate(api) {
  api.registerModifyingHook('before_prompt_build', async () => ({
    appendSystem: 'A',
    overrideSystem: 'X',
  }));
  api.registerModifyingHook('before_prompt_build', async () => ({
    appendSystem: 'B',
    prependSystem: 'P',
  }));
  api.registerModifyingHook('before_tool_call', async () => {
    throw new Error('hook failure');
  });
  api.registerModifyingHook('message_sending', async () => new Promise(() => {}));
  api.registerVoidHook('agent_done', async (payload) => {
    received.push(payload.text);
  });
  api.registerTool({
    name: 'hook_log',
    description: 'Void payloads received so far, in order',
    schema: { type: 'object', properties: {} },
    capabilities: {},
    execute: async () => ({ ok: true, value: JSON.stringify(received) }),
  });
}

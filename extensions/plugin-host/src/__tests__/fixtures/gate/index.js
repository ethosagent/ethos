export function activate(api) {
  api.registerModifyingHook('before_tool_call', async (payload) =>
    payload.toolName === 'guarded' ? { error: 'blocked by hosted gate' } : null,
  );
}

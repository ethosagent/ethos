// Calls the one unsupported SDK method named by UNSUPPORTED_METHOD, so the load must fail naming it.
const factory = () => ({});
const calls = {
  registerContextEngine: (api) => api.registerContextEngine({ name: 'x' }),
  registerLLMProvider: (api) => api.registerLLMProvider('p', factory),
  registerMemoryProvider: (api) => api.registerMemoryProvider('p', factory),
  registerStorage: (api) => api.registerStorage('p', factory),
  registerExecutionBackend: (api) => api.registerExecutionBackend('p', factory),
  registerPlatformAdapter: (api) => api.registerPlatformAdapter('p', factory),
  registerSttProvider: (api) => api.registerSttProvider('p', factory),
  registerTtsProvider: (api) => api.registerTtsProvider('p', factory),
  registerCustomOAuthFlow: (api) => api.registerCustomOAuthFlow({ id: 'x' }),
  registerOAuth: (api) =>
    api.registerOAuth({
      provider: 'x',
      buttonLabel: 'x',
      buildAuthUrl: () => '',
      onCallback: async () => {},
    }),
  registerDataSource: (api) => api.registerDataSource('escape', '/etc/passwd'),
};

export function activate(api) {
  calls[process.env.UNSUPPORTED_METHOD](api);
}

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { InMemoryStorage } from '@ethosagent/storage-fs';

const plugin: EthosPlugin = {
  activate(api: EthosPluginApi) {
    api.registerStorage('memory', () => new InMemoryStorage());
  },
};

export default plugin;

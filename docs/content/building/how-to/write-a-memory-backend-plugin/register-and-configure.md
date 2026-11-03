---
title: "Write a memory backend plugin: register and configure"
description: "Register the memory provider in activate, set it in config.yaml and route per personality."
kind: how-to
audience: developer
time: "5 min"
updated: 2026-11-03
---

## Task

Register the memory provider in `activate`, select it in `config.yaml` and optionally route a personality to it.

## Result

Memory reads and writes go through your backend.

## Prereqs

- Complete [part 1](../write-a-memory-backend-plugin.md): the plugin scaffold and `MemoryProvider` implementation exist.

## Steps

### 3. Register via activate

```ts title="src/index.ts"
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import { Mem0Provider } from './mem0-provider';

export function activate(api: EthosPluginApi): void {
  api.registerMemoryProvider('mem0', async ({ secrets, logger }) => {
    const apiKey = await secrets.get('providers/mem0/apiKey');
    if (!apiKey) {
      throw new Error('Mem0 API key not found in secrets store');
    }
    logger.info('Mem0 memory provider activated');
    return new Mem0Provider(apiKey, 'https://api.mem0.ai');
  });
}
```

The registered name becomes `ethos-plugin-mem0/mem0`.

### 4. Configure

```yaml title="~/.ethos/config.yaml"
memory: ethos-plugin-mem0/mem0
```

```bash
ethos secrets set providers/mem0/apiKey <your-key>
```

### 5. Per-personality routing (optional)

A personality can override the global memory backend:

```yaml title="~/.ethos/personalities/researcher/config.yaml"
memory:
  provider: ethos-plugin-mem0/mem0
  options:
    collection: researcher
```

The `options` dict is passed as `config` to your factory.

## Verify

```bash
ethos chat -q "remember that I prefer dark mode"
ethos chat -q "what are my preferences?"
```

The second turn should recall the preference via your Mem0 backend.

## Troubleshoot

**"Memory provider X is not registered"** — The plugin did not load. Check `ethos plugins list` and ensure `ethos.pluginContractMajor: 2` is set.

**Factory throws "API key not found"** — Run `ethos secrets set providers/mem0/apiKey <key>`. Network-only backends still need credentials even though they ignore `dataDir`.

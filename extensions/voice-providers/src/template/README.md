# create-ethos-voice-provider

Starter template for building a custom Ethos voice provider plugin.

## Quick start

1. Copy this template directory
2. Implement `SttProvider` and/or `TtsProvider` from `@ethosagent/types`
3. Export a factory function and call `registerSttProvider`/`registerTtsProvider` in your plugin's `activate()`
4. Declare `ethos.pluginContractMajor: 4` in your `package.json`

## Example STT provider

```typescript
import type { EthosPluginApi } from '@ethosagent/plugin-sdk';
import type { SttProvider, VoiceCapabilities } from '@ethosagent/types';

class MySttProvider implements SttProvider {
  readonly name = 'my-stt';
  readonly caps: VoiceCapabilities = {
    kind: 'stt',
    formats: ['opus', 'mp3', 'wav'],
    local: false,
    contractVersion: 1,
  };

  async transcribe(audioPath: string): Promise<string> {
    // Your implementation here
    return 'transcribed text';
  }
}

export function activate(api: EthosPluginApi): void {
  api.registerSttProvider('my-stt', () => new MySttProvider());
}
```

## Example TTS provider

```typescript
import type { TtsProvider, VoiceCapabilities } from '@ethosagent/types';

class MyTtsProvider implements TtsProvider {
  readonly name = 'my-tts';
  readonly caps: VoiceCapabilities = {
    kind: 'tts',
    formats: ['mp3'],
    local: false,
    maxInputChars: 5000,
    contractVersion: 1,
  };

  async synthesize(text: string): Promise<{ audio: Uint8Array; format: 'mp3' }> {
    // Your implementation here
    return { audio: new Uint8Array(0), format: 'mp3' };
  }
}
```

## Config-only (command) provider

No code needed — just add to `~/.ethos/config.yaml`:

```yaml
auxiliary:
  tts:
    provider: my-local-tts
    providers:
      my-local-tts:
        type: command
        command: "piper --model en_US-lessac-medium --output-file {output_path} < {input_path}"
        output_format: wav
```

## Conformance

Use `validateVoiceCaps` from `@ethosagent/voice-providers` to verify your caps declaration:

```typescript
import { validateVoiceCaps } from '@ethosagent/voice-providers';

const errors = validateVoiceCaps(myProvider.caps);
if (errors.length > 0) throw new Error(errors.join(', '));
```

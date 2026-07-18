// Utterance-buffered fallback: wrap a batch SttProvider so the session can
// treat it as a StreamingSttProvider. It buffers the utterance's PCM, hands it
// to an injected materializer that produces a path the batch provider reads,
// then yields a single final partial. Endpointing is worse (no live partials)
// but the contract is identical.

import type { PcmChunk, StreamingSttProvider, SttProvider } from '@ethosagent/types';

export function createBufferedSttAdapter(
  provider: SttProvider,
  pcmToPath: (chunks: PcmChunk[]) => Promise<string>,
): StreamingSttProvider {
  return {
    name: provider.name,
    caps: provider.caps,
    transcribe: (audioPath, opts) => provider.transcribe(audioPath, opts),
    async *transcribeStream(audio, opts) {
      const chunks: PcmChunk[] = [];
      for await (const chunk of audio) chunks.push(chunk);
      const path = await pcmToPath(chunks);
      const text = await provider.transcribe(path, opts);
      yield { text, isFinal: true };
    },
  };
}

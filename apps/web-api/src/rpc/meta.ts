import { os } from './context';

export const metaRouter = {
  capabilities: os.meta.capabilities.handler(async ({ context }) => {
    let voiceStt = context.voice?.isConfigured ?? false;
    if (!voiceStt) {
      const cfg = await context.config.get().catch(() => null);
      if (cfg?.voiceProvider) voiceStt = true;
    }
    let voiceTts = context.voice?.isTtsConfigured ?? false;
    if (!voiceTts) {
      const cfg = await context.config.get().catch(() => null);
      if (cfg?.voiceTtsProvider) voiceTts = true;
    }
    return {
      capabilities: {
        byok: true,
        voice_stt: voiceStt,
        voice_tts: voiceTts,
      },
    };
  }),
};

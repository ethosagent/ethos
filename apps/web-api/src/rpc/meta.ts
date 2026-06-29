import { os } from './context';

export const metaRouter = {
  capabilities: os.meta.capabilities.handler(async ({ context }) => {
    let voiceStt = context.voice?.isConfigured ?? false;
    if (!voiceStt) {
      const cfg = await context.config.get().catch(() => null);
      if (cfg?.voiceProvider) voiceStt = true;
    }
    return {
      capabilities: {
        byok: true,
        voice_stt: voiceStt,
      },
    };
  }),
};

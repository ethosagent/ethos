import { os } from './context';

export const voiceRouter = {
  transcribe: os.voice.transcribe.handler(async ({ input, context }) => {
    if (!context.voice) {
      throw new Error('Voice transcription not configured');
    }
    const transcript = await context.voice.transcribe(input.audio, input.mimeType);
    return { transcript };
  }),
};

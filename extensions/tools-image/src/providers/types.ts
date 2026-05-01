export interface ImageGenProvider {
  name: string;
  generate(opts: {
    prompt: string;
    size: string;
    quality: string;
  }): Promise<{ buffer: Buffer; cost_usd: number }>;
  supports(size: string, quality: string): boolean;
  isAvailable(): boolean;
}

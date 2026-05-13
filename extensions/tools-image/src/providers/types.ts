export interface GenerateOpts {
  prompt: string;
  size: string;
  quality: string;
  onProgress?: (msg: string) => void;
}

export interface GenerateResult {
  buffer: Buffer;
  cost_usd: number;
  prompt_used: string;
}

export interface ImageGenProvider {
  name: string;
  generate(opts: GenerateOpts): Promise<GenerateResult>;
  supports(size: string, quality: string): boolean;
  isAvailable(): boolean;
}

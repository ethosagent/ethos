export interface GenerateOpts {
  prompt: string;
  size: string;
  quality: 'standard' | 'hd';
  onProgress?: (msg: string) => void;
  apiKey?: string;
  fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface GenerateResult {
  buffer: Buffer;
  cost_usd: number;
  prompt_used: string;
}

export interface ImageGenProvider {
  readonly name: string;
  generate(opts: GenerateOpts): Promise<GenerateResult>;
  supports(size: string, quality: string): boolean;
  isAvailable(): boolean;
}

import type { ScopedFetch } from '@ethosagent/types';

export class ScopedFetchImpl implements ScopedFetch {
  constructor(private readonly allowedHosts: Set<string>) {}

  async fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    if (!this.isHostAllowed(parsed.hostname)) {
      throw new Error(`HOST_NOT_ALLOWED: ${parsed.hostname} is not in the declared allowedHosts`);
    }
    return globalThis.fetch(parsed, init);
  }

  private isHostAllowed(hostname: string): boolean {
    if (this.allowedHosts.has('*')) return true;
    if (this.allowedHosts.has(hostname)) return true;
    // Check subdomain wildcards: '*.github.com' matches 'api.github.com'
    for (const pattern of this.allowedHosts) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // '.github.com'
        if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
      }
    }
    return false;
  }
}

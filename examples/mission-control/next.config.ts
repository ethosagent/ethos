import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ethosagent/sdk', '@ethosagent/web-contracts'],
};

export default nextConfig;

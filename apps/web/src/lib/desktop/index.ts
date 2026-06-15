import type { EthosDesktopBridge } from '@ethosagent/web-contracts';

declare global {
  interface Window {
    ethos?: EthosDesktopBridge;
  }
}

/** True when running inside the Electron shell. */
export const isDesktop = typeof window !== 'undefined' && !!window.ethos;

/** The desktop bridge, or `null` when running in a plain browser. */
export const bridge: EthosDesktopBridge | null =
  typeof window !== 'undefined' ? (window.ethos ?? null) : null;

// Capability flags — all gated on the bridge being present.
export const hasKeychain = isDesktop;
export const hasLoginItem = isDesktop;
export const hasNativeDialogs = isDesktop;
export const hasFileSystem = isDesktop;
export const hasConnection = isDesktop;
export const hasGateway = isDesktop;

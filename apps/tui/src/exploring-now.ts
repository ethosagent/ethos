// Host-injected data source for the TUI "exploring now" strip. The TUI has no RPC
// path to the initiative store (web-api's InitiativesService owns that read), so the
// host that launches the TUI registers a getter here; with none registered the strip
// renders nothing. Shape mirrors ExploringNowOutput.current in @ethosagent/web-contracts.

export interface ExploringNowSnapshot {
  windowId: string;
  initiativeId: string;
  initiativeTitle: string;
  question: string | null;
  started: string;
  costSoFarUsd: number;
  readOnly: true;
}

export type ExploringNowSource = () => ExploringNowSnapshot | null;

let source: ExploringNowSource | null = null;

export function setExploringNowSource(next: ExploringNowSource | null): void {
  source = next;
}

export function readExploringNow(): ExploringNowSnapshot | null {
  return source ? source() : null;
}

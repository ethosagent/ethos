import type { SessionStore } from '@ethosagent/types';

export interface DebugServiceOptions {
  sessionStore: SessionStore;
}

export interface DebugChatInput {
  mainSessionId: string;
  message: string;
  clientId?: string;
}

export interface DebugChatOutput {
  sessionId: string;
  turnId: string;
}

export class DebugService {
  private readonly sessionStore: SessionStore;

  constructor(opts: DebugServiceOptions) {
    this.sessionStore = opts.sessionStore;
  }

  async chat(input: DebugChatInput): Promise<DebugChatOutput> {
    const debugSessionKey = `${input.mainSessionId}:debug`;
    const turnId = `debug-${Date.now()}`;
    return { sessionId: debugSessionKey, turnId };
  }
}

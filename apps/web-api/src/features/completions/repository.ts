import type { MessageRole, Session, SessionStore } from '@ethosagent/types';

// Storage access for the completions feature. Wraps the subset of
// SessionStore operations that CompletionsService needs: create ephemeral
// sessions and pre-populate prior message history. No business logic —
// that lives in service.ts.

export class CompletionsRepository {
  constructor(private readonly store: SessionStore) {}

  async createSession(input: {
    key: string;
    platform: string;
    model: string;
    provider: string;
    usage: Session['usage'];
  }): Promise<Session> {
    return this.store.createSession(input);
  }

  async appendMessage(input: {
    sessionId: string;
    role: MessageRole;
    content: string;
  }): Promise<void> {
    await this.store.appendMessage(input);
  }
}

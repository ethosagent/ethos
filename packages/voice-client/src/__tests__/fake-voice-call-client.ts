import type { VoiceCallClient, VoiceCallEvent } from '../voice-call-client';

// In-memory VoiceCallClient for unit tests. Drives the reducer/hook without a
// transport: `emit()` pushes an event to subscribers, `setConnectBehavior`
// controls whether `connect()` resolves or rejects. Mirrors the fakes pattern in
// extensions/platform-voice/src/__tests__/fakes.ts.
export class FakeVoiceCallClient implements VoiceCallClient {
  readonly muteCalls: boolean[] = [];
  disconnected = false;
  private listeners = new Set<(event: VoiceCallEvent) => void>();
  private connectError: Error | null = null;

  setConnectBehavior(behavior: { fail?: string }): void {
    this.connectError = behavior.fail ? new Error(behavior.fail) : null;
  }

  connect(): Promise<void> {
    return this.connectError ? Promise.reject(this.connectError) : Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }

  setMuted(muted: boolean): void {
    this.muteCalls.push(muted);
  }

  micStream(): MediaStream | null {
    return null;
  }

  on(listener: (event: VoiceCallEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: VoiceCallEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

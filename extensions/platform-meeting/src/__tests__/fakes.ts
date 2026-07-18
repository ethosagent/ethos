// FakeMeetingClient — an in-memory MeetingClient for unit tests. On `join()` it
// drains a recorded caption stream to every subscribed handler, then invokes the
// test-supplied `onDrained` hook so the test can trigger termination (in the
// real tool, capture runs until the turn's abortSignal fires). This is a test
// artifact only — the real binding is Playwright (see README.md).

import type { MeetingClient, MeetingJoinOptions, RawCaptionFragment } from '../meeting-client';

export interface FakeMeetingClientOptions {
  /** Called once the fixture has been drained to handlers (test termination hook). */
  onDrained?: () => void;
}

export class FakeMeetingClient implements MeetingClient {
  readonly joined: MeetingJoinOptions[] = [];
  leftCount = 0;
  private readonly handlers = new Set<(fragment: RawCaptionFragment) => void>();

  constructor(
    private readonly fragments: readonly RawCaptionFragment[],
    private readonly options: FakeMeetingClientOptions = {},
  ) {}

  async join(opts: MeetingJoinOptions): Promise<void> {
    this.joined.push(opts);
    for (const fragment of this.fragments) {
      for (const handler of this.handlers) handler(fragment);
    }
    this.options.onDrained?.();
  }

  onCaption(handler: (fragment: RawCaptionFragment) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async leave(): Promise<void> {
    this.leftCount += 1;
  }
}

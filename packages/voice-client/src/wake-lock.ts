/**
 * Keeps the screen awake for the duration of a call. The browser implementation
 * (`navigator.wakeLock`) lives in apps/web; the phone brings its own.
 */
export interface WakeLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  readonly held: boolean;
}

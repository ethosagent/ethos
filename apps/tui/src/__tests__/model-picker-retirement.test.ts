/**
 * The TUI model picker lists catalog rows through `getModelsForProvider`, which
 * hides a row from its `retiresOn` date. The list must be built when the picker
 * OPENS, not when the module loads, so a TUI left running across a retirement
 * date stops offering the retired model (Codex `gpt-5.5`, 2026-10-14). The
 * clock is fixed with fake `Date` only; Ink's own timers stay real.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPickerModal } from '../components/ModelPickerModal';

class CapturingStdout extends EventEmitter {
  columns = 240;
  rows = 200;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
  }
  get last(): string {
    return this.frames.at(-1) ?? '';
  }
}

function makeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
  vi.useRealTimers();
});

function open(): CapturingStdout {
  const stdout = new CapturingStdout();
  const instance = render(
    createElement(ModelPickerModal, { current: 'none', onSelect: () => {}, onCancel: () => {} }),
    {
      stdout: stdout as never,
      stdin: makeStdin() as never,
      stderr: stdout as never,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  unmounts.push(() => instance.unmount());
  return stdout;
}

const RETIRING = 'deprecated — retires 2026-10-14';

describe('ModelPickerModal evaluates retirement when it opens', () => {
  it('offers codex gpt-5.5 the day before its retirement date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    expect(open().last).toContain(RETIRING);
  });

  it('no longer offers it once the date is reached, in the same process', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    const frame = open().last;
    expect(frame).toContain('gpt-6-sol');
    expect(frame).not.toContain(RETIRING);
  });
});

import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  collectPluginCredential,
  createMutableOutput,
  readMaskedLine,
} from '../lib/credential-prompt';

// openclaw-9.5 item 1 — the CLI's masked answer to `credential_required`.

const SECRET = 'sk-live-TOPSECRET-4242';

function capture(): { stream: Writable; text: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

describe('readMaskedLine', () => {
  it('never echoes the typed value and keeps it out of readline history', async () => {
    const input = new PassThrough();
    const screen = capture();
    const output = createMutableOutput(screen.stream);
    const rl = createInterface({ input, output: output.stream, terminal: true });

    const pending = readMaskedLine(rl, output, screen.stream, 'API key: ');
    input.write(`${SECRET}\r`);
    const value = await pending;

    expect(value).toBe(SECRET);
    expect(screen.text()).toContain('API key: ');
    expect(screen.text()).not.toContain(SECRET);
    expect(screen.text()).not.toContain('TOPSECRET');
    const history = (rl as unknown as { history?: string[] }).history;
    expect(Array.isArray(history)).toBe(true);
    expect(history).not.toContain(SECRET);

    // Echo is back on for the next ordinary line.
    input.write('hello\r');
    await new Promise((r) => setImmediate(r));
    expect(screen.text()).toContain('hello');
    rl.close();
  });
});

describe('collectPluginCredential', () => {
  const req = {
    pluginId: 'weather',
    credentialKey: 'API_KEY',
    label: 'Weather API key',
    description: 'From the dashboard',
  };

  it('stores through setCredential and asks for a resubmit; the value is never printed', async () => {
    const lines: string[] = [];
    const setCredential = vi.fn(async () => {});
    const resubmit = await collectPluginCredential(req, {
      readSecret: async () => SECRET,
      write: (l) => lines.push(l),
      setCredential,
    });
    expect(resubmit).toBe(true);
    expect(setCredential).toHaveBeenCalledWith('weather', 'API_KEY', SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  it('an empty answer stores nothing and does not resubmit', async () => {
    const setCredential = vi.fn(async () => {});
    const resubmit = await collectPluginCredential(req, {
      readSecret: async () => '   ',
      write: () => {},
      setCredential,
    });
    expect(resubmit).toBe(false);
    expect(setCredential).not.toHaveBeenCalled();
  });

  it('a plugin unloaded between check and submit shows the error and does not resubmit', async () => {
    const lines: string[] = [];
    const resubmit = await collectPluginCredential(req, {
      readSecret: async () => SECRET,
      write: (l) => lines.push(l),
      setCredential: async (pluginId) => {
        throw new Error(`Plugin "${pluginId}" is not loaded`);
      },
    });
    expect(resubmit).toBe(false);
    expect(lines.join('\n')).toContain('Plugin "weather" is not loaded');
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

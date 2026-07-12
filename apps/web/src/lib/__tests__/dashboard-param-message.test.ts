import { describe, expect, it } from 'vitest';
import { readTrustedParamMessage } from '../dashboard-param-message';

// Minimal Window stand-ins — the predicate only reads `location.origin` on
// `self` and `parent` on the event source.
const ORIGIN = 'https://app.example';
const self = { location: { origin: ORIGIN } } as unknown as Window;
const childFrame = { parent: self } as unknown as Window; // a panel we rendered
const foreignWindow = { parent: {} } as unknown as Window; // outer page / unrelated

const select = { type: 'ethos:select', param: 'region', value: 'eu' };

describe('readTrustedParamMessage', () => {
  it('ignores a message from a foreign origin', () => {
    const msg = readTrustedParamMessage(
      { origin: 'https://evil.example', source: childFrame, data: select },
      self,
    );
    expect(msg).toBeNull();
  });

  it('ignores a message from a window that is not a child frame', () => {
    const msg = readTrustedParamMessage(
      { origin: ORIGIN, source: foreignWindow, data: select },
      self,
    );
    expect(msg).toBeNull();
  });

  it('accepts a same-origin message from a child frame', () => {
    const msg = readTrustedParamMessage({ origin: ORIGIN, source: childFrame, data: select }, self);
    expect(msg).toEqual({ param: 'region', value: 'eu' });
  });

  it('accepts the sandboxed-panel opaque origin ("null") from a child frame', () => {
    const msg = readTrustedParamMessage({ origin: 'null', source: childFrame, data: select }, self);
    expect(msg).toEqual({ param: 'region', value: 'eu' });
  });

  it('ignores an opaque-origin message from a non-child window', () => {
    const msg = readTrustedParamMessage(
      { origin: 'null', source: foreignWindow, data: select },
      self,
    );
    expect(msg).toBeNull();
  });

  it('ignores a wrong message type', () => {
    const msg = readTrustedParamMessage(
      { origin: ORIGIN, source: childFrame, data: { type: 'other', param: 'x', value: 'y' } },
      self,
    );
    expect(msg).toBeNull();
  });

  it('ignores a message with non-string param/value', () => {
    const msg = readTrustedParamMessage(
      { origin: ORIGIN, source: childFrame, data: { type: 'ethos:select', param: 1, value: 2 } },
      self,
    );
    expect(msg).toBeNull();
  });

  it('ignores a message with a null source', () => {
    const msg = readTrustedParamMessage({ origin: ORIGIN, source: null, data: select }, self);
    expect(msg).toBeNull();
  });
});

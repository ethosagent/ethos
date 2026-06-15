import { describe, expect, it } from 'vitest';
import {
  bridge,
  hasConnection,
  hasFileSystem,
  hasGateway,
  hasKeychain,
  hasLoginItem,
  hasNativeDialogs,
  isDesktop,
} from '../index';

describe('desktop bridge wrapper', () => {
  it('isDesktop is false when window.ethos is undefined', () => {
    expect(isDesktop).toBe(false);
  });

  it('bridge is null when window.ethos is undefined', () => {
    expect(bridge).toBeNull();
  });

  it('capability flags are false when not desktop', () => {
    expect(hasKeychain).toBe(false);
    expect(hasLoginItem).toBe(false);
    expect(hasNativeDialogs).toBe(false);
    expect(hasFileSystem).toBe(false);
    expect(hasConnection).toBe(false);
    expect(hasGateway).toBe(false);
  });
});

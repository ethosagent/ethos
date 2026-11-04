import { describe, expect, it } from 'vitest';
import { ollamaInstallPlan } from '../ollama-install-plan';

describe('ollamaInstallPlan', () => {
  it('linux runs the constant curl script via sh -c', () => {
    const p = ollamaInstallPlan('linux', { hasBrew: false, isRoot: false });
    expect(p.command).toBe('curl -fsSL https://ollama.com/install.sh | sh');
    expect(p.argv).toEqual(['sh', '-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
    expect(p.runnable).toBe(true);
  });

  it('macOS with brew installs and starts the service', () => {
    const p = ollamaInstallPlan('darwin', { hasBrew: true, isRoot: false });
    expect(p.command).toBe('brew install ollama && brew services start ollama');
    expect(p.runnable).toBe(true);
  });

  it('macOS without brew has no command, only a download url', () => {
    const p = ollamaInstallPlan('darwin', { hasBrew: false, isRoot: false });
    expect(p.command).toBeNull();
    expect(p.argv).toBeNull();
    expect(p.downloadUrl).toBe('https://ollama.com/download/mac');
    expect(p.runnable).toBe(false);
  });

  it('windows uses winget', () => {
    const p = ollamaInstallPlan('win32', { hasBrew: false, isRoot: false });
    expect(p.command).toBe('winget install --id Ollama.Ollama -e');
  });

  it('root is never runnable', () => {
    for (const os of ['linux', 'darwin', 'win32']) {
      expect(ollamaInstallPlan(os, { hasBrew: true, isRoot: true }).runnable).toBe(false);
    }
  });

  it('unknown platform has no command', () => {
    const p = ollamaInstallPlan('freebsd', { hasBrew: false, isRoot: false });
    expect(p.command).toBeNull();
    expect(p.runnable).toBe(false);
  });
});

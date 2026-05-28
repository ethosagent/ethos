import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logSupervisorEvent, supervisorLogPath } from '../logger';

let workDir;
let prevHome;
beforeEach(() => {
  workDir = join(tmpdir(), `ethos-logger-${process.pid}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = workDir;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(workDir, { recursive: true, force: true });
});
describe('logSupervisorEvent', () => {
  it('writes a valid JSON line to mesh-supervisor.log', () => {
    logSupervisorEvent({
      ts: '2024-01-01T00:00:00.000Z',
      team: 'analytics',
      personality: 'researcher',
      event: 'spawn',
      data: { port: 3001, pid: 12345 },
    });
    const logPath = supervisorLogPath();
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const firstLine = lines[0];
    if (firstLine === undefined) {
      throw new Error('expected one log line');
    }
    const entry = JSON.parse(firstLine);
    expect(entry.team).toBe('analytics');
    expect(entry.personality).toBe('researcher');
    expect(entry.event).toBe('spawn');
    expect(entry.data.port).toBe(3001);
  });
  it('appends multiple events without overwriting', () => {
    const events = ['spawn', 'exit', 'restart'];
    for (const event of events) {
      logSupervisorEvent({ ts: new Date().toISOString(), team: 't', personality: 'p', event });
    }
    const logPath = supervisorLogPath();
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const line = lines[i];
      if (line === undefined) {
        throw new Error(`expected log line at index ${i}`);
      }
      const entry = JSON.parse(line);
      expect(entry.event).toBe(events[i]);
    }
  });
  it('creates the log directory if it does not exist', () => {
    const logPath = supervisorLogPath();
    // The directory should not exist yet (fresh workDir).
    logSupervisorEvent({
      ts: new Date().toISOString(),
      team: 't',
      personality: 'p',
      event: 'spawn',
    });
    // If it reaches here without throwing, the directory was created.
    const content = readFileSync(logPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });
  it('each line is valid JSON and terminates with newline', () => {
    for (let i = 0; i < 5; i++) {
      logSupervisorEvent({
        ts: new Date().toISOString(),
        team: 'team',
        personality: `p${i}`,
        event: 'exit',
        data: { code: i },
      });
    }
    const raw = readFileSync(supervisorLogPath(), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trim().split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
  it('supervisorLogPath() uses HOME env', () => {
    const path = supervisorLogPath();
    expect(path).toContain(workDir);
    expect(path).toContain('mesh-supervisor.log');
  });
});

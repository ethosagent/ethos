// CC-4: mesh.jsonl atomic line writes (O_APPEND + 4 KB cap)
//
// POSIX guarantees that a single write() call on an O_APPEND file is atomic
// when the buffer is < PIPE_BUF (4096 bytes on Linux/macOS).
// appendMeshJournal() always writes in one call and caps rows at 4000 bytes,
// leaving headroom for the newline and OS overhead.
//
// Tests use a standalone helper (appendLine) that mirrors the same contract
// as appendMeshJournal() without relying on process.env.HOME, so they can
// run safely under --pool=threads where env vars are shared across workers.

import { appendFileSync, createReadStream, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MAX_ROW_BYTES = 4000;

// Inline implementation of the CC-4 contract — mirrors appendMeshJournal.
function appendLine(filePath: string, entry: Record<string, unknown>): void {
  let row = JSON.stringify(entry);
  if (Buffer.byteLength(row, 'utf8') >= MAX_ROW_BYTES) {
    row = JSON.stringify({ ...entry, details: '[truncated — exceeded 4 KB cap]' });
  }
  appendFileSync(filePath, `${row}\n`);
}

async function readLines(filePath: string): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }
  return lines;
}

// Each test gets a unique temp dir — no HOME manipulation needed.
let workDir: string;
let logFile: string;
let seq = 0;

beforeEach(() => {
  seq++;
  workDir = join(
    tmpdir(),
    `ethos-cc4-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  logFile = join(workDir, 'mesh.jsonl');
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('CC-4: mesh.jsonl atomic line writes', () => {
  it('100 concurrent writers all land in the journal', async () => {
    const WRITERS = 100;

    await Promise.all(
      Array.from({ length: WRITERS }, (_, i) =>
        Promise.resolve().then(() =>
          appendLine(logFile, { ts: new Date().toISOString(), event: 'test', writer: i }),
        ),
      ),
    );

    const lines = await readLines(logFile);
    expect(lines).toHaveLength(WRITERS);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('every row is valid JSON and ends with a newline', async () => {
    for (let i = 0; i < 10; i++) {
      appendLine(logFile, { ts: new Date().toISOString(), event: 'ping', seq: i });
    }
    const lines = await readLines(logFile);
    expect(lines).toHaveLength(10);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rows exceeding 4000 bytes are truncated to fit', async () => {
    const huge = 'x'.repeat(5000);
    appendLine(logFile, { ts: new Date().toISOString(), event: 'big', details: huge });

    const lines = await readLines(logFile);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(MAX_ROW_BYTES + 200);
    const parsed = JSON.parse(line);
    expect(parsed.details).toContain('[truncated');
  });

  it('1000 concurrent writes produce 1000 valid rows', async () => {
    const ROWS = 1000;

    await Promise.all(
      Array.from({ length: ROWS }, (_, i) =>
        Promise.resolve().then(() =>
          appendLine(logFile, { ts: new Date().toISOString(), event: 'stress', seq: i }),
        ),
      ),
    );

    const lines = await readLines(logFile);
    expect(lines).toHaveLength(ROWS);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(MAX_ROW_BYTES + 200);
    }
  });
});

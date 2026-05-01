// ethos backup / ethos import — snapshot and restore ~/.ethos/
//
// backup: tar.gz of config.yaml, keys.json, MEMORY.md, USER.md, personalities/
// import: extract and merge into ~/.ethos/

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { ethosDir } from '../config';

const BACKUP_FILES = ['config.yaml', 'keys.json', 'MEMORY.md', 'USER.md'];

const _USAGE_BACKUP = 'Usage: ethos backup [output-path]';
const USAGE_IMPORT = 'Usage: ethos import <backup-path>';

export async function runBackup(argv: string[]): Promise<void> {
  const outPath = argv[0] ?? `ethos-backup-${timestamp()}.tar.gz`;
  const dataDir = ethosDir();

  const entries = collectEntries(dataDir);
  if (entries.length === 0) {
    console.log('Nothing to backup — ~/.ethos/ is empty.');
    return;
  }

  await writeTarGz(entries, outPath);
  console.log(`✓ Backup written to: ${outPath} (${entries.length} files)`);
}

export async function runImport(argv: string[]): Promise<void> {
  const srcPath = argv[0];
  if (!srcPath) {
    console.error(USAGE_IMPORT);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(srcPath)) {
    console.error(`File not found: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  const dataDir = ethosDir();
  mkdirSync(dataDir, { recursive: true });

  const entries = await readTarGz(srcPath);
  for (const [relPath, content] of entries) {
    const dest = join(dataDir, relPath);
    mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
    writeFileSync(dest, content);
  }

  console.log(`✓ Imported ${entries.length} files into ~/.ethos/`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

interface Entry {
  relPath: string;
  content: Buffer;
}

function collectEntries(dataDir: string): Entry[] {
  const entries: Entry[] = [];

  for (const file of BACKUP_FILES) {
    const p = join(dataDir, file);
    if (existsSync(p)) entries.push({ relPath: file, content: readFileSync(p) });
  }

  const personalitiesDir = join(dataDir, 'personalities');
  if (existsSync(personalitiesDir)) {
    for (const id of readdirSync(personalitiesDir)) {
      const pDir = join(personalitiesDir, id);
      if (!statSync(pDir).isDirectory()) continue;
      for (const f of readdirSync(pDir)) {
        const fp = join(pDir, f);
        if (statSync(fp).isFile()) {
          entries.push({ relPath: join('personalities', id, f), content: readFileSync(fp) });
        }
      }
    }
  }

  return entries;
}

// Minimal tar format (POSIX ustar) — no external deps
function buildTar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relPath.slice(0, 100).padEnd(100, '\0'));
    const header = Buffer.alloc(512, 0);
    nameBytes.copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100); // mode
    Buffer.from('0000000\0').copy(header, 108); // uid
    Buffer.from('0000000\0').copy(header, 116); // gid
    const sizeOctal = entry.content.length.toString(8).padStart(11, '0');
    Buffer.from(`${sizeOctal}\0`).copy(header, 124); // size
    Buffer.from(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
    ).copy(header, 136); // mtime
    header[156] = 0x30; // type '0' = regular file
    Buffer.from('ustar\0').copy(header, 257);
    Buffer.from('00').copy(header, 263);

    // checksum
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);

    blocks.push(header);

    const dataBlocks = Math.ceil(entry.content.length / 512);
    const padded = Buffer.alloc(dataBlocks * 512, 0);
    entry.content.copy(padded);
    blocks.push(padded);
  }

  // Two 512-byte zero blocks to mark end of archive
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

async function writeTarGz(entries: Entry[], outPath: string): Promise<void> {
  const tar = buildTar(entries);
  const gzip = createGzip();
  const out = createWriteStream(outPath);
  const { Readable } = await import('node:stream');
  const src = Readable.from([tar]);
  gzip.pipe(out);
  src.pipe(gzip);
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
}

async function readTarGz(srcPath: string): Promise<Array<[string, Buffer]>> {
  const { Writable } = await import('node:stream');
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const src = createReadStream(srcPath);
  const gunzip = createGunzip();
  await pipeline(src, gunzip, sink);
  const raw = Buffer.concat(chunks);
  return parseTar(raw);
}

function parseTar(buf: Buffer): Array<[string, Buffer]> {
  const results: Array<[string, Buffer]> = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    if (!name) break;

    const sizeStr = header.slice(124, 135).toString('utf8').trim().replace(/\0.*/, '');
    const size = Number.parseInt(sizeStr, 8);
    offset += 512;

    const content = buf.slice(offset, offset + size);
    results.push([name, content]);

    offset += Math.ceil(size / 512) * 512;
  }

  return results;
}

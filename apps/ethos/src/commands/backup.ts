// ethos backup / ethos import — snapshot and restore ~/.ethos/
//
// backup: tar.gz of config.yaml, keys.json, MEMORY.md, USER.md, personalities/
// import: extract and merge into ~/.ethos/

import { randomBytes } from 'node:crypto';
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
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { EthosError } from '@ethosagent/types';
import { ethosDir } from '../config';
import { writeJson } from '../json-output';
import { getSecretsResolver } from '../wiring';

const BACKUP_FILES = ['config.yaml', 'keys.json', 'MEMORY.md', 'USER.md'];

const _USAGE_BACKUP = 'Usage: ethos backup [output-path]';
const USAGE_IMPORT = 'Usage: ethos import <backup-path> [--secrets <manifest-file | ->]';

export async function runBackup(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const filtered = argv.filter((a) => a !== '--json');
  const outPath =
    filtered[0] ?? `ethos-backup-${timestamp()}-${randomBytes(4).toString('hex')}.tar.gz`;
  const dataDir = ethosDir();

  const entries = collectEntries(dataDir);
  if (entries.length === 0) {
    if (jsonMode) {
      writeJson({ ok: true, path: outPath, fileCount: 0 });
      return;
    }
    console.log('Nothing to backup — ~/.ethos/ is empty.');
    return;
  }

  await writeTarGz(entries, outPath);
  if (jsonMode) {
    writeJson({ ok: true, path: outPath, fileCount: entries.length });
    return;
  }
  console.log(`✓ Backup written to: ${outPath} (${entries.length} files)`);
}

export async function runImport(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const secretsIdx = argv.indexOf('--secrets');
  const secretsPath = secretsIdx >= 0 ? argv[secretsIdx + 1] : undefined;
  if (secretsIdx >= 0 && (!secretsPath || secretsPath.startsWith('--'))) {
    console.error('--secrets requires a manifest file path or "-" for stdin.');
    console.error(USAGE_IMPORT);
    process.exitCode = 1;
    return;
  }
  const filtered = argv.filter(
    (a, i) => a !== '--json' && a !== '--secrets' && !(i > 0 && argv[i - 1] === '--secrets'),
  );
  const srcPath = filtered[0];
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

  const resolvedBase = resolve(dataDir) + sep;
  const entries = await readTarGz(srcPath);
  for (const [relPath, content] of entries) {
    const dest = join(dataDir, relPath);
    const resolvedDest = resolve(dest);
    if (!resolvedDest.startsWith(resolvedBase)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Path traversal blocked: "${relPath}" escapes ${dataDir}`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }
    mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
    writeFileSync(dest, content);
  }

  if (secretsPath) {
    const count = await injectSecrets(secretsPath);
    if (!jsonMode) console.log(`✓ Injected ${count} secret(s)`);
  }

  if (jsonMode) {
    writeJson({ ok: true, importedFiles: entries.length });
    return;
  }
  console.log(`✓ Imported ${entries.length} files into ~/.ethos/`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export interface Entry {
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
export function buildTar(entries: Entry[]): Buffer {
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

export function parseTar(buf: Buffer): Array<[string, Buffer]> {
  const results: Array<[string, Buffer]> = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    if (!name) break;

    // Reject path traversal and absolute paths at parse time
    if (name.includes('..') || name.startsWith('/')) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Malicious tar entry rejected: "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    // Only allow regular files (type '0' or null byte)
    const typeFlag = header[156];
    if (typeFlag !== 0x30 && typeFlag !== 0x00) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Unsupported tar entry type ${typeFlag} for "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    const sizeStr = header.slice(124, 135).toString('utf8').trim().replace(/\0.*/, '');
    const size = Number.parseInt(sizeStr, 8);
    offset += 512;

    const content = buf.slice(offset, offset + size);
    results.push([name, content]);

    offset += Math.ceil(size / 512) * 512;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Secrets manifest — simple line-based format (not YAML)
//
// Format:
//   global:
//     KEY: value
//   personalities:
//     <id>:
//       KEY: value
//
// Values are trimmed. Matching quotes (single or double) are stripped.
// Lines starting with # are comments. Blank lines are ignored.
// ---------------------------------------------------------------------------

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

interface ParsedSecrets {
  global: Map<string, string>;
  personalities: Map<string, Map<string, string>>;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseSecretsManifest(raw: string): ParsedSecrets {
  const global = new Map<string, string>();
  const personalities = new Map<string, Map<string, string>>();

  let section: 'none' | 'global' | 'personalities' = 'none';
  let currentPersonality: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed.endsWith(':')) {
      const header = trimmed.slice(0, -1);
      if (header === 'global') {
        section = 'global';
        currentPersonality = undefined;
      } else if (header === 'personalities') {
        section = 'personalities';
        currentPersonality = undefined;
      }
      continue;
    }

    if (section === 'personalities' && indent === 2 && trimmed.endsWith(':')) {
      currentPersonality = trimmed.slice(0, -1);
      if (!personalities.has(currentPersonality)) {
        personalities.set(currentPersonality, new Map());
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = stripQuotes(trimmed.slice(colonIdx + 1).trim());

    if (section === 'global' && indent >= 2) {
      global.set(key, value);
    } else if (section === 'personalities' && indent >= 4 && currentPersonality) {
      const pMap = personalities.get(currentPersonality);
      if (pMap) pMap.set(key, value);
    }
  }

  return { global, personalities };
}

async function injectSecrets(secretsPath: string): Promise<number> {
  let raw: string;
  if (secretsPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    if (!existsSync(secretsPath)) {
      throw new EthosError({
        code: 'FILE_NOT_FOUND',
        cause: `Secrets manifest not found: ${secretsPath}`,
        action: 'Provide a valid path to a secrets manifest file.',
      });
    }
    raw = readFileSync(secretsPath, 'utf8');
  }

  const parsed = parseSecretsManifest(raw);
  const secrets = await getSecretsResolver();
  let count = 0;

  for (const [key, value] of parsed.global) {
    await secrets.set(key, value);
    count++;
  }

  if (parsed.personalities.size > 0) {
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    for (const [pid, kvs] of parsed.personalities) {
      const scoped = new PersonalityScopedSecrets(secrets, pid);
      for (const [key, value] of kvs) {
        await scoped.set(key, value);
        count++;
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Personality import (G5+G6) — ethos personality import <file> [--force] [--secrets <manifest>]
// ---------------------------------------------------------------------------

const USAGE_PERSONALITY_IMPORT =
  'Usage: ethos personality import <file-or-dir> [--force] [--secrets <manifest>]';

export async function runPersonalityImport(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const secretsIdx = argv.indexOf('--secrets');
  const secretsPath = secretsIdx >= 0 ? argv[secretsIdx + 1] : undefined;

  if (secretsIdx >= 0 && (!secretsPath || secretsPath.startsWith('--'))) {
    console.error('--secrets requires a manifest file path or "-" for stdin.');
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  const positional = argv.filter(
    (a, i) => a !== '--force' && a !== '--secrets' && !(i > 0 && argv[i - 1] === '--secrets'),
  );

  const srcPath = positional[0];
  if (!srcPath) {
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(srcPath)) {
    console.error(`File not found: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  let entries: Array<[string, Buffer]>;
  const srcStat = statSync(srcPath);
  if (srcStat.isDirectory()) {
    const dirName = basename(srcPath);
    entries = [];
    for (const f of readdirSync(srcPath)) {
      const fp = join(srcPath, f);
      if (statSync(fp).isFile()) {
        entries.push([`personalities/${dirName}/${f}`, readFileSync(fp)]);
      }
    }
  } else {
    entries = await readTarGz(srcPath);
  }

  if (entries.length === 0) {
    console.error('Archive is empty — nothing to import.');
    process.exitCode = 1;
    return;
  }

  const first = entries[0];
  if (!first) {
    console.error('Archive is empty — nothing to import.');
    process.exitCode = 1;
    return;
  }
  const segments = first[0].split('/');
  const personalitiesIdx = segments.indexOf('personalities');
  if (personalitiesIdx < 0 || !segments[personalitiesIdx + 1]) {
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause: 'Cannot determine personality ID — expected paths under personalities/<id>/',
      action: 'Ensure the archive contains files under a personalities/<id>/ directory.',
    });
  }
  const personalityId = segments[personalitiesIdx + 1];

  // Validate personality ID — reject traversal characters
  if (!VALID_ID_RE.test(personalityId)) {
    throw new EthosError({
      code: 'IMPORT_BLOCKED',
      cause: `Invalid personality ID "${personalityId}" — must be alphanumeric with hyphens/underscores.`,
      action: 'Ensure the archive paths use a valid personality ID.',
    });
  }

  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const dataDir = ethosDir();
  const storage = (await import('@ethosagent/storage-fs')).FsStorage
    ? new (await import('@ethosagent/storage-fs')).FsStorage()
    : undefined;
  const reg = await createPersonalityRegistry(storage);
  await reg.loadFromDirectory(join(dataDir, 'personalities'));
  const existing = reg.get(personalityId);

  if (existing && !force && process.env.ETHOS_MANAGED !== '1') {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const overwrite = await new Promise<boolean>((res) => {
      rl.question(`Personality "${personalityId}" already exists. Overwrite? [y/N] `, (answer) => {
        rl.close();
        res(answer.toLowerCase() === 'y');
      });
    });
    if (!overwrite) {
      console.log('Cancelled.');
      return;
    }
  }

  // Write files — restrict to personalities/<id>/ only
  const personalityBase = resolve(join(dataDir, 'personalities', personalityId)) + sep;
  for (const [relPath, content] of entries) {
    const dest = join(dataDir, relPath);
    const resolvedDest = resolve(dest);
    if (!resolvedDest.startsWith(personalityBase)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Entry "${relPath}" is outside personality "${personalityId}" — only files under personalities/${personalityId}/ are allowed.`,
        action: 'Check the archive contents — it may target the wrong personality or be malicious.',
      });
    }
    mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
    writeFileSync(dest, content);
  }

  if (secretsPath) {
    const count = await injectSecrets(secretsPath);
    console.log(`✓ Injected ${count} secret(s)`);
  }

  console.log(`✓ Imported personality "${personalityId}"`);
}

import { gunzipSync, gzipSync } from 'node:zlib';

// POSIX UStar tar format — 512-byte blocks.
const BLOCK = 512;
function encodeStr(s, buf, offset, maxLen) {
  const src = Buffer.from(s, 'utf8');
  src.copy(buf, offset, 0, Math.min(src.length, maxLen));
}
function encodeOctal(n, buf, offset, len) {
  // Right-pad with null, left-pad with zeros; leave room for trailing null.
  const s = `${n
    .toString(8)
    .padStart(len - 1, '0')
    .slice(0, len - 1)}\0`;
  Buffer.from(s).copy(buf, offset);
}
function buildHeader(name, size, mtimeMs) {
  const h = Buffer.alloc(BLOCK, 0);
  encodeStr(name, h, 0, 100); // filename
  encodeStr('0000644\0', h, 100, 8); // mode
  encodeStr('0000000\0', h, 108, 8); // uid
  encodeStr('0000000\0', h, 116, 8); // gid
  encodeOctal(size, h, 124, 12); // file size
  encodeOctal(Math.floor(mtimeMs / 1000), h, 136, 12); // mtime (seconds)
  Buffer.from('        ').copy(h, 148); // checksum placeholder (8 spaces)
  h[156] = 0x30; // type flag: '0' = regular file
  encodeStr('ustar\0', h, 257, 6); // UStar magic
  encodeStr('00', h, 263, 2); // UStar version
  encodeStr('ethos', h, 265, 32); // uname
  encodeStr('ethos', h, 297, 32); // gname
  // Checksum: sum of all 512 bytes treating bytes 148–155 as spaces.
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : (h[i] ?? 0);
  }
  // Write as 6-digit octal + null + space (POSIX convention).
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(h, 148);
  return h;
}
/**
 * Pack `files` into a gzipped POSIX UStar tarball.
 * Keys are file paths inside the archive; values are raw content buffers.
 */
export function createTarGz(files) {
  const parts = [];
  const mtime = Date.now();
  for (const [name, data] of files) {
    parts.push(buildHeader(name, data.length, mtime));
    parts.push(data);
    // Pad data to next 512-byte boundary.
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  // End-of-archive marker: two zero blocks.
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}
/** Maximum decompressed size to prevent decompression bombs (100 MB). */
const MAX_DECOMPRESSED_SIZE = 100 * 1024 * 1024;
/**
 * Decompress and unpack a gzipped tar archive.
 * Returns a map of filename → content buffer.
 * Throws if decompressed size exceeds 100 MB to prevent decompression bombs.
 */
export function readTarGz(gz) {
  const tar = gunzipSync(gz, { maxOutputLength: MAX_DECOMPRESSED_SIZE });
  const files = new Map();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks = end-of-archive.
    if (header.every((b) => b === 0)) break;
    offset += BLOCK;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*/, '').trim();
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*/, '').trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!name || Number.isNaN(size)) break;
    files.set(name, Buffer.from(tar.subarray(offset, offset + size)));
    // Advance past data blocks (padded to 512-byte boundary).
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

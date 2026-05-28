import { describe, expect, it } from 'vitest';
import { buildTar, parseTar } from '../backup';
/**
 * Construct a raw tar block with an arbitrary name and type flag.
 * This bypasses buildTar's safe defaults to simulate malicious archives.
 */
function craftTarEntry(name, content, typeFlag = 0x30) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(name.padEnd(100, '\0')).copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100); // mode
    Buffer.from('0000000\0').copy(header, 108); // uid
    Buffer.from('0000000\0').copy(header, 116); // gid
    const sizeOctal = content.length.toString(8).padStart(11, '0');
    Buffer.from(`${sizeOctal}\0`).copy(header, 124); // size
    Buffer.from('00000000000\0').copy(header, 136); // mtime
    header[156] = typeFlag;
    Buffer.from('ustar\0').copy(header, 257);
    Buffer.from('00').copy(header, 263);
    // checksum
    let sum = 0;
    for (let i = 0; i < 512; i++)
        sum += header[i] ?? 0;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
    const dataBlocks = Math.ceil(content.length / 512);
    const padded = Buffer.alloc(dataBlocks * 512, 0);
    content.copy(padded);
    const end = Buffer.alloc(1024, 0);
    return Buffer.concat([header, padded, end]);
}
describe('parseTar — Zip Slip defense', () => {
    it('rejects entry with ../ path traversal', () => {
        const tar = craftTarEntry('../etc/passwd', Buffer.from('malicious'));
        expect(() => parseTar(tar)).toThrow('Malicious tar entry rejected: "../etc/passwd"');
    });
    it('rejects entry with embedded ../ traversal', () => {
        const tar = craftTarEntry('personalities/../../../tmp/x', Buffer.from('malicious'));
        expect(() => parseTar(tar)).toThrow('Malicious tar entry rejected: "personalities/../../../tmp/x"');
    });
    it('rejects entry with absolute path', () => {
        const tar = craftTarEntry('/etc/shadow', Buffer.from('malicious'));
        expect(() => parseTar(tar)).toThrow('Malicious tar entry rejected: "/etc/shadow"');
    });
    it('rejects symlink entries (type flag 0x32)', () => {
        const tar = craftTarEntry('personalities/test/link', Buffer.from(''), 0x32);
        expect(() => parseTar(tar)).toThrow('Unsupported tar entry type 50 for "personalities/test/link"');
    });
    it('accepts a normal entry', () => {
        const content = Buffer.from('name: test\n');
        const tar = buildTar([{ relPath: 'personalities/test/config.yaml', content }]);
        const entries = parseTar(tar);
        expect(entries).toHaveLength(1);
        expect(entries[0][0]).toBe('personalities/test/config.yaml');
        expect(entries[0][1].toString()).toBe('name: test\n');
    });
});

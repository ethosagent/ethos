import { describe, expect, it } from 'vitest';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const SKIP_EXTS = new Set(['exe', 'dll', 'so', 'dylib']);
function classifyAttachment(name, size) {
    if (size > MAX_FILE_SIZE)
        return { skip: true };
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (SKIP_EXTS.has(ext))
        return { skip: true };
    const type = IMAGE_EXTS.has(ext) ? 'image' : 'file';
    return { type, skip: false };
}
describe('file attachments', () => {
    it('classifies .png as image', () => {
        const result = classifyAttachment('photo.png', 1024);
        expect(result).toEqual({ type: 'image', skip: false });
    });
    it('classifies .jpg as image', () => {
        const result = classifyAttachment('pic.jpg', 2048);
        expect(result).toEqual({ type: 'image', skip: false });
    });
    it('classifies .pdf as file', () => {
        const result = classifyAttachment('doc.pdf', 5000);
        expect(result).toEqual({ type: 'file', skip: false });
    });
    it('skips .exe files', () => {
        const result = classifyAttachment('malware.exe', 1024);
        expect(result).toEqual({ skip: true });
    });
    it('skips files over 25MB', () => {
        const result = classifyAttachment('huge.png', MAX_FILE_SIZE + 1);
        expect(result).toEqual({ skip: true });
    });
    it('allows files at exactly 25MB', () => {
        const result = classifyAttachment('exact.png', MAX_FILE_SIZE);
        expect(result).toEqual({ type: 'image', skip: false });
    });
    it('handles files without extension', () => {
        const result = classifyAttachment('noext', 1024);
        expect(result).toEqual({ type: 'file', skip: false });
    });
});

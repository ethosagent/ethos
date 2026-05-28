import { describe, expect, it } from 'vitest';
import { buildAttachmentAnnotation } from '../attachment-annotation';
describe('buildAttachmentAnnotation', () => {
    it('produces XML annotation with ref, mime, size, filename', () => {
        const atts = [
            {
                type: 'image',
                ref: 'att-0',
                url: 'file:///cache/photo.jpg',
                mimeType: 'image/jpeg',
                filename: 'receipt.jpg',
                sizeBytes: 319488,
            },
        ];
        const result = buildAttachmentAnnotation(atts);
        expect(result).toContain('<attachments>');
        expect(result).toContain('ref="att-0"');
        expect(result).toContain('mime="image/jpeg"');
        expect(result).toContain('filename="receipt.jpg"');
        expect(result).toContain('</attachments>');
    });
    it('returns empty string for no attachments', () => {
        expect(buildAttachmentAnnotation([])).toBe('');
    });
    it('formats size as human-readable KB', () => {
        const atts = [
            { type: 'file', ref: 'att-0', url: 'file:///x', mimeType: 'text/plain', sizeBytes: 2048 },
        ];
        expect(buildAttachmentAnnotation(atts)).toContain('size="2KB"');
    });
    it('formats size as human-readable MB', () => {
        const atts = [
            {
                type: 'file',
                ref: 'att-0',
                url: 'file:///x',
                mimeType: 'application/pdf',
                sizeBytes: 1258291,
            },
        ];
        expect(buildAttachmentAnnotation(atts)).toContain('size="1.2MB"');
    });
    it('omits size when sizeBytes is undefined', () => {
        const atts = [
            { type: 'image', ref: 'att-0', url: 'file:///x', mimeType: 'image/png' },
        ];
        const result = buildAttachmentAnnotation(atts);
        expect(result).not.toContain('size=');
    });
});

import type { Attachment } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { classifyAttachment, unsupportedTypeError } from '../attachment-classifier';

function att(mimeType: string, filename?: string): Attachment {
  return { type: 'file', ref: 'test', url: 'file:///test', mimeType, filename };
}

describe('classifyAttachment', () => {
  it('classifies images as native', () => {
    expect(classifyAttachment(att('image/png', 'photo.png'))).toBe('native');
    expect(classifyAttachment(att('image/jpeg', 'photo.jpg'))).toBe('native');
    expect(classifyAttachment(att('image/gif', 'anim.gif'))).toBe('native');
    expect(classifyAttachment(att('image/webp', 'photo.webp'))).toBe('native');
  });

  it('classifies PDF as native', () => {
    expect(classifyAttachment(att('application/pdf', 'doc.pdf'))).toBe('native');
  });

  it('classifies text/* as text', () => {
    expect(classifyAttachment(att('text/plain', 'readme.txt'))).toBe('text');
    expect(classifyAttachment(att('text/html', 'page.html'))).toBe('text');
    expect(classifyAttachment(att('text/csv', 'data.csv'))).toBe('text');
    expect(classifyAttachment(att('text/markdown', 'doc.md'))).toBe('text');
  });

  it('classifies code files by extension', () => {
    expect(classifyAttachment(att('application/octet-stream', 'app.ts'))).toBe('text');
    expect(classifyAttachment(att('application/octet-stream', 'main.py'))).toBe('text');
    expect(classifyAttachment(att('application/octet-stream', 'main.go'))).toBe('text');
    expect(classifyAttachment(att('application/octet-stream', 'lib.rs'))).toBe('text');
  });

  it('classifies JSON and YAML by MIME', () => {
    expect(classifyAttachment(att('application/json', 'config.json'))).toBe('text');
    expect(classifyAttachment(att('application/x-yaml', 'config.yaml'))).toBe('text');
  });

  it('classifies office docs as extract', () => {
    expect(
      classifyAttachment(
        att('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'),
      ),
    ).toBe('extract');
    expect(
      classifyAttachment(
        att(
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'deck.pptx',
        ),
      ),
    ).toBe('extract');
    expect(
      classifyAttachment(
        att('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data.xlsx'),
      ),
    ).toBe('extract');
  });

  it('classifies ipynb as extract', () => {
    expect(classifyAttachment(att('application/octet-stream', 'notebook.ipynb'))).toBe('extract');
  });

  it('classifies unknown binaries as unsupported', () => {
    expect(classifyAttachment(att('application/zip', 'archive.zip'))).toBe('unsupported');
    expect(classifyAttachment(att('application/octet-stream', 'program.exe'))).toBe('unsupported');
    expect(classifyAttachment(att('video/mp4', 'video.mp4'))).toBe('unsupported');
  });
});

describe('unsupportedTypeError', () => {
  it('includes filename and MIME', () => {
    const err = unsupportedTypeError('application/zip', 'archive.zip');
    expect(err).toContain('archive.zip');
    expect(err).toContain('application/zip');
    expect(err).toContain('supported:');
  });

  it('works without filename', () => {
    const err = unsupportedTypeError('application/zip');
    expect(err).toContain('application/zip');
  });
});

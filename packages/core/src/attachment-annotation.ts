import type { Attachment } from '@ethosagent/types';

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function buildAttachmentAnnotation(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map((a) => {
    const parts = [`ref="${a.ref}"`, `mime="${a.mimeType}"`];
    if (a.sizeBytes !== undefined) parts.push(`size="${formatSize(a.sizeBytes)}"`);
    if (a.filename) parts.push(`filename="${a.filename}"`);
    return `  <file ${parts.join(' ')} />`;
  });
  return `<attachments>\n${lines.join('\n')}\n</attachments>`;
}

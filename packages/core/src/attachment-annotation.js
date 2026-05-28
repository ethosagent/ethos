function formatSize(bytes) {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function escapeXmlAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
export function buildAttachmentAnnotation(attachments) {
  if (attachments.length === 0) return '';
  const lines = attachments.map((a) => {
    const parts = [`ref="${escapeXmlAttr(a.ref)}"`, `mime="${escapeXmlAttr(a.mimeType)}"`];
    if (a.sizeBytes !== undefined) parts.push(`size="${formatSize(a.sizeBytes)}"`);
    if (a.filename) parts.push(`filename="${escapeXmlAttr(a.filename)}"`);
    return `  <file ${parts.join(' ')} />`;
  });
  return `<attachments>\n${lines.join('\n')}\n</attachments>`;
}

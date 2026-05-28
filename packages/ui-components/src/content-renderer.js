import { jsx as _jsx } from 'react/jsx-runtime';
import { HtmlRenderer } from './html-renderer';
import { MarkdownRenderer } from './markdown-renderer';

const CLOSE_TAG_RE = /<\/\w+>/;
function detectFormat(content) {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<') && CLOSE_TAG_RE.test(trimmed)) return 'html';
  return 'markdown';
}
export function ContentRenderer({ content, format = 'auto', className }) {
  const resolved = format === 'auto' ? detectFormat(content) : format;
  if (resolved === 'html') return _jsx(HtmlRenderer, { content: content, className: className });
  return _jsx(MarkdownRenderer, { content: content, className: className });
}

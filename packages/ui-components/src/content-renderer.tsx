import { HtmlRenderer } from './html-renderer';
import { MarkdownRenderer } from './markdown-renderer';

export interface ContentRendererProps {
  content: string;
  format?: 'markdown' | 'html' | 'auto';
  className?: string;
}

const CLOSE_TAG_RE = /<\/\w+>/;

function detectFormat(content: string): 'markdown' | 'html' {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<') && CLOSE_TAG_RE.test(trimmed)) return 'html';
  return 'markdown';
}

export function ContentRenderer({ content, format = 'auto', className }: ContentRendererProps) {
  const resolved = format === 'auto' ? detectFormat(content) : format;
  if (resolved === 'html') return <HtmlRenderer content={content} className={className} />;
  return <MarkdownRenderer content={content} className={className} />;
}

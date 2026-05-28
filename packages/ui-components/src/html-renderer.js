import DOMPurify from 'dompurify';
import { jsx as _jsx } from 'react/jsx-runtime';

function cn(...classes) {
  return classes.filter(Boolean).join(' ');
}
export function HtmlRenderer({ content, className }) {
  const clean = DOMPurify.sanitize(content, { USE_PROFILES: { html: true } });
  return _jsx('div', {
    className: cn('ethos-html text-sm', className),
    // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized
    dangerouslySetInnerHTML: { __html: clean },
  });
}

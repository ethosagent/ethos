import DOMPurify from 'dompurify';

function cn(...classes: (string | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function HtmlRenderer({ content, className }: { content: string; className?: string }) {
  const clean = DOMPurify.sanitize(content, { USE_PROFILES: { html: true } });
  return (
    <div
      className={cn('ethos-html text-sm', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

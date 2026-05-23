import type { ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function cn(...classes: (string | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

const OVERRIDES = {
  p: ({ children, ...props }: ComponentPropsWithoutRef<'p'>) => (
    <p className="my-2 text-sm leading-relaxed text-foreground" {...props}>
      {children}
    </p>
  ),
  strong: ({ children, ...props }: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  h1: ({ children, ...props }: ComponentPropsWithoutRef<'h1'>) => (
    <h1 className="mt-4 mb-2 text-lg font-bold text-foreground" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentPropsWithoutRef<'h2'>) => (
    <h2 className="mt-4 mb-2 text-base font-semibold text-foreground" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentPropsWithoutRef<'h3'>) => (
    <h3 className="mt-3 mb-1 text-sm font-semibold text-foreground" {...props}>
      {children}
    </h3>
  ),
  ul: ({ children, ...props }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="my-2 list-disc pl-6 space-y-1 text-sm" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="my-2 list-decimal pl-6 space-y-1 text-sm" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: ComponentPropsWithoutRef<'li'>) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote
      className="my-2 border-l-2 border-brand pl-4 italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props: ComponentPropsWithoutRef<'hr'>) => <hr className="my-4 border-border" {...props} />,
  a: ({ children, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a
      className="text-brand underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  code: ({ children, className: codeClassName, ...props }: ComponentPropsWithoutRef<'code'>) => {
    if (codeClassName) {
      return (
        <pre className="my-2 overflow-x-auto rounded border border-border bg-muted p-3 text-sm">
          <code className={cn('font-mono', codeClassName)} {...props}>
            {children}
          </code>
        </pre>
      );
    }
    return (
      <code
        className="rounded border border-border/60 bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.8125rem] text-brand"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => {
    return <>{children}</>;
  },
  table: ({ children, ...props }: ComponentPropsWithoutRef<'table'>) => (
    <table className="my-2 w-full border-collapse text-sm" {...props}>
      {children}
    </table>
  ),
  th: ({ children, ...props }: ComponentPropsWithoutRef<'th'>) => (
    <th
      className="border border-border bg-card/80 px-3 py-2 text-left text-[0.625rem] font-semibold tracking-wider uppercase text-muted-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<'td'>) => (
    <td className="border border-border px-3 py-1.5" {...props}>
      {children}
    </td>
  ),
};

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div
      className={cn(
        'text-sm leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={OVERRIDES}>
        {content}
      </Markdown>
    </div>
  );
}

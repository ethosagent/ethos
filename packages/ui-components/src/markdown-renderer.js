import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
function cn(...classes) {
    return classes.filter(Boolean).join(' ');
}
const OVERRIDES = {
    p: ({ children, ...props }) => (_jsx("p", { className: "my-2 text-sm leading-relaxed text-foreground", ...props, children: children })),
    strong: ({ children, ...props }) => (_jsx("strong", { className: "font-semibold text-foreground", ...props, children: children })),
    h1: ({ children, ...props }) => (_jsx("h1", { className: "mt-4 mb-2 text-lg font-bold text-foreground", ...props, children: children })),
    h2: ({ children, ...props }) => (_jsx("h2", { className: "mt-4 mb-2 text-base font-semibold text-foreground", ...props, children: children })),
    h3: ({ children, ...props }) => (_jsx("h3", { className: "mt-3 mb-1 text-sm font-semibold text-foreground", ...props, children: children })),
    ul: ({ children, ...props }) => (_jsx("ul", { className: "my-2 list-disc pl-6 space-y-1 text-sm", ...props, children: children })),
    ol: ({ children, ...props }) => (_jsx("ol", { className: "my-2 list-decimal pl-6 space-y-1 text-sm", ...props, children: children })),
    li: ({ children, ...props }) => (_jsx("li", { className: "leading-relaxed", ...props, children: children })),
    blockquote: ({ children, ...props }) => (_jsx("blockquote", { className: "my-2 border-l-2 border-brand pl-4 italic text-muted-foreground", ...props, children: children })),
    hr: (props) => _jsx("hr", { className: "my-4 border-border", ...props }),
    a: ({ children, ...props }) => (_jsx("a", { className: "text-brand underline underline-offset-2", target: "_blank", rel: "noopener noreferrer", ...props, children: children })),
    code: ({ children, className: codeClassName, ...props }) => {
        if (codeClassName) {
            return (_jsx("pre", { className: "my-2 overflow-x-auto rounded border border-border bg-muted p-3 text-sm", children: _jsx("code", { className: cn('font-mono', codeClassName), ...props, children: children }) }));
        }
        return (_jsx("code", { className: "rounded border border-border/60 bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.8125rem] text-brand", ...props, children: children }));
    },
    pre: ({ children }) => {
        return _jsx(_Fragment, { children: children });
    },
    table: ({ children, ...props }) => (_jsx("table", { className: "my-2 w-full border-collapse text-sm", ...props, children: children })),
    th: ({ children, ...props }) => (_jsx("th", { className: "border border-border bg-card/80 px-3 py-2 text-left text-[0.625rem] font-semibold tracking-wider uppercase text-muted-foreground", ...props, children: children })),
    td: ({ children, ...props }) => (_jsx("td", { className: "border border-border px-3 py-1.5", ...props, children: children })),
};
export function MarkdownRenderer({ content, className }) {
    return (_jsx("div", { className: cn('text-sm leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className), children: _jsx(Markdown, { remarkPlugins: [remarkGfm], components: OVERRIDES, children: content }) }));
}

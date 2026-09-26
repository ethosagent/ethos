import { useDoc } from '@docusaurus/plugin-content-docs/client';
import type { WrapperProps } from '@docusaurus/types';
import type DocBreadcrumbsType from '@theme/DocBreadcrumbs';
import DocBreadcrumbs from '@theme-original/DocBreadcrumbs';
import type { ReactNode } from 'react';

type Props = WrapperProps<typeof DocBreadcrumbsType>;

// Option C (mockup ethos-docs-c-classic.html): a page-kind badge — the docs
// skill's front-matter `kind` (tutorial / how-to / reference / explanation /
// decision) — rendered beside the breadcrumbs. Every content page declares
// `kind` (enforced by `pnpm docs:check`); pages without one just get the
// plain breadcrumbs. Styles: .ethos-breadcrumbs-row / .ethos-kind-badge in
// src/css/custom.css.
function pageKind(frontMatter: unknown): string | null {
  if (
    frontMatter !== null &&
    typeof frontMatter === 'object' &&
    'kind' in frontMatter &&
    typeof frontMatter.kind === 'string' &&
    frontMatter.kind.length > 0
  ) {
    return frontMatter.kind;
  }
  return null;
}

export default function DocBreadcrumbsWrapper(props: Props): ReactNode {
  const { frontMatter } = useDoc();
  const kind = pageKind(frontMatter);
  if (kind === null) {
    return <DocBreadcrumbs {...props} />;
  }
  return (
    <div className="ethos-breadcrumbs-row">
      <DocBreadcrumbs {...props} />
      <span className="ethos-kind-badge">{kind}</span>
    </div>
  );
}

// A skill candidate (`personalities.skillCandidatesList`) arrives as a file
// name and raw Markdown. Its card shows the same name and description an
// installed skill does, read from the YAML front matter when present.

export interface CandidateView {
  name: string;
  description: string | null;
  /** The body below the front matter — what Review shows. */
  body: string;
}

function field(frontMatter: string, key: string): string | null {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontMatter);
  const value = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  return value ? value : null;
}

export function candidateView(fileName: string, content: string): CandidateView {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  const front = fm?.[1] ?? '';
  const body = fm ? content.slice(fm[0].length) : content;
  return {
    name: field(front, 'name') ?? fileName.replace(/\.md$/, ''),
    description: field(front, 'description'),
    body: body.trim(),
  };
}

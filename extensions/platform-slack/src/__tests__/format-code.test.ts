// UBP-051 — Slack's mrkdwn converter ran its header and bold rewrites inside
// code: `a**2 + b**2` became `a*2 + b*2` and a `# comment` line in a fence
// became bold. Code is now extracted before the rewrites and restored after,
// still entity-escaped (CHS-004 applies to every byte Slack parses).

import { describe, expect, it } from 'vitest';
import { toNativeMarkdown } from '../format';

const CODE = '# comment\nif __name__ == "__main__":\n    x = a**2 + b**2  # [x](y)\n';

describe('Slack toNativeMarkdown code protection', () => {
  it('keeps a fenced block byte for byte', () => {
    const fence = `\`\`\`python\n${CODE}\`\`\``;
    expect(toNativeMarkdown(`Here:\n${fence}\n## Next`)).toBe(`Here:\n${fence}\n*Next*`);
  });

  it('keeps inline code byte for byte', () => {
    for (const code of ['__init__', 'a**2 + b**2', '[x](y)', '# not a header']) {
      expect(toNativeMarkdown(`run \`${code}\` and **go**`)).toBe(`run \`${code}\` and *go*`);
    }
  });

  it('still escapes control characters inside code', () => {
    expect(toNativeMarkdown('```\n<!channel> & <@U1>\n```')).toBe(
      '```\n&lt;!channel&gt; &amp; &lt;@U1&gt;\n```',
    );
    expect(toNativeMarkdown('`Map<K, V>`')).toBe('`Map&lt;K, V&gt;`');
  });
});

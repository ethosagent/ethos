// node scripts/size-metrics.mjs <repoRoot>   (read-only; Node 24)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => /^(apps|packages|extensions)\//.test(f))
  .filter((f) => !/(__tests__|\.test\.|\.spec\.|\/e2e\/|fixtures\/|\.d\.ts$)/.test(f));
const UI = /^apps\/(web|desktop|tui|vscode-extension)\//;
let physical = 0,
  code = 0,
  codeExcludingUi = 0,
  comment = 0,
  blank = 0,
  chars = 0,
  commentChars = 0;
const sizes = [],
  symbolTokens = [];
for (const f of files) {
  const text = readFileSync(join(root, f), 'utf8');
  const lines = text.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    physical++;
    if (inBlock) {
      comment++;
      commentChars += l.length;
      if (l.includes('*/')) inBlock = false;
      continue;
    }
    if (l === '') {
      blank++;
      continue;
    }
    if (l.startsWith('//')) {
      comment++;
      commentChars += l.length;
      continue;
    }
    if (l.startsWith('/*')) {
      comment++;
      commentChars += l.length;
      if (!l.includes('*/')) inBlock = true;
      continue;
    }
    code++;
    chars += l.length;
    if (!UI.test(f)) codeExcludingUi++;
  }
  const tokens = Math.round(text.length / 4);
  sizes.push({ f, lines: lines.length, tokens });
  const n = (
    text.match(
      /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+[A-Za-z_$]/gm,
    ) ?? []
  ).length;
  for (let i = 0; i < n; i++) symbolTokens.push(tokens);
}
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
console.log(
  JSON.stringify(
    {
      files: files.length,
      physical,
      code,
      codeExcludingUi,
      comment,
      blank,
      commentCharShare: +(commentChars / (commentChars + chars)).toFixed(3),
      filesOver1000Lines: sizes.filter((s) => s.lines > 1000).length,
      filesOver2000Lines: sizes.filter((s) => s.lines > 2000).length,
      filesOver5000Lines: sizes.filter((s) => s.lines > 5000).length,
      filesOver25kTokens: sizes.filter((s) => s.tokens > 25000).length,
      filesOver50kTokens: sizes.filter((s) => s.tokens > 50000).length,
      symbols: symbolTokens.length,
      symbolsInFilesOver25kTokens: symbolTokens.filter((t) => t > 25000).length,
      medianDefiningFileTokens: q(symbolTokens, 0.5),
      p90DefiningFileTokens: q(symbolTokens, 0.9),
      meanDefiningFileTokens: Math.round(
        symbolTokens.reduce((a, b) => a + b, 0) / symbolTokens.length,
      ),
    },
    null,
    1,
  ),
);

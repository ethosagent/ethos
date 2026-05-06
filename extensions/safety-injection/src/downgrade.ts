// Default dangerous-tool list used by Ch.3d post-read downgrade.
//
// When `safety.injectionDefense.postReadDowngrade.tools` is `'auto'` (the
// default), AgentLoop blocks calls to these tools for `turns` iterations
// after an `outputIsUntrusted` result. The user clears the downgrade by
// sending a fresh message — the per-run counter resets when AgentLoop.run()
// is called again.

const DEFAULT_DOWNGRADED_TOOLS: ReadonlyArray<string> = [
  'terminal',
  'run_code',
  'run_tests',
  'write_file',
  'patch_file',
  'web_extract',
  'browse_url',
  'browser_click',
  'browser_type',
  'process_start',
  'process_stop',
];

export function resolveDowngradedTools(spec: 'auto' | string[] | undefined): Set<string> {
  if (spec === undefined || spec === 'auto') return new Set(DEFAULT_DOWNGRADED_TOOLS);
  return new Set(spec);
}

export const DOWNGRADE_REJECTION_MESSAGE =
  'Tool blocked: an `outputIsUntrusted` tool just read external content. Dangerous tools are paused for the next turn or two. Send a new user message to clear, or re-run after acknowledging the prior content.';

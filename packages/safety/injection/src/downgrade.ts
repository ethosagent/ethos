// Default dangerous-tool list used by Ch.3d post-read downgrade.
//
// When `safety.injectionDefense.postReadDowngrade.tools` is `'auto'` (the
// default), AgentLoop blocks calls to these tools for `turns` iterations
// after an `outputIsUntrusted` result. The window expires on its own after
// those iterations; the per-run counter also resets when AgentLoop.run() is
// called again (a fresh user message).

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

// The rule this message states is enforced in
// packages/core/src/agent-loop/stages/tool-processing.ts (the `dgRemaining`
// check that refuses the call, and the decrement-then-rearm at the end of each
// iteration): the pause lifts by itself after the configured number of model
// steps (`postReadDowngrade.turns`, default 2) with no further untrusted read.
// A goal attempt never receives a user message, so the text must not tell the
// model to wait for one.
export const DOWNGRADE_REJECTION_MESSAGE =
  'Tool blocked: an `outputIsUntrusted` tool just read external content, so this tool is paused for the next few model steps (2 by default). The pause lifts on its own once those steps pass without another untrusted read; reading more untrusted content restarts it. Continue with tools that are not paused, then retry this call.';

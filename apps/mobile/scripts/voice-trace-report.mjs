#!/usr/bin/env node
// Grade a phone voice call trace against PHONE_VOICE_BAR.
//
//   node apps/mobile/scripts/voice-trace-report.mjs <trace.jsonl> [--tier=realtime|pipeline]
//
// The trace is the JSONL a dev build writes from `createCallTrace().toJsonl()`
// (@ethosagent/voice-client). The analyser is TypeScript source, so it is
// loaded through tsx's ESM API — the same runner the repo's other scripts use.
// Exit code: 0 PASS, 1 FAIL, 2 usage error.

import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
const tierArg = args.find((arg) => arg.startsWith('--tier='))?.slice('--tier='.length);
if (!file || (tierArg && tierArg !== 'realtime' && tierArg !== 'pipeline')) {
  console.error('usage: voice-trace-report.mjs <trace.jsonl> [--tier=realtime|pipeline]');
  process.exit(2);
}

const { analyzeTrace, formatTraceReport } = await tsImport(
  '../../../packages/voice-client/src/trace/analyze.ts',
  import.meta.url,
);
const report = analyzeTrace(readFileSync(file, 'utf8'), tierArg ? { tier: tierArg } : {});
console.log(formatTraceReport(report));
process.exit(report.pass ? 0 : 1);

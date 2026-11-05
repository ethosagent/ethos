import type { CatalogEntry } from '@ethosagent/types';
import { asana } from './mcp/asana';
import { awsKnowledge } from './mcp/aws-knowledge';
import { context7 } from './mcp/context7';
import { deepwiki } from './mcp/deepwiki';
import { fetch } from './mcp/fetch';
import { filesystem } from './mcp/filesystem';
import { git } from './mcp/git';
import { googleCalendar } from './mcp/google-calendar';
import { granola } from './mcp/granola';
import { linear } from './mcp/linear';
import { memory } from './mcp/memory';
import { microsoftLearn } from './mcp/microsoft-learn';
import { notion } from './mcp/notion';
import { sentry } from './mcp/sentry';
import { vercel } from './mcp/vercel';
import { wolfram } from './mcp/wolfram';

// Hand-kept: add a new entry file AND its line here. The match between this list
// and the files under ./<kind>/ is pinned by __tests__/index.test.ts.
export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  filesystem,
  git,
  fetch,
  googleCalendar,
  memory,
  deepwiki,
  context7,
  awsKnowledge,
  microsoftLearn,
  wolfram,
  sentry,
  vercel,
  linear,
  notion,
  granola,
  asana,
];

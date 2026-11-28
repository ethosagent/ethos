import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_FOR_WATCHLIST = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../templates/watchlist.schema.yaml'),
  'utf8',
);

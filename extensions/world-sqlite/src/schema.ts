import { z } from 'zod';

// DDL for `<dataDir>/worlds/graph.db` (plan world-model Task 1.2). Every table
// is STRICT; the FTS5 virtual table (added in Task 1.4) is the one exception,
// as in session-sqlite. The R3 triggers are pinned by
// __tests__/graph-store.test.ts ('R3 facts are closed, never deleted').

const AUTHORS = `('user','import','connector','agent')`;

export const SCHEMA_VERSION = 1;

export const DDL = `
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, world TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL, retired_at TEXT, merged_into TEXT,
  source_ref TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ${AUTHORS}),
  retired_by TEXT CHECK (retired_by IS NULL OR retired_by IN ${AUTHORS}), retired_source_ref TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_entities_world_type ON entities(world, type);

CREATE TABLE IF NOT EXISTS attributes (
  id TEXT PRIMARY KEY, world TEXT NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id),
  key TEXT NOT NULL, value_json TEXT NOT NULL,
  valid_from TEXT, valid_to TEXT, recorded_at TEXT NOT NULL, retired_at TEXT,
  source_ref TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ${AUTHORS}),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ${AUTHORS}), closed_source_ref TEXT,
  retired_by TEXT CHECK (retired_by IS NULL OR retired_by IN ${AUTHORS}), retired_source_ref TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attrs_entity ON attributes(world, entity_id, key);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY, world TEXT NOT NULL, type TEXT NOT NULL,
  from_id TEXT NOT NULL REFERENCES entities(id), to_id TEXT NOT NULL REFERENCES entities(id),
  attrs_json TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT, valid_to TEXT,            -- world clock; NULL valid_from = unknown start, NULL valid_to = still true
  recorded_at TEXT NOT NULL, retired_at TEXT, -- Ethos clock
  source_ref TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ${AUTHORS}),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  closed_by TEXT CHECK (closed_by IS NULL OR closed_by IN ${AUTHORS}), closed_source_ref TEXT,
  retired_by TEXT CHECK (retired_by IS NULL OR retired_by IN ${AUTHORS}), retired_source_ref TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(world, from_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(world, to_id, type);
CREATE INDEX IF NOT EXISTS idx_edges_recorded ON edges(world, recorded_at);

CREATE TABLE IF NOT EXISTS schemas (
  world TEXT PRIMARY KEY, version INTEGER NOT NULL, schema_json TEXT NOT NULL, applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS purge_tokens (       -- the only way past the delete triggers
  world TEXT NOT NULL, entity_id TEXT, reason TEXT NOT NULL, at TEXT NOT NULL
) STRICT;

-- R3: facts are immutable except for closing and retiring once. The closer and
-- retirer columns are set only in the UPDATE that first sets valid_to / retired_at
-- (NULL to value, once); a fact closed without them (an import) never gains them.
-- (id and world are pinned too; the plan's DDL left them rewritable.)
CREATE TRIGGER IF NOT EXISTS edges_no_rewrite BEFORE UPDATE ON edges
WHEN NEW.id IS NOT OLD.id OR NEW.world IS NOT OLD.world
  OR NEW.type IS NOT OLD.type OR NEW.from_id IS NOT OLD.from_id OR NEW.to_id IS NOT OLD.to_id
  OR NEW.attrs_json IS NOT OLD.attrs_json OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.source_ref IS NOT OLD.source_ref
  OR NEW.author IS NOT OLD.author OR NEW.confidence IS NOT OLD.confidence
  OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS NOT OLD.valid_to)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR ((NEW.closed_by IS NOT OLD.closed_by OR NEW.closed_source_ref IS NOT OLD.closed_source_ref)
      AND NOT (OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL))
  OR ((NEW.retired_by IS NOT OLD.retired_by OR NEW.retired_source_ref IS NOT OLD.retired_source_ref)
      AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'facts are closed, never rewritten'); END;
CREATE TRIGGER IF NOT EXISTS edges_no_delete BEFORE DELETE ON edges
WHEN NOT EXISTS (SELECT 1 FROM purge_tokens p WHERE p.world = OLD.world
  AND (p.entity_id IS NULL OR p.entity_id IN (OLD.from_id, OLD.to_id)))
BEGIN SELECT RAISE(ABORT, 'facts are closed, never deleted'); END;

CREATE TRIGGER IF NOT EXISTS attributes_no_rewrite BEFORE UPDATE ON attributes
WHEN NEW.id IS NOT OLD.id OR NEW.world IS NOT OLD.world
  OR NEW.entity_id IS NOT OLD.entity_id OR NEW.key IS NOT OLD.key
  OR NEW.value_json IS NOT OLD.value_json OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.source_ref IS NOT OLD.source_ref
  OR NEW.author IS NOT OLD.author OR NEW.confidence IS NOT OLD.confidence
  OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS NOT OLD.valid_to)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR ((NEW.closed_by IS NOT OLD.closed_by OR NEW.closed_source_ref IS NOT OLD.closed_source_ref)
      AND NOT (OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL))
  OR ((NEW.retired_by IS NOT OLD.retired_by OR NEW.retired_source_ref IS NOT OLD.retired_source_ref)
      AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'facts are closed, never rewritten'); END;
CREATE TRIGGER IF NOT EXISTS attributes_no_delete BEFORE DELETE ON attributes
WHEN NOT EXISTS (SELECT 1 FROM purge_tokens p WHERE p.world = OLD.world
  AND (p.entity_id IS NULL OR p.entity_id = OLD.entity_id))
BEGIN SELECT RAISE(ABORT, 'facts are closed, never deleted'); END;

-- Entities: only aliases (append), merged_into and retired_at (once) may change;
-- retired_by / retired_source_ref only in the UPDATE that first sets retired_at.
CREATE TRIGGER IF NOT EXISTS entities_no_rewrite BEFORE UPDATE ON entities
WHEN NEW.id IS NOT OLD.id OR NEW.world IS NOT OLD.world
  OR NEW.type IS NOT OLD.type OR NEW.name IS NOT OLD.name
  OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.source_ref IS NOT OLD.source_ref
  OR NEW.author IS NOT OLD.author
  OR (OLD.merged_into IS NOT NULL AND NEW.merged_into IS NOT OLD.merged_into)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR ((NEW.retired_by IS NOT OLD.retired_by OR NEW.retired_source_ref IS NOT OLD.retired_source_ref)
      AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL))
  OR NEW.aliases IS NOT OLD.aliases AND (
    length(NEW.aliases) < length(OLD.aliases)
    OR substr(NEW.aliases, 1, length(OLD.aliases) - 1) IS NOT substr(OLD.aliases, 1, length(OLD.aliases) - 1)
    OR NOT json_valid(NEW.aliases))
BEGIN SELECT RAISE(ABORT, 'entities are never rewritten'); END;
CREATE TRIGGER IF NOT EXISTS entities_no_delete BEFORE DELETE ON entities
WHEN NOT EXISTS (SELECT 1 FROM purge_tokens p WHERE p.world = OLD.world
  AND (p.entity_id IS NULL OR p.entity_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'entities are retired, never deleted'); END;
`;

// A stored schema is parsed, never cast (CLAUDE.md: Zod safeParse).
const attrSpec = z.object({
  type: z.enum(['string', 'int', 'number', 'bool', 'date', 'url']),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.string()).optional(),
});

export const worldSchemaZ = z.object({
  version: z.number().int().min(1),
  entities: z.record(z.string(), z.object({ attrs: z.record(z.string(), attrSpec) })),
  edges: z.record(
    z.string(),
    z.object({
      from: z.array(z.string()),
      to: z.array(z.string()),
      attrs: z.record(z.string(), attrSpec),
      unique: z.enum(['from', 'to']).optional(),
    }),
  ),
});

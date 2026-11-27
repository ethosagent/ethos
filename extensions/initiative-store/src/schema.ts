// Initiative ledger DDL (plan initiative-engine Task 1.2). Every table is
// STRICT; ordered reads tie-break on rowid (never in SELECT *). Timestamps are
// ISO-8601 UTC strings, so `substr(started, 1, 10)` is the UTC day.

export const INITIATIVE_STORE_SCHEMA_VERSION = 1;

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS initiatives (
    id TEXT PRIMARY KEY, personality_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human','agent')), parent_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('active','self_started','paused','review','ended','stopped')),
    config_path TEXT NOT NULL, config_hash TEXT NOT NULL, version INTEGER NOT NULL,
    paused_reason TEXT, stop_reason TEXT, last_reaction_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS config_versions (
    initiative_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL, diff TEXT NOT NULL,
    session_id TEXT, confirmed_by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (initiative_id, version)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('human','agent')),
    text TEXT NOT NULL, source_ref TEXT, created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS explorations (
    id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, idea_id TEXT, question TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('idea','proposed','exploring','rejected','stalled','briefed','adopted','parked')),
    budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0, estimate_usd REAL, deadline TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS windows (
    id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, exploration_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('survey','scan','window','brief')),
    started TEXT NOT NULL, ended TEXT, spent_usd REAL NOT NULL DEFAULT 0,
    tools_used TEXT NOT NULL DEFAULT '[]', reads TEXT NOT NULL DEFAULT '[]', checkpoint TEXT, end_reason TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS findings (
    id TEXT PRIMARY KEY, exploration_id TEXT NOT NULL, claim TEXT NOT NULL, source_ref TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1), created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS briefs (
    id TEXT PRIMARY KEY, exploration_id TEXT NOT NULL, version INTEGER NOT NULL, body_md TEXT NOT NULL,
    recommended_option TEXT, partial INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, draft_yaml TEXT NOT NULL, why TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','materialised','refused')), refusal TEXT, created_at TEXT NOT NULL
  ) STRICT;

  -- Approval surfaces only.
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY, target TEXT NOT NULL,
    gate TEXT NOT NULL CHECK (gate IN ('gate1_explore','gate2_adopt','self_start','config_change')),
    verdict TEXT NOT NULL, reason TEXT, option TEXT, decided_by TEXT NOT NULL, at TEXT NOT NULL
  ) STRICT;

  -- clarify in runs lands here, shown in the digest.
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL, exploration_id TEXT, text TEXT NOT NULL,
    answer TEXT, created_at TEXT NOT NULL, answered_at TEXT
  ) STRICT;
`;

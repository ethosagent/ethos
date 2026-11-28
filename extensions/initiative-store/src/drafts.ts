import type Database from '@ethosagent/sqlite';
import type { DraftRow, DraftStatus } from '@ethosagent/types';

interface DraftDbRow {
  id: string;
  parent_id: string;
  draft_yaml: string;
  why: string;
  status: string;
  refusal: string | null;
  created_at: string;
}

function toDraft(r: DraftDbRow): DraftRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    draftYaml: r.draft_yaml,
    why: r.why,
    status: r.status as DraftStatus,
    refusal: r.refusal,
    createdAt: r.created_at,
  };
}

/** Drafts in one status, oldest first (rowid breaks ties). */
export function selectDrafts(db: Database.Database, status: DraftStatus): DraftRow[] {
  const rows = db
    .prepare(
      `SELECT id, parent_id, draft_yaml, why, status, refusal, created_at FROM drafts
       WHERE status = ? ORDER BY created_at, rowid`,
    )
    .all(status) as DraftDbRow[];
  return rows.map(toDraft);
}

/** Moves a `pending` draft to its final status. Returns false when it is not pending (settled once). */
export function settleDraftRow(
  db: Database.Database,
  id: string,
  status: 'materialised' | 'refused',
  refusal: string | null,
): boolean {
  const r = db
    .prepare("UPDATE drafts SET status = ?, refusal = ? WHERE id = ? AND status = 'pending'")
    .run(status, refusal, id);
  return r.changes > 0;
}

import type { EthosClient } from '@ethosagent/sdk';

// Rename · Fork · Delete · Share transcript — the Sessions list's verbs (§4).
// Rename is `sessions.update {title}`: the contract has no `rename`.

export type SessionVerb = 'rename' | 'fork' | 'delete' | 'share';

type Sessions = Pick<EthosClient['rpc']['sessions'], 'update' | 'fork' | 'delete' | 'export'>;

/** Runs one verb; returns the new session's id for a fork, else null. */
export async function runSessionVerb(
  sessions: Sessions,
  verb: SessionVerb,
  opts: {
    id: string;
    title?: string;
    share?: (text: string, filename: string) => Promise<unknown>;
  },
): Promise<string | null> {
  if (verb === 'fork') return (await sessions.fork({ id: opts.id })).session.id;
  if (verb === 'rename') await sessions.update({ id: opts.id, title: opts.title?.trim() || null });
  else if (verb === 'delete') await sessions.delete({ id: opts.id });
  else {
    const out = await sessions.export({ id: opts.id, format: 'markdown' });
    await opts.share?.(out.content, out.filename);
  }
  return null;
}

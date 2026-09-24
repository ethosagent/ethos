import type { Session } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Select, Tooltip } from 'antd';
import { rpc } from '../../rpc';
import { sessionKeys } from './api/keys';

// The chat header's branch switcher (plan openclaw-9.5-adoption item 5): the
// origin session and its direct forks, numbered exactly as `/branches` numbers
// them in the CLI and on channels (`formatBranchList` in
// packages/surface-kit/src/branches.ts) — 1 is the origin, forks follow oldest
// first. Hidden until a session has at least one fork, so a conversation that
// was never forked shows nothing new.

export interface BranchOption {
  value: string;
  label: string;
}

/** The origin, then its forks oldest first. `[]` when there are no forks. */
export function branchOptions(originId: string, forks: readonly Session[]): BranchOption[] {
  if (forks.length === 0) return [];
  const sorted = [...forks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [
    { value: originId, label: '1 · origin' },
    ...sorted.map((s, i) => ({ value: s.id, label: `${i + 2} · ${s.title ?? 'fork'}` })),
  ];
}

export function BranchSwitcher({
  session,
  onSelect,
}: {
  session: Session | undefined;
  onSelect: (sessionId: string) => void;
}) {
  const originId = session ? (session.parentSessionId ?? session.id) : '';
  // `listSessions({ parentSessionId })` server-side — an indexed lookup, never
  // a scan of every session. Keyed under `sessionKeys.list()` so a fork (which
  // invalidates that prefix) refreshes it.
  const forks = useQuery({
    queryKey: [...sessionKeys.list(), 'branches', originId],
    queryFn: () => rpc.sessions.list({ parentSessionId: originId, limit: 200 }),
    enabled: Boolean(originId),
  });
  const options = branchOptions(originId, forks.data?.items ?? []);
  if (!session || options.length === 0) return null;
  return (
    <Tooltip title="Branches of this conversation">
      <Select
        size="small"
        aria-label="Switch to another branch of this conversation"
        value={session.id}
        options={options}
        onChange={onSelect}
        popupMatchSelectWidth={false}
      />
    </Tooltip>
  );
}

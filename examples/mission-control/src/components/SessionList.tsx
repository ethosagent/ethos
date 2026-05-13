'use client';

import type { Session } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useState } from 'react';
import { ethos } from '@/lib/ethos';

interface SessionListProps {
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
}

export function SessionList({ activeSessionId, onSelectSession }: SessionListProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await ethos.rpc.sessions.list({ limit: 50 });
      setSessions(res.items);
    } catch (err) {
      console.error('Failed to fetch sessions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await ethos.rpc.sessions.delete({ id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  return (
    <div className="flex flex-col border-r border-gray-200 dark:border-gray-800">
      <div className="flex items-center justify-between border-b border-gray-200 p-3 dark:border-gray-800">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <button
          type="button"
          onClick={fetchSessions}
          className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-3 text-sm text-gray-500">Loading...</p>}
        {!loading && sessions.length === 0 && (
          <p className="p-3 text-sm text-gray-500">No sessions. Send a message to start one.</p>
        )}
        {sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            onClick={() => onSelectSession(session.id)}
            className={`flex w-full items-start justify-between gap-2 border-b border-gray-100 p-3 text-left text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900 ${
              activeSessionId === session.id ? 'bg-blue-50 dark:bg-blue-950' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs text-gray-600 dark:text-gray-400">
                {session.id.slice(0, 8)}
              </p>
              {session.personalityId && (
                <p className="truncate text-xs text-gray-500">{session.personalityId}</p>
              )}
            </div>
            <button
              type="button"
              onClick={(e) => handleDelete(session.id, e)}
              className="shrink-0 rounded px-1 text-xs text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
            >
              Del
            </button>
          </button>
        ))}
      </div>
    </div>
  );
}

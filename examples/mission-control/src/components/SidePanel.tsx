'use client';

import type { MemoryFile, Personality } from '@ethosagent/web-contracts';
import { useCallback, useEffect, useState } from 'react';
import { ethos } from '@/lib/ethos';

interface SidePanelProps {
  personalityId: string | null;
  onPersonalityChange: (id: string) => void;
}

export function SidePanel({ personalityId, onPersonalityChange }: SidePanelProps) {
  const [personalities, setPersonalities] = useState<Personality[]>([]);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFile[]>([]);
  const [loadingPersonalities, setLoadingPersonalities] = useState(true);
  const [loadingMemory, setLoadingMemory] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await ethos.rpc.personalities.list({});
        setPersonalities(res.items);
        if (!personalityId && res.defaultId) {
          onPersonalityChange(res.defaultId);
        }
      } catch (err) {
        console.error('Failed to fetch personalities:', err);
      } finally {
        setLoadingPersonalities(false);
      }
    };
    void load();
  }, [personalityId, onPersonalityChange]);

  const fetchMemory = useCallback(async () => {
    setLoadingMemory(true);
    try {
      const res = await ethos.rpc.memory.list({});
      setMemoryFiles(res.items);
    } catch (err) {
      console.error('Failed to fetch memory:', err);
    } finally {
      setLoadingMemory(false);
    }
  }, []);

  useEffect(() => {
    void fetchMemory();
  }, [fetchMemory]);

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Personality picker */}
      <div className="border-b border-gray-200 p-3 dark:border-gray-800">
        <h2 className="mb-2 text-sm font-semibold">Personality</h2>
        {loadingPersonalities ? (
          <p className="text-xs text-gray-500">Loading...</p>
        ) : (
          <select
            value={personalityId ?? ''}
            onChange={(e) => onPersonalityChange(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {personalities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Memory viewer */}
      <div className="flex flex-1 flex-col overflow-hidden p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Memory</h2>
          <button
            type="button"
            onClick={() => void fetchMemory()}
            className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Refresh
          </button>
        </div>

        {loadingMemory && <p className="text-xs text-gray-500">Loading...</p>}

        <div className="flex-1 space-y-3 overflow-y-auto">
          {memoryFiles.map((file) => (
            <div key={file.store}>
              <p className="mb-1 text-xs font-semibold text-gray-500">
                {file.store === 'memory' ? 'MEMORY.md' : 'USER.md'}
              </p>
              <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 text-xs dark:bg-gray-900">
                {file.content || '(empty)'}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

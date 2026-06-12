import { createEthosClient } from '@ethosagent/sdk';
import { useEffect, useMemo, useState } from 'react';
import { useServerUrl } from '../../shell/ServerUrl';

interface CharacterSheetTabProps {
  personalityId: string;
}

export function CharacterSheetTab({ personalityId }: CharacterSheetTabProps) {
  const baseUrl = useServerUrl();
  const client = useMemo(() => createEthosClient({ baseUrl, fetch: globalThis.fetch }), [baseUrl]);

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    async function load() {
      try {
        const res = await client.rpc.personalities.characterSheet({ id: personalityId });
        if (!cancelled) setMarkdown(res.markdown);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [personalityId, client]);

  if (loading) {
    return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading...</span>;
  }

  if (error) {
    return <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Failed to load</span>;
  }

  return (
    <pre
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: 0,
      }}
    >
      {markdown}
    </pre>
  );
}

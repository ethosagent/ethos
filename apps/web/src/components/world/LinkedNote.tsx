import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { entityHref, mergeSpans, visibleWorldIds } from '../../features/worlds/linkify';
import { rpc } from '../../rpc';

/**
 * Read-only view of a note with world entity names as links. Renders nothing
 * when no name matches or the world calls fail (worlds off), so Memory is
 * unchanged for anyone without worlds.
 */
export function LinkedNote({ personalityId, text }: { personalityId: string; text: string }) {
  const mountsQ = useQuery({
    queryKey: ['worlds', 'mounts', personalityId],
    queryFn: () => rpc.worlds.mounts({ personalityId }),
    retry: false,
  });
  const worlds = mountsQ.data ? visibleWorldIds(personalityId, mountsQ.data) : [];
  const answers = useQueries({
    queries: worlds.map((world) => ({
      queryKey: ['worlds', 'linkify', world, text],
      queryFn: () => rpc.worlds.linkify({ world, text }),
      retry: false,
    })),
  });
  if (text === '' || answers.length === 0 || answers.some((a) => a.isPending)) return null;
  const spans = mergeSpans(
    text,
    answers.flatMap((a, i) => {
      const world = worlds[i];
      return a.data && world ? [{ world, spans: a.data.spans }] : [];
    }),
  );
  if (!spans.some((s) => s.entity)) return null;
  return (
    <section aria-label="Entities in this note" style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
        Names that match world entities
      </div>
      <pre
        style={{
          fontFamily: 'Geist Mono, monospace',
          fontSize: 12.5,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {spans.map((s, i) =>
          s.entity ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reordered
            <Link key={i} to={entityHref(s.entity.world, s.entity.id)} data-entity={s.entity.id}>
              {s.text}
            </Link>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reordered
            <span key={i}>{s.text}</span>
          ),
        )}
      </pre>
    </section>
  );
}

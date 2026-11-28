import { useEffect, useRef, useState } from 'react';
import type { CytoElements } from './world-logic';

// The one place Cytoscape is touched. It is imported lazily with a literal
// specifier so the library stays out of every route but World (computed import()
// is banned by archcheck; a literal one is allowed). Colours come from DESIGN.md
// tokens resolved at mount, because a canvas cannot read `var(--x)`.

function token(el: HTMLElement, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || 'currentColor';
}

export function CytoCanvas({
  elements,
  onOpen,
}: {
  elements: CytoElements;
  onOpen: (entityId: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let destroy: (() => void) | undefined;
    let cancelled = false;
    import('cytoscape')
      .then(({ default: cytoscape }) => {
        if (cancelled) return;
        const line = token(el, '--border-strong');
        const text = token(el, '--text-secondary');
        const cy = cytoscape({
          container: el,
          elements: [
            ...elements.nodes.map((n) => ({
              data: { ...n.data, color: token(el, n.data.token) },
            })),
            ...elements.edges,
          ],
          layout: { name: 'cose', animate: false },
          style: [
            {
              selector: 'node',
              style: {
                label: 'data(label)',
                'background-color': 'data(color)',
                color: text,
                'font-size': 11,
                width: 14,
                height: 14,
              },
            },
            {
              selector: 'edge',
              style: {
                'line-color': line,
                'target-arrow-color': line,
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                width: 1,
              },
            },
            { selector: 'edge.ended', style: { 'line-style': 'dashed' } },
          ],
        });
        cy.on('tap', 'node', (evt) => onOpen(evt.target.id()));
        destroy = () => cy.destroy();
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailed(err instanceof Error ? err.message : 'Graph failed to load');
      });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [elements, onOpen]);

  if (failed)
    return (
      <p className="world-empty" role="alert">
        Could not draw the graph: {failed}
      </p>
    );
  return <div ref={host} className="world-canvas" role="img" aria-label="World graph" />;
}

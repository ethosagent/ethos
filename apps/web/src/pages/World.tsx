import { type ReactNode, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChangesView } from '../components/world/ChangesView';
import { ConflictsInbox } from '../components/world/ConflictsInbox';
import { EntityPage } from '../components/world/EntityPage';
import { GraphView } from '../components/world/GraphView';
import { SchemaEditor } from '../components/world/SchemaEditor';
import { SettingsView } from '../components/world/SettingsView';
import { describeChange, schemaToYaml } from '../components/world/schema-form';
import { TreeView } from '../components/world/TreeView';
import type { WorldSchemaParsed } from '../components/world/types';
import { WorldHeader } from '../components/world/WorldHeader';
import { chooseDefaultView, opensOnSearch, type WorldView } from '../components/world/world-logic';
import '../components/world/world.css';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/LoadingState';
import {
  useWorldConfigSave,
  useWorldDecide,
  useWorldPromote,
  useWorldSchemaSave,
} from '../features/worlds/api/mutations';
import {
  useWorldChanges,
  useWorldConfig,
  useWorldEntity,
  useWorldGraph,
  useWorldList,
  useWorldProposals,
  useWorldSchema,
  useWorldTree,
} from '../features/worlds/api/queries';

// The World page (plan world-model Task 7.3). Every view reads the oRPC client
// types straight through; nothing here casts a response. The state that
// belongs in the URL (world, view, entity, focus) lives in search params so a
// link reopens the same screen.

const VIEWS: ReadonlyArray<{ key: WorldView; label: string }> = [
  { key: 'graph', label: 'Graph' },
  { key: 'tree', label: 'Tree' },
  { key: 'changes', label: 'Changes' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'schema', label: 'Schema' },
  { key: 'settings', label: 'Settings' },
];

function isView(v: string | null): v is WorldView {
  return VIEWS.some((x) => x.key === v);
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Request failed';
}

export function World() {
  const [params, setParams] = useSearchParams();
  const list = useWorldList();
  const worlds = list.data?.worlds ?? [];
  const summary = worlds.find((w) => w.id === params.get('world')) ?? worlds[0];
  const worldId = summary?.id ?? '';
  const isShared = worldId.startsWith('world:');

  const schemaQ = useWorldSchema(worldId, summary !== undefined);
  const requested = params.get('view');
  const view: WorldView = isView(requested)
    ? requested
    : chooseDefaultView(schemaQ.data?.parsed ?? null);
  // The default view depends on the schema, so nothing is fetched for a view until it is known.
  const viewReady = isView(requested) || !schemaQ.isPending;
  const entityId = params.get('entity');
  const focus = params.get('focus');

  const [hops, setHops] = useState(1);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [since, setSince] = useState(() => daysAgo(30));

  const large = summary ? opensOnSearch(summary.counts.entities) : false;
  const searching = view === 'graph' && large && focus === null;
  const graphQ = useWorldGraph(worldId, {
    asOf,
    focus,
    hops,
    enabled:
      summary !== undefined && viewReady && view === 'graph' && entityId === null && !searching,
  });
  const treeQ = useWorldTree(
    worldId,
    summary !== undefined && viewReady && ((view === 'tree' && entityId === null) || searching),
  );
  const entityQ = useWorldEntity(worldId, summary ? entityId : null);
  const changesQ = useWorldChanges(worldId, since, summary !== undefined && view === 'changes');
  const proposalsQ = useWorldProposals(worldId, summary !== undefined && view === 'conflicts');
  const configQ = useWorldConfig(worldId, summary !== undefined && view === 'settings' && isShared);

  const decide = useWorldDecide();
  const promote = useWorldPromote();
  const schemaSave = useWorldSchemaSave();
  const configSave = useWorldConfigSave();
  const undoTo = useRef<WorldSchemaParsed | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const set = (patch: Record<string, string | null>) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });

  if (list.isError) {
    return (
      <div className="world-page">
        <p className="world-empty" role="alert">
          Could not load worlds: {message(list.error)}
        </p>
      </div>
    );
  }
  if (!list.data) return <LoadingState label="Loading worlds" />;
  if (!summary) {
    return (
      <div className="world-page">
        <EmptyState
          title="No worlds yet."
          hint="Create one with `ethos world create <name>`, or import facts into a personality's private world."
        />
      </div>
    );
  }

  if (!viewReady) return <LoadingState label="Loading world" />;

  const runDecide = async (ids: string[], verdict: 'accept' | 'reject') => {
    setDecideError(null);
    try {
      for (const proposalId of ids) await decide.mutateAsync({ proposalId, verdict });
    } catch (err) {
      setDecideError(message(err));
    }
  };

  const saveSchema = (draft: WorldSchemaParsed, before: WorldSchemaParsed) => {
    const s = schemaQ.data;
    if (!s) return;
    const yaml = schemaToYaml({
      draft,
      sensitive: s.sensitive,
      changelog: s.changelog,
      currentVersion: s.version,
      by: 'owner',
      at: new Date().toISOString(),
      change: describeChange(before, draft),
    });
    schemaSave.mutate(
      { world: worldId, yaml, expectedVersion: s.version },
      {
        onSuccess: () => {
          undoTo.current = before;
        },
      },
    );
  };

  const undoSchema = () => {
    const s = schemaQ.data;
    const previous = undoTo.current;
    if (!s || !previous) return;
    const yaml = schemaToYaml({
      draft: previous,
      sensitive: s.sensitive,
      changelog: s.changelog,
      currentVersion: s.version,
      by: 'owner',
      at: new Date().toISOString(),
      change: 'undo last change',
    });
    schemaSave.mutate(
      { world: worldId, yaml, expectedVersion: s.version },
      {
        onSuccess: () => {
          undoTo.current = null;
        },
      },
    );
  };

  const tabs = VIEWS.filter((v) => v.key !== 'settings' || isShared);
  const proposals = proposalsQ.data?.proposals ?? [];

  let body: ReactNode;
  if (entityId !== null) {
    body = (
      <>
        <button type="button" className="world-btn" onClick={() => set({ entity: null })}>
          Back
        </button>
        {entityQ.isError ? (
          <p className="world-empty" role="alert">
            Could not load this entity: {message(entityQ.error)}
          </p>
        ) : entityQ.data ? (
          <EntityPage
            entity={entityQ.data}
            promoting={promote.isPending}
            onOpen={(id) => set({ entity: id })}
            onPromote={(f) => promote.mutate({ world: worldId, factId: f.id })}
          />
        ) : (
          <LoadingState label="Loading entity" />
        )}
      </>
    );
  } else if (view === 'graph') {
    body = (
      <GraphView
        entityCount={summary.counts.entities}
        nodes={graphQ.data?.nodes ?? []}
        edges={graphQ.data?.edges ?? []}
        searchIndex={(treeQ.data?.groups ?? []).flatMap((g) =>
          g.entities.map((e) => ({ id: e.id, name: e.name, type: g.type })),
        )}
        focus={focus}
        hops={hops}
        asOf={asOf}
        onFocus={(id) => set({ focus: id })}
        onHops={setHops}
        onAsOf={setAsOf}
        onOpen={(id) => set({ entity: id })}
      />
    );
  } else if (view === 'tree') {
    body = treeQ.data ? (
      <TreeView groups={treeQ.data.groups} onOpen={(id) => set({ entity: id })} />
    ) : (
      <LoadingState label="Loading tree" />
    );
  } else if (view === 'changes') {
    body = <ChangesView groups={changesQ.data?.groups ?? []} since={since} onSince={setSince} />;
  } else if (view === 'conflicts') {
    body = (
      <>
        {decideError ? (
          <p className="world-errors" role="alert">
            {decideError}
          </p>
        ) : null}
        <ConflictsInbox proposals={proposals} busy={decide.isPending} onDecide={runDecide} />
      </>
    );
  } else if (view === 'schema') {
    body = schemaQ.data ? (
      <SchemaEditor
        key={schemaQ.data.version}
        state={schemaQ.data}
        saving={schemaSave.isPending}
        saveError={schemaSave.isError ? message(schemaSave.error) : null}
        canUndo={undoTo.current !== null}
        onSave={saveSchema}
        onUndo={undoSchema}
      />
    ) : (
      <LoadingState label="Loading schema" />
    );
  } else {
    body = configQ.data ? (
      <SettingsView
        key={worldId}
        config={configQ.data}
        saving={configSave.isPending}
        error={configSave.isError ? message(configSave.error) : null}
        onSave={(next) => configSave.mutate({ world: worldId, ...next })}
      />
    ) : (
      <LoadingState label="Loading settings" />
    );
  }

  return (
    <div className="world-page">
      {worlds.length > 1 ? (
        <select
          aria-label="World"
          value={worldId}
          onChange={(e) => setParams({ world: e.target.value })}
        >
          {worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
            </option>
          ))}
        </select>
      ) : null}
      <WorldHeader world={summary} />
      <nav className="world-tabs" aria-label="World views">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className="world-tab"
            aria-current={entityId === null && view === t.key ? 'page' : undefined}
            onClick={() => set({ view: t.key, entity: null })}
          >
            {t.label}
            {t.key === 'conflicts' && summary.counts.pendingProposals > 0
              ? ` (${summary.counts.pendingProposals})`
              : ''}
          </button>
        ))}
      </nav>
      {body}
    </div>
  );
}

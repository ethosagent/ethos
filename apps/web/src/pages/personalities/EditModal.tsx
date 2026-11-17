import type { Personality } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, Modal, Spin, Tabs, Typography } from 'antd';
import { useMemo, useRef, useState } from 'react';
import { LivingSoulSection } from '../../components/LivingSoulSection';
import { ExecutionTab } from '../../components/personality/ExecutionTab';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { rpc } from '../../rpc';
import { ConfigEditor } from './ConfigEditor';
import { IdentityEditor } from './IdentityEditor';
import { PluginsAttachPanel } from './PluginsPanels';
import { PersonalitySkillsPanel } from './SkillsPanels';
import { ToolsetEditor } from './ToolsetPickers';

// ---------------------------------------------------------------------------
// MCP Tokens — set / remove bearer tokens for attached MCP servers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edit modal — three tabs (Identity / Toolset / Config) + Skills sub-surface
// ---------------------------------------------------------------------------

/** Tab keys the Edit modal's `Tabs` renders — used to open on a specific tab
 *  (e.g. Identity page's "Edit SOUL" fast path lands on `'identity'` instead
 *  of the default `'characterSheet'`). */
export type EditModalTabKey =
  | 'characterSheet'
  | 'identity'
  | 'toolset'
  | 'execution'
  | 'config'
  | 'soul'
  | 'skills'
  | 'plugins';

export function EditModal({
  id,
  onClose,
  initialTab = 'characterSheet',
}: {
  id: string;
  onClose: () => void;
  initialTab?: EditModalTabKey;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'get', id],
    queryFn: () => rpc.personalities.get({ id }),
  });
  const { modal } = AntApp.useApp();

  // Which panes hold unsaved drafts. A ref, not state: nothing renders off it —
  // it is read once, when the modal is asked to close.
  const dirtyTabs = useRef<Partial<Record<EditModalTabKey, boolean>>>({});
  // Stable per-tab reporters — `TabSaveBar` reports through an effect, so a new
  // function identity each render would re-fire it on every render.
  const reportDirty = useMemo(() => {
    const forTab = (tab: EditModalTabKey) => (dirty: boolean) => {
      dirtyTabs.current[tab] = dirty;
    };
    return {
      identity: forTab('identity'),
      toolset: forTab('toolset'),
      config: forTab('config'),
      plugins: forTab('plugins'),
    };
  }, []);

  // N5a — a navigation (or reload) while a tab holds a draft is the same loss
  // handleCancel guards against, just through a different exit. A thunk over
  // the ref: dirty state deliberately does not re-render this component.
  useUnsavedGuard(() => Object.values(dirtyTabs.current).some(Boolean));

  function handleCancel() {
    if (!Object.values(dirtyTabs.current).some(Boolean)) {
      onClose();
      return;
    }
    modal.confirm({
      title: 'Discard unsaved changes?',
      content: 'Some tabs hold edits that have not been saved. Closing loses them.',
      okText: 'Discard',
      okButtonProps: { danger: true },
      cancelText: 'Keep editing',
      onOk: onClose,
    });
  }

  return (
    <Modal
      open
      title={`Edit ${id}`}
      onCancel={handleCancel}
      footer={null}
      width={780}
      destroyOnClose
    >
      {isLoading || !data ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
          <Spin />
        </div>
      ) : (
        <Tabs
          defaultActiveKey={initialTab}
          items={[
            {
              key: 'characterSheet',
              label: 'Character sheet',
              children: <CharacterSheetPanel id={id} />,
            },
            {
              key: 'identity',
              label: 'Identity',
              children: (
                <IdentityEditor
                  id={id}
                  initialSoulMd={data.soulMd}
                  initialAvatarUrl={data.personality.display?.avatar_url}
                  initialEmoji={data.personality.display?.emoji}
                  onDirtyChange={reportDirty.identity}
                />
              ),
            },
            {
              key: 'toolset',
              label: 'Toolset',
              children: (
                <ToolsetEditor
                  id={id}
                  initialToolset={data.personality.toolset ?? []}
                  onDirtyChange={reportDirty.toolset}
                />
              ),
            },
            {
              key: 'execution',
              label: 'Execution',
              children: <ExecutionTab id={id} />,
            },
            {
              key: 'config',
              label: 'Config',
              children: (
                <ConfigEditor
                  id={id}
                  personality={data.personality}
                  onDirtyChange={reportDirty.config}
                />
              ),
            },
            {
              key: 'soul',
              label: 'Living Soul',
              children: <LivingSoulSection personalityId={id} />,
            },
            {
              key: 'skills',
              label: 'Skills',
              children: <PersonalitySkillsPanel personalityId={id} />,
            },
            {
              key: 'plugins',
              label: 'Plugins',
              children: (
                <PluginsAttachPanel
                  id={id}
                  initialPlugins={data.personality.plugins ?? []}
                  onDirtyChange={reportDirty.plugins}
                />
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

// The generated character sheet — one screen of what the personality is,
// what it has, and what it can reach. Same Markdown artifact `ethos
// personality show` prints; rendered read-only here as the primary read.
function CharacterSheetPanel({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities', 'characterSheet', id],
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });

  if (isLoading || !data) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 240 }}>
        <Spin />
      </div>
    );
  }

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Auto-generated from config + SOUL.md — the same artifact <code>ethos personality show</code>{' '}
        prints.
      </Typography.Paragraph>
      <pre
        style={{
          fontFamily: 'Geist Mono, monospace',
          fontSize: 12.5,
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {data.markdown}
      </pre>
    </>
  );
}

// ---------------------------------------------------------------------------
// Duplicate modal — pick a new id, then open the editor on the copy
// ---------------------------------------------------------------------------

export function DuplicateModal({
  source,
  existingIds,
  onClose,
  onDone,
}: {
  source: Personality;
  existingIds: Set<string>;
  onClose: () => void;
  onDone: (newId: string) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [newId, setNewId] = useState(`${source.id}-copy`);

  const mut = useMutation({
    mutationFn: () => rpc.personalities.duplicate({ id: source.id, newId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      qc.invalidateQueries({ queryKey: ['palette', 'personalities'] });
      notification.success({ message: `Duplicated → ${newId}`, placement: 'topRight' });
      onDone(newId);
    },
    onError: (err) =>
      notification.error({ message: 'Duplicate failed', description: (err as Error).message }),
  });

  const idValid = /^[a-z0-9_-]+$/.test(newId);
  const collision = existingIds.has(newId);

  return (
    <Modal
      open
      title={`Duplicate ${source.name}`}
      onCancel={onClose}
      onOk={() => mut.mutate()}
      okText="Duplicate"
      okButtonProps={{ loading: mut.isPending, disabled: !idValid || collision }}
      destroyOnClose
    >
      <Form layout="vertical">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Copies all four files (SOUL.md, toolset.yaml, config.yaml, skills/) into{' '}
          <Typography.Text code>~/.ethos/personalities/&lt;new-id&gt;/</Typography.Text>. The editor
          opens on the copy when this completes.
        </Typography.Paragraph>
        <Form.Item
          label="New ID"
          required
          validateStatus={collision ? 'error' : !idValid && newId ? 'error' : undefined}
          help={
            collision
              ? 'Already taken.'
              : !idValid
                ? 'Lowercase, dash/underscore-separated.'
                : undefined
          }
        >
          <Input autoFocus value={newId} onChange={(e) => setNewId(e.target.value.toLowerCase())} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

import type { MemoryFile, MemoryStoreId } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Select, Spin, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '../rpc';

type FileKey = 'memory' | 'user';

export function Memory() {
  const [selectedFile, setSelectedFile] = useState<FileKey>('memory');
  const [personalityId, setPersonalityId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  const effectivePersonalityId = personalityId ?? personalitiesQuery.data?.defaultId ?? null;

  const usersQuery = useQuery({
    queryKey: ['memory', 'listUsers'],
    queryFn: () => rpc.memory.listUsers({}),
  });

  const listQuery = useQuery({
    queryKey: ['memory', 'list', effectivePersonalityId, selectedFile === 'user' ? userId : null],
    queryFn: () =>
      rpc.memory.list({
        personalityId: effectivePersonalityId as string,
        ...(selectedFile === 'user' && userId ? { userId } : {}),
      }),
    enabled: !!effectivePersonalityId,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  if (personalitiesQuery.isLoading || (personalitiesQuery.isSuccess && listQuery.isLoading)) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (listQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load memory: {(listQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const files = listQuery.data?.items ?? [];
  const fileByStore = new Map(files.map((f) => [f.store, f] as const));
  const memoryMode = configQuery.data?.memory ?? 'markdown';

  const personalities = personalitiesQuery.data?.items ?? [];
  const users = usersQuery.data?.users ?? [];

  return (
    <div className="brain-page">
      {/* Header row */}
      <div className="brain-header">
        <h3 className="brain-title">Brain</h3>
        <div className="brain-header-selectors">
          <Select
            size="small"
            style={{ width: 180 }}
            className="brain-select"
            value={effectivePersonalityId ?? undefined}
            onChange={(v) => setPersonalityId(v)}
            loading={personalitiesQuery.isLoading}
            options={personalities.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
          />
          {selectedFile === 'user' ? (
            <Select
              size="small"
              style={{ width: 140 }}
              className="brain-select"
              value={userId ?? '__shared__'}
              onChange={(v) => setUserId(v === '__shared__' ? null : v)}
              loading={usersQuery.isLoading}
              options={[
                { value: '__shared__', label: 'Shared (default)' },
                ...users.map((u) => ({
                  value: u.userId,
                  label: u.displayLabel,
                })),
              ]}
            />
          ) : null}
        </div>
      </div>

      {memoryMode === 'vector' ? (
        <Typography.Paragraph type="secondary" style={{ margin: '0 0 12px', fontSize: 12 }}>
          Vector mode is active — the agent uses semantic chunks, not these files. Switch to{' '}
          <code>markdown</code> mode in Settings if you want edits here to flow back to the agent.
        </Typography.Paragraph>
      ) : null}

      {/* Two-panel layout */}
      <div className="brain-panels">
        {/* Left panel — file list */}
        <div className="brain-file-list">
          <div className="brain-file-list-label">Files</div>
          <FileItem
            label="MEMORY.md"
            active={selectedFile === 'memory'}
            onClick={() => setSelectedFile('memory')}
          />
          <FileItem
            label="USER.md"
            active={selectedFile === 'user'}
            onClick={() => setSelectedFile('user')}
          />
        </div>

        {/* Right panel — editor */}
        <div className="brain-editor-panel">
          {effectivePersonalityId ? (
            <BrainEditor
              store={selectedFile}
              file={fileByStore.get(selectedFile) ?? null}
              personalityId={effectivePersonalityId}
              userId={selectedFile === 'user' ? (userId ?? undefined) : undefined}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`brain-file-item${active ? ' brain-file-item--active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function BrainEditor({
  store,
  file,
  personalityId,
  userId,
}: {
  store: MemoryStoreId;
  file: MemoryFile | null;
  personalityId: string;
  userId?: string;
}) {
  const qc = useQueryClient();
  const { notification, modal } = AntApp.useApp();
  const [draft, setDraft] = useState(file?.content ?? '');
  const [savedContent, setSavedContent] = useState(file?.content ?? '');
  const [search, setSearch] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const content = file?.content ?? '';
    setDraft(content);
    setSavedContent(content);
  }, [file]);

  const writeMut = useMutation({
    mutationFn: (content: string) =>
      rpc.memory.write({ store, content, personalityId, ...(userId ? { userId } : {}) }),
    onSuccess: (_data, variables) => {
      setSavedContent(variables);
      qc.invalidateQueries({ queryKey: ['memory', 'list'] });
      notification.success({ message: 'Saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const dirty = draft !== savedContent;
  const matchCount = search ? countMatches(draft, search) : 0;
  const totalMatches = search ? countTotalMatches(draft, search) : 0;

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
      notification.info({ message: 'Copied to clipboard', placement: 'topRight' });
    } catch (err) {
      notification.error({ message: 'Copy failed', description: (err as Error).message });
    }
  }, [draft, notification]);

  const onRevert = useCallback(() => {
    if (!dirty) return;
    setDraft(savedContent);
  }, [dirty, savedContent]);

  const onSave = useCallback(() => {
    writeMut.mutate(draft);
  }, [draft, writeMut]);

  const onClear = useCallback(() => {
    modal.confirm({
      title: 'Clear memory',
      content: 'This will clear all memory. Are you sure?',
      okText: 'Clear',
      okButtonProps: { danger: true },
      onOk: () => {
        setDraft('');
        writeMut.mutate('');
      },
    });
  }, [modal, writeMut]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        onSave();
      }
    },
    [onSave],
  );

  const filename = store === 'memory' ? 'MEMORY.md' : 'USER.md';

  return (
    <div className="brain-editor">
      {/* Editor toolbar */}
      <div className="brain-editor-toolbar">
        <span className="brain-editor-filename">
          {filename}
          {dirty ? <span className="brain-dirty-dot"> *</span> : null}
        </span>

        <div className="brain-editor-toolbar-right">
          <div className="brain-search-wrap">
            <input
              type="text"
              className="brain-search-input"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <span className="brain-search-counter">
                {matchCount} of {totalMatches}
              </span>
            ) : null}
          </div>

          <button type="button" className="brain-action-btn" onClick={onCopy}>
            Copy
          </button>
          <button type="button" className="brain-action-btn" onClick={onRevert} disabled={!dirty}>
            Revert
          </button>
          <button
            type="button"
            className="brain-action-btn brain-action-btn--primary"
            onClick={onSave}
            disabled={!dirty || writeMut.isPending}
          >
            {writeMut.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            className="brain-action-btn brain-action-btn--danger"
            onClick={onClear}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Content textarea */}
      <textarea
        ref={textareaRef}
        className="brain-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        placeholder={
          store === 'memory'
            ? '# Project context\n\nNotes the agent reads each turn.'
            : '# About me\n\nWho you are, what you build, how you work.'
        }
      />
    </div>
  );
}

function countMatches(text: string, q: string): number {
  if (!q) return 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const lines = lower.split('\n');
  let count = 0;
  for (const line of lines) {
    if (line.includes(needle)) count++;
  }
  return count;
}

function countTotalMatches(text: string, q: string): number {
  if (!q) return 0;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let count = 0;
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return count;
}

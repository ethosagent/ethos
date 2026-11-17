import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { AvatarPicker } from '../../components/personality/AvatarPicker';
import {
  applyAvatarSelection,
  deleteAvatarRoute,
  removeAvatar,
  uploadAvatarBytes,
} from '../../components/personality/avatarActions';
import { EmojiField } from '../../components/personality/EmojiField';
import { TabSaveBar } from '../../components/personality/TabSaveBar';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import { rpc } from '../../rpc';

type IdentityAvatarAction =
  | { kind: 'curated'; url: string }
  | { kind: 'file'; file: File }
  | { kind: 'remove' };

export function IdentityEditor({
  id,
  initialSoulMd,
  initialAvatarUrl,
  initialEmoji,
  onDirtyChange,
}: {
  id: string;
  initialSoulMd: string;
  initialAvatarUrl?: string;
  initialEmoji?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const [draft, setDraft] = useState(initialSoulMd);
  // What is on disk, as far as this editor knows. Tracked separately from the
  // prop so the dirty flag clears the instant the write lands, rather than
  // waiting on the invalidated query to come back.
  const [savedSoulMd, setSavedSoulMd] = useState(initialSoulMd);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [emoji, setEmoji] = useState(initialEmoji);

  const mut = useMutation({
    mutationFn: (soulMd: string) => rpc.personalities.update({ id, soulMd }),
    onSuccess: (_result, soulMd) => {
      setSavedSoulMd(soulMd);
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({ message: 'SOUL.md saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  // The personality already exists here (unlike `NewAgentDialog`'s staged
  // selection), so every avatar action applies immediately. Curated and file
  // both go through `applyAvatarSelection` — which, for a curated pick,
  // DELETEs any stored uploaded file first so it doesn't linger orphaned on
  // disk once `display.avatar_url` points at a static path instead.
  const avatarDeps = {
    setAvatarUrl: (personalityId: string, url: string) =>
      rpc.personalities.update({ id: personalityId, display: { avatar_url: url } }),
    uploadAvatar: uploadAvatarBytes,
    deleteAvatar: deleteAvatarRoute,
  };

  const avatarMut = useMutation({
    mutationFn: async (action: IdentityAvatarAction) => {
      if (action.kind === 'remove') {
        await removeAvatar(id, avatarDeps);
      } else {
        await applyAvatarSelection(id, action, avatarDeps);
      }
    },
    onSuccess: (_result, action) => {
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      if (action.kind === 'remove') {
        setAvatarUrl(undefined);
        notification.success({ message: 'Avatar removed', placement: 'topRight' });
      } else if (action.kind === 'curated') {
        setAvatarUrl(action.url);
        notification.success({ message: 'Avatar updated', placement: 'topRight' });
      } else {
        // The upload route always serves the same URL for a given
        // personality — a cache-busting query param is what makes the
        // `<img>` actually refetch instead of reusing the pre-upload bytes.
        setAvatarUrl(`/api/personalities/${id}/avatar?v=${Date.now()}`);
        notification.success({ message: 'Avatar updated', placement: 'topRight' });
      }
    },
    onError: (err) =>
      notification.error({ message: 'Avatar update failed', description: (err as Error).message }),
  });

  // Applies on Set, like the avatar: one small value, nothing to stage.
  const emojiMut = useMutation({
    mutationFn: (next: string) => rpc.personalities.update({ id, display: { emoji: next } }),
    onSuccess: (_result, next) => {
      setEmoji(next === '' ? undefined : next);
      qc.invalidateQueries({ queryKey: ['personalities', 'get', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'characterSheet', id] });
      qc.invalidateQueries({ queryKey: ['personalities', 'list'] });
      notification.success({
        message: next === '' ? 'Emoji removed' : 'Emoji updated',
        placement: 'topRight',
      });
    },
    onError: (err) =>
      notification.error({ message: 'Emoji update failed', description: (err as Error).message }),
  });

  return (
    <Form layout="vertical">
      <Form.Item
        label="Avatar"
        help="Optional. Falls back to the generated mark when unset or the image fails to load."
      >
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <PersonalityMark personalityId={id} size={48} avatarUrl={avatarUrl} />
          <div style={{ flex: 1 }}>
            <AvatarPicker
              selectedCuratedUrl={avatarUrl}
              onSelectCurated={(url) => avatarMut.mutate({ kind: 'curated', url })}
              onFileSelected={(file) => avatarMut.mutate({ kind: 'file', file })}
              onRemove={() => avatarMut.mutate({ kind: 'remove' })}
              showRemove={Boolean(avatarUrl)}
            />
          </div>
        </div>
      </Form.Item>
      <Form.Item
        label="Emoji"
        help="Optional. One emoji, shown beside the name in the CLI, the TUI and chat. The mark stays."
      >
        <EmojiField
          value={emoji}
          saving={emojiMut.isPending}
          onSave={(next) => emojiMut.mutate(next)}
        />
      </Form.Item>

      <Typography.Paragraph type="secondary">
        First-person identity body. The agent loads this each turn.
      </Typography.Paragraph>
      <Form.Item>
        <Input.TextArea
          value={draft}
          autoSize={{ minRows: 14, maxRows: 30 }}
          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 12.5 }}
          onChange={(e) => setDraft(e.target.value)}
        />
      </Form.Item>
      {/* Dirty tracks the SOUL.md draft only. The avatar applies on select
          (an upload cannot sensibly be deferred), so folding it in here would
          claim unsaved changes for bytes already written. */}
      <TabSaveBar
        dirty={draft !== savedSoulMd}
        saving={mut.isPending}
        saveSucceeded={mut.isSuccess}
        onSave={() => mut.mutate(draft)}
        {...(onDirtyChange ? { onDirtyChange } : {})}
      />
    </Form>
  );
}

import { isSingleEmojiGrapheme } from '@ethosagent/types';
import { Button, Input, Typography } from 'antd';
import { useEffect, useState } from 'react';

// The Identity tab's `display.emoji` field, beside `AvatarPicker` (plan
// personality-presence-and-initiative §2). Standalone and state-agnostic like
// `AvatarPicker`: the caller owns the network write. The Set button is gated
// by the same `isSingleEmojiGrapheme` the server enforces
// (`personalities.update` in web-contracts, `FilePersonalityRegistry.update`),
// so an invalid value never leaves the page.

export interface EmojiDraftStatus {
  /** The draft as it would be saved — trimmed. `''` clears. */
  value: string;
  valid: boolean;
  changed: boolean;
}

export function emojiDraftStatus(draft: string, saved: string | undefined): EmojiDraftStatus {
  const value = draft.trim();
  return {
    value,
    valid: value === '' || isSingleEmojiGrapheme(value),
    changed: value !== (saved ?? ''),
  };
}

export interface EmojiFieldProps {
  /** The saved emoji, if any. */
  value?: string;
  saving?: boolean;
  /** Called with one emoji, or `''` to clear it. */
  onSave: (emoji: string) => void;
}

export function EmojiField({ value, saving = false, onSave }: EmojiFieldProps) {
  const [draft, setDraft] = useState(value ?? '');
  // A save lands as a new `value`; follow it so the field shows what is on disk.
  useEffect(() => setDraft(value ?? ''), [value]);
  const status = emojiDraftStatus(draft, value);
  const clearing = status.value === '' && status.changed;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          aria-label="Emoji"
          value={draft}
          maxLength={32}
          placeholder="🦉"
          status={status.valid ? undefined : 'error'}
          style={{ width: 72, textAlign: 'center' }}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={() => {
            if (status.valid && status.changed) onSave(status.value);
          }}
        />
        <Button
          disabled={!status.valid || !status.changed}
          loading={saving}
          onClick={() => onSave(status.value)}
        >
          {clearing ? 'Clear' : 'Set'}
        </Button>
      </div>
      {status.valid ? null : (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          One emoji only. A flag, keycap or joined sequence counts as one.
        </Typography.Text>
      )}
    </div>
  );
}

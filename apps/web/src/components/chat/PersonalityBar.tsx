import { Input } from 'antd';
import { useState } from 'react';
import { PersonalityRingAvatar } from '../ui/PersonalityRingAvatar';
import { PersonalitySwitcher } from './PersonalitySwitcher';

// 02-chat redesign: 44px personality bar with bottom blue stripe.
// Left: PersonalityRingAvatar (28px) + name (13px/500) + dropdown caret
// + optional "/ session title". Right: "New session" ghost button + overflow.

export interface PersonalityBarProps {
  personalityId: string;
  /** Display name. Falls back to the id if no friendly name is provided. */
  name?: string;
  model: string;
  /** Called when the user picks a different personality from the
   *  switcher. Caller decides whether to fork the session. */
  onSwitchPersonality: (personalityId: string) => void;
  /** Called when the user wants to start a fresh session. Caller wipes
   *  reducer state, URL `?session=` param, and localStorage. */
  onNewSession: () => void;
  /** Current session title, if any. Undefined = no active session. */
  sessionTitle?: string | null;
  /** Called after the user confirms a new title (empty string → pass null to clear). */
  onRenameSession?: (title: string | null) => void;
  /** Called when user picks an overflow action. */
  onOverflowAction?: (action: 'export' | 'fork' | 'delete') => void;
}

export function PersonalityBar({
  personalityId,
  name,
  onSwitchPersonality,
  onNewSession,
  sessionTitle,
  onRenameSession,
  onOverflowAction,
}: PersonalityBarProps) {
  const displayName = name ?? capitalize(personalityId);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [overflowOpen, setOverflowOpen] = useState(false);

  const startEdit = () => {
    setEditValue(sessionTitle ?? '');
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    if (onRenameSession) {
      onRenameSession(editValue.trim() || null);
    }
  };

  return (
    <div className="personality-bar">
      <div className="personality-bar-content">
        <div className="personality-bar-left">
          <PersonalityRingAvatar personalityId={personalityId} name={displayName} size={28} />
          <span className="personality-bar-name">{displayName}</span>
          <PersonalitySwitcher current={personalityId} onSelect={onSwitchPersonality} />

          {/* Session title after a separator slash */}
          {sessionTitle !== undefined ? (
            editing ? (
              <Input
                size="small"
                value={editValue}
                autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                onPressEnter={commitEdit}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(false);
                }}
                className="personality-bar-rename-input"
                style={{ fontSize: 13 }}
              />
            ) : (
              <>
                <span className="personality-bar-slash">/</span>
                <div className="personality-bar-session-title">
                  <span className="personality-bar-session-name">
                    {sessionTitle ?? 'Untitled session'}
                  </span>
                  {onRenameSession ? (
                    <button
                      type="button"
                      className="personality-bar-rename"
                      onClick={startEdit}
                      aria-label="Rename session"
                      title="Rename session"
                    >
                      <PencilIcon />
                    </button>
                  ) : null}
                </div>
              </>
            )
          ) : null}
        </div>

        <div className="personality-bar-actions">
          <button
            type="button"
            className="personality-bar-new btn-ghost"
            onClick={onNewSession}
            aria-label="New session"
            title="New session"
          >
            <PlusIcon />
            <span className="personality-bar-new-label">New session</span>
          </button>

          {/* Overflow menu */}
          <div className="personality-bar-overflow-wrap">
            <button
              type="button"
              className="personality-bar-overflow-trigger"
              onClick={() => setOverflowOpen((v) => !v)}
              aria-label="More actions"
              aria-expanded={overflowOpen}
            >
              &#x22EE;
            </button>
            {overflowOpen ? (
              <div className="personality-bar-overflow-menu">
                <button
                  type="button"
                  className="personality-bar-overflow-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    onOverflowAction?.('export');
                  }}
                >
                  Export
                </button>
                <button
                  type="button"
                  className="personality-bar-overflow-item"
                  onClick={() => {
                    setOverflowOpen(false);
                    onOverflowAction?.('fork');
                  }}
                >
                  Fork
                </button>
                <button
                  type="button"
                  className="personality-bar-overflow-item personality-bar-overflow-item--danger"
                  onClick={() => {
                    setOverflowOpen(false);
                    onOverflowAction?.('delete');
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 2.5v9M2.5 7h9" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.5 1.5 10.5 3.5 4 10 1.5 10.5 2 8 8.5 1.5Z" />
    </svg>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}

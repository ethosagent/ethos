import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { PersonalityRingAvatar } from './ui/PersonalityRingAvatar';

interface PersonalityPickerModalProps {
  open: boolean;
  onClose: () => void;
}

export function PersonalityPickerModal({ open, onClose }: PersonalityPickerModalProps) {
  const navigate = useNavigate();
  const { data } = usePersonalityList({ enabled: open });
  const personalities = data?.items ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Reset selection when opening
  useEffect(() => {
    if (open) setSelectedId(personalities[0]?.id ?? null);
  }, [open, personalities]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleStart = () => {
    if (!selectedId) return;
    onClose();
    navigate(`/chat?personality=${encodeURIComponent(selectedId)}`);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay click-to-dismiss
    <div
      ref={overlayRef}
      role="presentation"
      className="personality-picker-overlay"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="personality-picker-modal">
        <h2 className="personality-picker-title">Start a new session</h2>

        <div className="personality-picker-list">
          {personalities.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`personality-picker-row${selectedId === p.id ? ' selected' : ''}`}
              onClick={() => setSelectedId(p.id)}
            >
              <PersonalityRingAvatar personalityId={p.id} name={p.name} size={32} />
              <div className="personality-picker-info">
                <span className="personality-picker-name">{p.name}</span>
                {p.description ? (
                  <span className="personality-picker-desc">{p.description}</span>
                ) : null}
              </div>
              {p.model ? (
                <span className="badge badge-dim personality-picker-model">
                  {typeof p.model === 'string' ? p.model : 'multi-model'}
                </span>
              ) : null}
              {selectedId === p.id ? (
                <span className="personality-picker-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="personality-picker-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-blue"
            disabled={!selectedId}
            onClick={handleStart}
          >
            Start session →
          </button>
        </div>
      </div>
    </div>
  );
}

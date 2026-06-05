import { useCallback, useEffect, useState } from 'react';

interface SlashCommandPopoverProps {
  onCommand: (cmd: string) => void;
  onClose: () => void;
  filter: string;
}

const COMMANDS = [
  { name: 'new', description: 'Start a new session' },
  { name: 'fork', description: 'Fork this session' },
  { name: 'personality', description: 'Switch personality' },
  { name: 'abort', description: 'Abort the current turn' },
  { name: 'undo', description: 'Undo last N turns (default 1)' },
];

export function SlashCommandPopover({ onCommand, onClose, filter }: SlashCommandPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = COMMANDS.filter(
    (c) => !filter || c.name.toLowerCase().startsWith(filter.toLowerCase()),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: filter is an intentional trigger to reset selection
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[selectedIndex];
        if (cmd) {
          onCommand(cmd.name);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIndex, onCommand, onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden',
        marginBottom: 4,
      }}
    >
      {filtered.map((cmd, i) => (
        <button
          type="button"
          key={cmd.name}
          tabIndex={-1}
          onClick={() => onCommand(cmd.name)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            padding: '0 12px',
            cursor: 'pointer',
            background: i === selectedIndex ? 'var(--bg-overlay)' : 'transparent',
            border: 'none',
            width: '100%',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text-primary)',
            }}
          >
            /{cmd.name}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              color: 'var(--text-tertiary)',
            }}
          >
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}

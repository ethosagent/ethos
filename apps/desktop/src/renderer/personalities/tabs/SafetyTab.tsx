import { useCallback, useState } from 'react';
import { RadioOptionRow } from '../../ui/RadioOptionRow';
import { Toggle } from '../../ui/Toggle';
import { FsPathList } from '../components/FsPathList';

interface SafetyTabProps {
  personality: {
    fs_reach: { read: string[] | null; write: string[] | null } | null;
  };
  approvalMode: string;
  onChange: (changes: {
    approvalMode?: string;
    fsReach?: { read: string[]; write: string[] };
  }) => void;
}

const APPROVAL_MODES = [
  {
    value: 'inherit',
    label: 'Inherit',
    description: 'Use the workspace approval setting',
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Require approval for every tool call',
  },
  {
    value: 'smart',
    label: 'Smart',
    description: 'Auto-approve safe tools, ask for dangerous ones',
  },
  {
    value: 'off',
    label: 'Off',
    description: 'Auto-approve all tool calls',
  },
];

export function SafetyTab({ personality, approvalMode, onChange }: SafetyTabProps) {
  const [approvedSendersOnly, setApprovedSendersOnly] = useState(false);

  const readPaths = personality.fs_reach?.read ?? [];
  const writePaths = personality.fs_reach?.write ?? [];

  const handleReadPathsChange = useCallback(
    (paths: string[]) => {
      onChange({ fsReach: { read: paths, write: writePaths } });
    },
    [writePaths, onChange],
  );

  const handleWritePathsChange = useCallback(
    (paths: string[]) => {
      onChange({ fsReach: { read: readPaths, write: paths } });
    },
    [readPaths, onChange],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          Approval Mode
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {APPROVAL_MODES.map((mode) => (
            <RadioOptionRow
              key={mode.value}
              selected={approvalMode === mode.value}
              onClick={() => onChange({ approvalMode: mode.value })}
              accentColor="var(--accent)"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {mode.label}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {mode.description}
                </span>
              </div>
            </RadioOptionRow>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          Filesystem Reach
        </span>
        <FsPathList label="Read Paths" paths={readPaths} onChange={handleReadPathsChange} />
        <FsPathList label="Write Paths" paths={writePaths} onChange={handleWritePathsChange} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--text-tertiary)',
          }}
        >
          Channel Safety
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 0',
          }}
        >
          <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>
            Only respond to approved senders
          </span>
          <Toggle checked={approvedSendersOnly} onChange={setApprovedSendersOnly} />
        </div>
      </div>
    </div>
  );
}

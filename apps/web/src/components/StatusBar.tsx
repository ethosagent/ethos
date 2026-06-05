import { Link } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { StatusDot } from './ui/StatusDot';

interface StatusBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

export function StatusBar({ drawerOpen, onToggleDrawer }: StatusBarProps) {
  const { data, error, isLoading } = useConfig();

  const statusState: 'connected' | 'connecting' | 'offline' = isLoading
    ? 'connecting'
    : error
      ? 'offline'
      : 'connected';

  const statusLabel = isLoading ? 'connecting...' : error ? 'offline' : 'connected';

  const personalityName = data?.personality ?? '';
  const modelName = data?.model ?? '';

  return (
    <footer className="statusbar">
      <StatusDot status={statusState} size={6} />
      <span>{statusLabel}</span>

      <span className="sb-sep" />
      <Link to="/activity" className="sb-link">
        Activity
      </Link>
      <span className="sb-sep" />
      <Link to="/cron" className="sb-link">
        Cron
      </Link>

      <span className="sb-spacer" />
      <button
        type="button"
        className="sb-link"
        onClick={onToggleDrawer}
        aria-label={drawerOpen ? 'Close drawer' : 'Open drawer'}
        style={{
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg
          aria-hidden="true"
          width={16}
          height={16}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
        >
          <rect x="1" y="2" width="14" height="12" rx="2" />
          <line x1="10" y1="2" x2="10" y2="14" />
        </svg>
      </button>
      {personalityName || modelName ? (
        <span className="sb-personality-model">
          {personalityName}
          {personalityName && modelName ? ' · ' : ''}
          {modelName}
        </span>
      ) : (
        <span className="sb-personality-model">—</span>
      )}
    </footer>
  );
}

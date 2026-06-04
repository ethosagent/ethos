import { Link } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';

export function StatusBar() {
  const { data, error, isLoading } = useConfig();

  const statusState: 'connected' | 'connecting' | 'offline' = isLoading
    ? 'connecting'
    : error
      ? 'offline'
      : 'connected';

  const statusLabel = isLoading ? 'connecting…' : error ? 'offline' : 'Gateway ready';

  const providerModel = data ? `${data.provider} · ${data.model}` : '—';

  return (
    <footer className="statusbar">
      <span className={`sb-dot sb-dot--${statusState}`} aria-hidden="true" />
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
      <span>{providerModel}</span>
    </footer>
  );
}

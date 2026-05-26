import { useEffect, useState } from 'react';
import { SettingRow } from '../../ui/SettingRow';
import { Toggle } from '../../ui/Toggle';

interface LaunchAtLoginRowProps {
  hasShownHint: boolean;
  onRefresh: () => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  darwin: 'Could not register as a login item. Check System Settings → General → Login Items.',
  win32: 'Could not write to the Windows registry. Try running Ethos as administrator.',
  linux: 'Could not write to `~/.config/autostart/`. Check file permissions.',
};

export function LaunchAtLoginRow({ hasShownHint, onRefresh }: LaunchAtLoginRowProps) {
  const [enabled, setEnabled] = useState(false);
  const [inflight, setInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [bannerCollapsing, setBannerCollapsing] = useState(false);

  useEffect(() => {
    window.ethos.loginItem.get().then((val: boolean) => setEnabled(val));
  }, []);

  async function handleToggle(next: boolean) {
    setInflight(true);
    setError(null);
    const result = await window.ethos.loginItem.set({ enabled: next });
    setInflight(false);

    if (result.ok) {
      setEnabled(next);
      onRefresh();
      if (next && !hasShownHint) {
        setShowBanner(true);
      }
    } else {
      const platform = window.ethos.platform;
      setError(ERROR_MESSAGES[platform] ?? result.error ?? 'Could not update login item.');
    }
  }

  async function handleRetry() {
    await handleToggle(!enabled);
  }

  function handleDismiss() {
    setBannerCollapsing(true);
    window.ethos.settings.updateConfig({ hasShownLoginItemHint: true });
    setTimeout(() => {
      setShowBanner(false);
      setBannerCollapsing(false);
    }, 300);
  }

  const subText = enabled
    ? 'Ethos starts in the tray at login.'
    : 'Start in the background when you log in. Bots and scheduled jobs run without opening the app.';

  return (
    <div>
      <SettingRow label="Launch at login" subText={subText}>
        <Toggle checked={enabled} onChange={handleToggle} disabled={inflight} />
      </SettingRow>

      {showBanner && (
        <div
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '12px 16px',
            marginTop: 8,
            opacity: bannerCollapsing ? 0 : 1,
            maxHeight: bannerCollapsing ? 0 : 200,
            overflow: 'hidden',
            transition: 'opacity 300ms ease, max-height 300ms ease',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Ethos will start silently in the tray next time you log in. You'll see the ● icon in
              your menu bar.
            </span>
            <button
              type="button"
              onClick={handleDismiss}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleDismiss();
              }}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                fontSize: 12,
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                marginLeft: 16,
                flexShrink: 0,
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--error)' }}>{error}</span>
          <button
            type="button"
            onClick={handleRetry}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRetry();
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              fontSize: 12,
              color: 'var(--info)',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

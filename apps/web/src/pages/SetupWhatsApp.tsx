import { useEffect, useState } from 'react';

export function SetupWhatsApp() {
  const [qr, setQr] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Extract botId from the URL path: /setup/whatsapp/:botId
    const segments = window.location.pathname.split('/');
    const botId = segments[segments.length - 1] || 'default';
    const source = new EventSource(`/setup/whatsapp/${botId}`);

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.paired) {
          setPaired(true);
          source.close();
        } else if (data.qr) {
          setQr(data.qr);
        }
      } catch {
        setError('Failed to parse QR data');
      }
    };

    source.onerror = () => {
      setError('Connection lost. Refresh to retry.');
      source.close();
    };

    return () => source.close();
  }, []);

  if (paired) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
          WhatsApp Connected
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8 }}>
          Your WhatsApp number is now linked to Ethos. You can close this page.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p style={{ color: 'var(--error)', fontSize: 14 }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
        Connect WhatsApp
      </h2>
      <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8, marginBottom: 24 }}>
        Scan this QR code with WhatsApp on your phone.
      </p>
      {qr ? (
        <div>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            A QR code has been printed in your terminal. Scan it with WhatsApp.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            If you cannot access the terminal, copy this pairing code:
          </p>
          <code
            style={{
              display: 'block',
              marginTop: 8,
              padding: '8px 12px',
              background: 'var(--bg-overlay)',
              borderRadius: 'var(--radius-sm, 4px)',
              fontSize: 11,
              fontFamily: 'var(--font-mono, monospace)',
              color: 'var(--text-secondary)',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {qr}
          </code>
        </div>
      ) : (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
          Waiting for QR code...
        </p>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 16 }}>
        Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
      </p>
    </div>
  );
}

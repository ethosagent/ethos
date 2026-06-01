import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { z } from 'zod';

/** Narrow schema for SSE events from the `/setup/whatsapp/:botId` pairing stream. */
const WhatsAppPairingEventSchema = z.union([
  z.object({ paired: z.literal(true) }),
  z.object({ pairingCode: z.string() }),
  z.object({ qr: z.string() }),
]);

export function SetupWhatsApp() {
  const { botId = 'default' } = useParams();
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource(`/setup/whatsapp/${botId}`);

    source.onmessage = (event) => {
      try {
        const json: unknown = JSON.parse(event.data);
        const result = WhatsAppPairingEventSchema.safeParse(json);
        if (!result.success) return;
        const data = result.data;
        if ('paired' in data) {
          setPaired(true);
          setPairingCode(null);
          source.close();
        } else if ('pairingCode' in data) {
          setPairingCode(data.pairingCode);
        } else if ('qr' in data) {
          setQr(data.qr);
        }
      } catch {
        setError('Failed to parse pairing data');
      }
    };

    source.onerror = () => {
      setError('Connection lost. Refresh to retry.');
      source.close();
    };

    return () => source.close();
  }, [botId]);

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

  if (pairingCode) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)' }}>
          Connect WhatsApp
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 8, marginBottom: 24 }}>
          Enter this pairing code in WhatsApp on your phone.
        </p>
        <code
          style={{
            display: 'block',
            margin: '0 auto',
            maxWidth: 280,
            padding: '16px 20px',
            background: 'var(--bg-overlay)',
            borderRadius: 'var(--radius-sm, 4px)',
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: '0.18em',
            fontFamily: 'var(--font-mono, monospace)',
            color: 'var(--text-primary)',
            userSelect: 'all',
          }}
        >
          {pairingCode}
        </code>
        <p
          style={{
            fontSize: 13,
            color: 'var(--text-secondary)',
            marginTop: 24,
            lineHeight: 1.6,
            maxWidth: 420,
            marginInline: 'auto',
          }}
        >
          On your phone: WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device &rarr;
          Link with phone number instead, then enter this code.
        </p>
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
            If you cannot access the terminal, copy this raw QR string and render it as a QR code:
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
        <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Waiting for pairing code...</p>
      )}
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 16 }}>
        Open WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device
      </p>
    </div>
  );
}

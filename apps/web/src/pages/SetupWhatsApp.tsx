import { useEffect, useState } from 'react';

export function SetupWhatsApp() {
  const [qr, setQr] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const source = new EventSource('/setup/whatsapp');

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
        <div
          style={{
            display: 'inline-block',
            padding: 24,
            background: '#ffffff',
            borderRadius: 12,
          }}
        >
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qr)}`}
            alt="WhatsApp QR Code"
            width={256}
            height={256}
          />
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

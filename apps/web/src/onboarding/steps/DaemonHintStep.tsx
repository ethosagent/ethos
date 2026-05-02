import { Button } from 'antd';
import { useState } from 'react';
import type { WizardAnswers } from '../reducer';

type DaemonTab = 'launchd' | 'systemd' | 'pm2';

const SNIPPETS: Record<DaemonTab, string> = {
  launchd: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ethos.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ethos</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ethos.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ethos.err</string>
</dict>
</plist>

# Save to ~/Library/LaunchAgents/com.ethos.serve.plist
# then: launchctl load ~/Library/LaunchAgents/com.ethos.serve.plist`,

  systemd: `[Unit]
Description=Ethos agent server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ethos serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target

# Save to ~/.config/systemd/user/ethos.service
# then: systemctl --user enable --now ethos`,

  pm2: `# Start and save for auto-restart
pm2 start ethos --name ethos-serve -- serve
pm2 save

# Generate startup script (run the printed command)
pm2 startup`,
};

const TAB_LABELS: Record<DaemonTab, string> = {
  launchd: 'launchd (macOS)',
  systemd: 'systemd (Linux)',
  pm2: 'pm2 (cross-platform)',
};

export function DaemonHintStep({
  onNext,
  onBack,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<DaemonTab>('launchd');
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(SNIPPETS[tab]).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Run Ethos as a daemon.</h1>
      <p className="onboarding-supporting">
        Starting Ethos as a background service keeps cron jobs and incoming messages running when
        your browser is closed. Copy a snippet and follow the inline instructions — the browser
        cannot install it for you.
      </p>

      <div className="onboarding-daemon-tabs">
        {(Object.keys(SNIPPETS) as DaemonTab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`onboarding-daemon-tab${tab === t ? ' active' : ''}`}
            onClick={() => {
              setTab(t);
              setCopied(false);
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="onboarding-daemon-snippet-wrap">
        <pre className="onboarding-daemon-snippet">{SNIPPETS[tab]}</pre>
        <button
          type="button"
          className="onboarding-daemon-copy-btn"
          onClick={handleCopy}
          aria-label="Copy snippet"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="onboarding-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="primary" onClick={() => onNext({})}>
          Continue
        </Button>
      </div>
    </section>
  );
}

import { DrawerShell } from '../../ui/DrawerShell';

interface RegisterAgentDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function RegisterAgentDrawer({ open, onClose }: RegisterAgentDrawerProps) {
  return (
    <DrawerShell open={open} title="Register Agent" onClose={onClose}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 16px',
          gap: 12,
        }}
      >
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center' }}>
          Agent registration is available via the CLI only.
        </span>
        <code
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
            background: 'var(--bg-overlay)',
            borderRadius: 4,
            padding: '6px 10px',
          }}
        >
          ethos mesh register
        </code>
      </div>
    </DrawerShell>
  );
}

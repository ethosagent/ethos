import { QuickChatComposer } from './QuickChatComposer';

const isDarwin = window.ethos.platform === 'darwin';

const containerStyle: React.CSSProperties = {
  borderRadius: 8,
  overflow: 'hidden',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  ...(isDarwin
    ? { background: 'transparent' }
    : {
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }),
};

export function QuickChatApp() {
  return (
    <div className="quick-chat-container" style={containerStyle}>
      <QuickChatComposer />
    </div>
  );
}

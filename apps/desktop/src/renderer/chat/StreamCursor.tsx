export function StreamCursor() {
  return (
    <>
      <span
        style={{
          display: 'inline-block',
          width: 2,
          height: '1em',
          background: 'var(--blue)',
          borderRadius: 1,
          verticalAlign: 'text-bottom',
          marginLeft: 1,
          animation: 'stream-cursor-blink 1s step-end infinite',
        }}
        aria-hidden
      />
      <style>{`@keyframes stream-cursor-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`}</style>
    </>
  );
}

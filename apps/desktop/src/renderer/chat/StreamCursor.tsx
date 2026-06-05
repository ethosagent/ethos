import { useEffect, useState } from 'react';

export function StreamCursor() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setVisible((v) => !v), 530);
    return () => clearInterval(id);
  }, []);

  return (
    <span
      style={{
        opacity: visible ? 1 : 0,
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        color: 'var(--text-primary)',
        transition: 'opacity 100ms',
      }}
      aria-hidden
    >
      |
    </span>
  );
}

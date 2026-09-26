import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import styles from './styles.module.css';

const COMMAND = 'npm install -g @ethosagent/cli';

// The install pill from the "Alive" mockup — command + copy button.
// Used by the hero and the CTA bubble.
export default function InstallPill(): ReactNode {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
    } catch {
      // clipboard unavailable — the visible command is still selectable
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1400);
  }, []);

  return (
    <span className={styles.install}>
      <code>
        <span className={styles.prompt}>$</span> {COMMAND}
      </code>
      <button type="button" className={styles.copy} onClick={onCopy}>
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { HtmlBlock as HtmlBlockData } from '../../lib/chat-reducer';

interface Props {
  block: HtmlBlockData;
}

const RESIZE_LISTENER_SCRIPT = `
<script>
  function sendHeight() {
    var h = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'ethos-iframe-resize', height: h }, '*');
  }
  window.addEventListener('load', sendHeight);
  new ResizeObserver(sendHeight).observe(document.body);
</script>
`;

function injectResizeScript(html: string): string {
  if (html.includes('</body>')) {
    return html.replace('</body>', `${RESIZE_LISTENER_SCRIPT}</body>`);
  }
  return html + RESIZE_LISTENER_SCRIPT;
}

export function HtmlBlock({ block }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(block.height ?? 300);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'ethos-iframe-resize' && typeof e.data.height === 'number') {
        setHeight(Math.min(e.data.height + 16, 800));
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const srcDoc = injectResizeScript(block.html);

  return (
    <div className="html-block">
      {block.title ? <div className="html-block-title">{block.title}</div> : null}
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="html-block-iframe"
        style={{ height: `${height}px` }}
        title={block.title ?? 'Agent HTML output'}
      />
    </div>
  );
}

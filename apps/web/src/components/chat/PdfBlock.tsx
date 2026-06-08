import type { PdfBlock as PdfBlockData } from '../../lib/chat-reducer';

interface Props {
  block: PdfBlockData;
}

export function PdfBlock({ block }: Props) {
  return (
    <div className="pdf-block">
      {block.title ? <div className="pdf-block-title">{block.title}</div> : null}
      <embed
        src={block.src}
        type="application/pdf"
        className="pdf-block-embed"
        title={block.title ?? 'PDF document'}
      />
    </div>
  );
}

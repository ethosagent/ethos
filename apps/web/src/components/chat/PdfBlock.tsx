import type { PdfBlock as PdfBlockData } from '../../lib/chat-reducer';
import { SaveToDashboardButton } from '../dashboard/SaveToDashboardButton';

interface Props {
  block: PdfBlockData;
}

export function PdfBlock({ block }: Props) {
  return (
    <div className="pdf-block block-with-save" style={{ position: 'relative' }}>
      <SaveToDashboardButton
        blockType="pdf"
        content={block.src}
        metadata={{ title: block.title }}
      />
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

import type { ImageBlock as ImageBlockData } from '../../lib/chat-reducer';
import { SaveToDashboardButton } from '../dashboard/SaveToDashboardButton';

interface Props {
  block: ImageBlockData;
}

export function ImageBlock({ block }: Props) {
  return (
    <div className="image-block block-with-save" style={{ position: 'relative' }}>
      <SaveToDashboardButton
        blockType="image"
        content={block.src}
        metadata={{ title: block.title, alt: block.alt }}
      />
      <div role="img" aria-label={block.alt ?? block.title ?? 'Agent image'}>
        <img
          src={block.src}
          alt={block.alt ?? block.title ?? ''}
          className="image-block-img"
          loading="lazy"
        />
        {block.title ? <p className="image-block-caption">{block.title}</p> : null}
      </div>
    </div>
  );
}

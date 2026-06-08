import type { ImageBlock as ImageBlockData } from '../../lib/chat-reducer';

interface Props {
  block: ImageBlockData;
}

export function ImageBlock({ block }: Props) {
  return (
    <div className="image-block" role="img" aria-label={block.alt ?? block.title ?? 'Agent image'}>
      <img
        src={block.src}
        alt={block.alt ?? block.title ?? ''}
        className="image-block-img"
        loading="lazy"
      />
      {block.title ? <p className="image-block-caption">{block.title}</p> : null}
    </div>
  );
}

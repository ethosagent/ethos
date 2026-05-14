import type { Attachment, AttachmentCache, ScopedAttachments } from '@ethosagent/types';

export class ScopedAttachmentsImpl implements ScopedAttachments {
  private readonly attachments: Attachment[];
  private readonly cache: AttachmentCache;

  constructor(
    allAttachments: Attachment[],
    kinds: ('image' | 'file')[] | '*',
    cache: AttachmentCache,
  ) {
    this.cache = cache;
    this.attachments =
      kinds === '*' ? allAttachments : allAttachments.filter((a) => kinds.includes(a.type));
  }

  list(): Attachment[] {
    return this.attachments;
  }

  async open(att: Attachment): Promise<{ path: string }> {
    if (att.url.startsWith('file://')) {
      return { path: this.cache.resolveLocalPath(att.url) };
    }
    throw new Error(`Unsupported URL scheme in attachment: ${att.url}`);
  }

  async openByRef(ref: string): Promise<{ path: string }> {
    const att = this.attachments.find((a) => a.ref === ref);
    if (!att) throw new Error(`No attachment with ref "${ref}"`);
    return this.open(att);
  }
}

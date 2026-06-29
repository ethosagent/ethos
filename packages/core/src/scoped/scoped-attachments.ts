import type { Attachment, AttachmentCache, ScopedAttachments } from '@ethosagent/types';

export class ScopedAttachmentsImpl implements ScopedAttachments {
  private readonly attachments: Attachment[];
  private readonly cache: AttachmentCache;

  constructor(
    allAttachments: Attachment[],
    kinds: ('image' | 'file' | 'audio')[] | '*',
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
    if (!this.attachments.some((a) => a.ref === att.ref)) {
      throw new Error(`Attachment ref "${att.ref}" is not in the scoped list for this tool`);
    }
    // Validate URL scheme — only file:// is allowed. Reject anything else
    // (http, data, javascript, etc.) to prevent confused-deputy attacks where
    // a caller supplies a crafted att.url that the cache would blindly resolve.
    const scoped = this.attachments.find((a) => a.ref === att.ref);
    if (scoped && scoped.url !== att.url) {
      throw new Error(
        `Attachment URL mismatch: caller supplied "${att.url}" but scoped list has "${scoped.url}"`,
      );
    }
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

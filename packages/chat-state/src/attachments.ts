export type UploadState = 'uploading' | 'ready' | 'error';

export interface MessageAttachment {
  localId: string;
  state: UploadState;
  type: 'image' | 'file';
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
